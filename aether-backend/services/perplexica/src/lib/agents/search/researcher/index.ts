import z from 'zod';
import {
  ActionOutput,
  ResearcherInput,
  ResearcherOutput,
  SearchSources,
} from '../types';
import { ActionRegistry } from './actions';
import SessionManager from '@/lib/session';
import { ReasoningResearchBlock } from '@/lib/types';

/**
 * Deterministic Researcher
 *
 * @.architecture
 * Incoming:  ResearcherInput (classification with intentSources + searchQueries)
 * Processing:
 *   1. Map intentSources to registered actions (web_search, academic_search, etc.)
 *   2. Execute actions deterministically with classified searchQueries
 *   3. For balanced/quality: refine queries via generateObject and execute again
 * Outgoing:  ResearcherOutput {findings, searchFindings}
 *
 * WHY DETERMINISTIC:
 * The previous agentic loop used streamText with tool-calling. LFM 1.2B failed
 * to emit parseable tool-call tokens ~66% of the time, causing 0 search results.
 * This researcher receives pre-classified intent and queries from the classifier,
 * then executes them directly. No LLM decides whether to search — it always does.
 */

// ---------------------------------------------------------------------------
// Source type → action name mapping
// ---------------------------------------------------------------------------
const SOURCE_TO_ACTION: Record<SearchSources, string> = {
  web: 'web_search',
  academic: 'academic_search',
  discussions: 'social_search',
  legal: 'legal_search',
  news: 'news_search',
};

// ---------------------------------------------------------------------------
// Query refinement schema for balanced/quality modes
// ---------------------------------------------------------------------------
const refinementSchema = z.object({
  additionalQueries: z
    .array(z.string())
    .max(3)
    .describe(
      'Additional SEO-optimized search queries to deepen the research. ' +
        'Focus on aspects not covered by existing results. Empty array if research is complete.',
    ),
  done: z
    .boolean()
    .describe(
      'Set to true if the existing search results are sufficient to answer the question comprehensively.',
    ),
});

const REFINEMENT_PROMPT = `You are a research refinement assistant. Given a user's original question, the search queries already used, and the search results obtained so far, determine if additional searches are needed.

If the existing results are sufficient to answer the question comprehensively, set "done" to true and return an empty "additionalQueries" array.

If more information is needed, generate 1-3 additional search queries that:
- Cover aspects NOT already addressed by existing results
- Use different keywords or angles from the original queries
- Are SEO-optimized (keywords, not sentences)
- Target gaps or missing information in the current results

Be strategic: don't repeat similar queries. Each new query should explore a genuinely different angle.`;

class Researcher {
  async research(
    session: SessionManager,
    input: ResearcherInput,
  ): Promise<ResearcherOutput> {
    const actionOutput: ActionOutput[] = [];
    const { intentSources, searchQueries } = input.classification;

    // Determine max refinement rounds based on mode
    const maxRefinementRounds =
      input.config.mode === 'speed'
        ? 0 // Speed: execute once, no refinement
        : input.config.mode === 'balanced'
          ? 1 // Balanced: 1 refinement round
          : 4; // Quality: up to 4 refinement rounds

    // Set up research block for UI
    const researchBlockId = crypto.randomUUID();
    session.emitBlock({
      id: researchBlockId,
      type: 'research',
      data: { subSteps: [] },
    });

    const additionalConfig = {
      llm: input.config.llm,
      embedding: input.config.embedding,
      session,
      researchBlockId,
      fileIds: input.config.fileIds,
    };

    // ── Emit reasoning preamble for UI ──────────────────────────────────
    const intentDescription = intentSources.length > 0
      ? `Searching ${intentSources.join(', ')} sources`
      : 'Searching web sources';
    const queryDescription = searchQueries.join('", "');
    const reasoningText =
      `${intentDescription} for: "${queryDescription}". ` +
      (maxRefinementRounds > 0
        ? `Will refine up to ${maxRefinementRounds} time(s) based on results.`
        : 'Single-pass search.');

    const block = session.getBlock(researchBlockId);
    if (block && block.type === 'research') {
      block.data.subSteps.push({
        id: crypto.randomUUID(),
        type: 'reasoning',
        reasoning: reasoningText,
      } as ReasoningResearchBlock);
      session.updateBlock(researchBlockId, [
        { op: 'replace', path: '/data/subSteps', value: block.data.subSteps },
      ]);
    }

    // ── Round 0: Execute initial search with classified queries ─────────
    const initialResults = await this.executeDeterministicSearch(
      intentSources,
      searchQueries,
      input,
      additionalConfig,
    );
    actionOutput.push(...initialResults);

    // ── Rounds 1..N: Refinement via generateObject (balanced/quality) ──
    let allQueriesUsed = [...searchQueries];

    for (let round = 0; round < maxRefinementRounds; round++) {
      const currentResults = actionOutput
        .filter((a) => a.type === 'search_results')
        .flatMap((a) => a.results);

      // Ask LLM for refinement queries
      const refinement = await this.refineQueries(
        input.config.llm,
        input.classification.standaloneFollowUp || input.followUp,
        allQueriesUsed,
        currentResults,
      );

      if (!refinement || refinement.done || refinement.additionalQueries.length === 0) {
        break; // LLM says we have enough, or refinement failed
      }

      // Emit reasoning about refinement for UI
      const refBlock = session.getBlock(researchBlockId);
      if (refBlock && refBlock.type === 'research') {
        refBlock.data.subSteps.push({
          id: crypto.randomUUID(),
          type: 'reasoning',
          reasoning: `Refining search (round ${round + 1}): "${refinement.additionalQueries.join('", "')}"`,
        } as ReasoningResearchBlock);
        session.updateBlock(researchBlockId, [
          { op: 'replace', path: '/data/subSteps', value: refBlock.data.subSteps },
        ]);
      }

      // Execute refined queries
      const refinedResults = await this.executeDeterministicSearch(
        intentSources,
        refinement.additionalQueries,
        input,
        additionalConfig,
      );
      actionOutput.push(...refinedResults);
      allQueriesUsed.push(...refinement.additionalQueries);
    }

    // ── Also search uploads if fileIds present ──────────────────────────
    if (input.config.fileIds.length > 0) {
      try {
        const uploadResult = await ActionRegistry.execute(
          'uploads_search',
          { queries: searchQueries.slice(0, 3) },
          additionalConfig,
        );
        actionOutput.push(uploadResult);
      } catch {
        // Upload search is optional; don't fail the whole pipeline
      }
    }

    // ── Deduplicate results by URL ──────────────────────────────────────
    const searchResults = actionOutput
      .filter((a) => a.type === 'search_results')
      .flatMap((a) => a.results);

    const seenUrls = new Map<string, number>();
    const filteredSearchResults = searchResults
      .map((result, index) => {
        if (result.metadata.url && !seenUrls.has(result.metadata.url)) {
          seenUrls.set(result.metadata.url, index);
          return result;
        } else if (result.metadata.url && seenUrls.has(result.metadata.url)) {
          const existingIndex = seenUrls.get(result.metadata.url)!;
          const existingResult = searchResults[existingIndex];
          existingResult.content += `\n\n${result.content}`;
          return undefined;
        }
        return result;
      })
      .filter((r) => r !== undefined);

    // ── Emit source block ───────────────────────────────────────────────
    session.emitBlock({
      id: crypto.randomUUID(),
      type: 'source',
      data: filteredSearchResults,
    });

    return {
      findings: actionOutput,
      searchFindings: filteredSearchResults,
    };
  }

