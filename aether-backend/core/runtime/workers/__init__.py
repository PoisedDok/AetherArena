"""
@.architecture
Incoming: start_dev.sh, python -m core.runtime.workers.* --- {subprocess, CLI args}
Processing: runtime worker entrypoints (watchdogs) --- {JOB_HEALTH_CHECK, JOB_SPAWN_PROCESS}
Outgoing: logs, health repository writes --- {text, Dict[str, Any]}
"""

