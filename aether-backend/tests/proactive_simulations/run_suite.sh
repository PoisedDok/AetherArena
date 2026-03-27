#!/bin/bash
# PROACTIVE PIPELINE SIMULATION SUITE
# This script orchestrates a production-grade end-to-end simulation of the Aether proactive pipeline.

# 1. SETUP ENVIRONMENT
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
export AETHER_BACKEND_ROOT="$( cd "$SCRIPT_DIR/../../" && pwd )"

# Environment detection and config loading
if [ -f "$HOME/Library/Application Support/Aether/config/local.env" ]; then
    CONFIG_FILE="$HOME/Library/Application Support/Aether/config/local.env"
    echo "🔧 [Simulation] Using production config: $CONFIG_FILE"
elif [ -f "$AETHER_BACKEND_ROOT/config/local.env" ]; then
    CONFIG_FILE="$AETHER_BACKEND_ROOT/config/local.env"
    echo "🔧 [Simulation] Using development config: $CONFIG_FILE"
else
    echo "❌ [Simulation] Error: local.env not found!"
    exit 1
fi

# Export all keys so Python subprocesses inherit the exact same secrets
set -a
source "$CONFIG_FILE"
set +a

export PYTHONPATH="$AETHER_BACKEND_ROOT:$PYTHONPATH"
export DAEMON_LOG_LEVEL="INFO"
export DAEMON_LOG_TO_STDOUT="1"

mkdir -p "$AETHER_BACKEND_ROOT/logs"

# Define important paths
DAEMON_MANAGER="$AETHER_BACKEND_ROOT/services/daemons/daemon_manager.py"
SIMULATION_RUNNER="$AETHER_BACKEND_ROOT/tests/proactive_simulations/run_scenarios.py"

# 2. START PROACTIVE DAEMONS (Phase 1)
echo "🚀 [Simulation] Starting Phase 1: Proactive Daemons via daemon_manager.py..."
python3 "$DAEMON_MANAGER" > "$AETHER_BACKEND_ROOT/logs/daemons_sim.log" 2>&1 &
DAEMON_PID=$!

# 3. START PROACTIVE AGENT WORKER (Phase 2)
echo "🚀 [Simulation] Starting Phase 2: Proactive Agent Worker (standalone)..."
python3 "$AETHER_BACKEND_ROOT/tests/proactive_simulations/standalone_worker.py" > "$AETHER_BACKEND_ROOT/logs/worker_sim.log" 2>&1 &
WORKER_PID=$!

# Wait for components to initialize
echo "⏳ [Simulation] Waiting for components to initialize (15s)..."
sleep 15

# 4. RUN SIMULATION SCENARIOS (Injection and Query Gen monitoring)
echo "🎬 [Simulation] Injecting simulation scenarios..."
python3 "$SIMULATION_RUNNER"

# 5. MONITOR PROGRESS
echo "🔍 [Simulation] Monitoring Perplexica Agent logs (Docker)..."
# We'll just tail the logs and look for our interventions
docker logs --tail 50 -f aether-perplexica > "$AETHER_BACKEND_ROOT/logs/perplexica_sim.log" 2>&1 &
DOCKER_LOG_PID=$!

# Wait for 120 seconds for the entire pipeline to process all scenarios
echo "⏳ [Simulation] Pipeline running end-to-end (120s)..."
sleep 120

# 6. REPORT RESULTS
echo "📊 [Simulation] Final results check..."
echo "--- Generated Queries ---"
sqlite3 "$AETHER_BACKEND_ROOT/data/daemons/query_generation/queries.db" "SELECT timestamp, query_text FROM generated_queries ORDER BY timestamp DESC LIMIT 10"
echo "--- Agent Interventions ---"
grep "INTERVENTION" "$AETHER_BACKEND_ROOT/logs/worker_sim.log" | tail -n 10

# 7. CLEANUP
echo "🧹 [Simulation] Cleaning up simulation resources..."
kill $DAEMON_PID 2>/dev/null
kill $WORKER_PID 2>/dev/null
kill $DOCKER_LOG_PID 2>/dev/null

echo "✅ [Simulation] Simulation suite finished."
