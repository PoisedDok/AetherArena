"""
E2E Tests: File Indexing Pipeline

Validates indexing location lifecycle when service is available.
"""

import os
import tempfile

import pytest
import pytest_asyncio
from httpx import AsyncClient

from tests.e2e.helpers.http_wait import wait_for_endpoint


@pytest_asyncio.fixture
async def real_client():
    base_url = os.getenv("AETHER_E2E_BASE_URL", "http://127.0.0.1:8765")
    async with AsyncClient(base_url=base_url, timeout=60.0) as client:
        status = await wait_for_endpoint(client, "/v1/health")
        if status != 200:
            pytest.skip(f"Backend not reachable at {base_url}")
        yield client


@pytest.mark.e2e
@pytest.mark.requires_services
@pytest.mark.asyncio
async def test_indexing_location_lifecycle(real_client: AsyncClient, requires_file_indexing):
    with tempfile.TemporaryDirectory() as tmpdir:
        create_payload = {
            "location_name": "E2E Index",
            "root_path": tmpdir,
            "location_type": "secondary",
            "scan_interval_minutes": 15,
            "watch_enabled": False,
            "allowed_extensions": ["txt"],
        }
        create_resp = await real_client.post("/v1/file/location/create", json=create_payload)
        if create_resp.status_code == 503:
            pytest.skip("File indexing repository not initialized")
        assert create_resp.status_code == 201
        location = create_resp.json()
        location_id = location.get("id")
        assert location_id

        get_resp = await real_client.get(f"/v1/file/location/get/{location_id}")
        assert get_resp.status_code == 200

        update_resp = await real_client.put(
            f"/v1/file/location/update/{location_id}",
            json={"enabled": False},
        )
        assert update_resp.status_code == 200

        delete_resp = await real_client.delete(f"/v1/file/location/delete/{location_id}")
        assert delete_resp.status_code == 204
