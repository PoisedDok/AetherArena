"""
Cross-Source Proactive Test: Window Switching + File Activity

Tests the proactive pipeline's ability to generate queries from MULTIPLE sources:
1. Switches between Cursor IDE and LM Studio (active_windows logs)
2. Creates file activity (filesystem logs)
3. Waits for cross-source query generation
4. Captures queries WITH full context documents
5. Displays for quality evaluation

Run: python tests/integration/test_cross_source_window_switching.py
"""
import time
import json
import sys
import subprocess
from pathlib import Path
from datetime import datetime, timezone
import shutil
import os
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
        print(f"   API Error: {e}")
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


def _window_switch_test_enabled():
    """Cross-source window test is explicit opt-in for local macOS runs."""
    return os.getenv("PROACTIVE_ENABLE_WINDOW_SWITCHING_TEST", "0") == "1"


def _can_switch_windows():
    """Return True if osascript-based app switching can run."""
    return sys.platform == "darwin" and shutil.which("osascript") is not None


def timestamp():
    """Get current timestamp."""
    return datetime.now(timezone.utc).strftime('%H:%M:%S.%f')[:-3]


def print_header(title):
    """Print section header."""
    print(f"\n{'='*80}")
    print(f"  {title}")
    print(f"{'='*80}\n")


def switch_to_application(app_name):
    """Switch to application using AppleScript."""
    script = f'''
    tell application "{app_name}"
        activate
    end tell
    '''
    try:
        subprocess.run(['osascript', '-e', script], check=True, capture_output=True)
        print(f"[{timestamp()}] Switched to: {app_name}")
        return True
    except Exception as e:
        print(f"[{timestamp()}] Failed to switch to {app_name}: {e}")
        return False


def create_file_activity(batch_num):
    """Create file with meaningful content."""
    file_path = SAMPLE_DIR / f"cross_source_test_{int(time.time())}_batch{batch_num}.txt"
    
    content = f"""# Cross-Source Test - Batch {batch_num}
# Timestamp: {datetime.now().isoformat()}

## Research Notes: AI Model Training

Today I'm working on optimizing neural network architectures for natural language processing.
The focus is on transformer models and their attention mechanisms.

### Key Findings:
1. Attention heads show clear specialization in syntax vs semantics
2. Layer normalization placement significantly affects convergence
3. Positional encodings can be learned vs fixed - tradeoffs exist

### Next Steps:
- Experiment with mixture of experts architecture
- Compare performance on multilingual datasets
- Analyze computational efficiency vs accuracy tradeoffs

## LM Studio Configuration
Currently testing liquid/lfm2.5-1.2b model with:
- Temperature: 0.7
- Top-p: 0.9
- Max tokens: 2048

The model shows strong performance on reasoning tasks.
"""
    
    file_path.write_text(content)
    print(f"[{timestamp()}] Created: {file_path.name}")
    
    time.sleep(2)
    
    # Modify file
    file_path.write_text(content + f"\n\n## Update {timestamp()}\nAdded notes about model evaluation metrics.\n")
    print(f"[{timestamp()}] Modified: {file_path.name}")
    
    return file_path


def perform_window_switching_sequence():
    """Perform window switching between Cursor and LM Studio."""
    print_header("🪟 WINDOW SWITCHING SEQUENCE")
    
    # Switch to Cursor
    switch_to_application("Cursor")
    time.sleep(3)
    
    # Switch to LM Studio
    switch_to_application("LM Studio")
    time.sleep(3)
    
    # Switch back to Cursor
    switch_to_application("Cursor")
    time.sleep(3)
    
    # Switch to LM Studio again
    switch_to_application("LM Studio")
    time.sleep(2)
    
    print(f"[{timestamp()}] Window switching complete (4 switches)")


