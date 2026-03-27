/**
 * Proactive Agent Scout Endpoint
 * 
 * Phase 2 of DeepPlanning-inspired proactive system.
 * Receives queries from Phase 1 daemon and executes ReAct scouting.
 * 
 * @.architecture
 * Incoming: Backend /v1/proactive/scout --- {queries, sourceDocs, activityContext}
 * Processing: ReAct loop with tools → Decision making --- {JOB_SCOUT, JOB_DECIDE}
 * Outgoing: Backend --- {decision, recommendation, context}
 */

import ModelRegistry from '@/lib/models/registry';
import { ModelWithProvider } from '@/lib/models/types';
import SessionManager from '@/lib/session';
import ProactiveAgent from '@/lib/agents/proactive';
import { ProactiveInput, ActivityContext, SourceDocument } from '@/lib/agents/proactive/types';

interface ProactiveScoutRequestBody {
  queries: string[];
  traceId?: string;
  
  /** CURRENT ACTIVITY: High-priority, time-sensitive logs happening now */
  currentActivity: SourceDocument[];
  
  /** BACKGROUND HISTORY: Low-priority context from recent past */
  backgroundHistory: SourceDocument[];
  
  activityContext?: ActivityContext;
  
  /** Pre-fetched ICL examples from similar past runs */
  iclExamples?: Array<{
    recommendation: string;
    userFeedback: string;
    similarity?: number;
  }>;
  
  config: {
    apiBase: string;
    maxProcessingTimeSeconds?: number;
  };
  chatModel?: ModelWithProvider;
  embeddingModel?: ModelWithProvider;
}

export const POST = async (req: Request) => {
  let traceId = '';
  try {
    const body: ProactiveScoutRequestBody = await req.json();
    traceId = body.traceId || crypto.randomUUID();
    const traceLabel = `[trace:${traceId}]`;
    console.log(`${traceLabel} 🚀 Proactive scout request received`);
    console.log('📦 Request summary:', {
      traceId,
      queryCount: body.queries?.length ?? 0,
      currentActivityCount: body.currentActivity?.length ?? 0,
      backgroundHistoryCount: body.backgroundHistory?.length ?? 0,
      iclExamplesCount: body.iclExamples?.length ?? 0,
      maxProcessingTimeSeconds: body.config?.maxProcessingTimeSeconds,
    });

    if (!body.queries || !body.currentActivity || !body.backgroundHistory || !body.config) {
      console.error('❌ Missing required fields');
      return Response.json(
        {
          message: 'Missing queries, currentActivity, backgroundHistory, or config',
          traceId,
        },
        { status: 400 },
      );
    }
    
    console.log(`📊 Context: ${body.currentActivity.length} current, ${body.backgroundHistory.length} background`);


    // Single registry instance for model discovery + loading
    const registry = new ModelRegistry();

    // Model resolution for proactive agent:
    // 1. Backend SHOULD pass chatModel explicitly (resolved from settings.inference.default_model)
    // 2. Fallback: prefer Qwen3 from the inference registry (main agent model)
    // 3. Last resort: first available non-error model
    //
    // The inference server uses local directory names as model IDs (e.g.
    // 'lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit') which differ from
    // config canonical names. The registry fetches the actual model list from the server.
    let chatModel = body.chatModel;
    let embeddingModel = body.embeddingModel;

    if (!chatModel || !embeddingModel) {
      const activeProviders = await registry.getActiveProviders();
      
      if (!chatModel) {
        // Proactive pipeline REQUIRES the main agent model (Qwen3), not LFM.
        // LFM is too small for nuanced decision-making and reasoning.
        const aiProvider = activeProviders.find(p => p.id === 'aether-inference-default');
        const availableChat = aiProvider?.chatModels?.filter(m => m.key !== 'error') || [];
        
        // Prefer Qwen3 models — they are the designated agent model
        const qwen3Model = availableChat.find(m => 
          m.key.toLowerCase().includes('qwen3') || m.key.toLowerCase().includes('qwen-3')
        );
        const selectedChat = qwen3Model || availableChat[0];
        
        if (qwen3Model) {
          console.log(`🎯 Proactive agent: using Qwen3 model: ${qwen3Model.key}`);
        } else if (selectedChat) {
          console.warn(`⚠️ Proactive agent: Qwen3 not found, falling back to: ${selectedChat.key}`);
        } else {
          console.error('❌ Proactive agent: no chat models available from inference server');
        }
        
        chatModel = {
          providerId: 'aether-inference-default',
          key: selectedChat?.key || '',
        };
      }
      
      if (!embeddingModel) {
        embeddingModel = {
          providerId: 'transformers-default',
          key: 'Xenova/bge-small-en-v1.5',
        };
      }
    }

    // Load models in parallel
    const [llm, embeddings] = await Promise.all([
      registry.loadChatModel(chatModel.providerId, chatModel.key),
      registry.loadEmbeddingModel(
        embeddingModel.providerId,
        embeddingModel.key,
      ),
    ]);

    // Create session for progress tracking
    const session = SessionManager.createSession();

    // Create proactive agent
    const agent = new ProactiveAgent();
    console.log('🤖 Proactive agent created, starting scout...');

    // Build input with split context structure
    const input: ProactiveInput = {
      queries: body.queries,
      currentActivity: body.currentActivity,
      backgroundHistory: body.backgroundHistory,
      iclExamples: body.iclExamples || [],
      config: {
        llm: llm,
        embedding: embeddings,
        apiBase: body.config.apiBase,
        maxProcessingTimeSeconds: body.config.maxProcessingTimeSeconds,
      },
      session: session,
    };

    // Execute agent (non-streaming)
    const result = await agent.scout(input);
    console.log('✅ Scout completed, decision:', result.decision);
    console.log('📊 Stats:', {
      toolCalls: input.session.getAllBlocks().filter((b: any) => b.type === 'research').length,
      contextCount: result.context?.length,
      toolBudget: result.toolBudget ?? 0,
    });

    return Response.json(
      {
        decision: result.decision,
        recommendation: result.recommendation,
        supportingDocs: result.supportingDocs,
        context: result.context,
        reasoning: result.reasoning,
        deferReason: result.deferReason,
        toolBudget: result.toolBudget ?? 0,
        traceId,
        executedTools: result.executedTools,
        
        // Metadata
        llm_model: chatModel.key,
        tool_calls_count: session.getAllBlocks().filter((b: any) => 
          b.type === 'research' && b.data?.subSteps?.length
        ).reduce((sum: number, b: any) => sum + (b.data?.subSteps?.length || 0), 0),
      },
      { status: 200 },
    );
  } catch (error: any) {
    console.error(
      `[trace:${traceId || 'unknown'}] Proactive scout error:`,
      error,
    );
    return Response.json(
      {
        message: error.message || 'Internal server error',
        traceId: traceId || undefined,
      },
      { status: 500 },
    );
  }
};
