#!/usr/bin/env python3
# Incoming: none --- {none, none}
# Processing: none --- {0 jobs: none}
# Outgoing: none --- {none, none}
"""
Job Type Tracer - Pipeline Analysis Tool

Searches and traces job types across the entire backend architecture.
Uses @.architecture documentation to map complete data flow pipelines.

@.architecture
Incoming: CLI argv, Backend source tree with @.architecture blocks --- {List[str], utf-8}
Processing: parse_architecture(), trace_jobs(), validate_registry(), export_results() --- {3 jobs: JOB_LOG, JOB_TRACE, JOB_VALIDATE_SCHEMA}
Outgoing: stdout stream, architecture_index.json --- {Dict[str, Any], json}
"""

import re
import sys
import json
import argparse
from pathlib import Path
from typing import Dict, List, Set, Optional, Any
from dataclasses import dataclass, field
from collections import defaultdict

import yaml

TARGETS_FILENAME = "job_type_targets.yaml"

JOB_LAYER_MAP = {
    'app.py': 'interface_surface',
    'main.py': 'interface_surface',
    'api': 'interface_surface',
    'ws': 'interface_surface',
    'application': 'orchestration_core',
    'core': 'orchestration_core',
    'domains': 'domain_kernel',
    'data': 'persistence_plane',
    'aether_platform': 'shared_foundation',
    'monitoring': 'observability_stack',
    'security': 'observability_stack',
    'config': 'observability_stack',
    'utils': 'shared_foundation',
    'scripts': 'shared_foundation',
    'tests': 'shared_foundation',
    'services': 'platform_runtimes',
    'apps': 'platform_runtimes',
    '.architecture': 'architecture_docs',
    'logs': 'shared_foundation',
    'skills': 'shared_foundation',
}


def _strip_architecture_header(raw: str) -> str:
    """Remove three-line @.architecture docstring header from YAML text."""
    parts = raw.split("\n\n", 1)
    return parts[1] if len(parts) == 2 else raw


def _load_registry_data(registry_path: Path) -> Dict:
    """Resolve registry data, following source_of_truth pointers when present."""
    raw_content = _strip_architecture_header(registry_path.read_text(encoding='utf-8'))
    raw = yaml.safe_load(raw_content)

    if not isinstance(raw, dict):
        raise RuntimeError(f"Job registry at {registry_path} must be a mapping.")

    source = raw.get('source_of_truth')
    if isinstance(source, str):
        source_path = Path(source)
        if not source_path.is_absolute():
            source_path = (registry_path.parent / source_path).resolve()
        source_content = _strip_architecture_header(source_path.read_text(encoding='utf-8'))
        raw = yaml.safe_load(source_content)
        if not isinstance(raw, dict):
            raise RuntimeError(f"Job registry source {source_path} must deserialize to a mapping.")

    return raw


def load_job_targets_file(backend_root: Path) -> Dict[str, Dict[str, Any]]:
    """
    Load job target configuration from .architecture directory.
    """
    targets_path = backend_root / ".architecture" / TARGETS_FILENAME
    if not targets_path.exists():
        return {}

    raw_content = _strip_architecture_header(targets_path.read_text(encoding="utf-8"))
    try:
        data = yaml.safe_load(raw_content) or {}
    except yaml.YAMLError as exc:
        raise RuntimeError(f"Unable to parse {targets_path}: {exc}") from exc

    targets = data.get("targets", {})
    normalized: Dict[str, Dict[str, Any]] = {}
    for job, spec in targets.items():
        if not isinstance(spec, dict):
            continue
        layer_caps = spec.get("layer_caps") or {}
        normalized[job] = {
            "description": spec.get("description", ""),
            "target_total": int(spec.get("target_total", 0)),
            "layer_caps": {layer: int(cap) for layer, cap in layer_caps.items()},
        }
    return normalized


def _collect_jobs_from_yaml_data(data) -> Set[str]:
    """Recursively collect job identifiers from arbitrary YAML structures."""
    jobs: Set[str] = set()

    if isinstance(data, dict):
        for value in data.values():
            jobs.update(_collect_jobs_from_yaml_data(value))
    elif isinstance(data, list):
        for item in data:
            jobs.update(_collect_jobs_from_yaml_data(item))
    elif isinstance(data, str):
        matches = re.findall(r'JOB_[A-Z0-9_]{2,}', data)
        jobs.update(matches)

    return jobs