def wait_for_cross_source_queries(batch_num, file_name, timeout=60):
    """Wait for query generation from cross-source activity."""
    print_header(f"⏳ WAITING FOR BATCH {batch_num} QUERY GENERATION")
    
    start_time = time.time()
    initial_count = 0
    
    # Get initial count
    queries_data = api_get("/daemon/query_generation/queries?limit=1")
    if queries_data:
        initial_count = queries_data.get("count", 0)
    
    print(f"Initial query count: {initial_count}")
    
    while time.time() - start_time < timeout:
        time.sleep(5)
        elapsed = int(time.time() - start_time)
        
        queries_data = api_get("/daemon/query_generation/queries?limit=10")
        if queries_data:
            current_count = queries_data.get("count", 0)
            
            if current_count > initial_count:
                # Find queries related to this batch
                for q in queries_data.get("queries", []):
                    context_docs = q.get('context_docs', [])
                    
                    # Check if this query includes our test file or recent window activity
                    has_our_file = any(file_name in doc.get('file_path', '') for doc in context_docs)
                    has_window_logs = any(doc.get('window_title') is not None for doc in context_docs)
                    
                    if has_our_file or (has_window_logs and current_count > initial_count):
                        print(f"\n✅ Query generated after {elapsed}s!")
                        print(f"   New queries: {current_count - initial_count}")
                        print(f"   Contains file activity: {has_our_file}")
                        print(f"   Contains window activity: {has_window_logs}")
                        return True
        
        if elapsed % 10 == 0:
            print(f"   [{elapsed}s] Waiting...")
    
    print(f"\n⏱️  Timeout after {timeout}s")
    return False


def display_queries_with_context():
    """Fetch and display queries with their full context."""
    print_header("📋 GENERATED QUERIES WITH FULL CONTEXT")
    
    # Get recent queries
    queries_data = api_get("/daemon/query_generation/queries?limit=5")
    
    if not queries_data or not queries_data.get("queries"):
        print("❌ No queries found")
        return
    
    queries = queries_data.get("queries", [])
    
    for i, query in enumerate(queries, 1):
        print(f"\n{'─'*80}")
        print(f"QUERY #{i}")
        print(f"{'─'*80}")
        
        print("\n🔍 Generated Query:")
        print(f'   "{query.get("query", "N/A")}"')
        
        print("\n📊 Query Metadata:")
        print(f"   Query ID: {query.get('query_id', 'N/A')}")
        print(f"   Timestamp: {query.get('timestamp', 'N/A')}")
        print(f"   LLM Model: {query.get('llm_model', 'N/A')}")
        print(f"   Source Daemon: {query.get('source_daemon', 'N/A')}")
        print(f"   Generation Method: {query.get('generation_method', 'N/A')}")
        
        # Analyze context docs
        context_docs = query.get('context_docs', [])
        print(f"\n📚 Context Documents: {len(context_docs)} logs")
        
        if context_docs:
            # Categorize by source type
            fs_docs = [d for d in context_docs if 'file_path' in d and 'window_title' not in d]
            window_docs = [d for d in context_docs if 'window_title' in d]
            
            if fs_docs:
                print(f"\n   📁 FILESYSTEM LOGS ({len(fs_docs)}):")
                for idx, doc in enumerate(fs_docs, 1):
                    print(f"\n   [{idx}] File: {doc.get('file_name', 'N/A')}")
                    print(f"       Action: {doc.get('action', 'N/A')}")
                    print(f"       Path: {doc.get('file_path', 'N/A')[-50:]}")
                    print(f"       Time: {doc.get('timestamp', 'N/A')}")
            
            if window_docs:
                print(f"\n   🪟 ACTIVE WINDOW LOGS ({len(window_docs)}):")
                for idx, doc in enumerate(window_docs, 1):
                    print(f"\n   [{idx}] App: {doc.get('app_name', 'N/A')}")
                    print(f"       Window: {doc.get('window_title', 'N/A')[:60]}...")
                    print(f"       Time: {doc.get('timestamp', 'N/A')}")
            
            # Display first context doc content sample
            print("\n   📄 SAMPLE CONTEXT (First Document):")
            first_doc = context_docs[0]
            
            if 'file_path' in first_doc:
                print("       Type: Filesystem Event")
                print(f"       File: {first_doc.get('file_name', 'N/A')}")
            elif 'window_title' in first_doc:
                print("       Type: Window Activity")
                print(f"       App: {first_doc.get('app_name', 'N/A')}")
                print(f"       Window: {first_doc.get('window_title', 'N/A')[:60]}")
        
        print(f"\n{'─'*80}")


