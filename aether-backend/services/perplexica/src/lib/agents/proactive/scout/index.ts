/**
 * Proactive Scout - Researcher Loop Executor
 *
 * Pattern: Matches search/researcher/index.ts
 * Receives classifier tool plan, runs bounded ReAct research loop.
 */

import {
  ProactiveClassifierOutput,
  ResearchOutput,
  ActionOutput,
  ActivityContext,
  GatheredContext,
} from '../types';
import ProactiveActionRegistry from './actions/registry';
import { getProactiveScoutPrompt } from '@/lib/prompts/proactive/scout';
import SessionManager from '@/lib/session';
import { Message, ReasoningResearchBlock } from '@/lib/types';
import { ToolCall } from '@/lib/models/types';

export interface ScoutInput {
  queries: string[];
  currentActivity: any[];
  backgroundHistory: any[];
  activityContext?: ActivityContext;
  classification: ProactiveClassifierOutput;
  config: any;
  iclExamples?: any[];
  availableIndexes?: string;
}

class Scout {
  async research(
    session: SessionManager,
    input: ScoutInput,
  ): Promise<ResearchOutput> {
    const actionOutput: ActionOutput[] = [];
    const toolBudgetsByName = this.buildToolBudgets(input.classification);
    const maxToolCalls = this.resolveClassifierToolBudget(
      input.classification,
      toolBudgetsByName,
    );
    const maxLoopIterations = this.calculateLoopIterations(maxToolCalls);
    let consecutiveNoProgressIterations = 0;
    let consecutiveFailureIterations = 0;

    const toolCallCounts = new Map<string, number>();
    let totalToolCalls = 0;
    const executedToolSignatures = new Set<string>();

    const availableTools = ProactiveActionRegistry.getAvailableActionTools({
      classification: input.classification,
    });

    console.log(
      `🔧 [Scout] Available tools: ${availableTools.map((t) => t.name).join(', ')}`,
    );
    console.log(
      `📋 [Scout] Classification: retrieverCalls=${input.classification.toolDecisions.retrieverCalls.length}, webSearchCalls=${input.classification.toolDecisions.webSearchCalls.length}, maxToolCalls=${maxToolCalls}`,
    );
    console.log(
      `[Scout] Tool budgets by name: ${JSON.stringify(Object.fromEntries(toolBudgetsByName.entries()))}`,
    );

    const availableActionsDescription =
      ProactiveActionRegistry.getAvailableActionsDescriptions({
        classification: input.classification,
      });

    const proactiveBlockId = crypto.randomUUID();

    session.emitBlock({
      id: proactiveBlockId,
      type: 'research',
      data: {
        subSteps: [],
      },
    });

    const userMessage = this.formatProactiveInput(
      input.queries,
      input.currentActivity,
      input.backgroundHistory,
    );

    const agentMessageHistory: Message[] = [
      {
        role: 'user',
        content: userMessage,
      },
    ];

    const reasoningTrace: string[] = [];
    const iclExamples = input.iclExamples || [];

    if (iclExamples.length > 0) {
      console.log(`💡 [Scout] Received ${iclExamples.length} ICL examples`);
    }

    if (maxToolCalls === 0) {
      console.log('[Scout] Classifier produced zero tool budget; returning empty research output');
      return {
        findings: [],
        reasoningTrace,
        gatheredContext: [],
      };
    }

    for (let i = 0; i < maxLoopIterations; i++) {
      console.log(`\n🔄 [Scout] ReAct Iteration ${i + 1}/${maxLoopIterations}`);

      const prompt = getProactiveScoutPrompt(
        availableActionsDescription,
        {
          retrieverCalls: input.classification?.toolDecisions?.retrieverCalls || [],
          webSearchCalls: input.classification?.toolDecisions?.webSearchCalls || [],
          reasoning: input.classification?.reasoning || 'No reasoning provided',
        },
        i,
        maxLoopIterations,
        iclExamples.length > 0 ? iclExamples : undefined,
        input.availableIndexes,
      );

      const actionStream = input.config.llm.streamText({
        messages: [
          {
            role: 'system',
            content: prompt,
          },
          ...agentMessageHistory,
        ],
        tools: availableTools,
      });

      const block = session.getBlock(proactiveBlockId);
      const finalToolCalls: ToolCall[] = [];
      const reasoningEmittedForTool = new Set<string>();

      for await (const partialRes of actionStream) {
        if (partialRes.contentChunk) {
          console.log(`[Scout] LLM Text Delta: ${partialRes.contentChunk}`);
        }
        if (partialRes.toolCallChunk.length > 0) {
          partialRes.toolCallChunk.forEach((tc: ToolCall) => {
            // Extract reasoning parameter if available
            if (tc.arguments && tc.arguments.reasoning && block && block.type === 'research') {
              const reasoningStr = tc.arguments.reasoning;
              const subStepId = `reasoning-${tc.id}`;
              
              if (!reasoningEmittedForTool.has(tc.id)) {
                reasoningEmittedForTool.add(tc.id);
                block.data.subSteps.push({
                  id: subStepId,
                  type: 'reasoning',
                  reasoning: reasoningStr,
                });
                reasoningTrace.push(reasoningStr);
                session.updateBlock(proactiveBlockId, [
                  {
                    op: 'replace',
                    path: '/data/subSteps',
                    value: block.data.subSteps,
                  },
                ]);
              } else {
                const subStepIndex = block.data.subSteps.findIndex((step: any) => step.id === subStepId);
                if (subStepIndex !== -1) {
                  const subStep = block.data.subSteps[subStepIndex] as ReasoningResearchBlock;
                  if (subStep.reasoning !== reasoningStr) {
                    subStep.reasoning = reasoningStr;
                    reasoningTrace[reasoningTrace.length - 1] = reasoningStr; // Approximate update
                    session.updateBlock(proactiveBlockId, [
                      {
                        op: 'replace',
                        path: '/data/subSteps',
                        value: block.data.subSteps,
                      },
                    ]);
                  }
                }
              }
            }

            const existingIndex = finalToolCalls.findIndex((ftc) => ftc.id === tc.id);
            if (existingIndex !== -1) {
              finalToolCalls[existingIndex].arguments = tc.arguments;
            } else {
              finalToolCalls.push(tc);
            }
          });
        }
      }

      console.log(`[Scout] Iteration ${i + 1} finalToolCalls:`, finalToolCalls.map(t => t.name));

      if (finalToolCalls.length === 0) {
        consecutiveNoProgressIterations += 1;
        break;
      }

      if (finalToolCalls.some((tc) => tc.name === 'done')) {
        break;
      }

      agentMessageHistory.push({
        role: 'assistant',
        content: '',
        tool_calls: finalToolCalls,
      });

      const allowedToolCalls: ToolCall[] = [];
      const syntheticFeedbackMessages: any[] = [];
      
      for (const tc of finalToolCalls) {
        if (tc.name === 'done') {
          allowedToolCalls.push(tc);
          continue;
        }

        const isActualTool = true;
        if (isActualTool && !toolBudgetsByName.has(tc.name)) {
          console.log(`[Scout] Tool "${tc.name}" blocked: not approved by classifier`);
          syntheticFeedbackMessages.push({
            role: 'tool',
            id: tc.id,
            name: tc.name,
            content: JSON.stringify({
              type: 'error',
              error: `Tool "${tc.name}" blocked by classifier budget. Choose an approved tool from the <classifier_strategy> list.`
            })
          });
          continue;
        }

        if (isActualTool && totalToolCalls >= maxToolCalls) {
          syntheticFeedbackMessages.push({
            role: 'tool',
            id: tc.id,
            name: tc.name,
            content: JSON.stringify({
              type: 'error',
              error: `Global tool budget of ${maxToolCalls} exceeded. Call 'done' to finish.`
            })
          });
          break;
        }

        const currentCount = toolCallCounts.get(tc.name) || 0;
        const toolBudget = toolBudgetsByName.get(tc.name) || 0;
        if (isActualTool && currentCount >= toolBudget) {
          console.log(
            `[Scout] Tool "${tc.name}" blocked: budget exhausted (${currentCount}/${toolBudget})`,
          );
          syntheticFeedbackMessages.push({
            role: 'tool',
            id: tc.id,
            name: tc.name,
            content: JSON.stringify({
              type: 'error',
              error: `Budget for tool "${tc.name}" exhausted (${toolBudget} calls max). Choose a different approved tool or call 'done'.`
            })
          });
          continue;
        }

        const toolSignature = `${tc.name}:${JSON.stringify(tc.arguments)}`;
        if (executedToolSignatures.has(toolSignature)) {
          syntheticFeedbackMessages.push({
            role: 'tool',
            id: tc.id,
            name: tc.name,
            content: JSON.stringify({
              type: 'error',
              error: `Duplicate tool call detected. You already called "${tc.name}" with these exact arguments. Try a different strategy or call 'done'.`
            })
          });
          continue;
        }

        allowedToolCalls.push(tc);
        toolCallCounts.set(tc.name, currentCount + 1);
        if (isActualTool) {
          totalToolCalls += 1;
        }
        executedToolSignatures.add(toolSignature);
      }

      if (allowedToolCalls.length === 0) {
        if (syntheticFeedbackMessages.length > 0) {
          agentMessageHistory.push(...syntheticFeedbackMessages);
          consecutiveFailureIterations += 1;
        } else {
          consecutiveNoProgressIterations += 1;
        }
        break;
      }
      
      // If we have mixed valid and invalid tools, push the synthetic feedback for the invalid ones
      if (syntheticFeedbackMessages.length > 0) {
        agentMessageHistory.push(...syntheticFeedbackMessages);
        consecutiveFailureIterations += 1;
      }

      const executableToolCalls = allowedToolCalls.filter(
        (tool) => tool.name !== 'done',
      );

      if (allowedToolCalls.length === 0) {
        consecutiveNoProgressIterations += 1;
        break;
      }

      const actionCountBeforeIteration = actionOutput.length;
      const actionResults = await ProactiveActionRegistry.executeAll(
        allowedToolCalls,
        {
          llm: input.config.llm,
          embedding: input.config.embedding,
          session,
          proactiveBlockId,
          apiBase: input.config.apiBase,
        },
      );

      actionOutput.push(...actionResults.filter((r) => r.type !== 'reasoning'));

      const executableResultCount = actionResults.filter((_, idx) => {
        const toolName = allowedToolCalls[idx]?.name;
        return !!toolName && toolName !== 'done';
      }).length;

      const failedExecutableResultCount = actionResults.filter((action, idx) => {
        const toolName = allowedToolCalls[idx]?.name;
        if (!toolName || toolName === 'done') {
          return false;
        }
        return this.isActionFailure(action);
      }).length;

      const producedNewFindings = actionOutput.length > actionCountBeforeIteration;
      if (!producedNewFindings) {
        consecutiveNoProgressIterations += 1;
      } else {
        consecutiveNoProgressIterations = 0;
      }

      if (executableResultCount > 0 && failedExecutableResultCount >= executableResultCount) {
        consecutiveFailureIterations += 1;
      } else if (executableResultCount > 0) {
        consecutiveFailureIterations = 0;
      }

      actionResults.forEach((action, idx) => {
        const toolCall = allowedToolCalls[idx];
        if (!toolCall) return;
        agentMessageHistory.push({
          role: 'tool',
          id: toolCall.id,
          name: toolCall.name,
          content: JSON.stringify(action),
        });
      });

      const HISTORY_BUDGET_CHARS = 50000;
      const totalHistoryChars = agentMessageHistory.reduce(
        (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0),
        0,
      );

      if (totalHistoryChars > HISTORY_BUDGET_CHARS) {
        const { extractiveProcess } = await import('@/lib/utils/extractive');
        const toolMessageIndices: number[] = [];
        for (let j = 0; j < agentMessageHistory.length; j++) {
          if (agentMessageHistory[j].role === 'tool') {
            toolMessageIndices.push(j);
          }
        }
        const toPrune = toolMessageIndices.slice(
          0,
          Math.max(0, toolMessageIndices.length - 2),
        );
        if (toPrune.length > 0) {
          await Promise.all(
            toPrune.map(async (idx) => {
              const msg = agentMessageHistory[idx];
              const content = typeof msg.content === 'string' ? msg.content : '';
              if (content.length <= 2000) return;
              try {
                const pruned = await extractiveProcess({
                  text: content,
                  budget_chars: 2000,
                  chunk_size: 400,
                  chunk_overlap: 50,
                  max_chunks: 10,
                });
                msg.content = pruned.text;
              } catch {
                msg.content =
                  content.substring(0, 2000) +
                  '\n[... truncated for context window ...]';
              }
            }),
          );
        }
      }

      if (consecutiveNoProgressIterations >= 2) {
        break;
      }

      if (consecutiveFailureIterations >= 2) {
        break;
      }

      if (totalToolCalls >= maxToolCalls) {
        break;
      }
    }

    const toolsArr = Array.from(executedToolSignatures);
    console.log('📝 [Scout] executedTools to return:', toolsArr);

    return {
      findings: actionOutput,
      reasoningTrace,
      gatheredContext: this.buildGatheredContext(actionOutput),
      executedTools: toolsArr,
    };
  }

