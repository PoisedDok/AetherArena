#!/usr/bin/env python3
"""
Job Type Registry Validator

Validates that all @.architecture documentation uses only registered job types.

@.architecture
Incoming: .architecture/job_types.yaml, Backend .py files with @.architecture --- {YAML config, Python source files, regex patterns}
Processing: parse_registry(), extract_used_jobs(), validate_compliance(), report_violations() --- {4 jobs: architecture_parsing, job_indexing, validation, verification}
Outgoing: stdout (validation report), exit code (0=valid, 1=invalid) --- {str console output, int exit code}
"""

import re
import sys
import yaml
from pathlib import Path
from typing import Dict, Set, List, Tuple
from collections import defaultdict


def load_job_registry(registry_path: Path) -> Set[str]:
    """Load all registered job types from job_types.yaml"""
    with open(registry_path, 'r') as f:
        registry = yaml.safe_load(f)
    
    job_types = set()
    
    # Extract job types from all categories
    for category_key, category_data in registry.items():
        if isinstance(category_data, dict) and category_key not in ['version', 'domain', 'last_updated', 'usage_rules']:
            for job_name, job_info in category_data.items():
                if isinstance(job_info, dict):
                    job_types.add(job_name)
    
    return job_types


def extract_jobs_from_file(file_path: Path) -> List[str]:
    """Extract job types from a file's @.architecture documentation"""
    try:
        content = file_path.read_text(encoding='utf-8')
        
        # Find Processing line in @.architecture
        # Format: Processing: ... --- {N jobs: job_type1, job_type2, ...}
        arch_match = re.search(
            r'@\.architecture.*?Processing:.*?---\s*\{[^}]*jobs?:\s*([^}]+)\}',
            content,
            re.DOTALL
        )
        
        if not arch_match:
            return []
        
        jobs_str = arch_match.group(1)
        
        # Split by comma and clean
        jobs = [j.strip() for j in jobs_str.split(',')]
        
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


def validate_job_types(backend_root: Path) -> Tuple[bool, Dict]:
    """Validate all files use only registered job types"""
    
    # Load registry
    registry_path = backend_root / ".architecture" / "job_types.yaml"
    if not registry_path.exists():
        print(f"❌ Registry not found: {registry_path}")
        return False, {}
    
    registered_jobs = load_job_registry(registry_path)
    print(f"📋 Loaded {len(registered_jobs)} registered job types from registry")
    
    # Find all Python files
    exclude_dirs = ['services', 'venv', '__pycache__', 'tests', '.cache', 'node_modules']
    py_files = find_python_files(backend_root, exclude_dirs)
    print(f"🔍 Scanning {len(py_files)} Python files...\n")
    
    # Track violations
    violations = defaultdict(list)
    files_with_arch = 0
    unregistered_jobs = set()
    
    for py_file in py_files:
        jobs = extract_jobs_from_file(py_file)
        if not jobs:
            continue
        
        files_with_arch += 1
        rel_path = py_file.relative_to(backend_root)
        
        for job in jobs:
            if job not in registered_jobs:
                violations[job].append(str(rel_path))
                unregistered_jobs.add(job)
    
    # Report results
    print("=" * 80)
    print("📊 VALIDATION RESULTS")
    print("=" * 80)
    print(f"\n✅ Files scanned: {len(py_files)}")
    print(f"✅ Files with @.architecture: {files_with_arch}")
    print(f"✅ Registered job types: {len(registered_jobs)}")
    
    if violations:
        print(f"\n❌ Unregistered job types found: {len(unregistered_jobs)}\n")
        
        for job in sorted(unregistered_jobs):
            print(f"\n⚠️  Unregistered job type: '{job}'")
            print(f"   Used in {len(violations[job])} file(s):")
            for file_path in sorted(violations[job])[:5]:  # Show first 5
                print(f"   - {file_path}")
            if len(violations[job]) > 5:
                print(f"   ... and {len(violations[job]) - 5} more")
        
        print("\n" + "=" * 80)
        print("❌ VALIDATION FAILED")
        print("=" * 80)
        print("\nTo fix:")
        print("1. Add missing job types to .architecture/job_types.yaml")
        print("2. Or update files to use registered job types")
        print("3. Run this script again to verify")
        
        return False, violations
    else:
        print(f"\n✅ All job types are registered!\n")
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

