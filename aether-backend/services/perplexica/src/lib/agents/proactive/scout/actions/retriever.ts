/**
 * Retriever Tool - Unified Local Search
 * 
 * Searches across all local sources using v1 API endpoints:
 * - Browser history (BM25/semantic)
 * - Chat history (BM25/semantic)
 * - Filesystem (BM25/semantic)
 * - Email (BM25/semantic)
 * - Proactive cache (past agent outputs)
 */

import z from 'zod';
import { ProactiveAction, ActionOutput, ProactiveActionConfig } from '../../types';
import {
  PROACTIVE_RETRIEVER_SOURCES,
  ProactiveRetrieverSource,
} from '../../constants';

const actionDescription = `
Search local sources (browser history, chat conversations, indexed files, emails) for context.
Sources: browser, chat, filesystem, email, query_gen.
Modes: bm25 (keyword exact match), semantic (conceptual meaning), hybrid (RRF fusion of both for best quality).
`;

const DAEMON_SEARCH_SOURCES: ReadonlySet<ProactiveRetrieverSource> = new Set([
  'browser',
  'email',
  'filesystem',
  'query_gen',
]);

const buildLocalSearchEndpoint = (
  apiBase: string,
  source: ProactiveRetrieverSource,
  query: string,
  limit: number,
  mode: string,
  minScore: number,
): string => {
  // Use unified Aether-RAG endpoints where possible to support semantic, bm25, and hybrid modes
  if (source === 'browser') {
    return `${apiBase}/v1/search/index?name=browser_history&query=${encodeURIComponent(query)}&top_k=${limit}&mode=${mode}&min_score=${minScore}`;
  } else if (source === 'email') {
    return `${apiBase}/v1/search/index?name=email&query=${encodeURIComponent(query)}&top_k=${limit}&mode=${mode}&min_score=${minScore}`;
  } else if (source === 'filesystem') {
    return `${apiBase}/v1/search/files?query=${encodeURIComponent(query)}&top_k=${limit}&mode=${mode}&min_score=${minScore}`;
  } else if (source === 'query_gen') {
    // Treat query_gen as an Aether-RAG index just like browser/email
    return `${apiBase}/v1/search/index?name=query_generation_events&query=${encodeURIComponent(query)}&top_k=${limit}&mode=${mode}&min_score=${minScore}`;
  } else {
    // Treat as custom index name
    return `${apiBase}/v1/search/index?name=${encodeURIComponent(source)}&query=${encodeURIComponent(query)}&top_k=${limit}&mode=${mode}&min_score=${minScore}`;
  }
};

const buildChatSearchEndpoint = (apiBase: string): string => {
  return `${apiBase}/v1/search/chats`;
};

// Schema definition (research agent pattern)
const schema = z.object({
  query: z.string().describe('Search query'),
  sources: z
    .array(z.string())
    .describe('Sources to search. Can be standard sources (browser, chat, filesystem, email, query_gen) or custom index names (e.g., trec_covid)'),
  mode: z.enum(['bm25', 'semantic', 'hybrid']).describe('Search mode: bm25 (keyword), semantic (meaning-based), or hybrid (RRF fusion)'),
  limit: z.number().optional().describe('Max results per source (default: 8, max: 8)'),
  minScore: z.number().optional().describe('Minimum relevance score threshold between 0.0 and 1.0 (default: 0.0)'),
});

