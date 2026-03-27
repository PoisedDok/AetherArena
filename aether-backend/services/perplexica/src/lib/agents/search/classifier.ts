import z from 'zod';
import { ClassifierInput, ClassifierOutput, SearchSources } from './types';
import formatChatHistoryAsString from '@/lib/utils/formatHistory';

/**
 * Hybrid Classifier: Deterministic pre-filter + LLM intent detection
 *
 * @.architecture
 * Incoming:  ClassifierInput {query, enabledSources, chatHistory, llm}
 * Processing:
 *   Phase 1 — Deterministic regex pre-filter (greetings, math, weather, stock)
 *   Phase 2 — LLM intent classification via generateObject (intent + queries)
 *   Phase 3 — Source flag derivation (merge LLM intent with caller's enabledSources)
 *   Phase 4 — standaloneFollowUp reformulation (lightweight LLM, unchanged)
 * Outgoing:  ClassifierOutput {classification, standaloneFollowUp, intentSources, searchQueries}
 *
 * WHY HYBRID:
 * The researcher agent previously relied on LFM 1.2B to emit structured
 * tool-call tokens via streamText (~66% failure rate). This classifier now
 * does the heavy lifting: it determines WHAT to search and generates
 * optimized queries. The researcher then EXECUTES deterministically.
 *
 * generateObject is used instead of streamText because:
 * 1. Non-streaming — complete response before parsing, no partial token issues
 * 2. 3-path cascade — native tool_calls → content tokens → raw JSON + repairJson
 * 3. Simple schema — intent enum + string array = high success rate
 * 4. Deterministic fallback — if LLM fails, use raw query + caller's sources
 */

// ---------------------------------------------------------------------------
// Default classification: search everything, no widgets, no special sources.
// ---------------------------------------------------------------------------
const DEFAULT_CLASSIFICATION: ClassifierOutput['classification'] = {
  skipSearch: false,
  personalSearch: false,
  academicSearch: false,
  discussionSearch: false,
  legalSearch: false,
  showWeatherWidget: false,
  showStockWidget: false,
  showCalculationWidget: false,
};

// ---------------------------------------------------------------------------
// Phase 1: Pre-filter — catches trivial queries that should skip search
// ---------------------------------------------------------------------------
const GREETINGS = new Set([
  'hi', 'hello', 'hey', 'howdy', 'yo',
  'hi there', 'hello there', 'hey there',
  'thanks', 'thank you', 'thx', 'ty',
  'bye', 'goodbye', 'good bye', 'see you', 'cya',
  'ok', 'okay', 'sure', 'yes', 'no', 'yep', 'nope',
  'good morning', 'good evening', 'good night', 'gm', 'gn',
]);

const GREETING_REGEX = /^(hi|hello|hey|thanks?|bye)(\s+there)?\s*[!.]*$/i;

function isGreeting(q: string, qLower: string): boolean {
  return GREETINGS.has(qLower) || GREETING_REGEX.test(q);
}

function isMathExpression(q: string, qLower: string): boolean {
  const collapsed = qLower.replace(/\s+/g, '');
  return (
    /^[\d+\-*/().%^]+$/.test(collapsed) ||
    /^\d+(\.\d+)?\s*%\s*of\s*\d+/i.test(qLower) ||
    /^(sqrt|square root|cube root)\s*(\(?\s*\d+\s*\)?)/i.test(qLower) ||
    /^convert\s+\d+(\.\d+)?\s*[a-z]+\s+to\s+[a-z]+$/i.test(qLower)
  );
}

function isPureWeatherQuery(qLower: string): boolean {
  return (
    /^weather\s+(in|at|for)\s+\w/i.test(qLower) ||
    /^(forecast|temperature)\s+(in|at|for)\s+\w/i.test(qLower)
  );
}

function isPureStockQuery(q: string): boolean {
  return (
    /^[A-Z]{1,5}\s+(stock\s+)?price$/i.test(q) ||
    /^(price of|stock price of?)\s+[A-Z]{1,5}$/i.test(q)
  );
}

