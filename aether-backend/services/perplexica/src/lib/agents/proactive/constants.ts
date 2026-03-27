/**
 * Shared proactive source contract.
 *
 * Single source of truth for retriever source enum + normalization.
 */
export const PROACTIVE_RETRIEVER_SOURCES = [
  'email',
  'browser',
  'filesystem',
  'chat',
  'query_gen',
] as const;

export type ProactiveRetrieverSource = string;

export const PROACTIVE_RETRIEVER_SOURCES_CSV =
  PROACTIVE_RETRIEVER_SOURCES.join(', ');
export const PROACTIVE_RETRIEVER_SOURCES_SLASH =
  PROACTIVE_RETRIEVER_SOURCES.join('/');

const PROACTIVE_RETRIEVER_SOURCE_SET = new Set<string>(
  PROACTIVE_RETRIEVER_SOURCES,
);

export const PROACTIVE_RETRIEVER_SOURCE_SYNONYMS: Record<
  string,
  ProactiveRetrieverSource
> = {
  email: 'email',
  mail: 'email',
  gmail: 'email',
  outlook: 'email',
  inbox: 'email',
  browser: 'browser',
  web: 'browser',
  website: 'browser',
  webpage: 'browser',
  page: 'browser',
  tab: 'browser',
  url: 'browser',
  dashboard: 'browser',
  grafana: 'browser',
  kibana: 'browser',
  wiki: 'browser',
  portal: 'browser',
  runbook: 'browser',
  filesystem: 'filesystem',
  file: 'filesystem',
  files: 'filesystem',
  local: 'filesystem',
  document: 'filesystem',
  documents: 'filesystem',
  docs: 'filesystem',
  folder: 'filesystem',
  pdf: 'filesystem',
  note: 'filesystem',
  notes: 'filesystem',
  chat: 'chat',
  message: 'chat',
  messages: 'chat',
  slack: 'chat',
  teams: 'chat',
  discord: 'chat',
  query_gen: 'query_gen',
  query_generation: 'query_gen',
  'query-generation': 'query_gen',
  query: 'query_gen',
  queries: 'query_gen',
  generated_query: 'query_gen',
  generated_queries: 'query_gen',
};

export const isProactiveRetrieverSource = (
  value: string,
): boolean => {
  return PROACTIVE_RETRIEVER_SOURCE_SET.has(value);
};

export const normalizeProactiveRetrieverSource = (
  raw: string,
): ProactiveRetrieverSource | null => {
  const value = raw.trim().toLowerCase();
  if (!value) {
    return null;
  }

  if (isProactiveRetrieverSource(value)) {
    return value;
  }

  if (PROACTIVE_RETRIEVER_SOURCE_SYNONYMS[value]) {
    return PROACTIVE_RETRIEVER_SOURCE_SYNONYMS[value];
  }

  for (const [token, mapped] of Object.entries(
    PROACTIVE_RETRIEVER_SOURCE_SYNONYMS,
  )) {
    if (value.includes(token)) {
      return mapped;
    }
  }

  // If not a known synonym or default source, assume it's a custom index name
  return value;
};
