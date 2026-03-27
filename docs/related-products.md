# Related Products

## What already exists

There are several categories of existing systems that overlap with parts of what I am building:

- **Chat-first assistants** (ChatGPT, Claude desktop, Ollama WebUI): strong conversational interfaces, but weak on governance and traceability. They do not track why a result was produced or what tools were used to produce it.
- **Local model front-ends** (LM Studio, GPT4All, Jan): desktop UIs that connect to local model runtimes. Mostly focused on chat. Some have basic tool calling, but none have a proactive pipeline or structured agent workflows.
- **Automation and orchestration tools** (LangChain, CrewAI, AutoGen): systems that run multi-step workflows, but they are developer frameworks, not user-facing desktop products.
- **Search and RAG stacks** (Perplexica, PrivateGPT, AnythingLLM): good retrieval, sometimes packaged as a local product, but focused on question-answering over documents rather than agentic workflows or proactive assistance.

## What I am targeting

AetherArena is not another chatbot UI. The gap I am targeting is the combination of:

- **Local-first agentic workflows**: a platform that can host multiple agents, not just one chat session. The flagship use-case is GURU (AI paralegal), but the architecture supports adding more agents without rewriting the system.
- **Context injection under tight budgets**: SLM-focused. Small models need carefully selected evidence — chat history, documents, tool outputs — not just "dump everything into the prompt." This is the core engineering problem.
- **Governance over a large tool surface**: the backend has a tool registry with categorised entries. Routing, validation, and permissions matter when tools can search the web, read files, or execute code.
- **Traceability**: trails and artifacts that make results reproducible. If the system recommends something, I can trace it back to the documents, tool runs, or user actions that produced it.

## Why the gap matters

Existing products tend to do one of these well but not all of them together on-device. The hard engineering is not any single piece — it is getting many components to behave consistently under failure, security constraints, and drift. That is what makes this a software engineering project rather than a model wrapper.
