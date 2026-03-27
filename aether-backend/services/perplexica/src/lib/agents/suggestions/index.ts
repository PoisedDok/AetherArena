import formatChatHistoryAsString from '@/lib/utils/formatHistory';
import { suggestionGeneratorPrompt } from '@/lib/prompts/suggestions';
import { ChatTurnMessage } from '@/lib/types';
import z from 'zod';
import BaseLLM from '@/lib/models/base/llm';

type SuggestionGeneratorInput = {
  chatHistory: ChatTurnMessage[];
};

const schema = z.object({
  suggestions: z
    .array(z.string())
    .describe('List of suggested questions or prompts'),
});

const generateSuggestions = async (
  input: SuggestionGeneratorInput,
  llm: BaseLLM<any>,
) => {
  try {
    const res = await llm.generateObject<typeof schema>({
      messages: [
        {
          role: 'system',
          content: suggestionGeneratorPrompt,
        },
        {
          role: 'user',
          content: `<chat_history>\n${formatChatHistoryAsString(input.chatHistory)}\n</chat_history>`,
        },
      ],
      schema,
    });
    return res.suggestions;
  } catch (error: any) {
    console.warn("generateObject failed for suggestions, trying fallback...", error.message);

    // Vercel AI SDK often includes the unparseable content in the error message
    const contentMatch = error.message?.match(/content="([\s\S]*?)"(?:, tool_calls|$)/);
    let extractedContent = contentMatch && contentMatch[1] ? contentMatch[1] : null;

    if (!extractedContent) {
      // If we couldn't get it from the error, try a standard text generation fallback
      try {
        const fallbackRes = await llm.generateText({
          messages: [
            {
              role: 'system',
              content: suggestionGeneratorPrompt + "\n\nCRITICAL: Return ONLY a valid JSON object containing a 'suggestions' string array. No markdown formatting, no explanations, no prefix or suffix.",
            },
            {
              role: 'user',
              content: `<chat_history>\n${formatChatHistoryAsString(input.chatHistory)}\n</chat_history>`,
            },
          ],
        });
        extractedContent = fallbackRes.content;
      } catch (fallbackError) {
        console.error("Fallback generateText also failed", fallbackError);
        return [];
      }
    }

    if (extractedContent) {
      // First, try to extract and parse JSON from the content
      try {
        const jsonMatch = extractedContent.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.suggestions && Array.isArray(parsed.suggestions)) {
            return parsed.suggestions;
          }
        }
      } catch (e) {
        // Ignored
      }

      // Second, try to parse bullet points or numbered lists directly
      const lines = extractedContent.split('\n').map((line: string) => line.trim());
      const suggestions = lines
        .filter((line: string) => line.startsWith('-') || line.startsWith('*') || /^\d+\./.test(line))
        .map((line: string) => line.replace(/^[-*]\s*/, '').replace(/^\d+\.\s*/, '').trim())
        .filter((line: string) => line.length > 0);

      if (suggestions.length > 0) {
        return suggestions;
      }
    }

    return [];
  }
};

export default generateSuggestions;
