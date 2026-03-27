"""
E2E Test Configuration

Auto-marks every test collected under tests/e2e/ as @pytest.mark.e2e.
CI pipeline can isolate with: pytest -m e2e
"""

import pytest


def pytest_collection_modifyitems(items):
    """Auto-apply 'e2e' marker to all tests in this directory tree."""
    e2e_marker = pytest.mark.e2e
    for item in items:
        if "/e2e/" in str(item.fspath):
            item.add_marker(e2e_marker)