// ---------------------------------------------------------------------------
// Phase 1b: Widget detection — for non-skip queries that ALSO trigger widgets
// ---------------------------------------------------------------------------
function detectStockWidget(q: string, qLower: string): boolean {
  return (
    /\b(stock|share|shares|ticker|nasdaq|nyse|market cap|earnings)\b/i.test(qLower) &&
    /\b[A-Z]{1,5}\b/.test(q)
  ) || /\b(stock price|share price)\b/i.test(qLower);
}

function detectWeatherWidget(qLower: string): boolean {
  return /\b(weather|forecast|temperature|rain|snow|climate)\b/.test(qLower) &&
    /\b(in|at|for|of)\s+\w/i.test(qLower);
}

function detectCalculationWidget(qLower: string): boolean {
  return /\d+\s*[+\-*/^%]\s*\d+/.test(qLower) ||
    /\b(calculate|compute|solve)\b/i.test(qLower);
}

// ---------------------------------------------------------------------------
// Phase 2: LLM-based intent classification via generateObject
// ---------------------------------------------------------------------------

/** Intent types the LLM can classify into */
type IntentType = 'web' | 'news' | 'academic' | 'legal' | 'discussions' | 'mixed';

/** Map from classified intent to source list */
const INTENT_TO_SOURCES: Record<IntentType, SearchSources[]> = {
  web: ['web'],
  news: ['news'],
  academic: ['academic'],
  legal: ['legal'],
  discussions: ['discussions'],
  mixed: ['web', 'academic', 'news'],
};

const intentClassificationSchema = z.object({
  intent: z
    .enum(['web', 'news', 'academic', 'legal', 'discussions', 'mixed'])
    .describe(
      'The primary intent category for this query. ' +
      '"web" = general web search, people, products, companies. ' +
      '"news" = recent news, breaking stories, current events, journalism. ' +
      '"academic" = scholarly papers, research studies, scientific data. ' +
      '"legal" = case law, statutes, regulations, legal precedents. ' +
      '"discussions" = social media opinions, Reddit threads, forum posts. ' +
      '"mixed" = needs multiple source types (e.g., both web and academic).',
    ),
  queries: z
    .array(z.string())
    .min(1)
    .max(3)
    .describe(
      'SEO-optimized search queries derived from the user question. ' +
      'Use keywords, not full sentences. Cover different aspects. ' +
      'Example: user asks "What are the health benefits of green tea?" → ' +
      '["green tea health benefits", "green tea antioxidants research", "green tea vs black tea nutrition"]',
    ),
});

const INTENT_CLASSIFICATION_PROMPT = `You are a search query classifier and optimizer. Given a user's question, determine:

1. **Intent**: Which type of sources would best answer this question?
   - "web": General information, products, people, companies, how-to guides
   - "news": Recent news, breaking stories, current events, journalism
   - "academic": Research papers, scholarly articles, scientific studies, peer-reviewed data
   - "legal": Case law, court decisions, statutes, regulations, legal analysis
   - "discussions": Community opinions, Reddit threads, forum discussions, social media posts
   - "mixed": The question benefits from multiple source types (e.g., both web and academic)

2. **Queries**: Generate 1-3 SEO-optimized search queries that will find the best results.
   - Use keywords, not full sentences
   - Cover different aspects of the question
   - Be specific and targeted
   - Include relevant dates/years when the question implies recency

Examples:
- "Who is Elon Musk?" → intent: "web", queries: ["Elon Musk biography", "Elon Musk companies career", "Elon Musk net worth 2026"]
- "What happened in the stock market today?" → intent: "news", queries: ["stock market news today", "Dow Jones latest updates", "financial market breaking news"]
- "Latest research on CRISPR gene editing" → intent: "academic", queries: ["CRISPR gene editing 2026 research", "CRISPR clinical trials results", "CRISPR technology advances"]
- "What do people think about AI replacing jobs?" → intent: "discussions", queries: ["AI replacing jobs opinions", "AI automation employment Reddit", "artificial intelligence job displacement debate"]
- "Landmark privacy law cases in the EU" → intent: "legal", queries: ["EU GDPR landmark cases", "European privacy law court decisions", "EU data protection legal precedents"]
- "Is intermittent fasting effective?" → intent: "mixed", queries: ["intermittent fasting effectiveness", "intermittent fasting scientific studies", "intermittent fasting health benefits research"]`;

