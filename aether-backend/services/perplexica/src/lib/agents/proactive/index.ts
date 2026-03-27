/**
 * Proactive Agent Orchestrator
 * 
 * Pattern: Exact match to search/index.ts
 * 1. Call classifier FIRST (decide tools BEFORE loop)
 * 2. Pass classification to Scout (researcher)
 * 3. Pass research findings to Decision agent
 * 
 * @.architecture
 * Incoming: Query Generation Daemon → {queries, context_docs, activity_context}
 * Processing: Classifier → Researcher → Decision
 * Outgoing: Intervention decision + context
 */

import { ProactiveInput, ProactiveOutput } from './types';
import { classify } from './classifier';
import Scout from './scout';
import { decide } from './decision';

class ProactiveAgent {
  /**
   * Main entry point - orchestrate classification and scouting
   * Pattern: search/index.ts lines 54-90
   */
  async scout(input: ProactiveInput): Promise<ProactiveOutput> {
    const { 
      currentActivity, 
      backgroundHistory, 
      config, 
      session 
    } = input;

    // STEP 0.5: Pre-fetch available indexes so Classifier knows what it can query
    let availableIndexesText = undefined;
    try {
      console.log(`[ProactiveAgent] Fetching available indexes for classifier...`);
      const response = await fetch(`${config.apiBase}/v1/sources`);
      if (response.ok) {
        const data = await response.json();
        const indexes = data.indexes || [];
        const sources = data.sources || {};
        
        const customIndexes = indexes.map((idx: any) => {
          const typeStr = idx.source_type ? `[Type: ${idx.source_type}] ` : '';
          const modesStr = idx.supported_modes?.length ? idx.supported_modes.join(', ') : 'unknown';
          return `- ${typeStr}${idx.index_name}: ${idx.description || 'Custom index'} (${idx.chunk_count || 0} chunks, modes: ${modesStr})`;
        }).join('\n');
        
        const standardSources = Object.keys(sources)
          .filter(k => sources[k].enabled)
          .map(k => `- ${k}`)
          .join('\n');
          
        availableIndexesText = `Available Local Search Sources:\n\nStandard Sources:\n${standardSources || 'None'}\n\nCustom Indexes:\n${customIndexes || 'None'}`;
        console.log(`[ProactiveAgent] Loaded ${indexes.length} custom indexes and ${Object.keys(sources).length} standard sources.`);
      }
    } catch (err: any) {
      console.error(`[ProactiveAgent] Failed to fetch available indexes: ${err.message}`);
    }

    // STEP 1: Classify BEFORE agent loop (research agent pattern)
    console.log(`📋 [ProactiveAgent] Classifying context...`);
    const classification = await classify({
      currentActivity,
      backgroundHistory,
      activityContext: {
        current_time: new Date().toISOString(),
      },
      llm: config.llm,
      availableIndexes: availableIndexesText,
    });

    console.log(`✅ [ProactiveAgent] Classification:`, classification.toolDecisions);
    console.log(`   Reasoning: ${classification.reasoning}`);

    const plannedCalls =
      (classification.toolDecisions.retrieverCalls?.length || 0) +
      (classification.toolDecisions.webSearchCalls?.length || 0);
    const toolBudget = classification.toolDecisions.maxToolCalls || 0;

    // STEP 2: Empty tool plan means no research should run; defer at orchestrator.
    if (plannedCalls === 0 || toolBudget === 0) {
      return {
        decision: 'defer',
        context: [],
        reasoning: [classification.reasoning],
        deferReason: 'Classifier returned no executable tool plan.',
        toolBudget,
      };
    }

    // STEP 3: Pass classification to Scout (researcher pattern)
    const scout = new Scout();
    const researchResults = await scout.research(session, {
      queries: input.queries,
      currentActivity,
      backgroundHistory,
      classification: classification,
      config,
      iclExamples: input.iclExamples,
      availableIndexes: availableIndexesText,
    });

    // STEP 4: Final decision layer
    const decisionResult = await decide({
      queries: input.queries,
      currentActivity,
      backgroundHistory,
      research: researchResults,
      llm: config.llm,
    });

    session.emit('data', {
      type: 'proactiveComplete',
    });

    return {
      decision: decisionResult.decision,
      context: researchResults.gatheredContext,
      reasoning: [
        classification.reasoning, 
        ...researchResults.reasoningTrace,
        decisionResult.reasoning
      ].filter(Boolean) as string[],
      recommendation: decisionResult.recommendation,
      supportingDocs: decisionResult.supportingDocs,
      deferReason: decisionResult.deferReason,
      toolBudget,
      executedTools: researchResults.executedTools,
    };
  }
}

export default ProactiveAgent;
