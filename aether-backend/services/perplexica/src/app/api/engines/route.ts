import { getSearxngApiEndpoint } from '@/lib/config';
import axios from 'axios';

/**
 * GET /api/engines
 * Returns list of all available SearXNG engines with their metadata
 */
export const GET = async () => {
  try {
    const searxngURL = getSearxngApiEndpoint();
    
    // Define all available engines with metadata
    const engines = {
      // General web search engines
      general: [
        { name: 'bing', category: 'general', disabled: false, description: 'Microsoft Bing search engine' },
        { name: 'duckduckgo', category: 'general', disabled: false, description: 'DuckDuckGo privacy-focused search' },
        { name: 'google', category: 'general', disabled: true, description: 'Google search (may require configuration)' },
        { name: 'brave', category: 'general', disabled: false, description: 'Brave Search' },
        { name: 'startpage', category: 'general', disabled: false, description: 'Startpage privacy search' },
        { name: 'mojeek', category: 'general', disabled: false, description: 'Mojeek independent search' },
        { name: 'qwant', category: 'general', disabled: false, description: 'Qwant European search' },
        { name: 'wikipedia', category: 'general', disabled: false, description: 'Wikipedia encyclopedia' },
      ],
      
      // News engines
      news: [
        { name: 'bing news', category: 'news', disabled: false, description: 'Bing News aggregator' },
        { name: 'duckduckgo news', category: 'news', disabled: false, description: 'DuckDuckGo News' },
        { name: 'google news', category: 'news', disabled: true, description: 'Google News' },
        { name: 'reuters', category: 'news', disabled: false, description: 'Reuters news agency' },
      ],
      
      // Academic/Science engines
      academic: [
        { name: 'arxiv', category: 'science', disabled: false, description: 'arXiv preprint repository' },
        { name: 'pubmed', category: 'science', disabled: false, description: 'PubMed medical research' },
        { name: 'google scholar', category: 'science', disabled: true, description: 'Google Scholar' },
        { name: 'semantic scholar', category: 'science', disabled: false, description: 'Semantic Scholar AI research' },
        { name: 'springer', category: 'science', disabled: false, description: 'Springer academic publisher' },
      ],
      
      // Tech/IT engines
      tech: [
        { name: 'github', category: 'it', disabled: false, description: 'GitHub code repositories' },
        { name: 'stackoverflow', category: 'it', disabled: false, description: 'Stack Overflow Q&A' },
        { name: 'gitlab', category: 'it', disabled: false, description: 'GitLab repositories' },
        { name: 'npm', category: 'it', disabled: false, description: 'npm package registry' },
        { name: 'crates', category: 'it', disabled: false, description: 'Rust crates registry' },
        { name: 'pkg go dev', category: 'it', disabled: false, description: 'Go packages' },
        { name: 'docker hub', category: 'it', disabled: false, description: 'Docker container registry' },
      ],
      
      // Social media engines
      social: [
        { name: 'reddit', category: 'social media', disabled: false, description: 'Reddit discussions' },
        { name: 'lemmy', category: 'social media', disabled: false, description: 'Lemmy federated discussions' },
        { name: 'mastodon', category: 'social media', disabled: false, description: 'Mastodon federated social' },
      ],
      
      // Media engines
      media: [
        { name: 'youtube', category: 'videos', disabled: false, description: 'YouTube videos' },
        { name: 'vimeo', category: 'videos', disabled: false, description: 'Vimeo videos' },
        { name: 'google images', category: 'images', disabled: true, description: 'Google Images' },
        { name: 'bing images', category: 'images', disabled: false, description: 'Bing Images' },
        { name: 'unsplash', category: 'images', disabled: false, description: 'Unsplash free photos' },
        { name: 'pixabay', category: 'images', disabled: false, description: 'Pixabay free media' },
      ],
      
      // Specialized engines
      specialized: [
        { name: 'wolframalpha', category: 'science', disabled: false, description: 'Wolfram Alpha computational engine', requiresConfig: true },
      ],
      
      // Tor/Onion engines (privacy-focused)
      tor: [
        { name: 'ahmia', category: 'onions', disabled: false, description: 'Ahmia Tor hidden services search', requiresTor: true },
      ],
      
      // File sharing (use with caution)
      files: [
        { name: '1337x', category: 'files', disabled: false, description: '1337x torrent search' },
        { name: 'nyaa', category: 'files', disabled: false, description: 'Nyaa anime torrents' },
        { name: 'piratebay', category: 'files', disabled: false, description: 'The Pirate Bay' },
        { name: 'bt4g', category: 'files', disabled: false, description: 'BT4G torrent search' },
      ],
    };

    // Get all enabled engines (not disabled)
    const allEngines = Object.values(engines).flat();
    const enabledEngines = allEngines.filter(e => !e.disabled);
    const disabledEngines = allEngines.filter(e => e.disabled);

    // Try to fetch live status from SearXNG if available
    let liveEngines: any[] = [];
    try {
      const configRes = await axios.get(`${searxngURL}/config`, { timeout: 2000 });
      if (configRes.data?.engines) {
        liveEngines = configRes.data.engines;
      }
    } catch (err) {
      // SearXNG may not expose /config endpoint, use static list
    }

    return Response.json({
      success: true,
      searxng_url: searxngURL,
      total_engines: allEngines.length,
      enabled_count: enabledEngines.length,
      disabled_count: disabledEngines.length,
      engines: engines,
      enabled_engines: enabledEngines.map(e => e.name),
      disabled_engines: disabledEngines.map(e => e.name),
      categories: Object.keys(engines),
      live_status: liveEngines.length > 0 ? 'available' : 'using_static_list',
      usage_examples: {
        webSearch: ['bing', 'duckduckgo', 'bing news'],
        academicSearch: ['arxiv', 'pubmed', 'google scholar'],
        techSearch: ['github', 'stackoverflow'],
        torSearch: ['ahmia'],
        mediaSearch: ['youtube', 'bing images'],
      },
    }, { status: 200 });

  } catch (error: any) {
    console.error('Error fetching engines:', error.message);
    return Response.json({
      success: false,
      error: 'Failed to fetch engines list',
      message: error.message,
    }, { status: 500 });
  }
};

