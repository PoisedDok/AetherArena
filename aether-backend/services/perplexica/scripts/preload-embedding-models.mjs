/**
 * Pre-download ONNX embedding models into a deterministic Docker cache dir.
 * Run during `docker build` so the first embedding request is instant.
 *
 * CRITICAL: We set env.cacheDir BEFORE any model load to guarantee the
 * ONNX files land at /home/perplexica/model-cache (not the library default).
 * The same env var (HF_HOME) is set in the Dockerfile for runtime parity.
 */
import { env, pipeline } from '@huggingface/transformers';

// Force cache into a known path inside the build context.
// @huggingface/transformers stores models under env.cacheDir.
const CACHE_DIR = '/home/perplexica/model-cache';
env.cacheDir = CACHE_DIR;
console.log(`[preload] Cache directory set to: ${CACHE_DIR}`);

const MODELS = [
  'Xenova/bge-small-en-v1.5',
  'Xenova/nomic-embed-text-v1',
];

for (const model of MODELS) {
  console.log(`[preload] Downloading ${model}...`);
  const pipe = await pipeline('feature-extraction', model, { dtype: 'fp32' });
  const out = await pipe(['warmup'], { pooling: 'mean', normalize: true });
  const dims = out.tolist()[0].length;
  console.log(`[preload] ${model} ready (${dims} dims)`);
}

console.log('[preload] All embedding models cached.');