def _extract_jobs_from_yaml(file_path: Path) -> Set[str]:
    """Load YAML file and extract declared job identifiers."""
    try:
        raw_text = file_path.read_text(encoding='utf-8')
    except Exception as exc:
        print(f"⚠️  Error reading YAML {file_path}: {exc}")
        return set()

    header_section = raw_text.split("\n\n", 1)[0]
    header_jobs = re.findall(r'JOB_[A-Z0-9_]{2,}', header_section)

    try:
        payload = _strip_architecture_header(raw_text)
        data = yaml.safe_load(payload)
    except yaml.YAMLError as exc:
        print(f"⚠️  Error parsing YAML {file_path}: {exc}")
        data = None

    jobs = _collect_jobs_from_yaml_data(data) if data is not None else set()

    if not jobs:
        matches = re.findall(r'JOB_[A-Z0-9_]{2,}', raw_text)
        jobs.update(matches)
    else:
        jobs.update(re.findall(r'JOB_[A-Z0-9_]{2,}', raw_text))

    jobs.update(header_jobs)

    return {job.strip() for job in jobs if job.strip()}


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
    
    def __init__(self, backend_root: Path, allowed_job_types: Optional[Set[str]]):
        """
        Initialize job tracer.
        
        Args:
            backend_root: Path to backend root directory
        """
        self.backend_root = backend_root
        self.allowed_job_types = allowed_job_types
        self.architectures: List[ArchitectureInfo] = []
        self.job_index: Dict[str, List[ArchitectureInfo]] = defaultdict(list)
        self.all_job_types: Set[str] = set()
        self.unknown_job_types: Set[str] = set()
        self.job_targets: Dict[str, Dict[str, Any]] = {}
    
    def _register_architecture(self, arch_info: ArchitectureInfo) -> None:
        """Register architecture info and update job indices."""
        self.architectures.append(arch_info)

        for job_type in arch_info.job_types:
            self.job_index[job_type].append(arch_info)
            self.all_job_types.add(job_type)

            if self.allowed_job_types is not None and job_type not in self.allowed_job_types:
                self.unknown_job_types.add(job_type)

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
        yaml_files_processed = 0
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
                    self._register_architecture(arch_info)
                    files_scanned += 1
            except Exception as e:
                print(f"⚠️  Error parsing {py_file}: {e}")
        
        architecture_dir = self.backend_root / ".architecture"
        if architecture_dir.exists():
            yaml_files = sorted({
                path
                for pattern in ("*.yaml", "*.yml")
                for path in architecture_dir.rglob(pattern)
            })
            skipped_arch_docs = 0
            for yaml_file in yaml_files:
                if yaml_file.name == TARGETS_FILENAME:
                    continue
                skipped_arch_docs += 1
            if skipped_arch_docs:
                print(f"🛈 Skipped {skipped_arch_docs} architecture YAML file(s) in {architecture_dir}")

        print(f"✅ Scanned {files_scanned} files")
        if yaml_files_processed:
            print(f"📑 Included {yaml_files_processed} architecture YAML file(s)")
        print(f"📊 Found {len(self.all_job_types)} unique job types")
        if self.allowed_job_types is None:
            print("📘 Registry: not configured (skipping membership enforcement). Use --strict-registry to require it.")
        else:
            registered_observed = len(self.all_job_types) - len(self.unknown_job_types)
            print(f"📘 Registry coverage: {registered_observed}/{len(self.all_job_types)} observed types registered")
        
        return files_scanned
    
    def _parse_architecture_file(self, file_path: Path, extra_jobs: Optional[Set[str]] = None) -> Optional[ArchitectureInfo]:
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
            patterns = [
                re.compile(
                    r'@\.architecture\s*\n'
                    r'Incoming:\s*([^\n]+)\s*---\s*\{([^\}]+)\}\s*\n'
                    r'Processing:\s*([^\n]+)\s*---\s*\{([^\}]+)\}\s*\n'
                    r'Outgoing:\s*([^\n]+)\s*---\s*\{([^\}]+)\}',
                    re.MULTILINE,
                ),
                re.compile(
                    r'Incoming:\s*([^\n]+)\s*---\s*\{([^\}]+)\}\s*\n'
                    r'Processing:\s*([^\n]+)\s*---\s*\{([^\}]+)\}\s*\n'
                    r'Outgoing:\s*([^\n]+)\s*---\s*\{([^\}]+)\}',
                    re.MULTILINE,
                ),
            ]

            arch_match: Optional[re.Match[str]] = None
            for pattern in patterns:
                arch_match = pattern.search(content)
                if arch_match:
                    break
            
            if not arch_match:
                return None
            
            incoming_sources = arch_match.group(1).strip()
            incoming_types = arch_match.group(2).strip()
            processing_funcs = arch_match.group(3).strip()
            processing_jobs = arch_match.group(4).strip()
            outgoing_dests = arch_match.group(5).strip()
            outgoing_types = arch_match.group(6).strip()
            
            # Parse job types and counts, tolerating the legacy "N jobs:" prefix
            job_types_str = processing_jobs
            job_match = re.match(r'(\d+)\s+jobs?:\s*(.+)', processing_jobs, re.IGNORECASE)
            if job_match:
                job_types_str = job_match.group(2)
                job_count = int(job_match.group(1))
            else:
                job_count = 0
            
            job_types = [jt.strip() for jt in job_types_str.split(',') if jt.strip()]
            if extra_jobs:
                job_types.extend(list(extra_jobs))

            job_types = sorted(set(job_types))
            if job_count == 0 or job_count != len(job_types):
                job_count = len(job_types)
            
            return ArchitectureInfo(
                file_path=file_path,
                incoming=f"{incoming_sources} --- {{{incoming_types}}}",
                processing=f"{processing_funcs} --- {{{', '.join(job_types)}}}",
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
            print("   ")
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

    def _resolve_layer(self, file_path: Path) -> str:
        """Map a file path to its canonical architecture layer."""
        try:
            rel_path = file_path.relative_to(self.backend_root)
        except ValueError:
            rel_path = file_path

        if rel_path == Path("app.py") or rel_path == Path("main.py"):
            return JOB_LAYER_MAP['app.py']

        parts = rel_path.parts
        if not parts:
            return "other"

        top = parts[0]
        return JOB_LAYER_MAP.get(top, "other")

    def audit_job_targets(self, output_json: bool = False):
        """Compare observed job distribution against declared targets."""
        if not self.job_targets:
            print("⚠️  No job_type_targets.yaml found; skipping audit.")
            return

        job_counts = {job: len(files) for job, files in self.job_index.items()}
        report: List[Dict[str, Any]] = []
        offenders: List[Dict[str, Any]] = []

        for job, spec in self.job_targets.items():
            actual_total = job_counts.get(job, 0)
            target_total = spec.get("target_total", 0)
            layer_caps = spec.get("layer_caps", {})

            layer_counts: Dict[str, int] = defaultdict(int)
            for arch in self.job_index.get(job, []):
                layer = self._resolve_layer(arch.file_path)
                layer_counts[layer] += 1

            layer_overages = {
                layer: layer_counts.get(layer, 0) - cap
                for layer, cap in layer_caps.items()
                if layer_counts.get(layer, 0) > cap
            }
            unmanaged_layers = {
                layer: count
                for layer, count in layer_counts.items()
                if layer not in layer_caps and count > 0
            }

            delta_total = actual_total - target_total
            entry = {
                "job": job,
                "description": spec.get("description", ""),
                "target_total": target_total,
                "actual_total": actual_total,
                "delta_total": delta_total,
                "layer_caps": layer_caps,
                "layer_counts": dict(layer_counts),
                "layer_overages": layer_overages,
                "unmanaged_layers": unmanaged_layers,
            }
            report.append(entry)

            if delta_total > 0 or layer_overages or unmanaged_layers:
                offenders.append(entry)

        if output_json:
            print(json.dumps({"report": report, "offenders": offenders}, indent=2))
            return

        print("\n" + "=" * 80)
        print("🧮 JOB TARGET AUDIT")
        print("=" * 80)
        print(f"\nTargets loaded: {len(self.job_targets)} | Offenders: {len(offenders)}\n")

        if not offenders:
            print("✅ All tracked job types are within target thresholds.")
            return

        for entry in sorted(offenders, key=lambda x: x["delta_total"], reverse=True):
            print(f"• {entry['job']}: actual {entry['actual_total']} / target {entry['target_total']} (Δ {entry['delta_total']})")
            if entry["layer_overages"]:
                for layer, extra in entry["layer_overages"].items():
                    cap = entry["layer_caps"].get(layer, 0)
                    actual = entry["layer_counts"].get(layer, 0)
                    print(f"    - Layer {layer}: {actual} / cap {cap} (over by {extra})")
            if entry["unmanaged_layers"]:
                for layer, count in entry["unmanaged_layers"].items():
                    print(f"    - Layer {layer}: {count} file(s) but no cap defined")
            if entry["description"]:
                print(f"    · {entry['description']}")
            print()
    
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


def load_allowed_job_types(backend_root: Path) -> Optional[Set[str]]:
    """Load allowed job types from backend registry (optional)."""
    registry_path = backend_root.parent / 'Architecture' / 'backend_job_registry.yaml'
    if not registry_path.exists():
        return None
    data = _load_registry_data(registry_path)
    allowed: Set[str] = set()

    categories = data.get('categories', {})
    for category in categories.values():
        jobs = category.get('jobs', [])
        for job in jobs:
            allowed.add(job.strip())

    if not allowed:
        raise RuntimeError(f"Job registry at {registry_path} yielded no job definitions.")

    return allowed


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
        choices=['search', 'trace', 'list', 'find', 'export', 'audit'],
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

    parser.add_argument(
        '--strict-registry',
        action='store_true',
        help='Require ../Architecture/backend_job_registry.yaml and enforce job membership'
    )
    
    args = parser.parse_args()
    
    # Find backend root
    script_dir = Path(__file__).parent
    backend_root = script_dir.parent
    
    # Initialize tracer
    allowed_job_types = load_allowed_job_types(backend_root)
    if args.strict_registry and allowed_job_types is None:
        print("❌ Fatal: --strict-registry set but ../Architecture/backend_job_registry.yaml was not found")
        sys.exit(1)
    tracer = JobTracer(backend_root, allowed_job_types)
    tracer.scan_repository()
    tracer.job_targets = load_job_targets_file(backend_root)
    if args.strict_registry and tracer.unknown_job_types:
        print("\n❌ Unregistered job types detected in @.architecture blocks:")
        for job in sorted(tracer.unknown_job_types):
            print(f"   • {job}")
        sys.exit(1)
    
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
    elif args.command == 'audit':
        tracer.audit_job_targets(output_json=args.json)

    print()


if __name__ == '__main__':
    main()