async function classifyIntent(
  query: string,
  llm: ClassifierInput['llm'],
): Promise<{ intent: IntentType; queries: string[] } | null> {
  try {
    const result = await llm.generateObject<typeof intentClassificationSchema>({
      messages: [
        { role: 'system', content: INTENT_CLASSIFICATION_PROMPT },
        { role: 'user', content: query },
      ],
      schema: intentClassificationSchema,
      options: {
        temperature: 0.1,
        maxTokens: 300,
      },
    });
    // Validate the result has usable data
    if (
      result &&
      result.intent &&
      result.queries &&
      Array.isArray(result.queries) &&
      result.queries.length > 0 &&
      result.queries.every((q: string) => typeof q === 'string' && q.trim().length > 0)
    ) {
      return {
        intent: result.intent as IntentType,
        queries: result.queries.map((q: string) => q.trim()).slice(0, 3),
      };
    }
    return null;
  } catch {
    // LLM failure is non-fatal: deterministic fallback handles it
    return null;
  }
}

// ---------------------------------------------------------------------------
// Phase 3: Source flag derivation — merge LLM intent with caller's sources
// ---------------------------------------------------------------------------
function deriveSourceFlags(
  enabledSources: SearchSources[],
): Pick<
  ClassifierOutput['classification'],
  'academicSearch' | 'discussionSearch' | 'legalSearch'
> {
  return {
    academicSearch: enabledSources.includes('academic'),
    discussionSearch: enabledSources.includes('discussions'),
    legalSearch: enabledSources.includes('legal'),
  };
}

/**
 * Merge LLM-classified intent sources with the caller's explicit enabledSources.
 * Caller always has final say: if they specified only ['web'], we don't add 'academic'
 * even if the LLM thinks the query is academic. But if the caller specified multiple
 * sources or the default set, we use the LLM's classification to prioritize.
 */
function resolveIntentSources(
  llmSources: SearchSources[] | null,
  enabledSources: SearchSources[],
): SearchSources[] {
  if (!llmSources || llmSources.length === 0) {
    // Fallback: use whatever the caller sent
    return enabledSources.length > 0 ? enabledSources : ['web'];
  }

  // Intersect LLM intent with caller-enabled sources.
  // If intersection is empty (e.g., LLM says 'academic' but caller only sent 'web'),
  // fall back to caller's sources — caller has final say.
  const intersection = llmSources.filter((s) => enabledSources.includes(s));
  if (intersection.length > 0) {
    return intersection;
  }

  // No overlap: caller's explicit sources take priority
  return enabledSources.length > 0 ? enabledSources : llmSources;
}

// ---------------------------------------------------------------------------
// Phase 4: standaloneFollowUp — lightweight LLM reformulation
// ---------------------------------------------------------------------------
const reformulationSchema = z.object({
  standaloneFollowUp: z
    .string()
    .describe(
      "A self-contained, context-independent reformulation of the user's question.",
    ),
});

const REFORMULATION_PROMPT = `You are a query reformulator. Given a conversation history and a follow-up question, rewrite the question so it can be understood WITHOUT the conversation context.

Rules:
- If the question is already self-contained, return it unchanged.
- Replace pronouns ("it", "that", "they", "this") with the actual subject from conversation.
- Keep the rewritten question concise — no extra explanation.
- Return ONLY the rewritten question.

Examples:
- History: "User: Tell me about Tesla" → Follow-up: "How fast is it?" → "How fast is Tesla?"
- History: "User: What is Rust?" → Follow-up: "Show me examples" → "Show me Rust programming examples"
- No history → "What is quantum computing?" → "What is quantum computing?"`;

