'use strict';

const { freeze } = Object;

const DEFAULT_GROUP_LABELS = freeze({
  agent_output: 'Assistant History',
  file_location: 'Your Documents',
  source: 'Knowledge Base',
  system: 'System',
  other: 'Other',
});
const VALID_SEARCH_MODES = freeze(new Set(['semantic', 'bm25', 'hybrid']));

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = String(text ?? '');
  return div.innerHTML;
}

function escapeAttr(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatGroupLabel(type, labels = DEFAULT_GROUP_LABELS) {
  return labels[type] || type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function groupIndexes(indexes, labels = DEFAULT_GROUP_LABELS) {
  const grouped = {
    'Filesystem': [],
    'Browser': [],
    'Email': [],
    'System': []
  };
  indexes.forEach((index) => {
    let group = null;
    
    if (index.index_type === 'file_location') {
        group = 'Filesystem';
    } else if (index.index_type === 'source') {
        if (index.source_type === 'browser_history' || index.source_type === 'browser') {
            group = 'Browser';
        } else if (index.source_type === 'email') {
            group = 'Email';
        } else if (index.source_type === 'query_gen') {
            return; // Hide internal queries from user UI
        } else if (index.source_type === 'filesystem') {
            return; // Hide raw internal daemon event logs from user UI
        } else {
            group = 'Filesystem'; // Map custom sources to Filesystem
        }
    } else if (index.index_type === 'agent_output') {
        // Enforce strict 3 categories by hiding agent outputs from Index Browser
        // since they aren't directly configurable sources.
        return; 
    }
    
    if (group && grouped[group]) {
        grouped[group].push(index);
    }
  });
  
  const result = {};
  for (const [k, v] of Object.entries(grouped)) {
      if (v.length > 0) result[k] = v;
  }
  return result;
}

function getResultTitle(result) {
  const meta = result.metadata || {};
  if (meta.file_name) return meta.file_name;
  if (meta.title) return meta.title;
  if (meta.display_name) return meta.display_name;

  if (result.index_type === 'agent_output') {
    const agent = (result.index_name || '').replace('agent_', '').replace('_index', '');
    return agent ? `${agent.replace(/_/g, ' ')} output` : 'Agent Output';
  }

  const firstLine = (result.text || '').split('\n')[0];
  if (firstLine && firstLine.length < 100) return firstLine;
  return result.index_name || 'Untitled';
}

function getResultIcon(result, typeIcons, indexTypeIcons) {
  if (result.index_type === 'file_location') {
    const ext = (result.metadata?.file_extension || '').toLowerCase().replace('.', '');
    return typeIcons[ext] || 'fas fa-file';
  }
  return indexTypeIcons[result.index_type] || 'fas fa-file-alt';
}

function getOpenTarget(result) {
  const meta = result.metadata || {};
  if (meta.file_path) return { type: 'file', path: meta.file_path };
  if (meta.url) return { type: 'url', path: meta.url };
  return null;
}

function getDirectory(filePath) {
  if (!filePath) return '';
  const parts = filePath.replace(/\\/g, '/').split('/');
  if (parts.length > 3) {
    return '.../' + parts.slice(-3, -1).join('/');
  }
  return parts.slice(0, -1).join('/');
}

function truncateUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.length > 40
      ? parsed.pathname.slice(0, 37) + '...'
      : parsed.pathname;
    return parsed.hostname + path;
  } catch (_) {
    return url.length > 60 ? url.slice(0, 57) + '...' : url;
  }
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return dateStr;
    return date.toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric'
    });
  } catch (_) {
    return dateStr;
  }
}

function getResultBreadcrumb(result, helpers = {}) {
  const meta = result.metadata || {};
  const indexMap = helpers.indexMap || new Map();
  const source = indexMap.get(result.index_name)?.display_name || result.index_name || '';

  if (result.index_type === 'file_location') {
    const directory = meta.file_path ? helpers.getDirectory(meta.file_path) : '';
    return directory ? `${source} \u203A ${directory}` : source;
  }
  if (result.index_type === 'source') {
    const extra = meta.url ? ` \u203A ${helpers.truncateUrl(meta.url)}` : '';
    return `${source}${extra}`;
  }
  if (result.index_type === 'agent_output') {
    const date = meta.created_at ? ` \u203A ${helpers.formatDate(meta.created_at)}` : '';
    return `Agent: ${source}${date}`;
  }
  return source;
}

