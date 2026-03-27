/**
 * Extractive Processing Client
 *
 * Thin HTTP client for the Python backend's DocumentUtility API.
 * Used by search/proactive agents to rank and prune large text
 * or search results before injecting into LLM context.
 *
 * @.architecture
 * Incoming: search agents, proactive agents --- {large text or search results}
 * Processing: HTTP POST to Python backend /v1/utils/* --- {JOB_RANK, JOB_SELECT}
 * Outgoing: caller --- {ranked/pruned text or results within token budget}
 */

// ---------------------------------------------------------------------------
// Backend URL resolution
// ---------------------------------------------------------------------------
// Priority: env var → Docker internal host → localhost
// In Docker: AETHER_BACKEND_URL=http://host.docker.internal:8765
// In dev: defaults to http://127.0.0.1:8765

function getBackendUrl(): string {
  return (
    process.env.AETHER_BACKEND_URL ||
    (process.env.NODE_ENV === 'production'
      ? 'http://host.docker.internal:8765'
      : 'http://127.0.0.1:8765')
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractiveRequest {
  text: string;
  query?: string;
  budget_chars?: number;
  chunk_size?: number;
  chunk_overlap?: number;
  max_chunks?: number;
}

export interface ExtractiveResponse {
  text: string;
  chunks_total: number;
  chunks_selected: number;
  original_chars: number;
  result_chars: number;
  processing_ms: number;
}

export interface RankResultsRequest {
  results: Record<string, any>[];
  query: string;
  budget_chars?: number;
  content_field?: string;
  title_field?: string;
}

export interface RankResultsResponse {
  results: Record<string, any>[];
  total_input: number;
  total_selected: number;
  original_chars: number;
  result_chars: number;
  processing_ms: number;
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

/**
 * Process large text through DocumentUtility's extractive pipeline.
 * Chunks → TF-IDF/TextRank ranking → budget selection with head/tail anchoring.
 *
 * Falls back to naive head truncation if API is unreachable.
 */
export async function extractiveProcess(
  request: ExtractiveRequest,
): Promise<ExtractiveResponse> {
  const url = `${getBackendUrl()}/v1/utils/extractive`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: request.text,
        query: request.query || undefined,
        budget_chars: request.budget_chars ?? 40000,
        chunk_size: request.chunk_size ?? 800,
        chunk_overlap: request.chunk_overlap ?? 150,
        max_chunks: request.max_chunks ?? 50,
      }),
      signal: AbortSignal.timeout(15000), // 15s timeout
    });

    if (!response.ok) {
      throw new Error(`Backend returned ${response.status}: ${response.statusText}`);
    }

    return (await response.json()) as ExtractiveResponse;
  } catch (error) {
    console.warn(
      `[extractive] API call failed (${(error as Error).message}), using fallback truncation`,
    );
    // Fallback: naive head truncation (worst case, still bounded)
    const budget = request.budget_chars ?? 40000;
    const truncated = request.text.substring(0, budget);
    return {
      text: truncated,
      chunks_total: 1,
      chunks_selected: 1,
      original_chars: request.text.length,
      result_chars: truncated.length,
      processing_ms: 0,
    };
  }
}

/**
 * Rank structured search results by query relevance and select
 * top results within character budget.
 *
 * Falls back to taking first N results that fit the budget if API unreachable.
 */
export async function rankResults(
  request: RankResultsRequest,
): Promise<RankResultsResponse> {
  const url = `${getBackendUrl()}/v1/utils/rank-results`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        results: request.results,
        query: request.query,
        budget_chars: request.budget_chars ?? 40000,
        content_field: request.content_field ?? 'content',
        title_field: request.title_field ?? 'title',
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(`Backend returned ${response.status}: ${response.statusText}`);
    }

    return (await response.json()) as RankResultsResponse;
  } catch (error) {
    console.warn(
      `[rankResults] API call failed (${(error as Error).message}), using fallback selection`,
    );
    // Fallback: take first results that fit budget
    const budget = request.budget_chars ?? 40000;
    const contentField = request.content_field ?? 'content';
    const selected: Record<string, any>[] = [];
    let usedChars = 0;

    for (const result of request.results) {
      const content = String(result[contentField] || '');
      if (usedChars + content.length > budget && selected.length > 0) break;
      selected.push(result);
      usedChars += content.length;
    }

    return {
      results: selected,
      total_input: request.results.length,
      total_selected: selected.length,
      original_chars: request.results.reduce(
        (sum, r) => sum + String(r[contentField] || '').length,
        0,
      ),
      result_chars: usedChars,
      processing_ms: 0,
    };
  }
}

/**
 * Convenience: extractive process for a text string, only if it exceeds threshold.
 * Returns original text if under threshold.
 */
export async function extractiveIfNeeded(
  text: string,
  opts: {
    query?: string;
    thresholdChars?: number;
    budgetChars?: number;
  } = {},
): Promise<string> {
  const threshold = opts.thresholdChars ?? 30000;
  if (text.length <= threshold) return text;

  const result = await extractiveProcess({
    text,
    query: opts.query,
    budget_chars: opts.budgetChars ?? 40000,
  });

  return result.text;
}
