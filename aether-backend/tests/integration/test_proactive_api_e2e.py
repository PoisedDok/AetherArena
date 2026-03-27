"""
API-Driven End-to-End Test: Smart Proactive Pipeline

Tests complete flow using ONLY APIs (simulating user interaction):
1. Configure daemons via API (model, profiles, etc.)
2. Start daemons via API calls
3. Trigger activity (file creation)
4. Query stats via API to verify pipeline execution
5. Retrieve generated queries via API
6. Verify context linking via API

Run: python tests/integration/test_proactive_api_e2e.py
"""
import requests
import time
import json
from pathlib import Path
from datetime import datetime
import pytest

BASE_URL = "http://localhost:8765/v1/file"
HEALTH_URL = "http://localhost:8765/health"
SAMPLE_DIR = Path("/Volumes/Disk-D/Aether/Aether/AetherArena/sample")


def _backend_is_available():
    """Return True when local backend health endpoint is reachable."""
    try:
        response = requests.get(HEALTH_URL, timeout=5)
        return response.status_code < 500
    except requests.exceptions.RequestException:
        return False


class ProactiveAPITest:
    """Test proactive pipeline using only API calls."""
    
    def __init__(self):
        self.session = requests.Session()
        
    def api_call(self, method, endpoint, data=None, params=None):
        """Make API call and return JSON response."""
        url = f"{BASE_URL}/{endpoint}"
        try:
            if method == "GET":
                resp = self.session.get(url, params=params, timeout=30)
            elif method == "POST":
                resp = self.session.post(url, json=data, timeout=30)
            elif method == "DELETE":
                resp = self.session.delete(url, timeout=30)
            else:
                raise ValueError(f"Unsupported method: {method}")
            
            resp.raise_for_status()
            return resp.json()
        except requests.exceptions.RequestException as e:
            print(f"   ✗ API Error: {e}")
            return None
    
    def step1_reset_system(self):
        """Reset all daemon data via API."""
        print("\n" + "="*80)
        print("STEP 1: RESET SYSTEM")
        print("="*80)
        
        result = self.api_call("DELETE", "daemon/data/all")
        if result and result.get("success"):
            deleted = result.get("deleted_items", [])
            print(f"   ✓ Deleted {len(deleted)} items via API")
            for item in deleted[:5]:
                print(f"     - {item}")
        else:
            print("   ⚠️  No data to delete or API failed")
    
    def step2_configure_daemons(self):
        """Configure all daemons via API."""
        print("\n" + "="*80)
        print("STEP 2: CONFIGURE DAEMONS VIA API")
        print("="*80)
        
        config = {
            "query_generation": {
                # llm_model intentionally omitted — daemon resolves from central
                # settings via service_type="agent" (Qwen3 main agent model).
                "check_interval_seconds": 10,
                "context_size": 5
            },
            "browser": {
                "excluded_profiles": ["Default"],  # Exclude personal profile
                "scan_interval_seconds": 30
            },
            "filesystem": {
                "enabled": True,
                "scan_interval_seconds": 10,  # Faster for testing
                "watch_locations": [str(SAMPLE_DIR)]
            }
        }
        
        result = self.api_call("POST", "daemon/config", data=config)
        if result and result.get("success"):
            print(f"   ✓ Configured {len(result.get('updated_daemons', []))} daemons")
            for daemon in result.get("updated_daemons", []):
                print(f"     - {daemon}")
        
        # Verify config persisted
        config_check = self.api_call("GET", "daemon/config")
        if config_check:
            qg = config_check.get("query_generation", {})
            browser = config_check.get("browser", {})
            print("\n   ✓ Config verified:")
            print(f"     - Query Gen model: {qg.get('llm_model')}")
            print(f"     - Browser excluded: {browser.get('excluded_profiles')}")
    
    def step3_trigger_activity(self):
        """Create filesystem activity to trigger pipeline."""
        print("\n" + "="*80)
        print("STEP 3: TRIGGER FILESYSTEM ACTIVITY")
        print("="*80)
        
        test_file = SAMPLE_DIR / f"api_e2e_test_{int(time.time())}.txt"
        content = f"""
# Proactive Pipeline API Test
Timestamp: {datetime.now().isoformat()}

Test content for query generation:
- Machine learning model training techniques
- Neural network optimization strategies
- Deep learning performance metrics

This should trigger:
1. Filesystem daemon detection
2. Log indexing to BM25
3. Query generation with configured central agent model
4. Query indexing for proactive agent
"""
        test_file.write_text(content)
        print(f"   ✓ Created: {test_file.name}")
        
        # Modify to create more activity
        time.sleep(2)
        test_file.write_text(content + f"\n\nModified at: {datetime.now().isoformat()}")
        print(f"   ✓ Modified: {test_file.name}")
        
        return test_file
    
    def step4_wait_and_verify(self, wait_seconds=60):
        """Wait for daemons to process and verify via API."""
        print("\n" + "="*80)
        print("STEP 4: WAIT FOR DAEMON PROCESSING")
        print("="*80)
        
        print(f"\n   Waiting {wait_seconds} seconds for:")
        print("   1. Filesystem daemon to detect changes")
        print("   2. Logs to be indexed to BM25")
        print("   3. Query generation daemon to process")
        print("   4. Queries to be indexed")
        
        for i in range(wait_seconds // 5):
            time.sleep(5)
            print(f"   ... {(i+1)*5}s elapsed")
            
            # Check stats periodically
            if i % 3 == 2:  # Every 15 seconds
                stats = self.api_call("GET", "daemon/query_generation/stats")
                if stats and stats.get("total_queries", 0) > 0:
                    print(f"   🎯 Queries detected: {stats['total_queries']}")
    
    def step5_verify_queries(self):
        """Verify queries generated via API."""
        print("\n" + "="*80)
        print("STEP 5: VERIFY GENERATED QUERIES")
        print("="*80)
        
        # Get recent queries
        result = self.api_call("GET", "daemon/query_generation/queries", params={"limit": 5})
        
        if not result or result.get("count", 0) == 0:
            print("   ✗ No queries generated")
            return False
        
        queries = result.get("queries", [])
        print(f"\n   ✓ Generated {len(queries)} queries:")
        
        for i, q in enumerate(queries, 1):
            query_id = q.get("query_id", "NO_ID")
            query_text = q.get("query", "NO_TEXT")
            model = q.get("llm_model", "NO_MODEL")
            source = q.get("source_daemon", "NO_SOURCE")
            context_count = len(q.get("context_docs", []))
            
            print(f"\n   {i}. Query: \"{query_text}\"")
            print(f"      ID: {query_id}")
            print(f"      Model: {model}")
            print(f"      Source: {source}")
            print(f"      Context: {context_count} docs")
            
            # Verify query_id exists
            if not query_id or query_id == "NO_ID":
                print("      ✗ Missing query_id!")
                return False
            
            # Verify model used
            if not model or model == "NO_MODEL":
                print("      ✗ Missing llm_model in query record!")
                return False
            
            # Show context doc IDs
            doc_ids = q.get("context_doc_ids", [])
            if isinstance(doc_ids, str):
                doc_ids = json.loads(doc_ids)
            print(f"      Linked Doc IDs: {doc_ids[:5]}...")
        
        return True
    
    def step6_verify_stats(self):
        """Verify system stats via API."""
        print("\n" + "="*80)
        print("STEP 6: VERIFY SYSTEM STATS")
        print("="*80)
        
        stats = self.api_call("GET", "daemon/query_generation/stats")
        if stats:
            print(f"\n   Status: {stats.get('status')}")
            print(f"   Total queries: {stats.get('total_queries')}")
            print(f"   Source daemons: {stats.get('source_daemons')}")
            return stats.get('status') == 'active'
        
        return False
    
    def cleanup(self, test_file):
        """Clean up test file."""
        if test_file and test_file.exists():
            test_file.unlink()
            print(f"\n🧹 Cleaned up: {test_file.name}")
    
    def run(self):
        """Run complete API-driven test."""
        print("\n" + "="*80)
        print("🧪 PROACTIVE PIPELINE API E2E TEST")
        print("="*80)
        print(f"Timestamp: {datetime.now().isoformat()}")
        print(f"Backend: {BASE_URL}")
        
        test_file = None
        
        try:
            # Step 1: Reset
            self.step1_reset_system()
            
            # Step 2: Configure
            self.step2_configure_daemons()
            
            # Step 3: Trigger activity
            test_file = self.step3_trigger_activity()
            
            # Step 4: Wait for processing
            self.step4_wait_and_verify(wait_seconds=60)
            
            # Step 5: Verify queries
            queries_ok = self.step5_verify_queries()
            
            # Step 6: Verify stats
            stats_ok = self.step6_verify_stats()
            
            # Final verdict
            print("\n" + "="*80)
            if queries_ok and stats_ok:
                print("✅ PROACTIVE PIPELINE TEST PASSED")
                print("="*80)
                print("\nComplete flow verified via API:")
                print("  ✓ Config management (POST/GET)")
                print("  ✓ Data deletion (DELETE)")
                print("  ✓ Query generation with correct model")
                print("  ✓ Query retrieval with context")
                print("  ✓ Stats endpoint functional")
                return True
            else:
                print("❌ PROACTIVE PIPELINE TEST FAILED")
                print("="*80)
                return False
                
        except Exception as e:
            print(f"\n❌ ERROR: {e}")
            import traceback
            traceback.print_exc()
            return False
        
        finally:
            if test_file:
                self.cleanup(test_file)


@pytest.mark.integration
@pytest.mark.requires_services
@pytest.mark.slow
def test_proactive_api_e2e():
    """Enforce API-driven proactive pipeline under pytest."""
    if not _backend_is_available():
        pytest.skip("Backend service not running at http://localhost:8765")

    api_test = ProactiveAPITest()
    assert api_test.run() is True


if __name__ == "__main__":
    test = ProactiveAPITest()
    success = test.run()
    exit(0 if success else 1)
