import { ProactiveAction, ProactiveActionConfig, ActionOutput } from '../../../types';
import { ResearchAction, ClassifierOutput, SearchSources } from '../../../../search/types';

/**
 * Robust wrapper for Researcher Actions (from standard Search Agent)
 * to make them compatible with the Proactive Agent's tool calling protocol.
 * 
 * This ensures clean separation of concerns and prevents "includes of undefined" errors
 * by providing the necessary execution context and default configurations.
 * 
 * @.architecture
 * Pattern: Adapter/Wrapper
 * Responsibility: Map ProactiveAgent context to SearchAgent context for tool reuse.
 */
export class ResearcherActionWrapper implements ProactiveAction<any> {
  private action: ResearchAction<any>;
  private sources: SearchSources[];

  constructor(action: ResearchAction<any>, sources: SearchSources[] = ['web']) {
    this.action = action;
    this.sources = sources;
  }

  get name() {
    return this.action.name;
  }

  get schema() {
    return this.action.schema;
  }

  getToolDescription() {
    // Proactive agent typically operates in a balanced/thorough mode
    return this.action.getToolDescription({ mode: 'balanced' });
  }

  getDescription() {
    return this.action.getDescription({ mode: 'balanced' });
  }

  /**
   * Safe enabled check that provides all required fields for standard researcher actions
   */
  enabled(config: any): boolean {
    const mappedClassification = this.mapProactiveClassificationToSearch(
      config?.classification,
    );
    if (!mappedClassification) {
      console.warn(
        `[ProactiveAgent] Missing classifier output for "${this.name}". Tool disabled by default.`,
      );
      return false;
    }

    try {
      return this.action.enabled({
        classification: mappedClassification,
        fileIds: config.fileIds || [],
        mode: (config.mode as any) || 'balanced',
        sources: this.sources,
      });
    } catch (error) {
      console.error(`Error checking enabled status for ${this.name}:`, error);
      return false;
    }
  }

  private mapProactiveClassificationToSearch(
    classification: any,
  ): ClassifierOutput | null {
    const toolDecisions = classification?.toolDecisions;
    if (!toolDecisions) {
      return null;
    }

    const webSearchCalls = Array.isArray(toolDecisions.webSearchCalls)
      ? toolDecisions.webSearchCalls
      : [];
    const retrieverCalls = Array.isArray(toolDecisions.retrieverCalls)
      ? toolDecisions.retrieverCalls
      : [];

    const intentSources: SearchSources[] = [];
    if (webSearchCalls.some((call: any) => call?.type === 'web')) {
      intentSources.push('web');
    }
    if (webSearchCalls.some((call: any) => call?.type === 'academic')) {
      intentSources.push('academic');
    }
    if (webSearchCalls.some((call: any) => call?.type === 'social')) {
      intentSources.push('discussions');
    }
    if (webSearchCalls.some((call: any) => call?.type === 'legal')) {
      intentSources.push('legal');
    }

    const queryCandidates = webSearchCalls.flatMap((call: any) =>
      Array.isArray(call?.queries) ? call.queries : [],
    );
    const fallbackRetrieverQueries = retrieverCalls.map((call: any) => call?.query);
    const searchQueries = (queryCandidates.length > 0
      ? queryCandidates
      : fallbackRetrieverQueries
    )
      .filter((value: unknown): value is string => typeof value === 'string')
      .map((value: string) => value.trim())
      .filter(Boolean);

    return {
      classification: {
        skipSearch: intentSources.length === 0,
        personalSearch: false,
        academicSearch: intentSources.includes('academic'),
        discussionSearch: intentSources.includes('discussions'),
        legalSearch: intentSources.includes('legal'),
        showWeatherWidget: false,
        showStockWidget: false,
        showCalculationWidget: false,
      },
      standaloneFollowUp: '',
      intentSources,
      searchQueries,
    };
  }

  /**
   * Network error signatures that indicate service unavailability (not bugs).
   * When matched, return a structured service_unavailable response instead of
   * throwing — this preserves iteration budget and lets the scout LLM know
   * not to retry this tool category.
   */
  private static readonly NETWORK_ERROR_PATTERNS = [
    'ECONNREFUSED',
    'ENOTFOUND',
    'ERR_NETWORK',
    'fetch failed',
    'ETIMEDOUT',
    'ECONNRESET',
    'network',
    'socket hang up',
    'getaddrinfo',
  ];

  /**
   * Determine the tool category for deterministic blocking.
   * When a tool in category 'web' fails, the scout can block all web tools.
   */
  private getCategory(): string {
    // ResearchAction names are snake_case (e.g., web_search, scrape_url).
    // Keep legacy camelCase aliases to avoid silent misclassification.
    const webTools = new Set([
      'web_search',
      'scrape_url',
      'academic_search',
      'social_search',
      'legal_search',
      'webSearch',
      'scrapeURL',
      'academicSearch',
      'redditSearch',
      'youtubeSearch',
      'legalSearch',
      'newsSearch',
    ]);
    if (webTools.has(this.action.name)) return 'web';
    return 'local';
  }

  private static isNetworkError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return ResearcherActionWrapper.NETWORK_ERROR_PATTERNS.some(
      pattern => message.toLowerCase().includes(pattern.toLowerCase())
    );
  }

  /**
   * Execute with context mapping and graceful network failure handling.
   *
   * Network errors (offline, service down) return a structured service_unavailable
   * response — NOT an error. This lets the scout LLM reason about the failure and
   * avoid retrying tools in the same category, preserving iteration budget.
   * Non-network errors (bugs) still throw.
   */
  async execute(params: any, config: ProactiveActionConfig): Promise<ActionOutput> {
    const additionalConfig = {
      llm: config.llm,
      embedding: config.embedding,
      session: config.session,
      researchBlockId: config.proactiveBlockId,
      fileIds: [],
    };

    try {
      return await (this.action.execute(params, additionalConfig) as Promise<ActionOutput>);
    } catch (error) {
      if (ResearcherActionWrapper.isNetworkError(error)) {
        const category = this.getCategory();
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(
          `[ProactiveAgent] Tool "${this.action.name}" (category: ${category}) ` +
          `returned service_unavailable: ${reason}`
        );
        return {
          type: 'service_unavailable',
          tool: this.action.name,
          category,
          reason: `Service unavailable: ${reason}`,
          instruction: `The "${category}" category tools are currently unreachable. ` +
            `Do NOT retry any ${category}-category tools for this run. ` +
            `Focus on available local tools or produce results from data already gathered.`,
        };
      }
      throw error;
    }
  }
}