async function resolveStandaloneFollowUp(
  input: ClassifierInput,
): Promise<string> {
  const query = input.query.trim();

  if (!input.chatHistory || input.chatHistory.length === 0) {
    return query;
  }

  const hasUserHistory = input.chatHistory.some((m) => m.role === 'user');
  if (!hasUserHistory) {
    return query;
  }

  try {
    const output = await input.llm.generateObject<typeof reformulationSchema>({
      messages: [
        {
          role: 'system',
          content: REFORMULATION_PROMPT,
        },
        {
          role: 'user',
          content: `<conversation_history>\n${formatChatHistoryAsString(input.chatHistory.slice(-6))}\n</conversation_history>\n<follow_up_question>\n${query}\n</follow_up_question>`,
        },
      ],
      schema: reformulationSchema,
      options: {
        temperature: 0.1,
        maxTokens: 150,
      },
    });
    return output.standaloneFollowUp || query;
  } catch {
    return query;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export const classify = async (
  input: ClassifierInput,
): Promise<ClassifierOutput> => {
  const q = input.query.trim();
  const qLower = q.toLowerCase();

  // ── Phase 1: Greeting / trivial pre-filter (skip search) ────────────
  if (isGreeting(q, qLower)) {
    return {
      classification: { ...DEFAULT_CLASSIFICATION, skipSearch: true },
      standaloneFollowUp: q,
      intentSources: [],
      searchQueries: [],
    };
  }

  if (isMathExpression(q, qLower)) {
    return {
      classification: {
        ...DEFAULT_CLASSIFICATION,
        skipSearch: true,
        showCalculationWidget: true,
      },
      standaloneFollowUp: q,
      intentSources: [],
      searchQueries: [],
    };
  }

  if (isPureWeatherQuery(qLower)) {
    return {
      classification: {
        ...DEFAULT_CLASSIFICATION,
        skipSearch: true,
        showWeatherWidget: true,
      },
      standaloneFollowUp: q,
      intentSources: [],
      searchQueries: [],
    };
  }

  if (isPureStockQuery(q)) {
    return {
      classification: {
        ...DEFAULT_CLASSIFICATION,
        skipSearch: true,
        showStockWidget: true,
      },
      standaloneFollowUp: q,
      intentSources: [],
      searchQueries: [],
    };
  }

  // ── Phase 2: LLM intent classification (parallel with Phase 4) ──────
  // Run intent classification and standaloneFollowUp in parallel for speed
  const [intentResult, standaloneFollowUp] = await Promise.all([
    classifyIntent(q, input.llm),
    resolveStandaloneFollowUp(input),
  ]);

  // ── Phase 3: Build classification deterministically ─────────────────
  // Derive sources: merge LLM intent with caller's enabledSources
  const llmSources = intentResult
    ? INTENT_TO_SOURCES[intentResult.intent] || null
    : null;
  const intentSources = resolveIntentSources(llmSources, input.enabledSources);

  // Build source flags from the resolved intentSources (not just enabledSources)
  const sourceFlags = deriveSourceFlags(intentSources);

  const classification: ClassifierOutput['classification'] = {
    skipSearch: false,
    personalSearch: false,
    ...sourceFlags,
    showWeatherWidget: detectWeatherWidget(qLower),
    showStockWidget: detectStockWidget(q, qLower),
    showCalculationWidget: detectCalculationWidget(qLower),
  };

  // Build search queries: use LLM-optimized queries or fall back to raw query
  const searchQueries =
    intentResult && intentResult.queries.length > 0
      ? intentResult.queries
      : [q]; // Deterministic fallback: raw query always works

  return {
    classification,
    standaloneFollowUp,
    intentSources,
    searchQueries,
  };
};
