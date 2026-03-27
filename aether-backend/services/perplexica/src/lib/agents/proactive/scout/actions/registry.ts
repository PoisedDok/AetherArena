/**
 * Proactive Agent Action Registry
 * 
 * Registers all available tools for the proactive agent:
 * 1. Researcher tools (web_search, scrape_url, academic_search, etc.)
 * 2. Retriever tool (unified local search)
 * 3. Done tool (completion marker)
 */

import { ProactiveAction, ProactiveActionConfig, ActionOutput } from '../../types';
import { Tool, ToolCall } from '@/lib/models/types';
import z from 'zod';

// Import researcher tools (wrapped for proactive compatibility)
import webSearchAction from '../../../search/researcher/actions/webSearch';
import scrapeURLAction from '../../../search/researcher/actions/scrapeURL';
import academicSearchAction from '../../../search/researcher/actions/academicSearch';
import socialSearchAction from '../../../search/researcher/actions/socialSearch';
import legalSearchAction from '../../../search/researcher/actions/legalSearch';
import uploadsSearchAction from '../../../search/researcher/actions/uploadsSearch';
import newsSearchAction from '../../../search/researcher/actions/newsSearch';

// Import proactive-specific tools
import retrieverAction from './retriever';
import doneAction from '../../../search/researcher/actions/done'; // Reuse done tool
import { ResearcherActionWrapper } from './wrappers/ResearcherActionWrapper';

class ProactiveActionRegistry {
  private static actions: Map<string, ProactiveAction<any>> = new Map();

  static {
    // Researcher tools (wrapped for proactive compatibility)
    this.register(new ResearcherActionWrapper(webSearchAction, ['web']));
    this.register(new ResearcherActionWrapper(scrapeURLAction, ['web']));
    this.register(new ResearcherActionWrapper(academicSearchAction, ['academic']));
    this.register(new ResearcherActionWrapper(socialSearchAction, ['discussions']));
    this.register(new ResearcherActionWrapper(legalSearchAction, ['legal']));
    this.register(new ResearcherActionWrapper(uploadsSearchAction, ['web']));
    this.register(new ResearcherActionWrapper(newsSearchAction, ['news']));

    // Proactive-specific tools
    this.register(retrieverAction);
    this.register(doneAction as any);
  }

  static register(action: ProactiveAction<any>) {
    this.actions.set(action.name, action);
  }

  static get(name: string): ProactiveAction<any> | undefined {
    return this.actions.get(name);
  }

  /**
   * Get available tools for LLM (Perplexica Tool format)
   * Pattern: Match search/researcher/actions/registry.ts
   */
  static getAvailableActionTools(options: {
    classification?: any; // ProactiveClassifierOutput
    fileIds?: string[];
  }): Tool[] {
    const tools: Tool[] = [];

    // Filter tools based on classification (if provided)
    for (const action of this.actions.values()) {
      const isEnabled = this.shouldEnableAction(
        action.name,
        options.classification,
      );
        
      if (isEnabled) {
        let augmentedSchema = action.schema;
        if (augmentedSchema instanceof z.ZodObject) {
          augmentedSchema = augmentedSchema.extend({
            reasoning: z.string().describe('Your step-by-step reasoning for taking this action. Keep it brief. You must provide this.'),
          });
        }
        
        tools.push({
          name: action.name,
          description: action.getToolDescription(),
          schema: augmentedSchema,
        });
      }
    }

    return tools;
  }

  /**
   * Decide if action should be enabled based on classification
   * Pattern: Replace __tool_planner with pre-loop classification
   * 
   * Structure: classification = { toolDecisions: { retrieverCalls, webSearchCalls, maxToolCalls }, reasoning }
   */
  private static shouldEnableAction(actionName: string, classification: any): boolean {
    // CRITICAL: Access nested toolDecisions (matches Zod schema structure)
    const decisions = classification?.toolDecisions;
    
    if (!decisions) {
      console.log(`[Registry] WARNING: No toolDecisions in classification, disabling ${actionName}`);
      return actionName === 'done';  // Only 'done' enabled if no decisions
    }

    // Retriever tool - enable if calls planned
    if (actionName === 'retriever') {
      const enabled = decisions.retrieverCalls && decisions.retrieverCalls.length > 0;
      console.log(`[Registry] ${actionName} enabled: ${enabled}, planned calls: ${decisions.retrieverCalls?.length || 0}`);
      return enabled;
    }
    
    // Search tools - enable based on planned search type
    if (decisions.webSearchCalls && decisions.webSearchCalls.length > 0) {
      const searchTypes = decisions.webSearchCalls.map((call: any) => call.type);
      
      if (actionName === 'web_search' && searchTypes.includes('web')) {
        console.log(`[Registry] web_search enabled via planned call`);
        return true;
      }
      if (actionName === 'academic_search' && searchTypes.includes('academic')) {
        return true;
      }
      if (actionName === 'social_search' && searchTypes.includes('social')) {
        return true;
      }
      if (actionName === 'legal_search' && searchTypes.includes('legal')) {
        return true;
      }
      if (actionName === 'news_search' && searchTypes.includes('news')) {
        return true;
      }
      
      // scrape_url - enable if ANY search call has scrapeUrls: true
      if (actionName === 'scrape_url' && decisions.webSearchCalls.some((call: any) => call.scrapeUrls === true)) {
        console.log(`[Registry] scrape_url enabled via planned call with scrapeUrls=true`);
        return true;
      }
    }
    
    // Done tool always enabled
    if (actionName === 'done') {
      return true;
    }
    
    // Default: disabled (strict filtering)
    return false;
  }

  /**
   * Get tool descriptions for system prompt
   * Pattern: EXACT MATCH search/researcher/actions/registry.ts
   */
  static getAvailableActionsDescriptions(options: {
    classification?: any;
    fileIds?: string[];
  }): string {
    const availableActions: ProactiveAction<any>[] = [];

    for (const action of this.actions.values()) {
      const isEnabled = this.shouldEnableAction(
        action.name,
        options.classification,
      );
        
      if (isEnabled) {
        availableActions.push(action);
      }
    }

    return availableActions
      .map(
        (action) =>
          `<tool name="${action.name}">\n${action.getDescription()}\n</tool>`,
      )
      .join('\n\n');
  }

  /**
   * Execute all tool calls in parallel (DeepPlanning Pattern - 10x efficiency)
   */
  static async executeAll(
    toolCalls: ToolCall[],
    config: ProactiveActionConfig,
  ): Promise<ActionOutput[]> {
    // Execute all tools in parallel (DeepPlanning key finding)
    const results = await Promise.all(
      toolCalls.map(async (tc) => {
        const action = this.get(tc.name);
        if (!action) {
          return {
            type: 'error',
            message: `Unknown action: ${tc.name}`,
          };
        }

        try {
          return await action.execute(tc.arguments, config);
        } catch (error: any) {
          return {
            type: 'error',
            action: tc.name,
            message: error.message,
          };
        }
      }),
    );

    return results;
  }
}

export default ProactiveActionRegistry;
