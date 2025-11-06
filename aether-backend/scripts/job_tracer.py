#!/usr/bin/env python3
"""
Job Type Tracer - Pipeline Analysis Tool

Searches and traces job types across the entire backend architecture.
Uses @.architecture documentation to map complete data flow pipelines.

@.architecture
Incoming: Command line, Backend .py files with @.architecture --- {CLI args, str job_types, regex patterns}
Processing: parse_architecture(), search_jobs(), trace_pipeline(), display_results() --- {4 jobs: architecture_parsing, job_indexing, pipeline_tracing, search}
Outgoing: stdout, JSON output --- {Dict[str, List[FileInfo]] job index, pipeline visualization, search results}
"""

import re
import sys
import json
import argparse
from pathlib import Path
from typing import Dict, List, Set, Optional, Tuple
from dataclasses import dataclass, field
from collections import defaultdict


@dataclass
class ArchitectureInfo:
    """Parsed architecture documentation from a file."""
    file_path: Path
    incoming: str
    processing: str
    outgoing: str
    job_types: List[str] = field(default_factory=list)
    job_count: int = 0
    
    def __repr__(self):
        return f"<ArchitectureInfo: {self.file_path.name} - {len(self.job_types)} jobs>"


class JobTracer:
    """
    Traces job types across the backend architecture.
    
    Features:
    - Parse @.architecture documentation from all Python files
    - Index files by job type
    - Search for single or multiple job types
    - Trace complete data flow pipelines
    - Export results as JSON
    """
    
    def __init__(self, backend_root: Path):
        """
        Initialize job tracer.
        
        Args:
            backend_root: Path to backend root directory
        """
        self.backend_root = backend_root
        self.architectures: List[ArchitectureInfo] = []
        self.job_index: Dict[str, List[ArchitectureInfo]] = defaultdict(list)
        self.all_job_types: Set[str] = set()
    
    def scan_repository(self, exclude_dirs: Optional[List[str]] = None) -> int:
        """
        Scan repository for @.architecture documentation.
        
        Args:
            exclude_dirs: Directories to exclude from scan
            
        Returns:
            Number of files scanned
        """
        if exclude_dirs is None:
            exclude_dirs = ['services', 'venv', '__pycache__', 'tests', '.cache', 'node_modules']
        
        print(f"🔍 Scanning {self.backend_root} for @.architecture documentation...")
        
        files_scanned = 0
        for py_file in self.backend_root.rglob("*.py"):
            # Skip excluded directories
            if any(excluded in py_file.parts for excluded in exclude_dirs):
                continue
            
            # Skip __init__.py files
            if py_file.name == "__init__.py":
                continue
            
            try:
                arch_info = self._parse_architecture_file(py_file)
                if arch_info:
                    self.architectures.append(arch_info)
                    
                    # Index by job types
                    for job_type in arch_info.job_types:
                        self.job_index[job_type].append(arch_info)
                        self.all_job_types.add(job_type)
                    
                    files_scanned += 1
            except Exception as e:
                print(f"⚠️  Error parsing {py_file}: {e}")
        
        print(f"✅ Scanned {files_scanned} files")
        print(f"📊 Found {len(self.all_job_types)} unique job types")
        
        return files_scanned
    
    def _parse_architecture_file(self, file_path: Path) -> Optional[ArchitectureInfo]:
        """
        Parse @.architecture documentation from a Python file.
        
        Args:
            file_path: Path to Python file
            
        Returns:
            ArchitectureInfo if found, None otherwise
        """
        try:
            content = file_path.read_text(encoding='utf-8')
            
            # Find @.architecture section
            arch_match = re.search(
                r'@\.architecture\s*\n'
                r'Incoming:\s*([^\n]+)\s*---\s*\{([^\}]+)\}\s*\n'
                r'Processing:\s*([^\n]+)\s*---\s*\{([^\}]+)\}\s*\n'
                r'Outgoing:\s*([^\n]+)\s*---\s*\{([^\}]+)\}',
                content,
                re.MULTILINE
            )
            
            if not arch_match:
                return None
            
            incoming_sources = arch_match.group(1).strip()
            incoming_types = arch_match.group(2).strip()
            processing_funcs = arch_match.group(3).strip()
            processing_jobs = arch_match.group(4).strip()
            outgoing_dests = arch_match.group(5).strip()
            outgoing_types = arch_match.group(6).strip()
            
            # Parse job types and count
            # Format: "N jobs: job_type1, job_type2, ..."
            job_match = re.match(r'(\d+)\s+jobs?:\s*(.+)', processing_jobs)
            if job_match:
                job_count = int(job_match.group(1))
                job_types_str = job_match.group(2)
                job_types = [jt.strip() for jt in job_types_str.split(',')]
            else:
                job_count = 0
                job_types = []
            
            return ArchitectureInfo(
                file_path=file_path,
                incoming=f"{incoming_sources} --- {{{incoming_types}}}",
                processing=f"{processing_funcs} --- {{{processing_jobs}}}",
                outgoing=f"{outgoing_dests} --- {{{outgoing_types}}}",
                job_types=job_types,
                job_count=job_count
            )
            
        except Exception as e:
            print(f"Error reading {file_path}: {e}")
            return None
    
    def search_job_types(self, job_types: List[str], match_mode: str = 'any') -> List[ArchitectureInfo]:
        """
        Search for files by job type(s).
        
        Args:
            job_types: List of job types to search for
            match_mode: 'any' (OR) or 'all' (AND) matching
            
        Returns:
            List of matching ArchitectureInfo objects
        """
        results = []
        
        for arch in self.architectures:
            arch_jobs_lower = [j.lower() for j in arch.job_types]
            search_jobs_lower = [j.lower() for j in job_types]
            
            if match_mode == 'any':
                # Match if any job type matches
                if any(search_job in arch_jobs_lower for search_job in search_jobs_lower):
                    results.append(arch)
            elif match_mode == 'all':
                # Match if all job types present
                if all(search_job in arch_jobs_lower for search_job in search_jobs_lower):
                    results.append(arch)
        
        return results
    
    def fuzzy_search_jobs(self, query: str) -> List[str]:
        """
        Fuzzy search for job types matching query.
        
        Args:
            query: Search query (case-insensitive)
            
        Returns:
            List of matching job types
        """
        query_lower = query.lower()
        return sorted([
            job for job in self.all_job_types
            if query_lower in job.lower()
        ])
    
    def trace_pipeline(self, job_type: str) -> Dict[str, any]:
        """
        Trace complete pipeline for a job type.
        
        Args:
            job_type: Job type to trace
            
        Returns:
            Pipeline information with all related files
        """
        matching_files = self.job_index.get(job_type, [])
        
        if not matching_files:
            return {
                'job_type': job_type,
                'found': False,
                'files': []
            }
        
        # Organize by layer
        layers = defaultdict(list)
        for arch in matching_files:
            # Determine layer from path
            path_str = str(arch.file_path.relative_to(self.backend_root))
            
            if 'api/v1/endpoints' in path_str:
                layer = 'API Endpoints'
            elif 'api/v1/schemas' in path_str:
                layer = 'API Schemas'
            elif 'api/middleware' in path_str:
                layer = 'Middleware'
            elif 'core/runtime' in path_str:
                layer = 'Core Runtime'
            elif 'core/mcp' in path_str:
                layer = 'MCP'
            elif 'core/integrations' in path_str:
                layer = 'Integrations'
            elif 'data/' in path_str:
                layer = 'Data Layer'
            elif 'security/' in path_str:
                layer = 'Security'
            elif 'monitoring/' in path_str:
                layer = 'Monitoring'
            elif 'utils/' in path_str:
                layer = 'Utils'
            elif 'ws/' in path_str:
                layer = 'WebSocket'
            elif 'config/' in path_str:
                layer = 'Config'
            elif 'scripts/' in path_str:
                layer = 'Scripts'
            else:
                layer = 'Other'
            
            layers[layer].append(arch)
        
        return {
            'job_type': job_type,
            'found': True,
            'total_files': len(matching_files),
            'layers': {layer: len(files) for layer, files in layers.items()},
            'files': matching_files
        }
    
    def display_search_results(self, results: List[ArchitectureInfo], job_types: List[str]):
        """
        Display search results in formatted output.
        
        Args:
            results: List of matching ArchitectureInfo objects
            job_types: Job types that were searched
        """
        print("\n" + "=" * 80)
        print(f"🔍 SEARCH RESULTS: {', '.join(job_types)}")
        print("=" * 80)
        print(f"\n📊 Found {len(results)} file(s) matching job type(s): {', '.join(job_types)}\n")
        
        if not results:
            print("No files found.")
            return
        
        for i, arch in enumerate(results, 1):
            rel_path = arch.file_path.relative_to(self.backend_root)
            
            print(f"\n{i}. 📄 {rel_path}")
            print(f"   {'─' * 70}")
            print(f"   Jobs: {', '.join(arch.job_types)} ({arch.job_count} total)")
            print(f"   ")
            print(f"   ⬇️  Incoming:  {arch.incoming}")
            print(f"   ⚙️  Processing: {arch.processing}")
            print(f"   ⬆️  Outgoing:   {arch.outgoing}")
    
    def display_pipeline_trace(self, job_type: str):
        """
        Display complete pipeline trace for a job type.
        
        Args:
            job_type: Job type to trace
        """
        pipeline = self.trace_pipeline(job_type)
        
        print("\n" + "=" * 80)
        print(f"🔬 PIPELINE TRACE: {job_type}")
        print("=" * 80)
        
        if not pipeline['found']:
            print(f"\n❌ No files found for job type: {job_type}")
            return
        
        print(f"\n📊 Found {pipeline['total_files']} file(s) implementing '{job_type}'\n")
        
        # Display by layer
        print("📂 Distribution by Layer:")
        for layer, count in sorted(pipeline['layers'].items()):
            print(f"   • {layer}: {count} file(s)")
        
        print("\n🗺️  Complete Pipeline:\n")
        
        # Group by layer
        layers = defaultdict(list)
        for arch in pipeline['files']:
            path_str = str(arch.file_path.relative_to(self.backend_root))
            
            if 'api/v1/endpoints' in path_str:
                layer = '1. API Endpoints'
            elif 'api/v1/schemas' in path_str:
                layer = '2. API Schemas'
            elif 'api/middleware' in path_str:
                layer = '3. Middleware'
            elif 'ws/' in path_str:
                layer = '4. WebSocket'
            elif 'core/runtime' in path_str:
                layer = '5. Core Runtime'
            elif 'core/mcp' in path_str:
                layer = '6. MCP'
            elif 'core/integrations' in path_str:
                layer = '7. Integrations'
            elif 'data/' in path_str:
                layer = '8. Data Layer'
            elif 'security/' in path_str:
                layer = '9. Security'
            elif 'monitoring/' in path_str:
                layer = '10. Monitoring'
            elif 'utils/' in path_str:
                layer = '11. Utils'
            elif 'config/' in path_str:
                layer = '12. Config'
            elif 'scripts/' in path_str:
                layer = '13. Scripts'
            else:
                layer = '99. Other'
            
            layers[layer].append(arch)
        
        # Display in layer order
        for layer in sorted(layers.keys()):
            print(f"\n   {layer}")
            print(f"   {'─' * 70}")
            
            for arch in layers[layer]:
                rel_path = arch.file_path.relative_to(self.backend_root)
                print(f"   └─ 📄 {rel_path}")
                print(f"      ⬇️  {arch.incoming}")
                print(f"      ⚙️  {arch.processing}")
                print(f"      ⬆️  {arch.outgoing}")
                print()
    
    def list_all_job_types(self, sort_by: str = 'name'):
        """
        List all discovered job types.
        
        Args:
            sort_by: Sort mode - 'name' or 'frequency'
        """
        print("\n" + "=" * 80)
        print("📋 ALL JOB TYPES")
        print("=" * 80)
        print(f"\n📊 Total unique job types: {len(self.all_job_types)}\n")
        
        if sort_by == 'frequency':
            # Count occurrences
            job_counts = defaultdict(int)
            for arch in self.architectures:
                for job in arch.job_types:
                    job_counts[job] += 1
            
            # Sort by frequency
            sorted_jobs = sorted(job_counts.items(), key=lambda x: x[1], reverse=True)
            
            for job, count in sorted_jobs:
                print(f"   • {job:<40} ({count} file(s))")
        else:
            # Alphabetical
            for job in sorted(self.all_job_types):
                count = len(self.job_index[job])
                print(f"   • {job:<40} ({count} file(s))")
    
    def export_json(self, output_file: Path):
        """
        Export architecture index as JSON.
        
        Args:
            output_file: Path to output JSON file
        """
        data = {
            'total_files': len(self.architectures),
            'total_job_types': len(self.all_job_types),
            'job_types': sorted(list(self.all_job_types)),
            'job_index': {
                job: [
                    {
                        'file': str(arch.file_path.relative_to(self.backend_root)),
                        'jobs': arch.job_types,
                        'job_count': arch.job_count,
                        'incoming': arch.incoming,
                        'processing': arch.processing,
                        'outgoing': arch.outgoing
                    }
                    for arch in files
                ]
                for job, files in self.job_index.items()
            }
        }
        
        output_file.write_text(json.dumps(data, indent=2))
        print(f"\n✅ Exported architecture index to: {output_file}")


