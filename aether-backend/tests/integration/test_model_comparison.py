"""
Model Comparison Test: lfm-1.2B vs Qwen3-4b-Instruct-2507-MLX-8bit

Tests query generation quality with large documents using both models.
This is a standalone comparison script, NOT a pytest-compatible test suite.
Run directly: python tests/integration/test_model_comparison.py
"""
import pytest
import time
import sys
import asyncio

# Skip when collected by pytest — this is a standalone script, not a test suite.
pytestmark = pytest.mark.skip(reason="Standalone comparison script, not a pytest suite")
from pathlib import Path
from typing import List, Dict, Any

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from services.daemons.query_generation.generator import QueryGenerator
from services.daemons.filesystem.db import FileSystemDB
from config.settings import get_settings, reload_settings


def print_header(text: str, char: str = "="):
    """Print a formatted header."""
    print(f"\n{char * 80}")
    print(f"  {text}")
    print(f"{char * 80}\n")


async def test_model(model_name: str, context_docs: List[Dict[str, Any]], api_base: str = None) -> Dict[str, Any]:
    """Test query generation with a specific model.
    
    api_base defaults to settings.inference_url (aether-inference at :7090).
    """
    if api_base is None:
        reload_settings()
        api_base = get_settings().inference_url
    print_header(f"Testing Model: {model_name}", "-")
    
    start_time = time.time()
    
    generator = QueryGenerator(
        api_base=api_base,
        model=model_name,
        timeout_seconds=60.0
    )
    
    try:
        queries = await generator.generate_queries_cross_source(
            context_docs=context_docs,
            active_sources=["filesystem"]
        )
        
        elapsed = time.time() - start_time
        
        result = {
            "model": model_name,
            "queries": queries,
            "query_count": len(queries),
            "elapsed_seconds": round(elapsed, 2),
            "success": True
        }
        
        print(f"✅ Generated {len(queries)} queries in {elapsed:.2f}s")
        print("\nQueries:")
        for i, q in enumerate(queries, 1):
            print(f"  {i}. {q}")
        
        return result
        
    except Exception as e:
        elapsed = time.time() - start_time
        print(f"❌ Failed: {e}")
        return {
            "model": model_name,
            "queries": [],
            "query_count": 0,
            "elapsed_seconds": round(elapsed, 2),
            "success": False,
            "error": str(e)
        }
    finally:
        await generator.close()


def analyze_queries(results: List[Dict[str, Any]], context_docs: List[Dict[str, Any]]):
    """Analyze and compare query quality."""
    print_header("Query Quality Analysis")
    
    # Extract content keywords from documents
    content_keywords = set()
    for doc in context_docs:
        content = doc.get('content_preview', '')
        if content:
            # Extract meaningful words (>4 chars, exclude common words)
            words = content.lower().split()
            content_keywords.update([w for w in words if len(w) > 4 and w.isalnum()])
    
    print(f"📄 Document Keywords (sample): {list(content_keywords)[:20]}")
    print()
    
    for result in results:
        if not result['success']:
            continue
        
        model = result['model']
        queries = result['queries']
        
        print(f"🤖 Model: {model}")
        print(f"   Query Count: {result['query_count']}")
        print(f"   Speed: {result['elapsed_seconds']}s")
        
        # Calculate keyword overlap
        query_terms = set()
        for q in queries:
            query_terms.update(q.split())
        
        overlap = query_terms.intersection(content_keywords)
        overlap_ratio = len(overlap) / len(query_terms) if query_terms else 0
        
        print(f"   Keyword Overlap: {len(overlap)}/{len(query_terms)} terms ({overlap_ratio*100:.1f}%)")
        print(f"   Overlapping Terms: {list(overlap)[:10]}")
        
        # Check query diversity
        unique_terms = len(query_terms)
        total_terms = sum(len(q.split()) for q in queries)
        diversity = unique_terms / total_terms if total_terms else 0
        
        print(f"   Term Diversity: {unique_terms} unique / {total_terms} total ({diversity*100:.1f}%)")
        
        # Check constraint adherence
        constraint_pass = True
        for q in queries:
            terms = q.split()
            if len(terms) > 10:
                print(f"   ⚠️  Query exceeds 10 terms: '{q}'")
                constraint_pass = False
            if q != q.lower():
                print(f"   ⚠️  Query not lowercase: '{q}'")
                constraint_pass = False
            if not all(c.isalnum() or c.isspace() for c in q):
                print(f"   ⚠️  Query has special chars: '{q}'")
                constraint_pass = False
        
        if constraint_pass:
            print("   ✅ All constraints satisfied")
        
        print()


async def run_model_comparison():
    """Main test runner."""
    print_header("Model Comparison Test: Query Generation Quality")
    
    # Get recent large file logs from filesystem
    db_path = Path(__file__).parent.parent.parent / "data" / "daemons" / "filesystem" / "logs.db"
    fs_db = FileSystemDB(db_path)
    
    print("📁 Fetching recent filesystem logs with content...")
    
    # Get recent logs directly via SQL
    import sqlite3
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.execute("""
        SELECT * FROM fs_logs 
        WHERE content_preview IS NOT NULL 
        AND LENGTH(content_preview) > 100
        ORDER BY timestamp DESC 
        LIMIT 3
    """)
    recent_logs = [dict(row) for row in cursor.fetchall()]
    conn.close()
    
    if not recent_logs:
        print("❌ No recent filesystem logs with content found. Create files first.")
        return False
    
    print(f"✅ Found {len(recent_logs)} recent logs with content\n")
    
    for i, log in enumerate(recent_logs, 1):
        file_name = log.get('file_name', 'unknown')
        content_len = len(log.get('content_preview', ''))
        print(f"  {i}. {file_name} - {content_len} chars")
    
    # Models to test (served by aether-inference)
    # Phase 1 models only - thinking variant reserved for Phase 2
    models = [
        "liquid/lfm2.5-1.2b",
        "lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit"
    ]
    
    # Run tests for each model
    results = []
    for model in models:
        result = await test_model(model, recent_logs)
        results.append(result)
        time.sleep(2)  # Brief pause between models
    
    # Analyze and compare
    analyze_queries(results, recent_logs)
    
    # Print summary comparison
    print_header("Summary Comparison")
    
    print(f"{'Model':<30} {'Queries':<10} {'Speed':<12} {'Status':<10}")
    print("-" * 80)
    for r in results:
        status = "✅ SUCCESS" if r['success'] else "❌ FAILED"
        print(f"{r['model']:<30} {r['query_count']:<10} {r['elapsed_seconds']:<12}s {status:<10}")
    
    print()
    
    # Winner determination
    successful = [r for r in results if r['success']]
    if len(successful) == 2:
        lfm_result = next((r for r in successful if 'lfm' in r['model'].lower()), None)
        qwen_result = next((r for r in successful if 'qwen' in r['model'].lower()), None)
        
        if lfm_result and qwen_result:
            print("🏆 Recommendation:")
            if qwen_result['query_count'] > lfm_result['query_count']:
                print(f"   Use {qwen_result['model']} for richer query generation")
            elif lfm_result['elapsed_seconds'] < qwen_result['elapsed_seconds'] * 0.5:
                print(f"   Use {lfm_result['model']} for speed (2x+ faster)")
            else:
                print(f"   Both models viable - prefer {qwen_result['model']} for quality")
    
    return True


if __name__ == "__main__":
    success = asyncio.run(run_model_comparison())
    sys.exit(0 if success else 1)
