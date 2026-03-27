#!/usr/bin/env python3
# Incoming: none --- {none, none}
# Processing: none --- {0 jobs: none}
# Outgoing: none --- {none, none}
"""
Job Type Registry Validator

Validates that all @.architecture documentation uses only registered job types.

@.architecture
Incoming: .architecture/data_flow_standard.yaml, Backend .py files with @.architecture --- {Dict[str, Any], utf-8}
Processing: parse_registry(), extract_used_jobs(), validate_compliance(), report_violations() --- {3 jobs: JOB_LOG, JOB_TRACE, JOB_VALIDATE_SCHEMA}
Outgoing: stdout report, process exit code --- {Dict[str, Any], cli}
"""

import re
import sys
import yaml
from pathlib import Path
from typing import Dict, Set, List, Tuple, Any
from collections import defaultdict


def _strip_architecture_header(raw: str) -> str:
    """Remove three-line @.architecture docstring header from YAML text."""
    parts = raw.split("\n\n", 1)
    return parts[1] if len(parts) == 2 else raw


def _load_registry_data(registry_path: Path) -> Dict[str, Any]:
    """Resolve registry data, following source_of_truth pointers if declared."""
    raw_content = _strip_architecture_header(registry_path.read_text(encoding='utf-8'))
    raw = yaml.safe_load(raw_content)

    if not isinstance(raw, dict):
        raise RuntimeError(f"Job registry at {registry_path} must deserialize to a mapping.")

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


def load_job_registry(registry_path: Path) -> Set[str]:
    """Load all registered job types from data_flow_standard.yaml"""
    raw_content = registry_path.read_text(encoding='utf-8')
    
    # Remove @.architecture header if present
    raw_content = _strip_architecture_header(raw_content)
    
    registry = yaml.safe_load(raw_content)
    
    if not isinstance(registry, dict):
        raise RuntimeError(f"Job registry at {registry_path} must deserialize to a mapping.")

    job_types = set()

    # Load from job_types array
    job_type_list = registry.get('job_types', [])
    if isinstance(job_type_list, list):
        for job_entry in job_type_list:
            if isinstance(job_entry, dict) and 'name' in job_entry:
                job_types.add(job_entry['name'])
            elif isinstance(job_entry, str):
                job_types.add(job_entry)
    
    # Also check for legacy 'categories' structure
    categories = registry.get('categories', {})
    if isinstance(categories, dict):
        for category_data in categories.values():
            jobs = category_data.get('jobs', [])
            for job_name in jobs:
                job_types.add(job_name)

    return job_types


def extract_jobs_from_file(file_path: Path) -> List[str]:
    """Extract job types from a file's @.architecture documentation"""
    try:
        content = file_path.read_text(encoding='utf-8')
        
        # Find Processing line in @.architecture and capture the job list payload
        arch_match = re.search(
            r'@\.architecture.*?Processing:\s*[^\n]+?---\s*\{([^}]+)\}',
            content,
            re.DOTALL
        )
        
        if not arch_match:
            return []
        
        jobs_str = arch_match.group(1).strip()
        jobs_str = re.sub(r'^\d+\s+jobs?:\s*', '', jobs_str, flags=re.IGNORECASE)
        
        # Split by comma and clean
        jobs = [j.strip() for j in jobs_str.split(',') if j.strip()]
        
        return jobs
        
    except Exception as e:
        print(f"⚠️  Error reading {file_path}: {e}")
        return []


def find_python_files(root_dir: Path, exclude_dirs: List[str]) -> List[Path]:
    """Find all Python files excluding specified directories"""
    files = []
    for py_file in root_dir.rglob("*.py"):
        if any(excluded in py_file.parts for excluded in exclude_dirs):
            continue
        if py_file.name == "__init__.py":
            continue
        files.append(py_file)
    return files


def find_architecture_yaml_files(backend_root: Path) -> List[Path]:
    """Locate backend architecture YAML manifests/directives."""
    architecture_dir = backend_root / ".architecture"
    if architecture_dir.exists():
        files = {
            path
            for pattern in ("*.yaml", "*.yml")
            for path in architecture_dir.rglob(pattern)
        }
        return sorted(files)
    return []


