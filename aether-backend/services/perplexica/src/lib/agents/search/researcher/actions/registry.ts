import z from 'zod';
import { Tool, ToolCall } from '@/lib/models/types';
import {
  ActionOutput,
  AdditionalConfig,
  ClassifierOutput,
  ResearchAction,
  SearchAgentConfig,
  SearchSources,
} from '../../types';

class ActionRegistry {
  private static actions: Map<string, ResearchAction> = new Map();

  /**
   * Cache of JSON Schema representations per action name.
   * Computed once per action on first execute, reused thereafter.
   */
  private static schemaCache: Map<string, Record<string, any>> = new Map();

  static register(action: ResearchAction<any>) {
    this.actions.set(action.name, action);
  }

  static get(name: string): ResearchAction | undefined {
    return this.actions.get(name);
  }

  static getAvailableActions(config: {
    classification: ClassifierOutput;
    fileIds: string[];
    mode: SearchAgentConfig['mode'];
    sources: SearchSources[];
  }): ResearchAction[] {
    return Array.from(
      this.actions.values().filter((action) => action.enabled(config)),
    );
  }

  static getAvailableActionTools(config: {
    classification: ClassifierOutput;
    fileIds: string[];
    mode: SearchAgentConfig['mode'];
    sources: SearchSources[];
  }): Tool[] {
    const availableActions = this.getAvailableActions(config);

    return availableActions.map((action) => ({
      name: action.name,
      description: action.getToolDescription({ mode: config.mode }),
      schema: action.schema,
    }));
  }

  static getAvailableActionsDescriptions(config: {
    classification: ClassifierOutput;
    fileIds: string[];
    mode: SearchAgentConfig['mode'];
    sources: SearchSources[];
  }): string {
    const availableActions = this.getAvailableActions(config);

    return availableActions
      .map(
        (action) =>
          `<tool name="${action.name}">\n${action.getDescription({ mode: config.mode })}\n</tool>`,
      )
      .join('\n\n');
  }

  /**
   * Coerce LLM tool call arguments to match expected schema types.
   *
   * LLMs (especially smaller models) sometimes produce a plain string
   * where the schema declares an array. For example:
   *   Schema: queries: z.array(z.string())
   *   LLM returns: queries: "quantum computing"  (string, not array)
   *
   * This causes TypeError crashes in action handlers that call .map()
   * on the field. Rather than patching every handler, we fix it at the
   * execution boundary using the declared schema as source of truth.
   */
  private static coerceToolArgs(
    params: Record<string, any>,
    actionName: string,
    schema: z.ZodObject<any>,
  ): Record<string, any> {
    let jsonSchema = this.schemaCache.get(actionName);

    if (!jsonSchema) {
      try {
        jsonSchema = z.toJSONSchema(schema) as Record<string, any>;
        this.schemaCache.set(actionName, jsonSchema);
      } catch {
        return params;
      }
    }

    const properties = jsonSchema.properties;
    if (!properties || typeof properties !== 'object') return params;

    let needsCoercion = false;
    for (const [key, propSchema] of Object.entries(properties) as [
      string,
      any,
    ][]) {
      if (!(key in params) || params[key] == null) continue;

      if (propSchema.type === 'array' && typeof params[key] === 'string') {
        needsCoercion = true;
        break;
      }
    }

    if (!needsCoercion) return params;

    const coerced = { ...params };

    for (const [key, propSchema] of Object.entries(properties) as [
      string,
      any,
    ][]) {
      if (!(key in coerced) || coerced[key] == null) continue;

      if (propSchema.type === 'array' && typeof coerced[key] === 'string') {
        try {
          const parsed = JSON.parse(coerced[key]);
          coerced[key] = Array.isArray(parsed) ? parsed : [coerced[key]];
        } catch {
          coerced[key] = [coerced[key]];
        }
      }
    }

    return coerced;
  }

  static async execute(
    name: string,
    params: any,
    additionalConfig: AdditionalConfig & {
      researchBlockId: string;
      fileIds: string[];
    },
  ) {
    const action = this.actions.get(name);

    if (!action) {
      throw new Error(`Action with name ${name} not found`);
    }

    const coercedParams = this.coerceToolArgs(params, name, action.schema);

    return action.execute(coercedParams, additionalConfig);
  }

  static async executeAll(
    actions: ToolCall[],
    additionalConfig: AdditionalConfig & {
      researchBlockId: string;
      fileIds: string[];
    },
  ): Promise<ActionOutput[]> {
    const results: ActionOutput[] = [];

    await Promise.all(
      actions.map(async (actionConfig) => {
        const output = await this.execute(
          actionConfig.name,
          actionConfig.arguments,
          additionalConfig,
        );
        results.push(output);
      }),
    );

    return results;
  }
}

export default ActionRegistry;