def evaluate_query_quality():
    """Display evaluation framework for queries."""
    print_header("✨ QUERY QUALITY EVALUATION FRAMEWORK")
    
    print("""
📊 Evaluation Criteria:

1. RELEVANCE (How well does the query match the actual context?)
   - Are keywords from the source docs present?
   - Does it capture the main topic/activity?
   - Rating: ___ / 10

2. SPECIFICITY (Is the query specific enough to be useful?)
   - Generic vs specific information seeking
   - Actionable vs vague
   - Rating: ___ / 10

3. CROSS-SOURCE INTEGRATION (For multi-source contexts)
   - Does it connect insights across filesystem + window activity?
   - Or treats them separately?
   - Rating: ___ / 10

4. NATURAL LANGUAGE QUALITY
   - Grammatically correct?
   - Sounds like a real user query?
   - Rating: ___ / 10

5. PROACTIVE VALUE (Would this query help a proactive agent?)
   - Anticipates user needs?
   - Surfaces relevant information?
   - Rating: ___ / 10

💡 Review the queries above and mentally rate them!
""")


def run_cross_source_test():
    """Run the complete cross-source test."""
    print_header("🚀 CROSS-SOURCE PROACTIVE PIPELINE TEST")
    print(f"Start Time: {timestamp()}")
    print("Testing: Active Windows + Filesystem Logs → Query Generation")
    
    test_files = []
    
    try:
        # Batch 1
        print_header("📦 BATCH 1: Window Switching + File Creation")
        
        # Window switching
        perform_window_switching_sequence()
        
        # File activity
        time.sleep(2)
        file1 = create_file_activity(1)
        test_files.append(file1)
        
        # Wait for queries
        if wait_for_cross_source_queries(1, file1.name):
            print("✅ Batch 1 queries generated")
        else:
            print("⚠️  Batch 1 timed out")
        
        # Wait before batch 2
        time.sleep(10)
        
        # Batch 2
        print_header("📦 BATCH 2: More Window Switching + File Activity")
        
        # Window switching
        perform_window_switching_sequence()
        
        # File activity
        time.sleep(2)
        file2 = create_file_activity(2)
        test_files.append(file2)
        
        # Wait for queries
        if wait_for_cross_source_queries(2, file2.name):
            print("✅ Batch 2 queries generated")
        else:
            print("⚠️  Batch 2 timed out")
        
        # Display results
        time.sleep(5)
        display_queries_with_context()
        
        # Evaluation framework
        evaluate_query_quality()
        
        # Stats
        print_header("📊 SYSTEM STATS")
        stats = api_get("/daemon/query_generation/stats")
        if stats:
            print(f"Total Queries Generated: {stats.get('total_queries', 0)}")
            print(f"Active Source Daemons: {stats.get('source_daemons', 0)}")
            print(f"System Status: {stats.get('status', 'unknown')}")
        
        print_header("✅ TEST COMPLETE")
        print("Review the queries above to evaluate:")
        print("1. Cross-source integration quality")
        print("2. Relevance to actual user activity")
        print("3. Agentic prompt effectiveness")
        print("4. Model behavior and understanding")
        
        return True
        
    except KeyboardInterrupt:
        print("\n\n⏸️  Test interrupted by user")
        return False
    
    except Exception as e:
        print(f"\n\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return False
    
    finally:
        # Cleanup
        print_header("🧹 CLEANUP")
        for file_path in test_files:
            try:
                if file_path.exists():
                    file_path.unlink()
                    print(f"Removed: {file_path.name}")
            except Exception as e:
                print(f"Could not remove {file_path.name}: {e}")


@pytest.mark.integration
@pytest.mark.requires_services
@pytest.mark.slow
def test_cross_source_window_switching():
    """
    Enforce cross-source behavior when local prerequisites exist.
    Requires:
      - macOS with osascript
      - running backend at localhost:8765
      - PROACTIVE_ENABLE_WINDOW_SWITCHING_TEST=1
    """
    if not _backend_is_available():
        pytest.skip("Backend service not running at http://localhost:8765")
    if not _can_switch_windows():
        pytest.skip("Window switching test requires macOS osascript support")
    if not _window_switch_test_enabled():
        pytest.skip("Set PROACTIVE_ENABLE_WINDOW_SWITCHING_TEST=1 to run this test")

    assert run_cross_source_test() is True


if __name__ == "__main__":
    success = run_cross_source_test()
    sys.exit(0 if success else 1)
