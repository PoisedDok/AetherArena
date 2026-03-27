import OpenAI from 'openai/index.js';
import BaseLLM from '../../base/llm';
import {
  GenerateObjectInput,
  GenerateOptions,
  GenerateTextInput,
  GenerateTextOutput,
  StreamTextOutput,
  ToolCall,
} from '../../types';
import { parse } from 'partial-json';
import z from 'zod';
import {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
} from 'openai/resources/index.js';
import { Message } from '@/lib/types';
import { repairJson } from '@toolsycc/json-repair';

/**
 * Parse tool calls embedded as text in the content field.
 *
 * Different LLM backends emit tool calls using model-native tokens in the
 * content field instead of the standard OpenAI `tool_calls` structure.
 * This function handles two known formats:
 *
 * Format A (LFM via vLLM-MLX):
 *   <|tool_call_start|>[func_name(key="value", ...)]<|tool_call_end|>
 *
 * Format B (Qwen3 via vLLM-MLX):
 *   <tool_call>{"name": "func_name", "arguments": {...}}</tool_call>
 *
 * Both are extracted into the standard ToolCall format so the agent loop
 * processes them correctly.
 */
function parseToolCallsFromContent(content: string): ToolCall[] {
  const results: ToolCall[] = [];

  // ── Format A: LFM — <|tool_call_start|>[func(args)]<|tool_call_end|> ──
  const TOOL_BLOCK_REGEX =
    /<\|tool_call_start\|>\[([\s\S]*?)\]<\|tool_call_end\|>/g;

  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = TOOL_BLOCK_REGEX.exec(content)) !== null) {
    const inner = blockMatch[1].trim();

    const calls = splitToolCalls(inner);

    for (const call of calls) {
      const parenIdx = call.indexOf('(');
      if (parenIdx === -1) continue;

      const funcName = call.substring(0, parenIdx).trim();

      const argsRaw = extractBalancedArgs(call, parenIdx);
      if (argsRaw === null) continue;

      const args = parseKeyValueArgs(argsRaw);

      results.push({
        id: `call_${crypto.randomUUID().substring(0, 8)}`,
        name: funcName,
        arguments: args,
      });
    }
  }

  // ── Format B: Qwen3 — <tool_call>{"name":"...","arguments":{...}}</tool_call> ──
  const QWEN_TOOL_REGEX = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

  let qwenMatch: RegExpExecArray | null;
  while ((qwenMatch = QWEN_TOOL_REGEX.exec(content)) !== null) {
    const raw = qwenMatch[1].trim();
    if (!raw) continue;

    try {
      const json = JSON.parse(raw);
      if (json.name) {
        results.push({
          id: `call_${crypto.randomUUID().substring(0, 8)}`,
          name: json.name,
          arguments: json.arguments || {},
        });
      }
    } catch {
      try {
        const repaired = repairJson(raw, { extractJson: true }) as string;
        const json = JSON.parse(repaired);
        if (json.name) {
          results.push({
            id: `call_${crypto.randomUUID().substring(0, 8)}`,
            name: json.name,
            arguments: json.arguments || {},
          });
        }
      } catch {
        // Unparseable tool call content — skip
      }
    }
  }

  return results;
}

/**
 * Split a string of multiple function calls separated by commas,
 * respecting nested brackets and quotes.
 */
function splitToolCalls(inner: string): string[] {
  // Most common case: single function call
  if (!inner.includes('),')) return [inner];

  const calls: string[] = [];
  let depth = 0;
  let inStr = false;
  let escape = false;
  let start = 0;

  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"' && !escape) { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) {
      calls.push(inner.substring(start, i).trim());
      start = i + 1;
    }
  }
  const last = inner.substring(start).trim();
  if (last) calls.push(last);
  return calls;
}

/**
 * Extract the content between balanced parentheses starting at parenIdx.
 */
function extractBalancedArgs(call: string, parenIdx: number): string | null {
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = parenIdx; i < call.length; i++) {
    const c = call[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"' && !escape) { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '(') depth++;
    if (c === ')') {
      depth--;
      if (depth === 0) {
        return call.substring(parenIdx + 1, i);
      }
    }
  }
  // Fallback: take everything after the opening paren
  return call.substring(parenIdx + 1).replace(/\)$/, '');
}

