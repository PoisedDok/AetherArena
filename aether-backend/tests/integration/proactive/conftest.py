"""
Proactive Test Suite -- pytest configuration

Registers severity markers for the test suite.
All data factories and helpers are in helpers.py.
"""


import pytest
import requests


HEALTH_URL = "http://localhost:8765/health"


def _backend_is_available() -> bool:
    """Return True when local backend health endpoint is reachable."""
    try:
        response = requests.get(HEALTH_URL, timeout=3)
        return response.status_code < 500
    except requests.RequestException:
        return False


@pytest.fixture(scope="session", autouse=True)
def require_backend_for_proactive_integration():
    """
    Guard proactive integration suite behind local backend availability.

    Without this fixture, tests fail with connection errors when the stack
    is intentionally offline, which creates noisy false negatives.
    """
    if not _backend_is_available():
        pytest.skip("Proactive integration tests require backend at http://localhost:8765")


def pytest_configure(config):
    """Register custom severity markers."""
    for level in ("critical", "high", "medium", "low"):
        config.addinivalue_line(
            "markers",
            f"severity_{level}: Severity level {level}",
        )