const retrieverAction: ProactiveAction<typeof schema> = {
  name: 'retriever',
  schema: schema,

  getToolDescription: () =>
    'Search local sources (browser, chat, filesystem, email, query_gen) using BM25, semantic, or hybrid mode. Can search multiple sources in one call.',

  getDescription: () => actionDescription,

  enabled: (_) => true,

  execute: async (params, config: ProactiveActionConfig) => {
    const { query, sources, mode } = params;
    const limit = Math.min(params.limit || 8, 8);  // Hard cap at 8 results per source
    const minScore = params.minScore || 0.0;
    const { apiBase, session, proactiveBlockId } = config;

    const results: any[] = [];

    // Emit sub-step for UI
    const subStepId = crypto.randomUUID();
    const block = session.getBlock(proactiveBlockId);
    if (block && block.type === 'research') {
      block.data.subSteps.push({
        id: subStepId,
        type: 'searching',
        searching: [`${query} (sources: ${sources.join(', ')}, mode: ${mode})`],
      });
      session.updateBlock(proactiveBlockId, [
        {
          op: 'replace',
          path: '/data/subSteps',
          value: block.data.subSteps,
        },
      ]);
    }

    try {
      // Search each source via v1 API
      for (const source of sources) {
        // Source-of-truth routing:
        // - daemon logs/search for browser/email/filesystem/query_gen
        // - custom search endpoint for generic index names
        // - dedicated chat search endpoint for chat
        if (source !== 'chat') {
          let endpoint = buildLocalSearchEndpoint(apiBase, source as ProactiveRetrieverSource, query, limit, mode, minScore);
          try {
            let response = await fetch(endpoint, {
              method: 'GET',
              headers: { 'Content-Type': 'application/json' },
            });

            // Handle mode fallback (e.g. semantic -> bm25) if index doesn't support requested mode
            if (response.status === 400 && (mode === 'semantic' || mode === 'hybrid')) {
              try {
                const errorData = await response.clone().json();
                if (errorData.detail && errorData.detail.includes('does not support')) {
                  console.log(`[RetrieverAction] Source ${source} doesn't support ${mode}, falling back to bm25`);
                  endpoint = buildLocalSearchEndpoint(apiBase, source as ProactiveRetrieverSource, query, limit, 'bm25', minScore);
                  response = await fetch(endpoint, {
                    method: 'GET',
                    headers: { 'Content-Type': 'application/json' },
                  });
                }
              } catch (e) {
                // Ignore clone/json parse errors
              }
            }

            if (response.ok) {
              const data = await response.json();
              results.push({
                source,
                results: data.results || [],
                count: data.count || data.total_found || 0,
              });
            } else {
              results.push({
                source,
                results: [],
                count: 0,
                error: `${source} daemon search failed: ${response.status} ${response.statusText}`,
                endpoint,
              });
            }
          } catch (err) {
            results.push({
              source,
              results: [],
              count: 0,
              error: `${source} daemon search error: ${err instanceof Error ? err.message : String(err)}`,
              endpoint,
            });
          }
          continue;
        }

        // Chat history search
        try {
          const endpoint = buildChatSearchEndpoint(apiBase);
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              query,
              limit,
              mode,
            }),
          });

          if (response.ok) {
            const data = await response.json();
            const extractedResults = data.results || data.messages || data.files || [];
            results.push({
              source,
              results: extractedResults,
              count: data.total_results || data.total_found || data.total_count || data.count || extractedResults.length || 0,
            });
          } else {
            results.push({
              source,
              results: [],
              count: 0,
              error: `API error: ${response.status}`,
              endpoint,
            });
          }
        } catch (error: any) {
          results.push({
            source,
            results: [],
            count: 0,
            error: error.message,
            endpoint: buildChatSearchEndpoint(apiBase),
          });
        }
      }

      // Emit search results sub-step
      if (block && block.type === 'research') {
        // Convert results to Chunk format for search_results substep
        const chunks = results.flatMap((sourceResult) =>
          (sourceResult.results || []).map((item: any) => ({
            content: item.content || item.title || item.text || item.chunk_text || '',
            metadata: {
              source: sourceResult.source,
              ...item,
            },
          }))
        );

        block.data.subSteps.push({
          id: crypto.randomUUID(),
          type: 'search_results',
          reading: chunks.slice(0, 20), // Limit to 20 chunks for UI
        });

        session.updateBlock(proactiveBlockId, [
          {
            op: 'replace',
            path: '/data/subSteps',
            value: block.data.subSteps,
          },
        ]);
      }

      return {
        type: 'retriever_results',
        query,
        sources,
        mode,
        results,
        totalHits: results.reduce((sum, r) => sum + r.count, 0),
      };
    } catch (error: any) {
      // Error is returned in result, no substep update needed
      // (SearchingResearchBlock type doesn't support error states)

      return {
        type: 'retriever_results',
        query,
        sources,
        mode,
        results: [],
        totalHits: 0,
        error: error.message,
      };
    }
  },
};

export default retrieverAction;
