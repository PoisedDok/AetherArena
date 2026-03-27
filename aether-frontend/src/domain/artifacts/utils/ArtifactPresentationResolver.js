'use strict';

/**
Incoming: Domain artifact models + presentation context --- {Dict, json}
Processing: Determine viewer, tab, and switching directives for artifact presentation --- {2 jobs: JOB_FILTER_DATA, JOB_ROUTE_BY_TYPE}
Outgoing: Presentation descriptor for renderer components --- {Dict, json}
*/

const { normalizeArtifactPayload } = require('./ArtifactNormalizer');
const { createLogger } = require('../../../core/utils/logger');

const log = createLogger({ component: 'ArtifactPresentationResolver' });

const CODE_TYPES = new Set(['code', 'notebook', 'script', 'source']);
const OUTPUT_TYPES = new Set([
  'output',
  'console',
  'stdout',
  'stderr',
  'result',
  'results',
  'html',
  'markdown',
  'rich_text',
  'json',
  'table',
  'chart',
  'plot',
  'graph',
  'text',
  'log',
  'media',
  'image',
  'video',
  'audio',
  'svg',
  'png',
  'jpg',
  'jpeg',
  'gif'
]);
const FILE_TYPES = new Set(['file', 'archive', 'binary', 'dataset', 'artifact_file']);
const SUPPORTED_FORMATS = new Set(['text', 'markdown', 'html', 'json', 'image', 'video', 'audio', 'media']);

const FORMAT_ALIASES = new Map([
  ['plain', 'text'],
  ['plaintext', 'text'],
  ['txt', 'text'],
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['htm', 'html'],
  ['svg', 'image'],
  ['png', 'image'],
  ['jpg', 'image'],
  ['jpeg', 'image'],
  ['gif', 'image'],
  ['bmp', 'image'],
  ['webp', 'image'],
  ['csv', 'text'],
  ['tsv', 'text'],
  ['log', 'text'],
  ['stdout', 'text'],
  ['stderr', 'text'],
  ['audio/mpeg', 'audio'],
  ['audio/mp3', 'audio'],
  ['audio/wav', 'audio'],
  ['audio/ogg', 'audio'],
  ['video/mp4', 'video'],
  ['video/webm', 'video'],
  ['application/json', 'json'],
  ['application/xml', 'text'],
  ['application/octet-stream', 'text']
]);

function resolveArtifactPresentation(artifact = {}, context = {}) {
  let normalized;
  try {
    normalized = normalizeArtifactPayload(artifact, context.chatId || artifact.chatId || null);
  } catch (error) {
    log.error('Failed to normalize artifact', {
      error: error.message,
      artifactId: artifact?.id || artifact?.artifact_id || 'unknown'
    });
    throw error; // Fail fast - cannot resolve presentation without valid artifact
  }
  const role = normalizeString(normalized.role, 'assistant');
  const type = normalizeString(normalized.type, 'output');
  const format = sanitizeFormat(normalized.format || normalized.language || artifact.format || artifact.language, type);

  const viewer = resolveViewer(role, type, format, context);
  const tab = viewer;

  const autoSwitch = shouldAutoSwitch({
    viewer,
    tab,
    role,
    type,
    format,
    context,
    artifact: normalized
  });

  const currentTab = normalizeString(context.currentTab);
  const shouldSwitch = autoSwitch && currentTab !== tab;

  return {
    role,
    type,
    format,
    viewer,
    tab,
    shouldAutoSwitch: shouldSwitch,
    normalized,
    content: normalized.content,
    language: normalized.language,
    filename: normalized.filename || artifact.filename || null
  };
}

function resolveViewer(role, type, format, context) {
  const forceOutput = Boolean(context.forceOutput);

  if (FILE_TYPES.has(type)) {
    return 'files';
  }

  if (!forceOutput && role === 'assistant' && CODE_TYPES.has(type)) {
    return 'code';
  }

  if (role === 'computer') {
    return 'output';
  }

  if (OUTPUT_TYPES.has(type)) {
    return 'output';
  }

  if (CODE_TYPES.has(type)) {
    return forceOutput ? 'output' : 'code';
  }

  if (format === 'image' || format === 'video' || format === 'audio' || format === 'media') {
    return 'output';
  }

  return 'output';
}

function shouldAutoSwitch({ viewer, role, type, format, context, artifact }) {
  if (typeof context.forceAutoSwitch === 'boolean') {
    return context.forceAutoSwitch;
  }

  if (typeof context.autoSwitch === 'boolean') {
    return context.autoSwitch;
  }

  switch (viewer) {
    case 'output':
      if (role === 'computer') {
        return true;
      }
      if (context.origin === 'execution' || context.origin === 'load-output') {
        return true;
      }
      if (context.origin === 'stream' && context.isFinal) {
        return true;
      }
      if (artifact && artifact.metadata && artifact.metadata.autoFocus === true) {
        return true;
      }
      if (OUTPUT_TYPES.has(type)) {
        return true;
      }
      if (format === 'image' || format === 'video' || format === 'audio' || format === 'media') {
        return true;
      }
      return false;
    case 'files':
      return context.origin === 'file' || context.origin === 'file-import';
    case 'code':
      return context.origin === 'manual' || context.origin === 'stream-start';
    default:
      return false;
  }
}

function sanitizeFormat(formatValue, fallbackType) {
  const value = normalizeString(formatValue);
  if (value && SUPPORTED_FORMATS.has(value)) {
    return value;
  }

  if (value && FORMAT_ALIASES.has(value)) {
    return FORMAT_ALIASES.get(value);
  }

  if (value) {
    if (value.includes('markdown')) {
      return 'markdown';
    }
    if (value.includes('html')) {
      return 'html';
    }
    if (value.includes('json')) {
      return 'json';
    }
    if (value.includes('image') || value.includes('png') || value.includes('jpg') || value.includes('jpeg') || value.includes('gif')) {
      return 'image';
    }
    if (value.includes('video')) {
      return 'video';
    }
    if (value.includes('audio')) {
      return 'audio';
    }
    if (value.includes('text') || value.includes('plain')) {
      return 'text';
    }
  }

  if (fallbackType && OUTPUT_TYPES.has(fallbackType)) {
    if (fallbackType === 'html') return 'html';
    if (fallbackType === 'markdown') return 'markdown';
    if (fallbackType === 'json') return 'json';
    if (fallbackType === 'media' || fallbackType === 'image' || fallbackType === 'video' || fallbackType === 'audio') {
      return fallbackType;
    }
    return 'text';
  }

  if (fallbackType && CODE_TYPES.has(fallbackType)) {
    return 'text';
  }

  return 'text';
}

function normalizeString(value, fallback = '') {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim().toLowerCase();
  }
  if (typeof fallback === 'string' && fallback.trim().length > 0) {
    return fallback.trim().toLowerCase();
  }
  return '';
}

module.exports = {
  resolveArtifactPresentation,
  sanitizeFormat,
  CODE_TYPES,
  OUTPUT_TYPES,
  FILE_TYPES
};
