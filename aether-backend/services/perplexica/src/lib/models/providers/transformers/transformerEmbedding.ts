import { Chunk } from '@/lib/types';
import BaseEmbedding from '../../base/embedding';

type TransformerConfig = {
  model: string;
};

/**
 * ONNX Embedding via @huggingface/transformers (Transformers.js).
 *
 * CRITICAL: The library's default cacheDir is relative to node_modules
 * (dirname__ + '/.cache/'). In Docker, ONNX models are pre-downloaded
 * to /home/perplexica/model-cache during image build. We set env.cacheDir
 * explicitly so the runtime finds the pre-cached models instead of
 * re-downloading them on first request.
 */
const MODEL_CACHE_DIR = process.env.HF_HOME || '/home/perplexica/model-cache';

class TransformerEmbedding extends BaseEmbedding<TransformerConfig> {
  private pipelinePromise: Promise<any> | null = null;

  constructor(protected config: TransformerConfig) {
    super(config);
  }

  async embedText(texts: string[]): Promise<number[][]> {
    return this.embed(texts);
  }

  async embedChunks(chunks: Chunk[]): Promise<number[][]> {
    return this.embed(chunks.map((c) => c.content));
  }

  private async embed(texts: string[]) {
    if (!this.pipelinePromise) {
      this.pipelinePromise = (async () => {
        const { env, pipeline } = await import('@huggingface/transformers');
        // Point cache at pre-downloaded ONNX models (see Dockerfile + preload script)
        env.cacheDir = MODEL_CACHE_DIR;
        const result = await pipeline('feature-extraction', this.config.model, {
          dtype: 'fp32',
        });
        return result;
      })();
    }

    const pipe = await this.pipelinePromise;
    const output = await pipe(texts, { pooling: 'mean', normalize: true });
    return output.tolist() as number[][];
  }
}

export default TransformerEmbedding;