  private formatProactiveInput(
    queries: string[],
    currentActivity: any[],
    backgroundHistory: any[],
  ): string {
    const queryText = queries.map((q, i) => `${i + 1}. ${q}`).join('\n');

    const formatDocs = (docs: any[]) =>
      docs
        .map((doc, i) => {
          const timestamp = doc.timestamp || doc.metadata?.timestamp || 'No timestamp';
          const source = doc.source || doc.metadata?.source || 'unknown';
          const title =
            doc.metadata?.file_name || doc.metadata?.title || doc.metadata?.subject || 'Unknown';

          let content = '';
          if (doc.content) {
            content = `\n   Content: ${doc.content}`;
          } else if (doc.metadata?.body_preview) {
            content = `\n   Body: ${doc.metadata.body_preview}`;
          } else if (
            doc.metadata?.url &&
            !doc.metadata?.title?.includes(doc.metadata.url)
          ) {
            content = `\n   URL: ${doc.metadata.url}`;
          }

          const sender = doc.metadata?.sender ? `\n   From: ${doc.metadata.sender}` : '';

          let behavioral = '';
          if (source === 'browser' && doc.metadata) {
            const visitCount = doc.metadata.visit_count || 1;
            const typedCount = doc.metadata.typed_count || 0;

            let importance = '';
            if (typedCount > 5) {
              importance = ' [FREQUENTLY TYPED - HIGH IMPORTANCE]';
            } else if (visitCount > 20) {
              importance = ' [REPEATEDLY VISITED]';
            } else if (typedCount > 0) {
              importance = ' [DIRECTLY NAVIGATED]';
            }

            if (importance || visitCount > 1 || typedCount > 0) {
              behavioral = `\n   Usage: visited ${visitCount}x, typed ${typedCount}x${importance}`;
            }
          }

          return `${i + 1}. [${source}] ${title}\n   Timestamp: ${timestamp}${sender}${content}${behavioral}`;
        })
        .join('\n');

    const currentText =
      currentActivity.length > 0
        ? formatDocs(currentActivity)
        : 'No current activity detected';

    const backgroundText =
      backgroundHistory.length > 0
        ? formatDocs(backgroundHistory)
        : 'No background history available';

    return `
<proactive_context>

<generated_queries>
${queryText}
</generated_queries>

<current_activity priority="HIGH">
${currentText}
</current_activity>

<background_history priority="LOW">
${backgroundText}
</background_history>

</proactive_context>

Your task: gather relevant evidence using tools and return findings only.
`;
  }

