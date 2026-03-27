import time
import requests
import sqlite3
import json
import subprocess
import sys
from pathlib import Path
from datetime import datetime, timezone

# URLs
BASE_URL = "http://localhost:8765"
ACTIVITY_LOG_URL = f"{BASE_URL}/v1/sources/activity/log"
LATEST_UNSEEN_URL = f"{BASE_URL}/v1/proactive/latest-unseen"

# SQLite DB paths
APP_ROOT = Path(__file__).resolve().parent.parent.parent
QUERY_DB_PATH = APP_ROOT / "data" / "daemons" / "query_generation" / "queries.db"

# Scenarios to test
SCENARIOS = [
    {
        "name": "Scenario 1: User Study (Aerosol Transmission Offline)",
        "payloads": [
            {
                "url": "aether://index/trec_covid/user_study_1",
                "title": "COVID-19 Aerosol Transmission Initial Search",
                "text_content": "User is starting a deep dive on how COVID-19 transmits via aerosols in enclosed spaces. OFFLINE RETRIEVER REQUIRED. QUERY SAME INDEX REPEATEDLY IF NEEDED."
            },
            {
                "url": "aether://index/trec_covid/user_study_2",
                "title": "COVID-19 Aerosol Transmission Study Part 2",
                "text_content": "The study investigates the aerosol transmission of COVID-19 in enclosed spaces. OFFLINE RETRIEVER REQUIRED. SCRAPE FULL DOCS IF NEEDED."
            }
        ],
        "expected_topics": ["aerosol", "transmission", "covid"]
    },
    {
        "name": "Scenario 2: Specific User Mimic (Vaccine Efficacy)",
        "payloads": [
            {
                "url": "aether://index/trec_covid/vaccine_1",
                "title": "mRNA Vaccine Efficacy Analysis",
                "text_content": "User is looking for data regarding mRNA vaccine long-term efficacy and waning immunity. OFFLINE RETRIEVER REQUIRED."
            },
            {
                "url": "aether://index/trec_covid/vaccine_2",
                "title": "Clinical Trial Results for Boosters",
                "text_content": "Looking at booster shots and neutralizing antibody levels. OFFLINE RETRIEVER REQUIRED."
            }
        ],
        "expected_topics": ["vaccine", "efficacy", "booster", "mrna", "immunity"]
    }
]

def inject_scenario(scenario):
    print(f"\n{'='*80}")
    print(f"[{datetime.now().isoformat()}] Starting {scenario['name']}")
    print(f"{'='*80}")
    
    for i, payload in enumerate(scenario["payloads"]):
        print(f"[{datetime.now().isoformat()}] Injecting payload {i+1}...")
        response = requests.post(ACTIVITY_LOG_URL, json=payload, timeout=30)
        response.raise_for_status()
        time.sleep(1) # Delay to ensure sequential processing
        
    data = response.json()
    print(f"✅ Payloads injected successfully.")
    return data.get("log_id")

def check_query_generation(start_time_threshold, timeout=120):
    print(f"[{datetime.now().isoformat()}] Waiting for Query Generation Daemon (up to {timeout}s)...")
    start_time = time.time()
    
    while time.time() - start_time < timeout:
        if QUERY_DB_PATH.exists():
            try:
                conn = sqlite3.connect(QUERY_DB_PATH)
                conn.row_factory = sqlite3.Row
                cursor = conn.execute(
                    "SELECT * FROM generated_queries ORDER BY timestamp DESC LIMIT 10"
                )
                rows = cursor.fetchall()
                for row in rows:
                    try:
                        row_time = datetime.fromisoformat(row["timestamp"].replace("Z", "+00:00")).timestamp()
                    except:
                        row_time = time.time()
                        
                    if row_time > start_time_threshold - 5: # 5 seconds buffer
                        context_docs = json.loads(row["context_docs"])
                        is_our_activity = any("trec_covid" in doc.get("metadata", {}).get("url", "") for doc in context_docs)
                        
                        if is_our_activity:
                            print(f"✅ Query generated: {row['query']}")
                            return dict(row)
            except Exception as e:
                print(f"Database error: {e}")
            finally:
                if 'conn' in locals() and conn:
                    conn.close()
        time.sleep(5)
    print("❌ Timeout waiting for query generation.")
    return None

def check_agent_worker(query_id, timeout=180):
    print(f"[{datetime.now().isoformat()}] Waiting for Proactive Agent Worker to finish query {query_id} (up to {timeout}s)...")
    start_time = time.time()
    
    while time.time() - start_time < timeout:
        try:
            conn = sqlite3.connect(QUERY_DB_PATH)
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                "SELECT used_by_agent FROM generated_queries WHERE query_id = ?", 
                (query_id,)
            )
            row = cursor.fetchone()
            if row and row["used_by_agent"] == 1:
                print(f"✅ Proactive Agent Worker successfully processed the query.")
                return True
            elif row and row["used_by_agent"] == -1:
                print(f"❌ Proactive Agent Worker FAILED to process the query.")
                return False
        except Exception as e:
            pass
        finally:
            if 'conn' in locals() and conn:
                conn.close()
        time.sleep(5)
    print("❌ Timeout waiting for agent worker.")
    return False

