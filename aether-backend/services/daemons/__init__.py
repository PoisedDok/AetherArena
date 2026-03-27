"""Proactive daemons for log collection and indexing."""
from pathlib import Path

# Shared signal file path for inter-daemon communication.
# Source daemons (browser, email, filesystem) touch this file to signal
# the query generation daemon that new logs are ready for processing.
# Using resolve() to handle macOS /tmp -> /private/tmp symlinks.
QUERY_GEN_SIGNAL_FILE = Path("/tmp/query_gen_signal.trigger").resolve()

# Filesystem daemon touches this to signal the file indexing daemon that
# files changed in a watched (primary) folder.  The indexing daemon checks
# for this file each heartbeat and triggers an immediate primary-only scan.
FILE_INDEX_SIGNAL_FILE = Path("/tmp/file_index_signal.trigger").resolve()

# Signal file touched by the WebSocket router on user chat activity.
# The query generation daemon uses this to pause the proactive pipeline
# while the user is actively engaged in conversation.
CHAT_ACTIVITY_SIGNAL_FILE = Path("/tmp/chat_activity.trigger").resolve()