/**
 * Parse key=value argument strings where values can be:
 *   "string", 123, true, false, ["array"], {"object"}
 *
 * Input: queries=["Krish Dokania"], type="web"
 * Output: { queries: ["Krish Dokania"], type: "web" }
 */
function parseKeyValueArgs(argsRaw: string): Record<string, any> {
  const args: Record<string, any> = {};
  let pos = 0;
  const s = argsRaw.trim();

  while (pos < s.length) {
    // Skip whitespace and commas
    while (pos < s.length && (s[pos] === ' ' || s[pos] === ',' || s[pos] === '\n')) pos++;
    if (pos >= s.length) break;

    // Extract key
    const eqIdx = s.indexOf('=', pos);
    if (eqIdx === -1) break;
    const key = s.substring(pos, eqIdx).trim();
    pos = eqIdx + 1;

    // Skip whitespace after =
    while (pos < s.length && s[pos] === ' ') pos++;
    if (pos >= s.length) break;

    // Extract value based on first character
    const ch = s[pos];
    let value: any;

    if (ch === '"') {
      // Quoted string — find matching close quote
      const endQuote = findClosingQuote(s, pos);
      value = s.substring(pos + 1, endQuote);
      pos = endQuote + 1;
    } else if (ch === '[' || ch === '{') {
      // JSON array or object — find matching bracket
      const endBracket = findMatchingBracket(s, pos);
      const jsonStr = s.substring(pos, endBracket + 1);
      try {
        value = JSON.parse(jsonStr);
      } catch {
        value = jsonStr;
      }
      pos = endBracket + 1;
    } else {
      // Raw value (number, boolean, unquoted string)
      let endPos = pos;
      while (endPos < s.length && s[endPos] !== ',' && s[endPos] !== ')') endPos++;
      const raw = s.substring(pos, endPos).trim();
      if (raw === 'true') value = true;
      else if (raw === 'false') value = false;
      else if (!isNaN(Number(raw)) && raw !== '') value = Number(raw);
      else value = raw;
      pos = endPos;
    }

    args[key] = value;
  }

  return args;
}

function findClosingQuote(s: string, startQuote: number): number {
  for (let i = startQuote + 1; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '"') return i;
  }
  return s.length - 1;
}

function findMatchingBracket(s: string, startBracket: number): number {
  const open = s[startBracket];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inStr = false;
  for (let i = startBracket; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && inStr) { i++; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === open) depth++;
    if (c === close) { depth--; if (depth === 0) return i; }
  }
  return s.length - 1;
}

/**
 * Check if content contains partial or complete tool call tokens.
 * Supports both LFM (<|tool_call_start|>...<|tool_call_end|>) and
 * Qwen3 (<tool_call>...</tool_call>) formats.
 * Returns 'none' if no tool call tokens found, 'partial' if start found
 * but not end, 'complete' if both start and end found.
 */
function detectToolCallState(
  content: string,
): 'none' | 'partial' | 'complete' {
  // LFM format
  const hasLFMStart = content.includes('<|tool_call_start|>');
  const hasLFMEnd = content.includes('<|tool_call_end|>');
  if (hasLFMStart && hasLFMEnd) return 'complete';
  if (hasLFMStart) return 'partial';

  // Qwen3 format
  const hasQwenStart = content.includes('<tool_call>');
  const hasQwenEnd = content.includes('</tool_call>');
  if (hasQwenStart && hasQwenEnd) return 'complete';
  if (hasQwenStart) return 'partial';

  return 'none';
}

/** Check if content contains any tool call start token (either format). */
function hasToolCallStart(content: string): boolean {
  return (
    content.includes('<|tool_call_start|>') || content.includes('<tool_call>')
  );
}

/** Check if content contains any tool call end token (either format). */
function hasToolCallEnd(content: string): boolean {
  return (
    content.includes('<|tool_call_end|>') || content.includes('</tool_call>')
  );
}

type OpenAIConfig = {
  apiKey: string;
  model: string;
  baseURL?: string;
  options?: GenerateOptions;
};

class OpenAILLM extends BaseLLM<OpenAIConfig> {
  openAIClient: OpenAI;

  constructor(protected config: OpenAIConfig) {
    super(config);

    this.openAIClient = new OpenAI({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseURL || 'https://api.openai.com/v1',
      timeout: 300000, // 5 minutes (fixes Docker vpnkit/undici early termination on slow local models)
      maxRetries: 2,
    });
  }