  private buildGatheredContext(actionOutput: ActionOutput[]): GatheredContext[] {
    return actionOutput
      .filter((a) => a.type === 'retriever_results' || a.type === 'search_results')
      .map((a: any) => ({
        source: a.query || a.type || 'unknown',
        results: a.results || [],
        relevance:
          typeof a.relevance === 'number'
            ? a.relevance
            : typeof a.score === 'number'
              ? a.score
              : 0.5,
      }));
  }

  private buildToolBudgets(
    classification: ProactiveClassifierOutput,
  ): Map<string, number> {
    const budgets = new Map<string, number>();
    const decisions = classification?.toolDecisions;

    if (!decisions) {
      return budgets;
    }

    const increment = (toolName: string, count = 1) => {
      if (!Number.isFinite(count) || count <= 0) return;
      budgets.set(toolName, (budgets.get(toolName) || 0) + count);
    };

    if (decisions.retrieverCalls && decisions.retrieverCalls.length > 0) {
      increment('retriever', decisions.retrieverCalls.length);
    }

    for (const plannedCall of decisions.webSearchCalls || []) {
      if (plannedCall.type === 'web') {
        increment('web_search');
      } else if (plannedCall.type === 'academic') {
        increment('academic_search');
      } else if (plannedCall.type === 'social') {
        increment('social_search');
      } else if (plannedCall.type === 'legal') {
        increment('legal_search');
      }

      if (plannedCall.scrapeUrls === true) {
        increment('scrape_url');
      }
    }

    return budgets;
  }

