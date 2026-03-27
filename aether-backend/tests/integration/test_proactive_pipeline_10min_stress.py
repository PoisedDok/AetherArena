"""
10-Minute Proactive Pipeline Stress Test

Tests pipeline stability over extended period with multiple activity bursts:
1. Creates file activity every 60 seconds for 10 minutes
2. Tracks precise timestamps for each operation
3. Verifies query generation for each burst
4. Monitors cumulative system performance
5. Generates comprehensive latency report

Run: python tests/integration/test_proactive_pipeline_10min_stress.py
"""
import time
import json
import sys
import os
from pathlib import Path
from datetime import datetime, timezone
from typing import Dict, Any
import pytest

# Configuration
API_BASE = "http://localhost:8765/v1/file"
HEALTH_URL = "http://localhost:8765/health"
SAMPLE_DIR = Path(__file__).parent.parent.parent.parent / "sample"
TEST_DURATION_MINUTES = 10
ACTIVITY_INTERVAL_SECONDS = 60


def api_get(endpoint):
    """GET request to API."""
    import urllib.request
    try:
        with urllib.request.urlopen(f"{API_BASE}{endpoint}", timeout=10) as response:
            return json.loads(response.read())
    except Exception:
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
    except Exception:
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
    except Exception:
        return None


def _backend_is_available():
    """Return True when local backend health endpoint is reachable."""
    import urllib.request

    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=5) as response:
            return 200 <= response.status < 300
    except Exception:
        return False


def _int_env(name: str, default: int) -> int:
    """Parse integer env var with safe fallback."""
    value = os.getenv(name)
    if value is None:
        return default
    try:
        parsed = int(value)
        return parsed if parsed > 0 else default
    except ValueError:
        return default


