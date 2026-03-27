import z from 'zod';
import { ResearchAction } from '../../types';
import { searchSearxng } from '@/lib/searxng';
import { Chunk, SearchResultsResearchBlock } from '@/lib/types';

const actionSchema = z.object({
  type: z.literal('legal_search'),
  queries: z
    .array(z.string())
    .describe('An array of legal search queries (case names, citations, statutes, or keywords).'),
  jurisdiction: z
    .enum(['uk', 'us', 'commonwealth', 'eu', 'international', 'all'])
    .optional()
    .default('all')
    .describe('Jurisdiction to search: uk, us, commonwealth, eu, international, or all'),
});

// Legal databases by jurisdiction
const LEGAL_DATABASES = {
  uk: ['bailii.org'],
  us: ['courtlistener.com', 'law.justia.com'],
  commonwealth: ['austlii.edu.au', 'canlii.org', 'nzlii.org', 'commonlii.org'],
  eu: ['eur-lex.europa.eu'],
  international: ['icj-cij.org', 'worldlii.org'],
};

function getLegalSites(jurisdiction: string): string[] {
  if (jurisdiction === 'all') {
    return Object.values(LEGAL_DATABASES).flat();
  }
  return LEGAL_DATABASES[jurisdiction as keyof typeof LEGAL_DATABASES] || [];
}

const speedModePrompt = `
Use this tool to search legal databases for case law, statutes, regulations, and legal precedents. You can provide up to 3 queries at a time.
You are on speed mode - you can only call this tool once. Make your queries count.

**Query Strategy:**
- For cases: Use case names, citations, or key legal issues (e.g., "Brown v Board", "347 U.S. 483", "human rights act")
- For statutes: Use code sections or act names (e.g., "18 USC 1001", "Data Protection Act")
- For legal concepts: Use precise legal terminology (e.g., "promissory estoppel", "duty of care")

Your queries should be targeted and use legal terminology. Avoid broad queries.
You can search 3 queries in one go - use all 3 to cover different aspects of the legal question.

If this tool is present and the query is legal in nature, you MUST use this tool.
`;

const balancedModePrompt = `
Use this tool to search legal databases for case law, statutes, regulations, and legal precedents. You can provide up to 3 queries at a time.
You can call this tool several times to build comprehensive legal research.

**Research Strategy:**
1. Start with broader legal concepts or leading cases
2. Narrow down to specific jurisdictions or fact patterns
3. Search for related precedents and statutory authority
4. Look for recent developments or appeals

**Query Examples:**
- Cases: "Smith v Jones", "negligence duty of care", "contract formation"
- Statutes: "copyright act 1976", "criminal procedure", "employment law"
- Citations: "347 U.S. 483", "[2020] UKSC 15", "2021 SCC 10"

Use 3 queries per call. You can call this tool multiple times to thoroughly research the legal issue.
If this tool is present and relevant, you MUST use it.
`;

const qualityModePrompt = `
Use this tool to search legal databases for comprehensive legal research. You can provide up to 3 queries at a time.
You must call this tool several times (5-6+ iterations) to gather thorough legal authority unless the question is very simple.

**Comprehensive Research Strategy:**
1. Start with primary authority (leading cases, key statutes)
2. Search for precedential hierarchy (supreme court → appeals → lower courts)
3. Examine statutory interpretation and legislative history
4. Review secondary sources and legal commentary
5. Check for recent developments, appeals, or overrulings
6. Consider comparative law from other jurisdictions if relevant

**Query Precision:**
- Use proper legal citations when known
- Search both broad concepts and narrow fact patterns
- Include jurisdiction-specific terms
- Look for dissenting opinions and scholarly critiques

Use all 3 query slots per call. Call this tool multiple times (at least 5-6 iterations) for thorough research.
If this tool is present, you MUST use it comprehensively.
`;

const legalSearchAction: ResearchAction<typeof actionSchema> = {
  name: 'legal_search',
  schema: actionSchema,
  getToolDescription: () =>
    "Use this tool to search legal databases for case law, statutes, regulations, and legal precedents across multiple jurisdictions (UK, US, Commonwealth, EU, International). Provide up to 3 queries at a time with optional jurisdiction filter.",
  getDescription: (config) => {
    let prompt = '';

    switch (config.mode) {
      case 'speed':
        prompt = speedModePrompt;
        break;
      case 'balanced':
        prompt = balancedModePrompt;
        break;
      case 'quality':
        prompt = qualityModePrompt;
        break;
      default:
        prompt = speedModePrompt;
        break;
    }

    return prompt;
  },
  enabled: (config) => {
    // Enable if 'legal' source is selected or if classifier detects legal query
    return config.sources.includes('legal');
  },
  execute: async (input, additionalConfig) => {
    input.queries = input.queries.slice(0, 3);
    const { jurisdiction = 'all' } = input;

    // Get applicable legal database sites
    const legalSites = getLegalSites(jurisdiction);
    
    if (legalSites.length === 0) {
      return {
        type: 'search_results' as const,
        results: [],
      };
    }

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
      // Build site-restricted query
      const siteQuery = legalSites.map((site) => `site:${site}`).join(' OR ');
      const fullQuery = `(${siteQuery}) ${q} (case OR judgment OR statute OR act OR regulation)`;

      const res = await searchSearxng(fullQuery, {
        engines: ['google', 'duckduckgo', 'brave', 'qwant', 'startpage'],
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

export default legalSearchAction;
