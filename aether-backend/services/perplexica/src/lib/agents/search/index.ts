import { ResearcherOutput, SearchAgentInput } from './types';
import SessionManager from '@/lib/session';
import { classify } from './classifier';
import Researcher from './researcher';
import { getWriterPrompt } from '@/lib/prompts/search/writer';
import { WidgetExecutor } from './widgets';
import { rankResults } from '@/lib/utils/extractive';
import db from '@/lib/db';
import { chats, messages } from '@/lib/db/schema';
import { and, eq, gt } from 'drizzle-orm';
import { TextBlock } from '@/lib/types';

class SearchAgent {
  async searchAsync(session: SessionManager, input: SearchAgentInput) {
    const exists = await db.query.messages.findFirst({
      where: and(
        eq(messages.chatId, input.chatId),
        eq(messages.messageId, input.messageId),
      ),
    });

    if (!exists) {
      await db.insert(messages).values({
        chatId: input.chatId,
        messageId: input.messageId,
        backendId: session.id,
        query: input.followUp,
        createdAt: new Date().toISOString(),
        status: 'answering',
        responseBlocks: [],
      });
    } else {
      await db
        .delete(messages)
        .where(
          and(eq(messages.chatId, input.chatId), gt(messages.id, exists.id)),
        )
        .execute();
      await db
        .update(messages)
        .set({
          status: 'answering',
          backendId: session.id,
          responseBlocks: [],
        })
        .where(
          and(
            eq(messages.chatId, input.chatId),
            eq(messages.messageId, input.messageId),
          ),
        )
        .execute();
    }

    const classification = await classify({
      chatHistory: input.chatHistory,
      enabledSources: input.config.sources,
      query: input.followUp,
      llm: input.config.llm,
    });

    const widgetPromise = WidgetExecutor.executeAll({
      classification,
      chatHistory: input.chatHistory,
      followUp: input.followUp,
      llm: input.config.llm,
    }).then((widgetOutputs) => {
      widgetOutputs.forEach((o) => {
        session.emitBlock({
          id: crypto.randomUUID(),
          type: 'widget',
          data: {
            widgetType: o.type,
            params: o.data,
          },
        });
      });
      return widgetOutputs;
    });

    let searchPromise: Promise<ResearcherOutput> | null = null;

    if (!classification.classification.skipSearch) {
      const researcher = new Researcher();
      searchPromise = researcher.research(session, {
        chatHistory: input.chatHistory,
        followUp: input.followUp,
        classification: classification,
        config: input.config,
      });
    }

    const [widgetOutputs, searchResults] = await Promise.all([
      widgetPromise,
      searchPromise,
    ]);

    session.emit('data', {
      type: 'researchComplete',
    });

    // ---------------------------------------------------------------------------
    // Context budget control: rank search findings by query relevance and
    // select top results within ~80k chars (~20k tokens) via DocumentUtility API.
    // In quality mode, the researcher can produce 100+ findings (300-600KB).
    // Without this, the writer LLM context explodes.
    // ---------------------------------------------------------------------------
    let findings = searchResults?.searchFindings || [];

    const rawContextChars = findings.reduce((sum, f) => sum + (f.content?.length || 0), 0);
    const CONTEXT_BUDGET_CHARS = 80000;

    if (rawContextChars > CONTEXT_BUDGET_CHARS && findings.length > 0) {
      console.log(
        `[SearchAgent] Raw context ${rawContextChars} chars (${findings.length} findings) exceeds budget ${CONTEXT_BUDGET_CHARS}, ranking via DocumentUtility API...`,
      );

      try {
        const ranked = await rankResults({
          results: findings.map((f) => ({
            content: f.content,
            title: f.metadata?.title || '',
            url: f.metadata?.url || '',
            metadata: f.metadata,
          })),
          query: input.followUp,
          budget_chars: CONTEXT_BUDGET_CHARS,
          content_field: 'content',
          title_field: 'title',
        });

        findings = ranked.results.map((r) => ({
          content: r.content as string,
          metadata: (r.metadata as Record<string, any>) || { title: r.title, url: r.url },
        }));

        console.log(
          `[SearchAgent] Context ranked: ${ranked.total_input} -> ${ranked.total_selected} results, ` +
            `${ranked.original_chars} -> ${ranked.result_chars} chars (${ranked.processing_ms}ms)`,
        );
      } catch (err) {
        console.warn(
          `[SearchAgent] Rank API failed (${(err as Error).message}), using all findings`,
        );
      }
    }

    const finalContext = findings
      .map(
        (f, index) =>
          `<result index=${index + 1} title=${f.metadata.title}>${f.content}</result>`,
      )
      .join('\n');

    const widgetContext = widgetOutputs
      .map((o) => {
        return `<result>${o.llmContext}</result>`;
      })
      .join('\n-------------\n');

    const finalContextWithWidgets = `<search_results note="These are the search results and assistant can cite these">\n${finalContext}\n</search_results>\n<widgets_result noteForAssistant="Its output is already showed to the user, assistant can use this information to answer the query but do not CITE this as a souce">\n${widgetContext}\n</widgets_result>`;

    const writerPrompt = getWriterPrompt(
      finalContextWithWidgets,
      input.config.systemInstructions,
      input.config.mode,
    );
    const answerStream = input.config.llm.streamText({
      messages: [
        {
          role: 'system',
          content: writerPrompt,
        },
        ...input.chatHistory,
        {
          role: 'user',
          content: input.followUp,
        },
      ],
    });

    let responseBlockId = '';

    for await (const chunk of answerStream) {
      if (!responseBlockId) {
        const block: TextBlock = {
          id: crypto.randomUUID(),
          type: 'text',
          data: chunk.contentChunk,
        };

        session.emitBlock(block);

        responseBlockId = block.id;
      } else {
        const block = session.getBlock(responseBlockId) as TextBlock | null;

        if (!block) {
          continue;
        }

        block.data += chunk.contentChunk;

        session.updateBlock(block.id, [
          {
            op: 'replace',
            path: '/data',
            value: block.data,
          },
        ]);
      }
    }

    session.emit('end', {});

    await db
      .update(messages)
      .set({
        status: 'completed',
        responseBlocks: session.getAllBlocks(),
      })
      .where(
        and(
          eq(messages.chatId, input.chatId),
          eq(messages.messageId, input.messageId),
        ),
      )
      .execute();
  }
}

export default SearchAgent;
