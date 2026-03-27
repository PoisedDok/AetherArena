"""
End-to-End Test: Smart Proactive Pipeline (API-Driven)

Tests complete flow using ONLY APIs (no direct DB access):
1. Configure daemons via API
2. Trigger activity (filesystem changes)
3. Verify detection via API
4. Check query generation via API
5. Verify BM25 indexing via API

Run: python tests/integration/test_proactive_pipeline_e2e.py
"""
import time
import json
import sys
from pathlib import Path
from datetime import datetime, timezone
import pytest

# Configuration
API_BASE = "http://localhost:8765/v1/file"
HEALTH_URL = "http://localhost:8765/health"
SAMPLE_DIR = Path(__file__).parent.parent.parent.parent / "sample"


def api_get(endpoint):
    """GET request to API."""
    import urllib.request
    try:
        with urllib.request.urlopen(f"{API_BASE}{endpoint}", timeout=10) as response:
            return json.loads(response.read())
    except Exception as e:
        print(f"   API GET error: {e}")
        return None


def api_post(endpoint, data):
    """POST request to API."""
    import urllib.request
    try:
        req = urllib.request.Request(
            f"{API_BASE}{endpoint}",
            data=json.dumps(data).encode('utf-8'),
            headers={'Content-Type': 'application/json'}
        )
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.loads(response.read())
    except Exception as e:
        print(f"   API POST error: {e}")
        return None


def api_delete(endpoint):
    """DELETE request to API."""
    import urllib.request
    try:
        req = urllib.request.Request(
            f"{API_BASE}{endpoint}",
            method='DELETE'
        )
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.loads(response.read())
    except Exception as e:
        print(f"   API DELETE error: {e}")
        return None


def _backend_is_available():
    """Return True when local backend health endpoint is reachable."""
    import urllib.request

    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=5) as response:
            return 200 <= response.status < 300
    except Exception:
        return False


