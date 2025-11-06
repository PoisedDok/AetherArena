import { searchSearxng } from '@/lib/searxng';

const websitesForTopic = {
  tech: {
    query: ['technology news', 'latest tech', 'AI', 'science and innovation'],
    links: ['techcrunch.com', 'wired.com', 'theverge.com'],
  },
  finance: {
    query: ['finance news', 'economy', 'stock market', 'investing'],
    links: ['bloomberg.com', 'cnbc.com', 'marketwatch.com'],
  },
  art: {
    query: ['art news', 'culture', 'modern art', 'cultural events'],
    links: ['artnews.com', 'hyperallergic.com', 'theartnewspaper.com'],
  },
  sports: {
    query: ['sports news', 'latest sports', 'cricket football tennis'],
    links: ['espn.com', 'bbc.com/sport', 'skysports.com'],
  },
  entertainment: {
    query: ['entertainment news', 'movies', 'TV shows', 'celebrities'],
    links: ['hollywoodreporter.com', 'variety.com', 'deadline.com'],
  },
  legal: {
    query: ['legal news', 'court rulings', 'regulation', 'lawsuits', 'Supreme Court'],
    links: ['reuters.com/legal', 'law360.com', 'abajournal.com'],
  },
};

type Topic = keyof typeof websitesForTopic;

export const GET = async (req: Request) => {
  try {
    const params = new URL(req.url).searchParams;

    const mode: 'normal' | 'preview' =
      (params.get('mode') as 'normal' | 'preview') || 'normal';
    const topicParam = (params.get('topic') || '').trim().toLowerCase();
    const topic: Topic = (topicParam in websitesForTopic
      ? (topicParam as Topic)
      : 'tech');
    const qParam = (params.get('q') || '').trim();

    const selectedTopic = websitesForTopic[topic];

    let data: any[] = [];

    if (mode === 'normal') {
      const seenUrls = new Set();

      const queries = qParam ? [qParam] : selectedTopic.query;
      // Execute searches with per-call isolation to avoid failing the whole batch
      const tasks = selectedTopic.links.flatMap((link) =>
        queries.map(async (query) => {
          try {
            const engines = topic === 'legal'
              ? ['bing news']
              : ['bing news', 'duckduckgo news'];
            const res = await searchSearxng(`site:${link} ${query}`, {
            engines,
              pageno: 1,
              language: 'en',
            });
            return Array.isArray(res?.results) ? res.results : [];
          } catch (err) {
            // Swallow individual engine/site errors; continue aggregating others
            return [];
          }
        }),
      );

      const batches = await Promise.allSettled(tasks);
      const flattened: any[] = [];
      for (const r of batches) {
        if (r.status === 'fulfilled' && Array.isArray(r.value)) {
          flattened.push(...r.value);
        }
      }

      data = flattened
        .filter((item) => {
          const url = (item?.url || '').toLowerCase().trim();
          if (!url) return false;
          if (seenUrls.has(url)) return false;
          seenUrls.add(url);
          return true;
        })
        .sort(() => Math.random() - 0.5);
    } else {
      const link = selectedTopic.links[Math.floor(Math.random() * selectedTopic.links.length)];
      const query = qParam || selectedTopic.query[Math.floor(Math.random() * selectedTopic.query.length)];
      try {
        const engines = topic === 'legal'
          ? ['bing news']
          : ['bing news', 'duckduckgo news'];
        const res = await searchSearxng(`site:${link} ${query}`,
          {
            engines,
            pageno: 1,
            language: 'en',
          },
        );
        data = Array.isArray(res?.results) ? res.results : [];
      } catch (err) {
        data = [];
      }
    }

    return Response.json(
      {
        blogs: data,
      },
      {
        status: 200,
      },
    );
  } catch (err) {
    console.error(`An error occurred in discover route: ${err}`);
    // Never fail hard: return empty result to avoid breaking clients
    return Response.json({ blogs: [] }, { status: 200 });
  }
};
