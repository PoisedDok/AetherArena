/**
 * Proactive Agent Types
 * 
 * @.architecture
 * Incoming: Query Generation Daemon → {queries: string[], context_docs: Document[]}
 * Processing: ReAct loop → {scout tools, gather context, make intervention decision}
 * Outgoing: Proactive Index DB + User Notification → {decision, recommendation, context}
 */

import z from 'zod';  // Required for z.infer in ProactiveAction interface
import BaseLLM from '@/lib/models/base/llm';
import BaseEmbedding from '@/lib/models/base/embedding';
import SessionManager from '@/lib/session';
import type { ProactiveRetrieverSource } from './constants';

/**
 * Input from Phase 1 Query Generation Daemon + Phase 4 ICL Examples
 */
export interface ProactiveInput {
  /** Generated queries from Phase 1 */
  queries: string[];
  
  /** CURRENT ACTIVITY: Logs happening RIGHT NOW (HIGH PRIORITY) */
  currentActivity: SourceDocument[];
  
  /** BACKGROUND HISTORY: Recent past logs that might provide context (LOW PRIORITY) */
  backgroundHistory: SourceDocument[];
  
  /** User activity context (optional — Perplexica creates its own for classifier) */
  activityContext?: ActivityContext;
  
  /** Agent configuration */
  config: ProactiveConfig;
  
  /** Session for streaming progress */
  session: SessionManager;
  
  /** Pre-fetched In-Context Learning examples from similar past runs (Phase 4) */
  iclExamples?: Array<{
    recommendation: string;
    userFeedback: string;
    similarity?: number;
    daysAgo?: number;
  }>;
}

/**
 * Source document from daemon logs
 */
export interface SourceDocument {
  source: ProactiveRetrieverSource | 'active_windows';
  timestamp: string;
  content?: string;
  metadata: Record<string, any>;
}

/**
 * User activity context for decision-making
 * DEPRECATED: No real implementation. Reserved for future use.
 */
export interface ActivityContext {
  [key: string]: any;  // Flexible for future expansion
}

/**
 * Agent configuration
 */
export interface ProactiveConfig {
  /** LLM for ReAct loop */
  llm: BaseLLM<any>;
  
  /** Embedding model for semantic search */
  embedding: BaseEmbedding<any>;
  
  /** Backend API base URL */
  apiBase: string;

  /** Upper bound for scout runtime budget (seconds) */
  maxProcessingTimeSeconds?: number;
}

/**
 * Output from Proactive Agent
 */
export interface ProactiveOutput {
  /** Agent decision */
  decision: 'intervene' | 'defer';
  
  /** Gathered context */
  context: GatheredContext[];
  
  /** Agent reasoning trace */
  reasoning: string[];
  
  /** Recommendation for user (if intervene) */
  recommendation?: string;
  
  /** Supporting documents */
  supportingDocs?: any[];
  
  /** Structured reason for defer (Phase 4 ICL transparency) */
  deferReason?: string;

  /** Tool budget approved by classifier for this run */
  toolBudget?: number;

  /** Tools executed during the research phase */
  executedTools?: any[];
}

/**
 * Context gathered by agent from tools
 */
export interface GatheredContext {
  source: string;
  results: any[];
  relevance: number;
}

/**
 * Action output from tool execution
 */
export interface ActionOutput {
  type: string;
  [key: string]: any;
}

/**
 * Proactive action interface
 * Pattern from ResearchAction (search/types.ts line 103-123)
 */
export interface ProactiveAction<
  TSchema extends z.ZodObject<any> = z.ZodObject<any>,
> {
  name: string;
  schema: z.ZodObject<any>;
  getToolDescription: () => string;
  getDescription: () => string;
  enabled: (config: any) => boolean;
  execute: (
    params: z.infer<TSchema>,  // KEY FIX: Use z.infer like research agent
    config: ProactiveActionConfig,
  ) => Promise<ActionOutput>;
}

/**
 * Action execution context
 */
export interface ProactiveActionConfig {
  llm: BaseLLM<any>;
  embedding: BaseEmbedding<any>;
  session: SessionManager;
  proactiveBlockId: string;
  apiBase: string;
}

/**
 * Classifier input (called BEFORE scout loop)
 */
export interface ProactiveClassifierInput {
  currentActivity: SourceDocument[];
  backgroundHistory: SourceDocument[];
  activityContext: {
    current_time: string;  // Only field actually used
  };
  llm: BaseLLM<any>;
  availableIndexes?: string;
}

/**
 * Classifier output (passed TO scout)
 * NEW: Classifier selects tools AND their parameters
 */
export interface ProactiveClassifierOutput {
  toolDecisions: {
    retrieverCalls: Array<{
      query: string;
      sources: Array<ProactiveRetrieverSource>;
      mode: 'bm25' | 'semantic' | 'hybrid';
    }>;
    webSearchCalls: Array<{
      type: 'web' | 'news' | 'academic' | 'social' | 'legal';
      queries: string[];  // Max 3 queries per call
      scrapeUrls: boolean;  // Whether to enable URL scraping for this search
    }>;  // Empty array if not needed
    maxToolCalls: number;  // Budget hard cap: 4 (2 retriever + 2 web)
  };
  reasoning: string;
}

/**
 * Research output from Scout layer.
 * Pure evidence gathering; no decision semantics.
 */
export interface ResearchOutput {
  findings: ActionOutput[];
  reasoningTrace: string[];
  gatheredContext: GatheredContext[];
  executedTools?: any[];
}

/**
 * Decision output from Decision Agent layer.
 */
export interface DecisionOutput {
  decision: 'intervene' | 'defer';
  recommendation?: string;
  supportingDocs?: any[];
  deferReason?: string;
  reasoning?: string;
  executedTools?: any[];
}