class ProactivePipelineTest:
    """API-driven test for the complete proactive pipeline."""
    
    def __init__(self):
        self.test_file = SAMPLE_DIR / f"e2e_test_{int(time.time())}.txt"
        
    def print_header(self, title):
        """Print section header."""
        print(f"\n{'='*80}")
        print(f"  {title}")
        print(f"{'='*80}\n")
        
    def step1_reset_via_api(self):
        """Step 1: Reset ONLY filesystem daemon data via API."""
        self.print_header("STEP 1: Reset Filesystem Daemon via API")
        
        # Only clear filesystem to preserve other daemons (Browser, Email, etc.)
        result = api_delete("/daemon/filesystem/data")
        if result and result.get("success"):
            print("✓ Deleted filesystem daemon data and BM25 index")
            print("  Waiting 5s for daemon to sync fresh state...")
            time.sleep(5)
            return True
        else:
            print("✗ Failed to delete filesystem data")
            return False
    
    def step2_configure_via_api(self):
        """Step 2: Configure daemons via API."""
        self.print_header("STEP 2: Configure Daemons via API")
        
        config = {
            "query_generation": {
                # llm_model intentionally omitted — daemon resolves from central
                # settings via service_type="agent" (Qwen3, the main agent model).
                "check_interval_seconds": 10,
                "enabled": True
            },
            "browser": {
                "excluded_profiles": ["Default"],
                "enabled": True
            },
            "filesystem": {
                "enabled": True,
                "scan_interval_seconds": 10,
                "watch_locations": [str(SAMPLE_DIR)]
            },
            "email": {
                "enabled": True
            }
        }
        
        result = api_post("/daemon/config", config)
        if result and result.get("success"):
            print(f"✓ Configured {len(result.get('updated_daemons', []))} daemons")
            print("  Model: resolved from central config (Qwen3 main agent model)")
            print("  Browser excluded: Default (personal)")
            print("  Filesystem watching: sample folder")
            return True
        else:
            print("✗ Failed to configure")
            return False
    
    def step3_verify_config_via_api(self):
        """Step 3: Verify configuration persisted."""
        self.print_header("STEP 3: Verify Config Persistence")
        
        config = api_get("/daemon/config")
        if config:
            qg = config.get("query_generation", {})
            browser = config.get("browser", {})
            print("✓ Config loaded from API:")
            print(f"  Query Gen Model: {qg.get('llm_model')}")
            print(f"  Browser Excluded: {browser.get('excluded_profiles')}")
            # Model comes from central config (Qwen3) — just verify config loaded
            return qg.get("enabled") is True
        else:
            print("✗ Failed to get config")
            return False
    
    def step4_trigger_activity(self):
        """Step 4: Trigger filesystem activity."""
        self.print_header("STEP 4: Trigger Filesystem Activity")
        
        content = f"""
# Proactive Pipeline Test - {datetime.now().isoformat()}

Testing Keywords: artificial intelligence, machine learning, deep learning
Context: Testing the smart proactive query generation system
Goal: Verify end-to-end pipeline from file change to query indexing

This file should:
1. Be detected by filesystem daemon
2. Trigger query generation (threshold=1 for filesystem)
3. Generate queries using the main agent model (Qwen3 from central config)
4. Index queries to BM25 for proactive agent
"""
        
        self.test_file.write_text(content)
        print(f"✓ Created test file: {self.test_file.name}")
        
        # Modify to create more activity
        time.sleep(2)
        self.test_file.write_text(content + f"\n\nUpdated: {datetime.now().isoformat()}")
        print("✓ Modified test file")
        
        return True
    
    def step5_wait_for_query_generation(self, timeout=120):
        """Step 5: Wait for query generation and track latency."""
        self.print_header("STEP 5: Latency Analysis (End-to-End)")
        
        trigger_time = datetime.now(timezone.utc)
        print(f"⏰ Trigger Time (File Change): {trigger_time.isoformat()}")
        print("Waiting for daemons to process...")
        
        start_time = time.time()
        
        while time.time() - start_time < timeout:
            time.sleep(5)
            elapsed = int(time.time() - start_time)
            
            # Check query count
            queries_data = api_get("/daemon/query_generation/queries?limit=1")
            if queries_data and queries_data.get("queries"):
                q = queries_data["queries"][0]
                
                # Check if this query is linked to our test activity
                context_docs = q.get('context_docs', [])
                is_our_activity = any(self.test_file.name in doc.get('file_path', '') for doc in context_docs)
                
                if is_our_activity:
                    # Parse Timestamps for Latency Calculation
                    q_time_str = q.get('timestamp')
                    q_time = datetime.fromisoformat(q_time_str.replace('Z', '+00:00'))
                    
                    # Source detection time (from first context doc)
                    src_time_str = context_docs[0].get('timestamp')
                    src_time = datetime.fromisoformat(src_time_str.replace('Z', '+00:00'))
                    
                    self.print_header("📈 PIPELINE LATENCY REPORT")
                    print(f"1. [ACTIVITY] File Created/Modified : {trigger_time.strftime('%H:%M:%S.%f')[:-3]}")
                    
                    # Delta 1: Detection Latency
                    detect_latency = (src_time - trigger_time).total_seconds()
                    print(f"2. [SOURCE]   Detected by Daemon     : {src_time.strftime('%H:%M:%S.%f')[:-3]} (Δ {detect_latency:.2f}s)")
                    
                    # Delta 2: Generation Latency
                    gen_latency = (q_time - src_time).total_seconds()
                    print(f"3. [AGENT]    Queries Generated      : {q_time.strftime('%H:%M:%S.%f')[:-3]} (Δ {gen_latency:.2f}s)")
                    
                    # Total E2E
                    total_latency = (q_time - trigger_time).total_seconds()
                    print(f"\n🚀 Total End-to-End Latency: {total_latency:.2f} seconds")
                    
                    print(f"\n📋 Generated Query Sample: \"{q.get('query')}\"")
                    return True
            
            print(f"   [{elapsed}s] Polling API...")
        
        print(f"\n✗ Timeout after {timeout}s")
        return False
    
    def step6_verify_stats_via_api(self):
        """Step 6: Verify system stats via API."""
        self.print_header("STEP 6: Verify System Stats via API")
        
        stats = api_get("/daemon/query_generation/stats")
        if stats:
            print("✓ Query Generation Stats:")
            print(f"  Total Queries: {stats.get('total_queries', 0)}")
            print(f"  Source Daemons: {stats.get('source_daemons', 0)}")
            print(f"  Status: {stats.get('status', 'unknown')}")
            return True
        else:
            print("✗ Failed to get stats")
            return False
    
    def cleanup(self):
        """Clean up test file."""
        if self.test_file.exists():
            self.test_file.unlink()
            print(f"\n🧹 Cleaned up: {self.test_file.name}\n")
    
    def run(self):
        """Run complete API-driven test."""
        try:
            print("\n" + "🧪 PROACTIVE PIPELINE E2E TEST (API-DRIVEN)" + "\n")
            print(f"Test File: {self.test_file}")
            print(f"API Base: {API_BASE}")
            print(f"Timestamp: {datetime.now().isoformat()}\n")
            
            # Step 1: Reset via API
            if not self.step1_reset_via_api():
                print("\n❌ TEST FAILED: Could not reset system")
                return False
            
            # Step 2: Configure via API
            if not self.step2_configure_via_api():
                print("\n❌ TEST FAILED: Could not configure daemons")
                return False
            
            # Step 3: Verify config
            if not self.step3_verify_config_via_api():
                print("\n❌ TEST FAILED: Config not persisted")
                return False
            
            # Step 4: Trigger activity
            if not self.step4_trigger_activity():
                print("\n❌ TEST FAILED: Could not create activity")
                return False
            
            # Step 5: Wait for query generation
            if not self.step5_wait_for_query_generation():
                print("\n❌ TEST FAILED: Query generation did not process activity")
                return False
            
            # Step 6: Verify stats
            if not self.step6_verify_stats_via_api():
                print("\n⚠️  WARNING: Could not verify stats")
            
            # Success
            self.print_header("✅ TEST PASSED")
            print("Complete proactive pipeline verified via APIs:")
            print("  1. ✓ Config reset via DELETE API")
            print("  2. ✓ Daemons configured via POST API")
            print("  3. ✓ Config persisted and retrieved via GET API")
            print("  4. ✓ Filesystem activity detected")
            print("  5. ✓ Queries generated using configured LLM")
            print("  6. ✓ System stats accessible via API")
            print("\nAll operations performed via REST APIs (user-accessible).\n")
            return True
            
        except Exception as e:
            print(f"\n❌ ERROR: {e}")
            import traceback
            traceback.print_exc()
            return False
        
        finally:
            self.cleanup()


@pytest.mark.integration
@pytest.mark.requires_services
@pytest.mark.slow
def test_proactive_pipeline_e2e_api_driven():
    """Enforce E2E proactive pipeline behavior under pytest."""
    if not _backend_is_available():
        pytest.skip("Backend service not running at http://localhost:8765")

    pipeline_test = ProactivePipelineTest()
    assert pipeline_test.run() is True


if __name__ == "__main__":
    test = ProactivePipelineTest()
    success = test.run()
    sys.exit(0 if success else 1)
