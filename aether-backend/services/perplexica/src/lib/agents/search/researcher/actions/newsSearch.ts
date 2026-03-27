import z from 'zod';
import { ResearchAction } from '../../types';
import { Chunk, SearchResultsResearchBlock } from '@/lib/types';
import { searchSearxng } from '@/lib/searxng';

const schema = z.object({
  queries: z.array(z.string()).describe('List of news search queries'),
});

const newsSearchDescription = `
Use this tool to perform searches for recent news, press releases, breaking stories, and current events relevant to the user's query. Provide a list of concise search queries that will help gather comprehensive news information on the topic at hand.
You can provide up to 3 queries at a time. Make sure the queries are specific and relevant to the user's needs.

For example, if the user is interested in recent advancements in AI, your queries could be:
1. "Latest AI developments 2024"
2. "Artificial intelligence breaking news"
3. "Recent advancements in machine learning"

If this tool is present and no other tools are more relevant, you MUST use this tool to get the needed news information.
`;

const newsSearchAction: ResearchAction<typeof schema> = {
  name: 'news_search',
  schema: schema,
  getDescription: () => newsSearchDescription,
  getToolDescription: () =>
    "Use this tool to perform searches for recent news, press releases, breaking stories, and current events relevant to the user's query. Provide a list of concise search queries that will help gather comprehensive news information on the topic at hand.",
  enabled: (config) => config.sources.includes('news'),
  execute: async (input, additionalConfig) => {
    input.queries = input.queries.slice(0, 3);

    const researchBlock = additionalConfig.session.getBlock(
      additionalConfig.researchBlockId,
    );

    if (researchBlock && researchBlock.type === 'research') {
      researchBlock.data.subSteps.push({
        type: 'searching',
        id: crypto.randomUUID(),
        searching: input.queries,
      });

      additionalConfig.session.updateBlock(additionalConfig.researchBlockId, [
        {
          op: 'replace',
          path: '/data/subSteps',
          value: researchBlock.data.subSteps,
        },
      ]);
    }

    const searchResultsBlockId = crypto.randomUUID();
    let searchResultsEmitted = false;

    let results: Chunk[] = [];

    const search = async (q: string) => {
      const res = await searchSearxng(q, {
        engines: ['bing news', 'google news', 'reuters', 'wikinews', 'hackernews', 'yahoo news', 'startpage news', 'duckduckgo news', 'brave.news'],
      });

      const resultChunks: Chunk[] = res.results
        .slice(0, 8)
        .map((r) => ({
          content: r.content || r.title,
          metadata: {
            title: r.title,
            url: r.url,
          },
        }));

      results.push(...resultChunks);

      if (
        !searchResultsEmitted &&
        researchBlock &&
        researchBlock.type === 'research'
      ) {
        searchResultsEmitted = true;

        researchBlock.data.subSteps.push({
          id: searchResultsBlockId,
          type: 'search_results',
          reading: resultChunks,
        });

        additionalConfig.session.updateBlock(additionalConfig.researchBlockId, [
          {
            op: 'replace',
            path: '/data/subSteps',
            value: researchBlock.data.subSteps,
          },
        ]);
      } else if (
        searchResultsEmitted &&
        researchBlock &&
        researchBlock.type === 'research'
      ) {
        const subStepIndex = researchBlock.data.subSteps.findIndex(
          (step) => step.id === searchResultsBlockId,
        );

        const subStep = researchBlock.data.subSteps[
          subStepIndex
        ] as SearchResultsResearchBlock;

        subStep.reading.push(...resultChunks);

        additionalConfig.session.updateBlock(additionalConfig.researchBlockId, [
          {
            op: 'replace',
            path: '/data/subSteps',
            value: researchBlock.data.subSteps,
          },
        ]);
      }
    };

    await Promise.all(input.queries.map(search));

    return {
      type: 'search_results',
      results,
    };
  },
};

export default newsSearchAction;