  convertToOpenAIMessages(messages: Message[]): ChatCompletionMessageParam[] {
    return messages.map((msg) => {
      if (msg.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: msg.id,
          content: msg.content,
        } as ChatCompletionToolMessageParam;
      } else if (msg.role === 'assistant') {
        return {
          role: 'assistant',
          content: msg.content,
          ...(msg.tool_calls &&
            msg.tool_calls.length > 0 && {
              tool_calls: msg.tool_calls?.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.arguments),
                },
              })),
            }),
        } as ChatCompletionAssistantMessageParam;
      }

      return msg;
    });
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const openaiTools: ChatCompletionTool[] = [];

    input.tools?.forEach((tool) => {
      openaiTools.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: z.toJSONSchema(tool.schema),
        },
      });
    });

    const response = await this.openAIClient.chat.completions.create({
      model: this.config.model,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      messages: this.convertToOpenAIMessages(input.messages),
      temperature:
        input.options?.temperature ?? this.config.options?.temperature ?? 0.6,
      top_p: input.options?.topP ?? this.config.options?.topP,
      max_completion_tokens:
        input.options?.maxTokens ?? this.config.options?.maxTokens,
      stop: input.options?.stopSequences ?? this.config.options?.stopSequences,
      frequency_penalty:
        input.options?.frequencyPenalty ??
        this.config.options?.frequencyPenalty,
      presence_penalty:
        input.options?.presencePenalty ?? this.config.options?.presencePenalty,
    });

    if (response.choices && response.choices.length > 0) {
      const msg = response.choices[0].message;
      const content = msg.content || '';

      // ── Standard path: server populated tool_calls field ───────────
      let toolCalls: ToolCall[] =
        msg.tool_calls
          ?.map((tc) => {
            if (tc.type === 'function') {
              return {
                name: tc.function.name,
                id: tc.id,
                arguments: JSON.parse(tc.function.arguments),
              };
            }
          })
          .filter((tc) => tc !== undefined) || [];

      // ── Fallback: parse tool calls from content field ─────────────
      // Handles models (e.g. LFM) that emit tool calls as text tokens
      // in the content field instead of the structured tool_calls field.
      if (
        toolCalls.length === 0 &&
        openaiTools.length > 0 &&
        detectToolCallState(content) === 'complete'
      ) {
        const contentToolCalls = parseToolCallsFromContent(content);
        if (contentToolCalls.length > 0) {
          toolCalls = contentToolCalls;
        }
      }

      return {
        content,
        toolCalls,
        additionalInfo: {
          finishReason: response.choices[0].finish_reason,
        },
      };
    }

    throw new Error('No response from OpenAI');
  }

  async *streamText(
    input: GenerateTextInput,
  ): AsyncGenerator<StreamTextOutput> {
    const openaiTools: ChatCompletionTool[] = [];

    input.tools?.forEach((tool) => {
      openaiTools.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: z.toJSONSchema(tool.schema),
        },
      });
    });

    const stream = await this.openAIClient.chat.completions.create({
      model: this.config.model,
      messages: this.convertToOpenAIMessages(input.messages),
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      temperature:
        input.options?.temperature ?? this.config.options?.temperature ?? 0.6,
      top_p: input.options?.topP ?? this.config.options?.topP,
      max_completion_tokens:
        input.options?.maxTokens ?? this.config.options?.maxTokens,
      stop: input.options?.stopSequences ?? this.config.options?.stopSequences,
      frequency_penalty:
        input.options?.frequencyPenalty ??
        this.config.options?.frequencyPenalty,
      presence_penalty:
        input.options?.presencePenalty ?? this.config.options?.presencePenalty,
      stream: true,
    });

    let recievedToolCalls: { name: string; id: string; arguments: string }[] =
      [];

    // ── Content-based tool call detection state ─────────────────────
    // When tools are requested but the backend doesn't populate
    // delta.tool_calls (e.g. LFM via vLLM-MLX), tool call tokens
    // arrive as text in delta.content. We buffer content when we
    // detect <|tool_call_start|> and emit parsed ToolCalls when
    // <|tool_call_end|> is found.
    let contentBuffer = '';
    let bufferingToolCall = false;
    const hasTools = openaiTools.length > 0;

    for await (const chunk of stream) {
      if (chunk.choices && chunk.choices.length > 0) {
        const delta = chunk.choices[0].delta;
        const nativeToolCalls = delta.tool_calls;
        const contentDelta = delta.content || '';
        const isDone = chunk.choices[0].finish_reason !== null;

        if (contentDelta) {
          console.log(`[OpenAILLM] Raw content delta: ${contentDelta}`);
        }
        if (nativeToolCalls) {
          console.log(`[OpenAILLM] Native tool calls:`, JSON.stringify(nativeToolCalls));
        }

        // ── Path A: Server provided native tool_calls (Qwen3, etc.) ──
        if (nativeToolCalls && nativeToolCalls.length > 0) {
          yield {
            contentChunk: contentDelta,
            toolCallChunk:
              nativeToolCalls.map((tc) => {
                if (!recievedToolCalls[tc.index]) {
                  const call = {
                    name: tc.function?.name!,
                    id: tc.id!,
                    arguments: tc.function?.arguments || '',
                  };
                  recievedToolCalls.push(call);
                  return { ...call, arguments: parse(call.arguments || '{}') };
                } else {
                  const existingCall = recievedToolCalls[tc.index];
                  existingCall.arguments += tc.function?.arguments || '';
                  return {
                    ...existingCall,
                    arguments: parse(existingCall.arguments),
                  };
                }
              }),
            done: isDone,
            additionalInfo: {
              finishReason: chunk.choices[0].finish_reason,
            },
          };
          continue;
        }

        // ── Path B: Content-based tool call detection (LFM, Qwen3) ────
        // Handles both LFM (<|tool_call_start|>...<|tool_call_end|>) and
        // Qwen3 (<tool_call>...</tool_call>) token formats.
        if (hasTools && contentDelta) {
          contentBuffer += contentDelta;

          // Start buffering when any tool call start token detected
          if (!bufferingToolCall && hasToolCallStart(contentBuffer)) {
            bufferingToolCall = true;
          }

          if (bufferingToolCall) {
            // Check if we have a complete tool call (either format)
            if (hasToolCallEnd(contentBuffer)) {
              const parsed = parseToolCallsFromContent(contentBuffer);
              if (parsed.length > 0) {
                yield {
                  contentChunk: '',
                  toolCallChunk: parsed,
                  done: isDone,
                  additionalInfo: {
                    finishReason: isDone ? 'tool_calls' : null,
                  },
                };
                // Reset buffer after emitting tool calls
                contentBuffer = '';
                bufferingToolCall = false;
                continue;
              }
            }
            // Still buffering — don't yield content yet
            if (isDone) {
              // Stream ended while buffering — attempt parse of partial buffer
              const parsed = parseToolCallsFromContent(contentBuffer);
              if (parsed.length > 0) {
                yield {
                  contentChunk: '',
                  toolCallChunk: parsed,
                  done: true,
                  additionalInfo: { finishReason: 'tool_calls' },
                };
              } else {
                // Failed to parse — yield buffered content as-is
                yield {
                  contentChunk: contentBuffer,
                  toolCallChunk: [],
                  done: true,
                  additionalInfo: {
                    finishReason: chunk.choices[0].finish_reason,
                  },
                };
              }
              contentBuffer = '';
              bufferingToolCall = false;
            }
            continue;
          }
        }

        // ── Path C: Regular content (no tool call tokens) ────────────
        yield {
          contentChunk: contentDelta,
          toolCallChunk: [],
          done: isDone,
          additionalInfo: {
            finishReason: chunk.choices[0].finish_reason,
          },
        };
      }
    }

    // ── End of stream: flush any remaining buffer ─────────────────────
    if (bufferingToolCall && contentBuffer.length > 0) {
      const parsed = parseToolCallsFromContent(contentBuffer);
      if (parsed.length > 0) {
        yield {
          contentChunk: '',
          toolCallChunk: parsed,
          done: true,
          additionalInfo: { finishReason: 'tool_calls' },
        };
      } else {
        yield {
          contentChunk: contentBuffer,
          toolCallChunk: [],
          done: true,
          additionalInfo: { finishReason: 'stop' },
        };
      }
    }
  }

  /**
   * Extract structured data from the LLM using tool calling.
   *
   * WHY TOOL CALLING (not response_format):
   * - `response_format: json_schema` is NOT supported by vLLM-MLX, many
   *   local inference servers, and older OpenAI-compatible proxies.
   * - Tool calling is the universal lowest common denominator — every
   *   provider that serves chat completions supports it.
   * - Tool-calling-trained models (Qwen3, LFM, GPT, Gemini) naturally
   *   express structured extraction as function calls.
   *
   * Response parsing uses a 3-path cascade:
   *   A) Native `tool_calls` field (OpenAI, Groq, Qwen3 via vLLM-MLX)
   *   B) Content-based tool call tokens (LFM via vLLM-MLX)
   *   C) Raw JSON in content (fallback for servers that return text)
   */
  async generateObject<T>(input: GenerateObjectInput): Promise<T> {
    const jsonSchema = z.toJSONSchema(input.schema);

    // Prepare OpenAI request parameters
    const requestParams: any = {
      messages: this.convertToOpenAIMessages(input.messages),
      model: this.config.model,
      temperature:
        input.options?.temperature ?? this.config.options?.temperature ?? 0.6,
      top_p: input.options?.topP ?? this.config.options?.topP,
      max_completion_tokens:
        input.options?.maxTokens ?? this.config.options?.maxTokens,
      stop: input.options?.stopSequences ?? this.config.options?.stopSequences,
      frequency_penalty:
        input.options?.frequencyPenalty ??
        this.config.options?.frequencyPenalty,
      presence_penalty:
        input.options?.presencePenalty ?? this.config.options?.presencePenalty,
    };

    // If json mode is specifically requested, configure for JSON output instead of tool calling
    if (input.mode === 'json') {
      requestParams.response_format = { type: 'json_object' };
      // Inject schema requirement into messages if possible
      const schemaString = JSON.stringify(jsonSchema, null, 2);
      if (requestParams.messages.length > 0 && requestParams.messages[0].role === 'system') {
        requestParams.messages[0].content += `\n\nReturn ONLY valid JSON that strictly matches this schema: ${schemaString}`;
      } else {
        requestParams.messages.unshift({
          role: 'system',
          content: `Return ONLY valid JSON that strictly matches this schema: ${schemaString}`,
        });
      }
    } else {
      // Default tool calling mode
      requestParams.tools = [
        {
          type: 'function' as const,
          function: {
            name: 'extract',
            description: 'Extract structured data from the input.',
            parameters: jsonSchema,
          },
        },
      ];
      requestParams.tool_choice = {
        type: 'function' as const,
        function: { name: 'extract' },
      };
    }

    const response = await this.openAIClient.chat.completions.create(requestParams);

    if (!response.choices || response.choices.length === 0) {
      throw new Error('generateObject: No response from server');
    }

    const msg = response.choices[0].message;
    const content = msg.content || '';
    let parsed: unknown = null;

    // If json mode was requested, expect output in content directly
    if (input.mode === 'json' && content) {
      try {
        parsed = JSON.parse(content);
      } catch {
        try {
          parsed = JSON.parse(
            repairJson(content, { extractJson: true }) as string,
          );
        } catch {
          // Fallback to regex extraction just in case
          const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/);
          if (jsonMatch) {
            try {
              parsed = JSON.parse(jsonMatch[1]);
            } catch {
              try {
                parsed = JSON.parse(
                  repairJson(jsonMatch[1], { extractJson: true }) as string,
                );
              } catch {
                // Ignore
              }
            }
          }
        }
      }
    }

    // ── Path A: Native tool_calls field (Qwen3, OpenAI, Groq, Gemini) ──
    if (parsed === null && msg.tool_calls && msg.tool_calls.length > 0) {
      const funcCall = msg.tool_calls.find((tc) => tc.type === 'function');
      if (funcCall && funcCall.type === 'function') {
        const argsStr = funcCall.function.arguments;
        try {
          parsed = JSON.parse(argsStr);
        } catch {
          try {
            parsed = JSON.parse(
              repairJson(argsStr, { extractJson: true }) as string,
            );
          } catch {
            // Path A failed — fall through to B/C
          }
        }
      }
    }

    // ── Path B: Content-based tool call tokens (LFM via vLLM-MLX) ──────
    if (parsed === null && content) {
      const contentToolCalls = parseToolCallsFromContent(content);
      if (contentToolCalls.length > 0) {
        parsed = contentToolCalls[0].arguments;
      }
    }

    // ── Path C: Raw JSON in content (fallback for text-only servers) ────
    if (parsed === null && content) {
      try {
        parsed = JSON.parse(
          repairJson(content, { extractJson: true }) as string,
        );
      } catch {
        // All paths exhausted
      }
    }

    if (parsed === null) {
      throw new Error(
        `generateObject: No extractable structured output. ` +
          `content=${content ? `"${content.substring(0, 200)}"` : 'null'}, ` +
          `tool_calls=${msg.tool_calls ? msg.tool_calls.length : 0}`,
      );
    }

    try {
      return input.schema.parse(parsed) as T;
    } catch (err) {
      throw new Error(
        `generateObject: Schema validation failed. ` +
          `parsed=${JSON.stringify(parsed).substring(0, 300)}, error=${err}`,
      );
    }
  }

  /**
   * Stream structured data extraction using tool calling.
   *
   * Same tool-calling approach as generateObject but in streaming mode.
   * Accumulates tool_calls argument deltas and yields partial parses
   * via the partial-json parser. Falls back to content-based parsing
   * for models that emit tool calls as content tokens (LFM).
   *
   * Currently zero callers in the codebase — implemented to satisfy
   * the BaseLLM abstract interface and prevent future breakage.
   */
  async *streamObject<T>(input: GenerateObjectInput): AsyncGenerator<T> {
    const jsonSchema = z.toJSONSchema(input.schema);

    const stream = await this.openAIClient.chat.completions.create({
      model: this.config.model,
      messages: this.convertToOpenAIMessages(input.messages),
      temperature:
        input.options?.temperature ?? this.config.options?.temperature ?? 0.6,
      top_p: input.options?.topP ?? this.config.options?.topP,
      max_completion_tokens:
        input.options?.maxTokens ?? this.config.options?.maxTokens,
      stop: input.options?.stopSequences ?? this.config.options?.stopSequences,
      frequency_penalty:
        input.options?.frequencyPenalty ??
        this.config.options?.frequencyPenalty,
      presence_penalty:
        input.options?.presencePenalty ?? this.config.options?.presencePenalty,
      tools: [
        {
          type: 'function' as const,
          function: {
            name: 'extract',
            description: 'Extract structured data from the input.',
            parameters: jsonSchema,
          },
        },
      ],
      tool_choice: {
        type: 'function' as const,
        function: { name: 'extract' },
      },
      stream: true,
    });

    let accumulatedArgs = '';
    let contentBuffer = '';
    let usedNativeToolCalls = false;

    for await (const chunk of stream) {
      if (!chunk.choices || chunk.choices.length === 0) continue;

      const delta = chunk.choices[0].delta;

      // ── Path A: Native tool_calls argument deltas ──────────────────
      if (delta.tool_calls && delta.tool_calls.length > 0) {
        usedNativeToolCalls = true;
        const argsDelta = delta.tool_calls[0].function?.arguments || '';
        accumulatedArgs += argsDelta;

        try {
          yield parse(accumulatedArgs) as T;
        } catch {
          // Partial JSON not yet parseable — skip this yield
        }
        continue;
      }

      // ── Accumulate content for Path B/C ────────────────────────────
      if (delta.content) {
        contentBuffer += delta.content;

        // If no native tool_calls seen yet, try progressive JSON parse
        if (!usedNativeToolCalls) {
          try {
            yield parse(contentBuffer) as T;
          } catch {
            // Not valid partial JSON yet — skip
          }
        }
      }
    }

    // ── End of stream: yield final validated result ───────────────────
    if (usedNativeToolCalls && accumulatedArgs) {
      try {
        const finalParsed = JSON.parse(accumulatedArgs);
        yield input.schema.parse(finalParsed) as T;
      } catch {
        try {
          const repaired = repairJson(accumulatedArgs, {
            extractJson: true,
          }) as string;
          yield input.schema.parse(JSON.parse(repaired)) as T;
        } catch {
          // Best-effort final yield already happened via partial parses
        }
      }
      return;
    }

    // ── Content-based fallback (Path B: tool call tokens in content) ──
    if (contentBuffer) {
      const contentToolCalls = parseToolCallsFromContent(contentBuffer);
      if (contentToolCalls.length > 0) {
        try {
          yield input.schema.parse(contentToolCalls[0].arguments) as T;
          return;
        } catch {
          // Fall through to raw JSON
        }
      }

      // Path C: Raw JSON content
      try {
        const repaired = repairJson(contentBuffer, {
          extractJson: true,
        }) as string;
        yield input.schema.parse(JSON.parse(repaired)) as T;
      } catch {
        // All paths exhausted — last partial yield was best effort
      }
    }
  }
}

export default OpenAILLM;
