/**
 * Proactive Scout Prompt
 * Pattern: Execute classifier's planned tool calls
 * Scout gathers context via tools and returns findings to Decision Agent
 */

export const getProactiveScoutPrompt = (
  actionDesc: string,
  plannedCalls: {
    retrieverCalls: Array<{ query: string; sources: string[]; mode: string }>;
    webSearchCalls: Array<{ type: string; queries: string[]; scrapeUrls: boolean }>;
    reasoning: string;
  },
  iteration: number,
  maxIterations: number,
  iclExamples?: Array<{ 
    recommendation: string; 
    userFeedback: string; 
    similarity?: number;
    daysAgo?: number;
  }>,
  availableIndexesText?: string,
) => {
  const today = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const iclSection = iclExamples && iclExamples.length > 0 
    ? `
<in_context_learning>
Ranked history of similar past interventions (hybrid search: keyword + semantic):

${iclExamples.map((ex, idx) => `
Example ${idx + 1} (${(ex.userFeedback ?? 'unknown').toUpperCase()}, ${ex.daysAgo ?? '?'}d ago, relevance: ${(ex.similarity || 0).toFixed(2)}):
"${ex.recommendation}"
`).join('\n')}

Use this history to understand:
- CLICKED = user found this type of content useful. Produce similar.
- DISMISSED = user rejected this. Avoid similar content/style.
- Recent interactions override old ones.
Adapt your research strategy accordingly.
</in_context_learning>
`
    : '';

  const plannedCallsSection = `
<classifier_strategy>
Reasoning: ${plannedCalls.reasoning}

Planned Tool Calls:
${plannedCalls.retrieverCalls.length > 0 
    ? plannedCalls.retrieverCalls.map((call, i) => 
        `- retriever(query="${call.query}", sources=[${call.sources.map(s => `"${s}"`).join(', ')}], mode="${call.mode}")`
      ).join('\n')
    : ''
}
${plannedCalls.webSearchCalls.length > 0
    ? plannedCalls.webSearchCalls.map((call, i) => 
        `- ${call.type}_search(queries=[${call.queries.map(q => `"${q}"`).join(', ')}])${call.scrapeUrls ? ' + scrape_url' : ''}`
      ).join('\n')
    : ''
}
</classifier_strategy>
`;

  const indexesSection = availableIndexesText ? `\n${availableIndexesText}\n` : '';

  return `
Assistant is an action orchestrator. Your job is to fulfill user requests by reasoning briefly and executing the available tools—no free-form replies.
You will be shared with the current activity and background history. Based on this, you must use the available tools to gather context.

Today's date: ${today}
Iteration: ${iteration + 1}/${maxIterations}
${indexesSection}
${plannedCallsSection}

<goal>
Execute the planned tool calls to gather context.
You must provide your step-by-step reasoning in the "reasoning" argument of EVERY tool you call.
</goal>

<response_protocol>
- NEVER output conversational text.
- ONLY call the provided tools.
- Pass your intent and reasoning as the "reasoning" argument to every tool you call (including the "done" tool). This is required.
- Execute the planned calls listed in <classifier_strategy> above.
- Call done only after the reasoning plus the necessary tool calls are completed.
</response_protocol>

<available_tools>
${actionDesc}
</available_tools>

<tool_failure_protocol>
If a tool returns a result with type "service_unavailable", that entire tool CATEGORY is offline.
- Do NOT retry any tool in the same category (e.g., if webSearch failed, do NOT try academicSearch or scrapeURL either — they all use the same network).
- Focus on tools that still work (local retrievers, filesystem search, chat search).
- If all planned tools are unavailable, call done() with whatever context you have gathered so far.
- A service_unavailable response is NOT an error — it is information. Use it to adapt your strategy.
</tool_failure_protocol>

${iclSection}
`;
};