def check_latest_unseen(expected_topics):
    print(f"[{datetime.now().isoformat()}] Fetching notification via API...")
    try:
        response = requests.get(LATEST_UNSEEN_URL, timeout=10)
        response.raise_for_status()
        data = response.json()
        
        if not data.get("has_unseen"):
            print("⚠️ No unseen notification found. The agent may have decided to defer.")
            return None
            
        print(f"✅ Unseen notification retrieved successfully.")
        print(f"   - Run ID: {data.get('run_id')}")
        
        recommendation = data.get('recommendation', '')
        print(f"\n--- RECOMMENDATION TONE & CONTENT ---")
        print(f"{recommendation}\n-------------------------------------")
        
        # Verify Tone/Content
        found_topics = [t for t in expected_topics if t.lower() in recommendation.lower()]
        if found_topics:
            print(f"✅ Recommendation is on-topic. Mentions: {', '.join(found_topics)}")
        else:
            print(f"⚠️ Warning: Recommendation might be off-topic. Expected mentions from {expected_topics}")
            
        return data.get('run_id')
        
    except Exception as e:
        print(f"❌ Error fetching latest unseen: {e}")
        return None

def verify_db_metadata(run_id):
    print(f"\n[{datetime.now().isoformat()}] Verifying Rich Metadata directly from Database for run {run_id}...")
    
    query = f"""
    SELECT json_build_object(
        'decision', decision,
        'llm_model', llm_model,
        'tool_calls_count', tool_calls_count,
        'executed_tools', executed_tools,
        'context_gathered', context_gathered,
        'reasoning_traces', reasoning_traces
    ) FROM proactive_agent_runs WHERE id = '{run_id}';
    """
    try:
        cmd = ["docker", "exec", "supabase-db", "psql", "-U", "supabase_admin", "-d", "aether", "-t", "-A", "-c", query]
        output = subprocess.check_output(cmd, text=True).strip()
        
        if not output or output == "null":
            print("❌ Run ID not found in database.")
            return False
            
        run_data = json.loads(output)
        
        # 1. Decision
        print(f"   - Decision: {run_data.get('decision')}")
        
        # 2. Tool Calls
        tool_count = run_data.get('tool_calls_count', 0)
        executed_tools = run_data.get('executed_tools', [])
        print(f"   - Tool Calls Count: {tool_count}")
        print(f"   - Executed Tools Array Size: {len(executed_tools)}")
        
        if tool_count > 0 and len(executed_tools) == 0:
            print(f"   ❌ ERROR: tool_calls_count is {tool_count} but executed_tools array is empty. Bug in execution tracking!")
            return False
        elif tool_count == 0:
            print(f"   ⚠️ Warning: Agent didn't use any tools.")
        else:
            print(f"   ✅ Executed Tools: {[t.get('tool', t) if isinstance(t, dict) else t for t in executed_tools]}")
            
        # 3. Context Gathered
        context = run_data.get('context_gathered', [])
        if len(context) > 0:
            print(f"   ✅ Context Gathered: {len(context)} items.")
            # Check for ICL or standard structure
            for i, c in enumerate(context[:2]):
                source = c.get('source', 'Unknown')
                print(f"      Context {i+1} Source: {source}")
        else:
            print(f"   ❌ ERROR: Context Gathered is empty. Retriever may have failed.")
            return False
            
        # 4. Reasoning Traces (Tone/ICL check)
        traces = run_data.get('reasoning_traces', [])
        print(f"   ✅ Reasoning Traces: {len(traces)} steps recorded.")
        
        return True
        
    except Exception as e:
        print(f"❌ Error verifying DB metadata: {e}")
        return False

def main():
    print(f"Starting Robust Proactive Pipeline Test Suite...")
    
    for idx, scenario in enumerate(SCENARIOS):
        start_time = time.time()
        
        # 1. Inject
        inject_scenario(scenario)
        
        # 2. Await Query Gen
        query_row = check_query_generation(start_time_threshold=start_time)
        if not query_row:
            print(f"⏭️ Skipping remainder of {scenario['name']} due to Query Gen failure.\n")
            continue
            
        # 3. Await Agent Worker
        worker_success = check_agent_worker(query_row["query_id"])
        if not worker_success:
            print(f"⏭️ Skipping remainder of {scenario['name']} due to Agent Worker failure.\n")
            continue
            
        # 4. Await DB Sync & Check Unseen
        time.sleep(2)
        run_id = check_latest_unseen(scenario["expected_topics"])
        
        # 5. Verify Metadata Robustness
        if run_id:
            verify_db_metadata(run_id)
        else:
            print(f"⚠️ No run ID returned. Agent might have deferred, so no intervention was sent.")
            
        print(f"\n✅ Scenario {idx+1} complete.\n")

if __name__ == "__main__":
    main()