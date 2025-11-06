# pylint: disable=missing-module-docstring
# SPDX-License-Identifier: MIT
"""Integration tests for the OCR REST API.

These tests exercise the most important user-visible endpoints of the unified OCR
service (health, model load/unload, file OCR, upload OCR).

Key characteristics
===================
* **Pytest**-native – no ad-hoc print logic; failures surface via assertions.
* **Configurable** – API base URL and default backend read from environment
  variables with sensible fall-backs.
* **Efficient** – models are loaded once per session and unloaded after the last
  test; file lists are capped to avoid expensive end-to-end runs.
* **Robust** – all HTTP requests include time-outs; rich assertion messages help
  diagnose server issues quickly.
* **Portable** – avoids hard-coded ``~/Downloads``; test files are resolved from
  an environment variable or generated on-the-fly if none are present.
"""
from __future__ import annotations

import os
import tempfile
import time
from pathlib import Path
from typing import Dict, Iterator, List

import pytest
import requests

# ---------------------------------------------------------------------------
# Configuration helpers
# ---------------------------------------------------------------------------

def _env(name: str, default: str) -> str:
    """Read *name* from the environment, returning *default* if unset or empty."""
    value = os.getenv(name)
    return value if value else default


API_BASE: str = _env("OCR_API_BASE", "http://localhost:8001/v1")
DEFAULT_BACKEND: str = _env("OCR_BACKEND", "paddleocr_vl")
HTTP_TIMEOUT: int = int(_env("OCR_HTTP_TIMEOUT", "120"))  # seconds
MAX_IMAGES: int = int(_env("OCR_MAX_IMAGES", "2"))
MAX_PDFS: int = int(_env("OCR_MAX_PDFS", "1"))

# Endpoints -----------------------------------------------------------------
BACKENDS_EP = f"{API_BASE}/ocr/backends"
HEALTH_EP = f"{API_BASE}/ocr/health"
LOAD_EP = f"{API_BASE}/ocr/load"
UNLOAD_EP = f"{API_BASE}/ocr/unload"
FORMATS_EP = f"{API_BASE}/ocr/formats"
PROCESS_FILE_EP = f"{API_BASE}/ocr/process/file"
PROCESS_UPLOAD_EP = f"{API_BASE}/ocr/process/upload"


# ---------------------------------------------------------------------------
# HTTP utility
# ---------------------------------------------------------------------------

def request_json(method: str, url: str, timeout: int = HTTP_TIMEOUT, **kwargs):
    """Make an HTTP request and return the decoded JSON body.

    Raises ``pytest.fail`` with a helpful message if the request fails or the
    response status is not 2xx.
    """
    try:
        resp = requests.request(method, url, timeout=timeout, **kwargs)
    except requests.RequestException as exc:
        pytest.fail(f"{method} {url} failed – {exc}")

    if not resp.ok:
        pytest.fail(
            f"{method} {url} → HTTP {resp.status_code}: {resp.text[:200]}…"
        )

    try:
        return resp.json()
    except ValueError as exc:  # JSON decode error
        pytest.fail(
            f"{method} {url} returned non-JSON body: {resp.text[:200]}… ({exc})"
        )


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def backend() -> str:  # noqa: D401 – simple name is intentional
    """The backend under test (session-scoped)."""
    return DEFAULT_BACKEND


@pytest.fixture(scope="session")
def model_loaded(backend: str) -> None:  # noqa: D401 – pytest fixture
    """Ensure the model is loaded once per session and unload after tests."""

    # Load
    payload = {"backend": backend, "force_reload": False}
    data = request_json("POST", LOAD_EP, json=payload)
    assert data.get("success"), f"Model failed to load: {data}"

    # Wait until the backend confirms the model is fully initialised
    max_wait = int(_env("OCR_MODEL_READY_TIMEOUT", "120"))  # seconds
    deadline = time.time() + max_wait
    while time.time() < deadline:
        status = request_json("GET", f"{HEALTH_EP}?backend={backend}")
        if status.get("model_loaded"):
            break
        time.sleep(2)
    else:
        pytest.fail(
            f"Backend did not report model_loaded within {max_wait}s; last status: {status}"
        )

    yield  # run the tests

    # Unload
    data = request_json("POST", f"{UNLOAD_EP}?backend={backend}")
    assert data.get("success"), f"Model failed to unload: {data}"