function anySelectedSupportsBM25(selectedSources, indexMap) {
  for (const name of selectedSources) {
    const idx = indexMap.get(name);
    if (idx && idx.supported_modes && idx.supported_modes.includes('bm25')) {
      return true;
    }
  }
  return false;
}

function getSupportedModesForIndex(indexInfo) {
  if (indexInfo && indexInfo._unindexed) return new Set();

  const rawModes = Array.isArray(indexInfo?.supported_modes)
    ? indexInfo.supported_modes
    : ['semantic'];
  const normalizedModes = new Set();
  for (const mode of rawModes) {
    if (typeof mode === 'string' && VALID_SEARCH_MODES.has(mode)) {
      normalizedModes.add(mode);
    }
  }
  if (normalizedModes.size === 0) {
    normalizedModes.add('semantic');
  }
  return normalizedModes;
}

function getAvailableSearchModes(selectedSources, indexMap, indexes) {
  const allIndexes = Array.isArray(indexes) ? indexes : [];
  const byName = new Map(
    allIndexes.map((idx) => [idx?.index_name || idx?.name || idx?.id, idx]).filter(([name]) => Boolean(name))
  );

  const selectedPool = selectedSources.size > 0
    ? [...selectedSources]
      .map((name) => indexMap.get(name) || byName.get(name))
      .filter(Boolean)
    : [];

  // Strict mode semantics: if sources are selected, only expose modes that
  // every selected source can execute (intersection), not the union.
  if (selectedPool.length > 0) {
    let intersection = null;
    for (const idx of selectedPool) {
      if (idx._unindexed) continue; // Unindexed sources don't restrict search modes, they just won't be searched
      const supported = getSupportedModesForIndex(idx);
      if (!intersection) {
        intersection = new Set(supported);
        continue;
      }
      intersection = new Set([...intersection].filter((mode) => supported.has(mode)));
    }
    
    if (!intersection) {
        return new Set(['semantic']); // Fallback if all selected are unindexed
    }

    // Dynamic Hybrid Compute:
    // If the intersection natively contains 'hybrid', leave it.
    // If it contains both 'semantic' and 'bm25', we can dynamically offer 'hybrid'.
    if (intersection.has('semantic') && intersection.has('bm25')) {
        intersection.add('hybrid');
    }
    return intersection;
  }

  // When nothing is selected, keep broad discoverability (union across all).
  const union = new Set();
  for (const idx of allIndexes) {
    if (idx._unindexed) continue;
    const supported = getSupportedModesForIndex(idx);
    for (const mode of supported) {
      union.add(mode);
    }
  }
  
  // Dynamic Hybrid Compute:
  if (union.has('semantic') && union.has('bm25')) {
      union.add('hybrid');
  }
  
  if (union.size === 0) {
    union.add('semantic');
  }
  return union;
}

function highlightQuery(text, query, escapeFn = escapeHtml) {
  if (!text || !query) return escapeFn(text || '');
  const escaped = escapeFn(text);
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return escaped;

  try {
    const pattern = words
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    // Regex matches the search words but uses a negative lookahead to avoid
    // matching inside an HTML entity (e.g. matching 'amp' in '&amp;') or
    // inside a tag (though we already escaped the text, so tags aren't present
    // unless they are our own <mark> tags).
    // The pattern (?![^&;]*;) ensures we don't match mid-entity.
    const regex = new RegExp(`(${pattern})(?![^&;]*;)`, 'gi');
    return escaped.replace(regex, '<mark class="se-highlight">$1</mark>');
  } catch (_) {
    return escaped;
  }
}

function formatDuration(ms) {
  if (typeof ms !== 'number') return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatScore(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return '-';
  // If score is <= 1.0, treat as normalized probability/similarity percentage.
  if (score <= 1.0) {
    return Math.round(score * 100) + '%';
  }
  // For raw scores > 1.0 (typically BM25), show raw rounded to 2 decimals.
  return score.toFixed(2);
}

module.exports = {
  anySelectedSupportsBM25,
  escapeAttr,
  escapeHtml,
  formatDate,
  formatDuration,
  formatGroupLabel,
  formatScore,
  getAvailableSearchModes,
  getDirectory,
  getOpenTarget,
  getResultBreadcrumb,
  getResultIcon,
  getResultTitle,
  groupIndexes,
  highlightQuery,
  truncateUrl,
};
