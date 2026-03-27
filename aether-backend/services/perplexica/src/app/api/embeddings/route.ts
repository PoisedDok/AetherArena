/**
 * OpenAI-compatible Embedding API
 *
 * Runs ONNX embedding models locally via @huggingface/transformers (Transformers.js).
 * No external inference provider required — models execute inside this container.
 *
 * Supported models:
 *   - Xenova/bge-small-en-v1.5   (384 dims, default — fast, backward-compatible)
 *   - Xenova/nomic-embed-text-v1  (768 dims, quality — selectable from settings)
 *
 * @.architecture
 * Incoming:  aether-hub backend, Aether-RAG indexer, memory service --- {text[], model?}
 * Processing: TransformerEmbedding pipeline (ONNX, fp32) --- {1 job: JOB_GENERATE_EMBEDDING}
 * Outgoing:  caller --- {OpenAI-compatible embedding response}
 */

import { NextResponse } from 'next/server';
import TransformerEmbedding from '@/lib/models/providers/transformers/transformerEmbedding';

// ── Model registry ──────────────────────────────────────────────────────────
const SUPPORTED_MODELS: Record<string, { dims: number }> = {
  'Xenova/bge-small-en-v1.5': { dims: 384 },
  'Xenova/nomic-embed-text-v1': { dims: 768 },
};

const DEFAULT_MODEL = 'Xenova/bge-small-en-v1.5';

// ── Warm model cache (one instance per model key) ───────────────────────────
const modelCache = new Map<string, TransformerEmbedding>();

function getOrCreateModel(modelKey: string): TransformerEmbedding {
  let instance = modelCache.get(modelKey);
  if (!instance) {
    instance = new TransformerEmbedding({ model: modelKey });
    modelCache.set(modelKey, instance);
  }
  return instance;
}

// ── POST /api/embeddings — OpenAI-compatible ────────────────────────────────
export async function POST(req: Request) {
  try {
    const body = await req.json();

    // Validate input
    const rawInput = body.input;
    if (rawInput === undefined || rawInput === null) {
      return NextResponse.json(
        { error: { message: '`input` is required', type: 'invalid_request_error' } },
        { status: 400 },
      );
    }

    const texts: string[] = Array.isArray(rawInput) ? rawInput : [rawInput];
    if (texts.length === 0 || texts.some((t) => typeof t !== 'string' || t.length === 0)) {
      return NextResponse.json(
        { error: { message: '`input` must be a non-empty string or array of non-empty strings', type: 'invalid_request_error' } },
        { status: 400 },
      );
    }

    // Resolve model
    const requestedModel = body.model || DEFAULT_MODEL;
    const modelKey = SUPPORTED_MODELS[requestedModel] ? requestedModel : DEFAULT_MODEL;

    const embedder = getOrCreateModel(modelKey);
    const embeddings = await embedder.embedText(texts);

    // Format as OpenAI response
    const data = embeddings.map((embedding, index) => ({
      object: 'embedding' as const,
      embedding,
      index,
    }));

    const totalTokens = texts.reduce((sum, t) => sum + t.split(/\s+/).length, 0);

    return NextResponse.json({
      object: 'list',
      data,
      model: modelKey,
      usage: {
        prompt_tokens: totalTokens,
        total_tokens: totalTokens,
      },
    });
  } catch (error: any) {
    console.error('Embedding generation failed:', error);
    return NextResponse.json(
      { error: { message: error.message || 'Internal embedding error', type: 'server_error' } },
      { status: 500 },
    );
  }
}

// ── GET /api/embeddings — health / info ─────────────────────────────────────
export async function GET() {
  try {
    // Quick health probe: ensure default model can load
    const embedder = getOrCreateModel(DEFAULT_MODEL);
    // Warm the pipeline with a trivial embed (first call downloads + compiles ONNX)
    await embedder.embedText(['health']);

    return NextResponse.json({
      status: 'healthy',
      default_model: DEFAULT_MODEL,
      supported_models: Object.entries(SUPPORTED_MODELS).map(([key, v]) => ({
        key,
        dimensions: v.dims,
      })),
      model_loaded: true,
    });
  } catch (error: any) {
    return NextResponse.json(
      {
        status: 'unhealthy',
        default_model: DEFAULT_MODEL,
        model_loaded: false,
        error: error.message,
      },
      { status: 503 },
    );
  }
}
