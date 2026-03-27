"""
Proactive Context Injection Service

Provides infrastructure for proactive context assembly and prediction.

Components:
- logic/: LogProcessor, TraceGenerator for "creaming" raw logs
- (Future) agent.py: Magnetic ReAct agent for proactive interventions

@.architecture
Incoming: Daemons (browser, email, filesystem) --- {SQLite logs, BM25 indexes}
Processing: Log creaming, pattern extraction, proactive query formulation --- {Multiple jobs}
Outgoing: Proactive agent responses, UI notifications --- {streamed responses}
"""

__all__ = []
