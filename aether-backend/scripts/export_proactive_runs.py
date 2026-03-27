#!/usr/bin/env python3
"""
Export Proactive Agent Runs

A utility script to easily dump the proactive pipeline runs from the database
into nicely formatted JSON, YAML, or Markdown for evaluation, user studies,
and pipeline traceability.

Usage:
  python scripts/export_proactive_runs.py --format md --limit 10 --output runs.md
"""

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

try:
    import yaml
    HAS_YAML = True
except ImportError:
    HAS_YAML = False


def fetch_runs(limit: int, days: int = None, hours: int = None) -> list:
    """Fetch runs directly from the Supabase PostgreSQL container as JSON."""
    
    where_clause = ""
    if days is not None:
        where_clause = f"WHERE created_at >= NOW() - INTERVAL '{days} days'"
    elif hours is not None:
        where_clause = f"WHERE created_at >= NOW() - INTERVAL '{hours} hours'"

    query = f"""
    SELECT json_agg(t) FROM (
        SELECT 
            id, query_ids, queries, source_docs, day_date, agent_mode, 
            llm_model, tool_calls_count, execution_time_ms, decision, 
            defer_reason, context_gathered, recommendation, supporting_docs, 
            reasoning_traces, shown_to_user, user_feedback, feedback_timestamp, 
            created_at, executed_tools
        FROM proactive_agent_runs
        {where_clause}
        ORDER BY created_at DESC
        LIMIT {limit}
    ) t;
    """
    
    try:
        cmd = [
            "docker", "exec", "supabase-db", 
            "psql", "-U", "supabase_admin", "-d", "aether", "-t", "-A", "-c", query
        ]
        output = subprocess.check_output(cmd, text=True).strip()
        
        if not output or output == "null":
            return []
            
        return json.loads(output)
    except subprocess.CalledProcessError as e:
        print(f"Error connecting to database via docker: {e}", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"Error parsing database JSON output: {e}", file=sys.stderr)
        sys.exit(1)


def format_markdown(runs: list) -> str:
    """Format runs into a clean, readable Markdown document."""
    if not runs:
        return "# Proactive Pipeline Runs\n\nNo runs found."
        
    lines = ["# Proactive Pipeline Runs\n"]
    lines.append(f"*Exported at: {datetime.now(timezone.utc).isoformat()}*\n")
    lines.append(f"*Total runs: {len(runs)}*\n\n---\n")
    
    for i, run in enumerate(runs, 1):
        run_id = run.get('id', 'N/A')
        date_str = run.get('created_at', 'N/A')
        decision = run.get('decision', 'N/A').upper()
        model = run.get('llm_model', 'N/A')
        exec_time = run.get('execution_time_ms', 0)
        tool_count = run.get('tool_calls_count', 0)
        
        lines.append(f"## {i}. Run `{run_id}`")
        lines.append(f"**Date**: {date_str} | **Decision**: `{decision}` | **Model**: `{model}` | **Time**: {exec_time}ms | **Tools**: {tool_count}\n")
        
        # Queries
        queries = run.get('queries', [])
        if queries:
            lines.append("### Triggering Queries")
            for q in queries:
                lines.append(f"- {q}")
            lines.append("")
            
        # Recommendation / Defer Reason
        if decision == 'INTERVENE':
            lines.append("### Recommendation")
            lines.append(f"> {run.get('recommendation', 'N/A')}\n")
        else:
            lines.append("### Defer Reason")
            lines.append(f"> {run.get('defer_reason', 'N/A')}\n")
            
        # Reasoning Traces
        traces = run.get('reasoning_traces', [])
        if traces:
            lines.append("### Reasoning Trace")
            for idx, trace in enumerate(traces, 1):
                # Replace newlines so it stays in one blockquote or list item cleanly
                clean_trace = str(trace).replace('\n', ' ')
                lines.append(f"{idx}. {clean_trace}")
            lines.append("")
            
        # Executed Tools
        executed_tools = run.get('executed_tools', [])
        if executed_tools:
            lines.append("### Executed Tools")
            for t in executed_tools:
                lines.append(f"- `{t}`")
            lines.append("")
            
        # User Feedback
        feedback = run.get('user_feedback')
        if feedback:
            lines.append(f"**User Feedback**: `{feedback}` (at {run.get('feedback_timestamp')})\n")
            
        lines.append("---\n")
        
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Export proactive agent runs from the database.")
    parser.add_argument("-f", "--format", choices=["json", "yaml", "md"], default="md", 
                        help="Output format (default: md)")
    parser.add_argument("-l", "--limit", type=int, default=50, 
                        help="Maximum number of runs to export (default: 50)")
    parser.add_argument("-d", "--days", type=int, default=None, 
                        help="Filter to runs from the last N days")
    parser.add_argument("--hours", type=int, default=None, 
                        help="Filter to runs from the last N hours")
    parser.add_argument("-o", "--output", type=str, default=None, 
                        help="Output file path (prints to stdout if not specified)")
    
    args = parser.parse_args()
    
    runs = fetch_runs(limit=args.limit, days=args.days, hours=args.hours)
    
    if args.format == "json":
        output_text = json.dumps(runs, indent=2)
    elif args.format == "yaml":
        if not HAS_YAML:
            print("Error: pyyaml is not installed. Run 'pip install pyyaml' to use yaml format.", file=sys.stderr)
            sys.exit(1)
        output_text = yaml.dump(runs, sort_keys=False, allow_unicode=True)
    elif args.format == "md":
        output_text = format_markdown(runs)
    
    if args.output:
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(output_text)
        print(f"✅ Successfully exported {len(runs)} runs to {out_path.absolute()}")
    else:
        print(output_text)

if __name__ == "__main__":
    main()