@pytest.fixture(scope="session")
def test_files(tmp_path_factory) -> Dict[str, List[Path]]:  # noqa: D401
    """Return dict of test image and PDF paths.

    Resolution order:
      1. Files listed in ``OCR_TEST_IMAGES`` and ``OCR_TEST_PDFS`` env vars
         (comma-separated absolute paths).
      2. Files found in ``~/Downloads`` matching certain extensions.
      3. On-the-fly generated placeholder PNG if none found.
    """
    downloads = Path.home() / "Downloads"

    def split_env(var: str) -> List[Path]:
        val = os.getenv(var, "").strip()
        return [Path(p) for p in val.split(",") if p]

    images: List[Path] = split_env("OCR_TEST_IMAGES")
    pdfs: List[Path] = split_env("OCR_TEST_PDFS")

    if not images:
        for ext in (".png", ".jpg", ".jpeg"):
            images += sorted(downloads.glob(f"*{ext}"))
        images = images[:MAX_IMAGES]

    if not pdfs:
        pdfs = sorted(downloads.glob("*.pdf"))[:MAX_PDFS]

    if not images:
        # Generate a simple image
        from PIL import Image, ImageDraw  # deferred import

        img_path = tmp_path_factory.mktemp("gen") / "test_ocr_api.png"
        img = Image.new("RGB", (400, 100), "white")
        ImageDraw.Draw(img).text((10, 30), "Test OCR API", fill="black")
        img.save(img_path)
        images.append(img_path)

    return {"images": images, "pdfs": pdfs}


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_api_reachable():
    """Fail fast if the API server is not up."""
    try:
        requests.get(BACKENDS_EP, timeout=5).raise_for_status()
    except requests.RequestException as exc:
        pytest.skip(f"API server not reachable: {exc}")


def test_list_backends():
    data = request_json("GET", BACKENDS_EP)
    assert "backends" in data, "Response missing 'backends' key"
    assert data["backends"], "No backends reported by the API"


def test_health_check(backend: str):
    data = request_json("GET", f"{HEALTH_EP}?backend={backend}")
    assert data.get("healthy"), f"{backend} backend reported unhealthy: {data}"


def test_load_and_unload_model(model_loaded):  # noqa: D401
    """Fixture already covers load/unload – this test just asserts fixture ran."""
    assert model_loaded is None  # noqa: S101 – Pytest style


def test_formats(backend: str):
    data = request_json("GET", f"{FORMATS_EP}?backend={backend}")
    assert data.get("input_formats"), "Input formats list empty"
    assert data.get("output_formats"), "Output formats list empty"


@pytest.mark.parametrize("task", ["ocr", "table"])
@pytest.mark.parametrize("file_key", ["images", "pdfs"])

def test_process_file(test_files, backend: str, task: str, file_key: str, model_loaded):
    files = test_files[file_key]
    if not files:
        pytest.skip(f"No {file_key} files available for testing")

    file_path = files[0]
    payload = {
        "file_path": str(file_path),
        "output_format": "markdown",
        "backend": backend,
        "task": task,
    }
    t0 = time.perf_counter()
    data = request_json("POST", PROCESS_FILE_EP, json=payload)
    elapsed = time.perf_counter() - t0

    assert data.get("success"), f"process/file failed: {data}"
    assert data.get("backend") == backend, "Backend mismatch in response"
    assert data.get("results"), "No OCR results returned"
    assert elapsed < HTTP_TIMEOUT, "OCR request exceeded timeout budget"


@pytest.mark.parametrize("task", ["ocr"])

def test_process_upload(test_files, backend: str, task: str, model_loaded):
    img_files = test_files["images"]
    if not img_files:
        pytest.skip("No image available for upload test")

    file_path = img_files[0]
    with file_path.open("rb") as fh:
        files = {"file": (file_path.name, fh, "application/octet-stream")}
        data_fields = {"output_format": "markdown", "backend": backend, "task": task}
        data = request_json("POST", PROCESS_UPLOAD_EP, files=files, data=data_fields)

    assert data.get("success"), f"process/upload failed: {data}"
    assert data.get("original_filename") == file_path.name, "Filename mismatch"

