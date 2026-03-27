import { UIConfigField } from '@/lib/config/types';
import { getConfiguredModelProviderById } from '@/lib/config/serverRegistry';
import BaseModelProvider from '../../base/provider';
import { Model, ModelList, ProviderMetadata } from '../../types';
import LMStudioLLM from './lmstudioLLM';
import BaseLLM from '../../base/llm';
import BaseEmbedding from '../../base/embedding';
import LMStudioEmbedding from './lmstudioEmbedding';

interface LMStudioConfig {
  baseURL: string;
}

const providerConfigFields: UIConfigField[] = [
  {
    type: 'string',
    name: 'Base URL',
    key: 'baseURL',
    description: 'The base URL for LM Studio server',
    required: true,
    placeholder: 'http://localhost:1234',
    env: 'LM_STUDIO_BASE_URL',
    scope: 'server',
  },
];

class LMStudioProvider extends BaseModelProvider<LMStudioConfig> {
  constructor(id: string, name: string, config: LMStudioConfig) {
    super(id, name, config);
  }

  private normalizeBaseURL(url: string): string {
    const trimmed = url.trim().replace(/\/+$/, '');
    return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
  }

  async getDefaultModels(): Promise<ModelList> {
    try {
      const baseURL = this.normalizeBaseURL(this.config.baseURL);

      const res = await fetch(`${baseURL}/models`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const data = await res.json();

      const models: Model[] = data.data.map((m: any) => {
        return {
          name: m.id,
          key: m.id,
        };
      });

      return {
        embedding: models,
        chat: models,
      };
    } catch (err) {
      if (err instanceof TypeError) {
        throw new Error(
          'Error connecting to LM Studio. Please ensure the base URL is correct and the LM Studio server is running.',
        );
      }

      throw err;
    }
  }

  async getModelList(): Promise<ModelList> {
    const defaultModels = await this.getDefaultModels();
    const configProvider = getConfiguredModelProviderById(this.id)!;

    return {
      embedding: [
        ...defaultModels.embedding,
        ...configProvider.embeddingModels,
      ],
      chat: [...defaultModels.chat, ...configProvider.chatModels],
    };
  }

  async loadChatModel(key: string): Promise<BaseLLM<any>> {
    try {
      const modelList = await this.getModelList();

      // Exact match first
      let exists = modelList.chat.find((m) => m.key === key);

      if (!exists) {
        // Loose match: the configured key may be an alias
        // while the server reports full IDs (e.g. "lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit").
        // Try case-insensitive substring match on the model name portion.
        const keyLower = key.toLowerCase();
        exists = modelList.chat.find((m) => {
          const mLower = m.key.toLowerCase();
          return mLower.includes(keyLower) || keyLower.includes(mLower);
        });
      }

      if (!exists) {
        // No match found in the server model list. Log a warning but proceed —
        // the inference server may accept aliases/short-names that aren't in
        // the /v1/models list. Let the actual completion call decide validity.
        console.warn(
          `[LMStudioProvider] Model key "${key}" not found in server model list. ` +
            `Proceeding anyway — the inference server may resolve aliases.`,
        );
      }
    } catch (err) {
      // Server unreachable or model list fetch failed — log but proceed.
      // The actual chat completion call will surface a clearer error.
      console.warn(
        `[LMStudioProvider] Could not validate model "${key}" against server: ${err}. Proceeding anyway.`,
      );
    }

    return new LMStudioLLM({
      apiKey: 'lm-studio',
      model: key,
      baseURL: this.normalizeBaseURL(this.config.baseURL),
    });
  }

  async loadEmbeddingModel(key: string): Promise<BaseEmbedding<any>> {
    try {
      const modelList = await this.getModelList();

      let exists = modelList.embedding.find((m) => m.key === key);

      if (!exists) {
        const keyLower = key.toLowerCase();
        exists = modelList.embedding.find((m) => {
          const mLower = m.key.toLowerCase();
          return mLower.includes(keyLower) || keyLower.includes(mLower);
        });
      }

      if (!exists) {
        console.warn(
          `[LMStudioProvider] Embedding model key "${key}" not found in server model list. ` +
            `Proceeding anyway — the inference server may resolve aliases.`,
        );
      }
    } catch (err) {
      console.warn(
        `[LMStudioProvider] Could not validate embedding model "${key}" against server: ${err}. Proceeding anyway.`,
      );
    }

    return new LMStudioEmbedding({
      apiKey: 'lm-studio',
      model: key,
      baseURL: this.normalizeBaseURL(this.config.baseURL),
    });
  }

  static parseAndValidate(raw: any): LMStudioConfig {
    if (!raw || typeof raw !== 'object')
      throw new Error('Invalid config provided. Expected object');
    if (!raw.baseURL)
      throw new Error('Invalid config provided. Base URL must be provided');

    return {
      baseURL: String(raw.baseURL),
    };
  }

  static getProviderConfigFields(): UIConfigField[] {
    return providerConfigFields;
  }

  static getProviderMetadata(): ProviderMetadata {
    return {
      key: 'lmstudio',
      name: 'LM Studio',
    };
  }
}

export default LMStudioProvider;
