#!/usr/bin/env python3
# Incoming: tests runner --- {PyTest, cli}
# Processing: run docs_enforcer and architecture_linter to verify compliance --- {2 jobs: JOB_VALIDATE, JOB_TRACE}
# Outgoing: stdout, JSON reports --- {Dict[str, Any], json}

import json
import subprocess
from pathlib import Path
import pytest

BACKEND_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = BACKEND_ROOT / "scripts"


def test_docs_headers_compliant() -> None:
	"""Docs enforcer should report zero missing/invalid headers."""
	report_path = BACKEND_ROOT / "architecture_docs_report.json"
	include_path = BACKEND_ROOT / "api" / "v1" / "endpoints"
	docs_enforcer_script = SCRIPTS_DIR / "docs_enforcer.py"
	if not docs_enforcer_script.exists():
		pytest.skip(f"Script not found: {docs_enforcer_script}")
	
	result = subprocess.run(
		[
			"python3",
			str(SCRIPTS_DIR / "docs_enforcer.py"),
			"--mode",
			"validate",
			"--include",
			str(include_path),
			"--write-report",
			str(report_path),
		],
		capture_output=True,
		text=True,
	)
	assert result.returncode == 0, f"docs_enforcer failed: {result.stdout}\n{result.stderr}"
	assert report_path.exists(), "architecture_docs_report.json not generated"
	report = json.loads(report_path.read_text(encoding="utf-8"))
	assert report["summary"]["missing_headers"] == 0
	assert report["summary"]["invalid_headers"] == 0


def test_architecture_linter_generates_report() -> None:
	"""Architecture linter should generate a JSON report even if violations exist."""
	report_path = BACKEND_ROOT / "architecture_report.json"
	linter_script = SCRIPTS_DIR / "architecture_linter.py"
	if not linter_script.exists():
		pytest.skip(f"Script not found: {linter_script}")
		
	result = subprocess.run(
		[
			"python3",
			str(SCRIPTS_DIR / "architecture_linter.py"),
			"--write-report",
			str(report_path),
		],
		capture_output=True,
		text=True,
	)
	# Non-zero return code indicates violations; that's acceptable for now
	assert result.returncode in (0, 1), f"architecture_linter execution failed: {result.stdout}\n{result.stderr}"
	assert report_path.exists(), "architecture_report.json not generated"
	report = json.loads(report_path.read_text(encoding="utf-8"))
	assert "summary" in report and "violations" in report