class ProactiveStressTest:
    """10-minute stress test for proactive pipeline."""
    
    def __init__(
        self,
        test_duration_minutes: int = TEST_DURATION_MINUTES,
        activity_interval_seconds: int = ACTIVITY_INTERVAL_SECONDS,
        query_timeout_seconds: int = 45,
    ):
        self.test_id = int(time.time())
        self.test_files = []
        self.activity_log = []
        self.start_time = None
        self.latencies = []
        self.test_duration_minutes = test_duration_minutes
        self.activity_interval_seconds = activity_interval_seconds
        self.query_timeout_seconds = query_timeout_seconds
        
    def timestamp(self):
        """Get current timestamp string."""
        return datetime.now(timezone.utc).strftime('%H:%M:%S.%f')[:-3]
    
    def log_event(self, event_type: str, description: str, data: Dict[str, Any] = None):
        """Log a timestamped event."""
        event = {
            "time": self.timestamp(),
            "elapsed": time.time() - self.start_time if self.start_time else 0,
            "type": event_type,
            "description": description,
            "data": data or {}
        }
        self.activity_log.append(event)
        print(f"[{event['time']}] {event_type}: {description}")
        return event
    
    def print_header(self, title):
        """Print section header."""
        print(f"\n{'='*80}")
        print(f"  {title}")
        print(f"{'='*80}\n")
    
    def setup_system(self):
        """Reset and configure the system."""
        self.print_header("SETUP: System Initialization")
        
        # Reset filesystem daemon
        self.log_event("SETUP", "Resetting filesystem daemon")
        result = api_delete("/daemon/filesystem/data")
        if not result or not result.get("success"):
            print("⚠️  Warning: Could not reset filesystem data")
        
        time.sleep(5)  # Wait for sync
        
        # Configure daemons
        self.log_event("SETUP", "Configuring daemons")
        config = {
            "query_generation": {
                # llm_model intentionally omitted — daemon resolves from central
                # settings via service_type="agent" (Qwen3, the main agent model).
                "check_interval_seconds": 5,
                "enabled": True
            },
            "filesystem": {
                "enabled": True,
                "scan_interval_seconds": 10,
                "watch_locations": [str(SAMPLE_DIR)]
            }
        }
        
        result = api_post("/daemon/config", config)
        if result and result.get("success"):
            self.log_event("SETUP", f"Configured {len(result.get('updated_daemons', []))} daemons")
        else:
            self.log_event("ERROR", "Failed to configure daemons")
            return False
        
        return True
    
    def create_activity_burst(self, burst_number: int) -> Path:
        """Create a burst of file activity."""
        file_path = SAMPLE_DIR / f"stress_test_{self.test_id}_burst_{burst_number:02d}.txt"
        
        content = f"""
# Proactive Stress Test - Burst {burst_number}
# Test ID: {self.test_id}
# Timestamp: {datetime.now().isoformat()}

## Burst Details
- Burst Number: {burst_number}
- Keywords: machine learning, neural networks, deep learning, AI research
- Activity Type: File creation and modification

## Test Objectives
1. Verify filesystem daemon detection
2. Measure query generation latency
3. Monitor system stability over time
4. Track cumulative performance metrics

## Expected Behavior
- Detection: < 1 second
- Query Generation: 10-20 seconds
- System: Stable and responsive
"""
        
        # Create file
        create_time = datetime.now(timezone.utc)
        file_path.write_text(content)
        self.log_event("ACTIVITY", f"Created burst_{burst_number:02d}.txt", {"action": "create"})
        
        # Modify file
        time.sleep(2)
        file_path.write_text(content + f"\n\n## Updated at {datetime.now().isoformat()}")
        self.log_event("ACTIVITY", f"Modified burst_{burst_number:02d}.txt", {"action": "modify"})
        
        self.test_files.append(file_path)
        return file_path
    
    def wait_for_query_generation(self, burst_number: int, file_name: str, timeout: int = 45) -> bool:
        """Wait for query generation and measure latency."""
        trigger_time = datetime.now(timezone.utc)
        start_wait = time.time()
        initial_count = 0
        
        # Get initial query count
        queries_data = api_get("/daemon/query_generation/queries?limit=1")
        if queries_data:
            initial_count = queries_data.get("count", 0)
        
        while time.time() - start_wait < timeout:
            time.sleep(5)
            elapsed = int(time.time() - start_wait)
            
            queries_data = api_get("/daemon/query_generation/queries?limit=5")
            if queries_data and queries_data.get("queries"):
                # Check if our file is in any recent query
                for q in queries_data["queries"]:
                    context_docs = q.get('context_docs', [])
                    is_our_burst = any(file_name in doc.get('file_path', '') for doc in context_docs)
                    
                    if is_our_burst:
                        # Calculate latencies
                        q_time = datetime.fromisoformat(q.get('timestamp').replace('Z', '+00:00'))
                        src_time = datetime.fromisoformat(context_docs[0].get('timestamp').replace('Z', '+00:00'))
                        
                        detect_latency = (src_time - trigger_time).total_seconds()
                        gen_latency = (q_time - src_time).total_seconds()
                        total_latency = (q_time - trigger_time).total_seconds()
                        
                        self.latencies.append({
                            "burst": burst_number,
                            "detect": detect_latency,
                            "generate": gen_latency,
                            "total": total_latency,
                            "query": q.get('query', '')
                        })
                        
                        self.log_event(
                            "LATENCY",
                            f"Burst {burst_number}: Detect={detect_latency:.2f}s, Generate={gen_latency:.2f}s, Total={total_latency:.2f}s",
                            {"query_sample": q.get('query', '')[:50]}
                        )
                        
                        return True
            
            if elapsed % 10 == 0:
                self.log_event("WAIT", f"Waiting for burst {burst_number} query generation... ({elapsed}s)")
        
        self.log_event("TIMEOUT", f"Burst {burst_number} query generation timed out after {timeout}s")
        return False
    
    def run_stress_test(self):
        """Run the 10-minute stress test."""
        self.start_time = time.time()
        self.print_header(f"🔥 PROACTIVE PIPELINE STRESS TEST ({self.test_duration_minutes} MINUTES)")
        
        print(f"Test ID: {self.test_id}")
        print(f"Duration: {self.test_duration_minutes} minutes")
        print(f"Activity Interval: {self.activity_interval_seconds} seconds")
        print(f"Start Time: {self.timestamp()}\n")
        
        # Setup
        if not self.setup_system():
            self.log_event("FATAL", "System setup failed")
            return False
        
        # Calculate number of bursts
        num_bursts = max(1, (self.test_duration_minutes * 60) // self.activity_interval_seconds)
        
        self.print_header(f"STRESS TEST: {num_bursts} Activity Bursts Over {self.test_duration_minutes} Minutes")
        
        successful_bursts = 0
        failed_bursts = 0
        
        for burst_num in range(1, num_bursts + 1):
            burst_start = time.time()
            elapsed_minutes = (burst_start - self.start_time) / 60
            
            self.print_header(f"Burst {burst_num}/{num_bursts} (Elapsed: {elapsed_minutes:.1f} min)")
            
            # Create activity
            file_path = self.create_activity_burst(burst_num)
            
            # Wait for query generation
            if self.wait_for_query_generation(
                burst_num,
                file_path.name,
                timeout=self.query_timeout_seconds,
            ):
                successful_bursts += 1
                self.log_event("SUCCESS", f"Burst {burst_num} completed successfully")
            else:
                failed_bursts += 1
                self.log_event("FAILURE", f"Burst {burst_num} failed")
            
            # Get current stats
            stats = api_get("/daemon/query_generation/stats")
            if stats:
                self.log_event(
                    "STATS",
                    f"System: {stats.get('total_queries', 0)} total queries, {stats.get('source_daemons', 0)} sources",
                    stats
                )
            
            # Wait for next interval (accounting for processing time)
            burst_duration = time.time() - burst_start
            sleep_time = max(0, self.activity_interval_seconds - burst_duration)
            
            if sleep_time > 0 and burst_num < num_bursts:
                self.log_event("IDLE", f"Waiting {sleep_time:.1f}s until next burst...")
                time.sleep(sleep_time)
        
        # Final report
        self.generate_final_report(successful_bursts, failed_bursts, num_bursts)
        
        return failed_bursts == 0
    
    def generate_final_report(self, successful: int, failed: int, total: int):
        """Generate comprehensive final report."""
        self.print_header("📊 FINAL STRESS TEST REPORT")
        
        duration = time.time() - self.start_time
        
        print(f"Test Duration: {duration / 60:.2f} minutes ({duration:.1f}s)")
        print(f"Activity Bursts: {total}")
        print(f"  ✅ Successful: {successful} ({successful/total*100:.1f}%)")
        print(f"  ❌ Failed: {failed} ({failed/total*100:.1f}%)")
        
        if self.latencies:
            self.print_header("⏱️  LATENCY STATISTICS")
            
            detect_latencies = [l['detect'] for l in self.latencies]
            gen_latencies = [l['generate'] for l in self.latencies]
            total_latencies = [l['total'] for l in self.latencies]
            
            print("Detection Latency:")
            print(f"  Min: {min(detect_latencies):.2f}s")
            print(f"  Max: {max(detect_latencies):.2f}s")
            print(f"  Avg: {sum(detect_latencies)/len(detect_latencies):.2f}s")
            
            print("\nGeneration Latency:")
            print(f"  Min: {min(gen_latencies):.2f}s")
            print(f"  Max: {max(gen_latencies):.2f}s")
            print(f"  Avg: {sum(gen_latencies)/len(gen_latencies):.2f}s")
            
            print("\nEnd-to-End Latency:")
            print(f"  Min: {min(total_latencies):.2f}s")
            print(f"  Max: {max(total_latencies):.2f}s")
            print(f"  Avg: {sum(total_latencies)/len(total_latencies):.2f}s")
            
            self.print_header("🔍 SAMPLE GENERATED QUERIES")
            for i, lat in enumerate(self.latencies[:5], 1):
                print(f"{i}. Burst {lat['burst']}: \"{lat['query'][:60]}...\"")
        
        # System health check
        self.print_header("🏥 SYSTEM HEALTH CHECK")
        stats = api_get("/daemon/query_generation/stats")
        if stats:
            print("✅ API Responsive")
            print(f"   Total Queries: {stats.get('total_queries', 0)}")
            print(f"   Source Daemons: {stats.get('source_daemons', 0)}")
            print(f"   Status: {stats.get('status', 'unknown')}")
        else:
            print("❌ API Not Responsive")
        
        # Event log summary
        self.print_header("📝 EVENT SUMMARY")
        event_types = {}
        for event in self.activity_log:
            event_types[event['type']] = event_types.get(event['type'], 0) + 1
        
        for event_type, count in sorted(event_types.items()):
            print(f"  {event_type}: {count} events")
    
    def cleanup(self):
        """Clean up test files."""
        self.print_header("🧹 CLEANUP")
        cleaned = 0
        for file_path in self.test_files:
            try:
                if file_path.exists():
                    file_path.unlink()
                    cleaned += 1
            except Exception as e:
                print(f"⚠️  Could not delete {file_path.name}: {e}")
        
        self.log_event("CLEANUP", f"Removed {cleaned}/{len(self.test_files)} test files")
    
    def run(self):
        """Main test runner."""
        try:
            success = self.run_stress_test()
            
            if success:
                self.print_header("✅ STRESS TEST PASSED")
                print("All bursts processed successfully!")
                print("Pipeline is stable under sustained load.\n")
            else:
                self.print_header("⚠️  STRESS TEST COMPLETED WITH FAILURES")
                print("Some bursts failed to generate queries.")
                print("Review latency report above for details.\n")
            
            return success
            
        except KeyboardInterrupt:
            self.print_header("⏸️  TEST INTERRUPTED BY USER")
            self.log_event("INTERRUPT", "Test stopped by user")
            return False
        
        except Exception as e:
            self.print_header("❌ TEST ERROR")
            print(f"Error: {e}")
            import traceback
            traceback.print_exc()
            return False
        
        finally:
            self.cleanup()


@pytest.mark.integration
@pytest.mark.requires_services
@pytest.mark.slow
def test_proactive_pipeline_stress():
    """
    Enforce stress behavior under pytest.
    Tunable via env vars:
      PROACTIVE_STRESS_DURATION_MINUTES (default: 1)
      PROACTIVE_STRESS_INTERVAL_SECONDS (default: 20)
      PROACTIVE_STRESS_QUERY_TIMEOUT_SECONDS (default: 30)
    """
    if not _backend_is_available():
        pytest.skip("Backend service not running at http://localhost:8765")

    stress_test = ProactiveStressTest(
        test_duration_minutes=_int_env("PROACTIVE_STRESS_DURATION_MINUTES", 1),
        activity_interval_seconds=_int_env("PROACTIVE_STRESS_INTERVAL_SECONDS", 20),
        query_timeout_seconds=_int_env("PROACTIVE_STRESS_QUERY_TIMEOUT_SECONDS", 30),
    )
    assert stress_test.run() is True


if __name__ == "__main__":
    test = ProactiveStressTest()
    success = test.run()
    sys.exit(0 if success else 1)
