/**
 * Proactive Agent Classifier
 * 
 * Pattern: Exact match to research agent's classifier.ts
 * Calls LLM BEFORE agent loop to decide tool requirements.
 */

import z from 'zod';
import { ProactiveClassifierInput, ProactiveClassifierOutput } from './types';
import {
  normalizeProactiveRetrieverSource,
  ProactiveRetrieverSource,
} from './constants';
import { getProactiveClassifierPrompt } from '@/lib/prompts/proactive/classifier';

const MAX_CALLS_PER_TOOL = 2;
const MAX_TOTAL_TOOL_CALLS = 4;

const DEFAULT_TOOL_DECISIONS: ProactiveClassifierOutput['toolDecisions'] = {
  retrieverCalls: [],
  webSearchCalls: [],
  maxToolCalls: 0,
};

const dedupe = <T>(items: T[]): T[] => {
  return [...new Set(items)];
};

const normalizeOutput = (
  raw: z.infer<typeof schema>,
): ProactiveClassifierOutput => {
  const retrieverCalls: ProactiveClassifierOutput['toolDecisions']['retrieverCalls'] =
    raw.toolDecisions.retrieverCalls
      .slice(0, MAX_CALLS_PER_TOOL)
      .map((call) => {
        const unresolved = (call.sources || []).filter(
          (source) => normalizeProactiveRetrieverSource(source) === null,
        );
        if (unresolved.length > 0) {
          console.warn(
            '[ProactiveClassifier] Ignoring unknown retriever sources:',
            unresolved,
          );
        }

        const normalizedSources = dedupe(
          (call.sources || [])
            .map((source) => normalizeProactiveRetrieverSource(source))
            .filter(
              (source): source is ProactiveRetrieverSource => source !== null,
            ),
        );

        const mode: 'bm25' | 'semantic' | 'hybrid' =
          call.mode === 'semantic' ? 'semantic' : call.mode === 'hybrid' ? 'hybrid' : 'bm25';

        return {
          query: call.query.trim(),
          sources: normalizedSources,
          mode,
        };
      })
      .filter((call) => call.query.length > 0 && call.sources.length > 0);

  const webSearchCalls = raw.toolDecisions.webSearchCalls
    .slice(0, MAX_CALLS_PER_TOOL)
    .map((call) => ({
      type: call.type,
      queries: call.queries
        .map((query) => query.trim())
        .filter(Boolean)
        .slice(0, 3),
      scrapeUrls: Boolean(call.scrapeUrls),
    }))
    .filter((call) => call.queries.length > 0);

  const plannedCalls = retrieverCalls.length + webSearchCalls.length;
  const requestedBudget = Number.isFinite(raw.toolDecisions.maxToolCalls)
    ? Math.floor(raw.toolDecisions.maxToolCalls)
    : plannedCalls;
  const boundedRawBudget = Math.max(
    0,
    Math.min(MAX_TOTAL_TOOL_CALLS, requestedBudget),
  );
  const maxToolCalls =
    plannedCalls === 0
      ? 0
      : Math.max(
          plannedCalls,
          boundedRawBudget,
        );

  const reasoning =
    raw.reasoning.trim() ||
    'Classifier output normalized for strict proactive tool contract.';

  return {
    toolDecisions: {
      retrieverCalls,
      webSearchCalls,
      maxToolCalls,
    },
    reasoning,
  };
};

const schema = z.object({
  toolDecisions: z.object({
    retrieverCalls: z
      .array(
        z.object({
          query: z.string().default(''),
          // Accept raw strings from model, then normalize to strict enum.
          sources: z.array(z.string()).default([]),
          mode: z.enum(['bm25', 'semantic', 'hybrid']).default('bm25'),
        }),
      )
      .max(MAX_CALLS_PER_TOOL)
      .default([])
      .describe('Planned retriever tool calls with exact parameters (max 2 calls)'),
    webSearchCalls: z
      .array(
        z.object({
          type: z.enum(['web', 'news', 'academic', 'social', 'legal']).default('web'),
          queries: z.array(z.string()).default([]),
          scrapeUrls: z.boolean().default(false),
        }),
      )
      .max(MAX_CALLS_PER_TOOL)
      .default([])
      .describe('Planned web search calls by type (empty array if not needed)'),
    maxToolCalls: z
      .number()
      .min(0)
      .max(MAX_TOTAL_TOOL_CALLS)
      .default(0)
      .describe('Tool budget hard cap is 4 (2 retriever + 2 web).'),
  }).default(DEFAULT_TOOL_DECISIONS),
  reasoning: z
    .string()
    .default('')
    .describe('Brief explanation of tool plan (1-2 sentences)'),
});

/**
 * Classify proactive context and decide which tools are needed
 * Called BEFORE scout agent loop starts
 */
export const classify = async (input: ProactiveClassifierInput) => {
  const contextSummary = `
<current_activity>
${input.currentActivity.map(doc => {
  const title = doc.metadata?.title || doc.metadata?.subject || doc.metadata?.file_name || 'Activity';
  const preview = doc.content || doc.metadata?.body_preview || '';
  return `- ${title}: ${preview}`;
}).join('\n')}
</current_activity>

<background_history>
${input.backgroundHistory.map(doc => {
  const label = (doc.metadata as any)?.query || doc.metadata?.title || 'Background';
  return `- ${label}`;
}).join('\n')}
</background_history>

<activity_context>
Time: ${input.activityContext.current_time}
</activity_context>
`;

  try {
    const output = await input.llm.generateObject<typeof schema>({
      mode: 'json',
      messages: [
        {
          role: 'system',
          content: getProactiveClassifierPrompt(input.availableIndexes),
        },
        {
          role: 'user',
          content: contextSummary,
        },
      ],
      schema,
    });
    
    console.log('[ProactiveClassifier] Raw model output:', JSON.stringify(output, null, 2));

    return normalizeOutput(output);
  } catch (error) {
    console.error(
      '[ProactiveClassifier] LLM classification failed; returning empty tool plan',
      error,
    );

    // Fail-safe: never fabricate tool calls when planning fails.
    // Orchestrator treats empty plan as defer.
    return {
      toolDecisions: {
        retrieverCalls: [],
        webSearchCalls: [],
        maxToolCalls: 0,
      },
      reasoning: 'Classification failed; no tool plan generated.',
    };
  }
};