  /**
   * Execute search actions deterministically for the given sources and queries.
   * No LLM decides whether to search — it always executes.
   */
  private async executeDeterministicSearch(
    sources: SearchSources[],
    queries: string[],
    input: ResearcherInput,
    additionalConfig: {
      llm: any;
      embedding: any;
      session: SessionManager;
      researchBlockId: string;
      fileIds: string[];
    },
  ): Promise<ActionOutput[]> {
    const results: ActionOutput[] = [];
    const effectiveSources = sources.length > 0 ? sources : ['web' as SearchSources];

    // Execute each source type in parallel
    const searchPromises = effectiveSources.map(async (source) => {
      const actionName = SOURCE_TO_ACTION[source];
      if (!actionName) return;

      const action = ActionRegistry.get(actionName);
      if (!action) return;

      // Build params matching each action's schema
      const params = this.buildActionParams(actionName, queries);

      try {
        const output = await ActionRegistry.execute(
          actionName,
          params,
          additionalConfig,
        );
        results.push(output);
      } catch (err) {
        console.error(
          `[Researcher] Action ${actionName} failed:`,
          (err as Error).message,
        );
        // Non-fatal: other sources may still succeed
      }
    });

    await Promise.all(searchPromises);
    return results;
  }

  /**
   * Build action-specific params from generic queries.
   * Each action has a slightly different schema (e.g., legal_search has jurisdiction).
   */
  private buildActionParams(
    actionName: string,
    queries: string[],
  ): Record<string, any> {
    const trimmedQueries = queries.slice(0, 3);

    switch (actionName) {
      case 'web_search':
        return { type: 'web_search', queries: trimmedQueries };
      case 'legal_search':
        return { type: 'legal_search', queries: trimmedQueries, jurisdiction: 'all' };
      case 'academic_search':
      case 'social_search':
        return { queries: trimmedQueries };
      default:
        return { queries: trimmedQueries };
    }
  }

  /**
   * Ask the LLM for refinement queries based on current results.
   * Uses generateObject for reliability (3-path cascade).
   * Returns null on any failure — caller treats null as "done".
   */
  private async refineQueries(
    llm: any,
    originalQuery: string,
    queriesUsed: string[],
    currentResults: Array<{ content: string; metadata: Record<string, any> }>,
  ): Promise<z.infer<typeof refinementSchema> | null> {
    try {
      // Build a concise summary of current results for context
      const resultSummary = currentResults
        .slice(0, 15) // Limit context to avoid token overflow
        .map(
          (r, i) =>
            `[${i + 1}] ${r.metadata?.title || 'Untitled'}: ${(r.content || '').substring(0, 200)}`,
        )
        .join('\n');

      const result = await llm.generateObject({
        messages: [
          { role: 'system', content: REFINEMENT_PROMPT },
          {
            role: 'user',
            content:
              `Original question: ${originalQuery}\n\n` +
              `Queries already used: ${queriesUsed.join(', ')}\n\n` +
              `Current results (${currentResults.length} total):\n${resultSummary}\n\n` +
              `Should I search for more? If yes, what additional queries would cover new ground?`,
          },
        ],
        schema: refinementSchema,
        options: {
          temperature: 0.2,
          maxTokens: 300,
        },
      });

      if (
        result &&
        typeof result.done === 'boolean' &&
        Array.isArray(result.additionalQueries)
      ) {
        return {
          done: result.done,
          additionalQueries: result.additionalQueries
            .filter((q: string) => typeof q === 'string' && q.trim().length > 0)
            .map((q: string) => q.trim())
            .slice(0, 3),
        };
      }
      return null;
    } catch {
      // Refinement failure is non-fatal: treat as "done"
      return null;
    }
  }
}

export default Researcher;
