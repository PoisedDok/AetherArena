"""
Integration Test Configuration

Auto-marks every test collected under tests/integration/ as @pytest.mark.integration.
CI pipeline can isolate with: pytest -m integration
"""

import pytest


def pytest_collection_modifyitems(items):
    """Auto-apply 'integration' marker to all tests in this directory tree."""
    integration_marker = pytest.mark.integration
    for item in items:
        if "/integration/" in str(item.fspath):
            item.add_marker(integration_marker)