def main():
    """Main entry point for job tracer CLI."""
    parser = argparse.ArgumentParser(
        description='Job Type Tracer - Trace job types across backend architecture',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Search for single job type
  ./job_tracer.py search validation
  
  # Search for multiple job types (OR)
  ./job_tracer.py search validation sanitization
  
  # Search for files with ALL job types (AND)
  ./job_tracer.py search --all validation sanitization
  
  # Trace complete pipeline for a job type
  ./job_tracer.py trace streaming
  
  # Fuzzy search for job types
  ./job_tracer.py find stream
  
  # List all job types
  ./job_tracer.py list
  
  # List job types by frequency
  ./job_tracer.py list --sort frequency
  
  # Export architecture index as JSON
  ./job_tracer.py export architecture_index.json
        """
    )
    
    parser.add_argument(
        'command',
        choices=['search', 'trace', 'list', 'find', 'export'],
        help='Command to execute'
    )
    
    parser.add_argument(
        'args',
        nargs='*',
        help='Command arguments (job types for search/trace, query for find, file for export)'
    )
    
    parser.add_argument(
        '--all',
        action='store_true',
        help='Match ALL job types (AND logic) instead of ANY (OR logic)'
    )
    
    parser.add_argument(
        '--sort',
        choices=['name', 'frequency'],
        default='name',
        help='Sort mode for list command'
    )
    
    parser.add_argument(
        '--json',
        action='store_true',
        help='Output results as JSON'
    )
    
    args = parser.parse_args()
    
    # Find backend root
    script_dir = Path(__file__).parent
    backend_root = script_dir.parent
    
    # Initialize tracer
    tracer = JobTracer(backend_root)
    tracer.scan_repository()
    
    # Execute command
    if args.command == 'search':
        if not args.args:
            print("❌ Error: Please provide at least one job type to search for")
            sys.exit(1)
        
        match_mode = 'all' if args.all else 'any'
        results = tracer.search_job_types(args.args, match_mode)
        
        if args.json:
            output = {
                'query': args.args,
                'match_mode': match_mode,
                'total_results': len(results),
                'results': [
                    {
                        'file': str(arch.file_path.relative_to(backend_root)),
                        'jobs': arch.job_types,
                        'incoming': arch.incoming,
                        'processing': arch.processing,
                        'outgoing': arch.outgoing
                    }
                    for arch in results
                ]
            }
            print(json.dumps(output, indent=2))
        else:
            tracer.display_search_results(results, args.args)
    
    elif args.command == 'trace':
        if not args.args:
            print("❌ Error: Please provide a job type to trace")
            sys.exit(1)
        
        job_type = args.args[0]
        tracer.display_pipeline_trace(job_type)
    
    elif args.command == 'list':
        tracer.list_all_job_types(sort_by=args.sort)
    
    elif args.command == 'find':
        if not args.args:
            print("❌ Error: Please provide a search query")
            sys.exit(1)
        
        query = args.args[0]
        matches = tracer.fuzzy_search_jobs(query)
        
        print(f"\n🔍 Fuzzy search for: '{query}'")
        print(f"📊 Found {len(matches)} matching job types:\n")
        
        for match in matches:
            count = len(tracer.job_index[match])
            print(f"   • {match} ({count} file(s))")
    
    elif args.command == 'export':
        if not args.args:
            print("❌ Error: Please provide output filename")
            sys.exit(1)
        
        output_file = Path(args.args[0])
        tracer.export_json(output_file)
    
    print()


if __name__ == '__main__':
    main()

