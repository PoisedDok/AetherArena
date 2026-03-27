import z from 'zod';
import { DecisionOutput, ResearchOutput } from './types';
import { getProactiveDecisionPrompt } from '@/lib/prompts/proactive/decision';
import BaseLLM from '@/lib/models/base/llm';

interface ProactiveDecisionInput {
  queries: string[];
  currentActivity: any[];
  backgroundHistory: any[];
  research: ResearchOutput;
  llm: BaseLLM<any>;
}

const decisionSchema = z.object({
  decision: z.string(),
  recommendation: z.string().default(''),
  deferReason: z.string().default(''),
  supportingDocIndices: z.array(z.number().int().min(1)).max(5).default([]),
  reasoning: z.string().default(''),
});

const summarizeDoc = (doc: any, index: number): string => {
  const source = doc?.source || doc?.metadata?.source || 'unknown';
  const title =
    doc?.metadata?.title ||
    doc?.metadata?.subject ||
    doc?.metadata?.file_name ||
    doc?.title ||
    'Untitled';
  const sender = doc?.metadata?.sender ? ` from="${doc.metadata.sender}"` : '';
  const url = doc?.metadata?.url || doc?.url || '';
  const path = doc?.metadata?.path || doc?.metadata?.file_path || doc?.path || '';
  const preview =
    doc?.content ||
    doc?.text ||
    doc?.snippet ||
    doc?.metadata?.body_preview ||
    doc?.metadata?.content_preview ||
    '';

  const location = url ? ` url="${url}"` : path ? ` path="${path}"` : '';
  return `${index + 1}. [${source}] ${title}${sender}${location}\n${preview}`;
};

const extractResearchDocs = (research: ResearchOutput): any[] => {
  const docs: any[] = [];
  for (const context of research.gatheredContext || []) {
    const outerResults = Array.isArray(context?.results) ? context.results : [];
    for (const outer of outerResults) {
      if (Array.isArray(outer?.results)) {
        docs.push(...outer.results);
      } else {
        docs.push(outer);
      }
    }
  }
  return docs.filter((doc) => !!doc);
};

const buildDecisionContext = (input: ProactiveDecisionInput): string => {
  const queryText = input.queries.map((q, idx) => `${idx + 1}. ${q}`).join('\n');
  const currentText = (input.currentActivity || [])
    .slice(0, 8)
    .map((doc, idx) => summarizeDoc(doc, idx))
    .join('\n\n');
  const backgroundText = (input.backgroundHistory || [])
    .slice(0, 8)
    .map((doc, idx) => summarizeDoc(doc, idx))
    .join('\n\n');

  const researchDocs = extractResearchDocs(input.research);
  const researchText = researchDocs
    .slice(0, 20)
    .map((doc, idx) => summarizeDoc(doc, idx))
    .join('\n\n');
  const reasoningText = (input.research.reasoningTrace || [])
    .slice(-8)
    .map((step, idx) => `${idx + 1}. ${step}`)
    .join('\n');

  return `
<generated_queries>
${queryText || 'none'}
</generated_queries>

<current_activity>
${currentText || 'none'}
</current_activity>

<background_history>
${backgroundText || 'none'}
</background_history>

<research_findings>
${researchText || 'none'}
</research_findings>

<research_reasoning_trace>
${reasoningText || 'none'}
</research_reasoning_trace>
`;
};

const normalizeDecision = (
  raw: z.infer<typeof decisionSchema>,
  researchDocs: any[],
): DecisionOutput => {
  const selectedDocs = raw.supportingDocIndices
    .map((index) => researchDocs[index - 1])
    .filter((doc) => !!doc)
    .slice(0, 5);

  if (raw.decision.toLowerCase().trim() === 'intervene') {
    const recommendation = raw.recommendation.trim();
    return {
      decision: 'intervene',
      recommendation:
        recommendation ||
        'Research found actionable context related to your current activity.',
      supportingDocs: selectedDocs,
      reasoning: raw.reasoning.trim(),
    };
  }

  const deferReason = raw.deferReason.trim();
  return {
    decision: 'defer',
    deferReason:
      deferReason || 'Insufficient novel actionable evidence from the research layer.',
    reasoning: raw.reasoning.trim(),
  };
};

export const decide = async (
  input: ProactiveDecisionInput,
): Promise<DecisionOutput> => {
  const decisionContext = buildDecisionContext(input);
  const researchDocs = extractResearchDocs(input.research);

  try {
    const result = await input.llm.generateObject<typeof decisionSchema>({
      mode: 'json',
      messages: [
        {
          role: 'system',
          content: getProactiveDecisionPrompt(decisionContext),
        },
        {
          role: 'user',
          content:
            'Return JSON only. Choose intervene or defer. If intervene, include recommendation and supportingDocIndices.',
        },
      ],
      schema: decisionSchema,
    });

    return normalizeDecision(result, researchDocs);
  } catch (error) {
    console.error('[ProactiveDecision] Decision generation failed, deferring', error);
    return {
      decision: 'defer',
      deferReason: 'Decision layer failed to produce a reliable result.',
    };
  }
};