  private resolveClassifierToolBudget(
    classification: ProactiveClassifierOutput,
    toolBudgetsByName: Map<string, number>,
  ): number {
    const requestedBudget = Number(
      classification?.toolDecisions?.maxToolCalls,
    );
    const classifierBudget =
      Number.isFinite(requestedBudget) && requestedBudget > 0
        ? Math.floor(requestedBudget)
        : 0;
    const plannedBudget = [...toolBudgetsByName.values()].reduce(
      (sum, count) => sum + count,
      0,
    );

    if (classifierBudget === 0 || plannedBudget === 0) {
      return 0;
    }

    return Math.min(classifierBudget, plannedBudget);
  }

  private calculateLoopIterations(maxToolCalls: number): number {
    if (maxToolCalls <= 0) return 0;
    return Math.max(1, maxToolCalls + 2);
  }

  private isActionFailure(action: ActionOutput): boolean {
    if ((action as any).type === 'service_unavailable') {
      return true;
    }
    if (typeof (action as any).error === 'string' && (action as any).error.trim()) {
      return true;
    }
    if ((action as any).type === 'retriever_results') {
      const sourceResults = Array.isArray((action as any).results)
        ? (action as any).results
        : [];
      if (sourceResults.length === 0) {
        return true;
      }
      const hasHits = sourceResults.some((result: any) => (result?.count || 0) > 0);
      const allErrored = sourceResults.every((result: any) => !!result?.error);
      return !hasHits && allErrored;
    }
    return false;
  }
}

export default Scout;