def extract_jobs_from_yaml(file_path: Path) -> List[str]:
    """Extract job identifiers from backend architecture YAML."""
    try:
        raw_text = file_path.read_text(encoding='utf-8')
    except Exception as exc:
        print(f"⚠️  Error reading YAML {file_path}: {exc}")
        return []

    header_section = raw_text.split("\n\n", 1)[0]
    header_jobs = re.findall(r'JOB_[A-Z0-9_]{2,}', header_section)

    try:
        payload = _strip_architecture_header(raw_text)
        data = yaml.safe_load(payload)
    except yaml.YAMLError as exc:
        print(f"⚠️  Error parsing YAML {file_path}: {exc}")
        data = None

    jobs: Set[str] = set()

    def _collect(node: Any) -> None:
        if isinstance(node, dict):
            for value in node.values():
                _collect(value)
        elif isinstance(node, list):
            for item in node:
                _collect(item)
        elif isinstance(node, str):
            matches = re.findall(r'JOB_[A-Z0-9_]{2,}', node)
            jobs.update(matches)

    if data is not None:
        _collect(data)

    if not jobs:
        jobs.update(re.findall(r'JOB_[A-Z0-9_]{2,}', raw_text))
    else:
        jobs.update(re.findall(r'JOB_[A-Z0-9_]{2,}', raw_text))

    jobs.update(header_jobs)

    return sorted(job.strip() for job in jobs if job.strip())


def validate_job_types(backend_root: Path) -> Tuple[bool, Dict]:
    """Validate all files use only registered job types"""
    
    # Load registry from .architecture/data_flow_standard.yaml
    registry_path = backend_root / ".architecture" / "data_flow_standard.yaml"
    if not registry_path.exists():
        print(f"❌ Registry not found: {registry_path}")
        print(f"   Expected location: {backend_root}/.architecture/data_flow_standard.yaml")
        return False, {}
    
    registered_jobs = load_job_registry(registry_path)
    print(f"📋 Loaded {len(registered_jobs)} registered job types from {registry_path.relative_to(backend_root)}")
    
    # Find all Python files
    exclude_dirs = ['services', 'venv', '__pycache__', 'tests', '.cache', 'node_modules']
    py_files = find_python_files(backend_root, exclude_dirs)
    print(f"🔍 Scanning {len(py_files)} Python files...\n")
    
    # Track violations
    violations: Dict[str, Set[str]] = defaultdict(set)
    python_files_with_arch = 0
    unregistered_jobs = set()
    
    for py_file in py_files:
        jobs = extract_jobs_from_file(py_file)
        if not jobs:
            continue
        
        python_files_with_arch += 1
        rel_path = py_file.relative_to(backend_root)
        
        for job in jobs:
            if job not in registered_jobs:
                violations[job].add(str(rel_path))
                unregistered_jobs.add(job)

    yaml_files = find_architecture_yaml_files(backend_root)
    print(f"📑 Scanning {len(yaml_files)} architecture YAML files...\n")

    yaml_files_with_jobs = 0

    for yaml_file in yaml_files:
        jobs = extract_jobs_from_yaml(yaml_file)
        if not jobs:
            continue

        yaml_files_with_jobs += 1
        rel_path = yaml_file.relative_to(backend_root)

        for job in jobs:
            if job not in registered_jobs:
                violations[job].add(str(rel_path))
                unregistered_jobs.add(job)
    
    # Report results
    print("=" * 80)
    print("📊 VALIDATION RESULTS")
    print("=" * 80)
    print(f"\n✅ Python files scanned: {len(py_files)}")
    print(f"✅ Python files with @.architecture: {python_files_with_arch}")
    print(f"✅ Architecture YAML files scanned: {len(yaml_files)}")
    print(f"✅ Architecture YAML files with jobs: {yaml_files_with_jobs}")
    print(f"✅ Registered job types: {len(registered_jobs)}")
    
    if violations:
        print(f"\n❌ Unregistered job types found: {len(unregistered_jobs)}\n")
        
        for job in sorted(unregistered_jobs):
            paths = sorted(violations[job])
            print(f"\n⚠️  Unregistered job type: '{job}'")
            print(f"   Used in {len(paths)} file(s):")
            for file_path in paths[:5]:  # Show first 5
                print(f"   - {file_path}")
            if len(paths) > 5:
                print(f"   ... and {len(paths) - 5} more")
        
        print("\n" + "=" * 80)
        print("❌ VALIDATION FAILED")
        print("=" * 80)
        print("\nTo fix:")
        print("1. Add missing job types to .architecture/data_flow_standard.yaml")
        print("2. Or update files to use registered job types")
        print("3. Run this script again to verify")
        
        return False, violations
    else:
        print("\n✅ All job types are registered!\n")
        print("=" * 80)
        print("✅ VALIDATION PASSED")
        print("=" * 80)
        return True, {}


def main():
    """Main entry point"""
    print("\n🔍 Backend Job Type Registry Validator\n")
    
    # Find backend root
    script_dir = Path(__file__).parent
    backend_root = script_dir.parent
    
    # Validate
    valid, violations = validate_job_types(backend_root)
    
    # Exit with appropriate code
    sys.exit(0 if valid else 1)


if __name__ == '__main__':
    main()

