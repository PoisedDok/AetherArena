"""
E2E Tests: Job Queue Pipeline

Validates queueing, cancellation, and deletion workflows.
"""

import os
import uuid
import asyncio

import pytest
import pytest_asyncio
from httpx import AsyncClient

from tests.e2e.helpers.http_wait import wait_for_endpoint


@pytest_asyncio.fixture
async def real_client():
    base_url = os.getenv("AETHER_E2E_BASE_URL", "http://127.0.0.1:8765")
    async with AsyncClient(base_url=base_url, timeout=30.0) as client:
        status = await wait_for_endpoint(client, "/v1/health")
        if status != 200:
            pytest.skip(f"Backend not reachable at {base_url} (status={status})")
        yield client


@pytest.mark.e2e
@pytest.mark.requires_services
@pytest.mark.asyncio
async def test_queue_cancel_delete_job(real_client: AsyncClient):
    configs_resp = await real_client.get("/v1/agent/configs")
    if configs_resp.status_code != 200:
        pytest.fail(f"Agent configs not available (status={configs_resp.status_code})")
    configs = configs_resp.json()
    if not configs:
        pytest.fail("No agent configs seeded")

    queueable_agents = {"research", "memory"}
    queueable_configs = [cfg for cfg in configs if cfg.get("agent_name") in queueable_agents]
    if not queueable_configs:
        pytest.fail("No queueable agents configured (expected research/memory)")
    agent = next((cfg for cfg in queueable_configs if cfg.get("enabled")), queueable_configs[0])
    agent_name = agent.get("agent_name")
    if not agent_name:
        pytest.fail("Agent config missing agent_name")

    was_enabled = bool(agent.get("enabled"))
    if not was_enabled:
        update_resp = await real_client.put(
            f"/v1/agent/config/{agent_name}",
            json={"enabled": True},
        )
        if update_resp.status_code not in (200, 204):
            pytest.fail(
                f"Unable to enable agent for job queue test (status={update_resp.status_code})"
            )

    job_payload = {
        "agent_name": agent_name,
        "entity_id": str(uuid.uuid4()),
        "entity_type": "chat",
        "execution_strategy": "parallel",
        "metadata": {"source": "e2e-test"},
    }
    create_resp = await real_client.post("/v1/agent/start", json=job_payload)
    assert create_resp.status_code == 201
    job = create_resp.json()
    job_id = job.get("job_id")
    assert job_id

    status_resp = await real_client.get(f"/v1/agent/status/{job_id}")
    assert status_resp.status_code == 200
    status = status_resp.json().get("status")
    if status != "pending":
        for _ in range(5):
            await asyncio.sleep(0.5)
            status_resp = await real_client.get(f"/v1/agent/status/{job_id}")
            assert status_resp.status_code == 200
            status = status_resp.json().get("status")
            if status == "pending":
                break
    if status != "pending":
        pytest.fail(f"Job not pending for cancel (status={status})")

    cancel_resp = await real_client.post(f"/v1/agent/stop/{job_id}")
    assert cancel_resp.status_code == 200
    cancel_body = cancel_resp.json()
    assert cancel_body.get("status") == "cancelled"

    delete_resp = await real_client.delete(f"/v1/agent/delete/{job_id}")
    assert delete_resp.status_code == 200

    if not was_enabled:
        await real_client.put(
            f"/v1/agent/config/{agent_name}",
            json={"enabled": False},
        )


@pytest.mark.e2e
@pytest.mark.requires_services
@pytest.mark.slow
@pytest.mark.asyncio
async def test_job_queue_stress(real_client: AsyncClient):
    configs_resp = await real_client.get("/v1/agent/configs")
    if configs_resp.status_code != 200:
        pytest.fail(f"Agent configs not available (status={configs_resp.status_code})")
    configs = configs_resp.json()
    if not configs:
        pytest.fail("No agent configs seeded")

    queueable_agents = {"research", "memory"}
    queueable_configs = [cfg for cfg in configs if cfg.get("agent_name") in queueable_agents]
    if not queueable_configs:
        pytest.fail("No queueable agents configured (expected research/memory)")
    agent = next((cfg for cfg in queueable_configs if cfg.get("enabled")), queueable_configs[0])
    agent_name = agent.get("agent_name")
    if not agent_name:
        pytest.fail("Agent config missing agent_name")

    was_enabled = bool(agent.get("enabled"))
    if not was_enabled:
        update_resp = await real_client.put(
            f"/v1/agent/config/{agent_name}",
            json={"enabled": True},
        )
        if update_resp.status_code not in (200, 204):
            pytest.fail(
                f"Unable to enable agent for job queue stress test (status={update_resp.status_code})"
            )

    created_job_ids = []
    for _ in range(5):
        job_payload = {
            "agent_name": agent_name,
            "entity_id": str(uuid.uuid4()),
            "entity_type": "chat",
            "execution_strategy": "parallel",
            "metadata": {"source": "e2e-stress"},
        }
        create_resp = await real_client.post("/v1/agent/start", json=job_payload)
        if create_resp.status_code != 201:
            pytest.fail(f"Unable to enqueue jobs for stress test (status={create_resp.status_code})")
        created_job_ids.append(create_resp.json().get("job_id"))

    list_resp = await real_client.get("/v1/agent/jobs", params={"limit": 50})
    assert list_resp.status_code == 200

    for job_id in created_job_ids:
        if not job_id:
            continue
        cancel_resp = await real_client.post(f"/v1/agent/stop/{job_id}")
        if cancel_resp.status_code == 200:
            await real_client.delete(f"/v1/agent/delete/{job_id}")

    if not was_enabled:
        await real_client.put(
            f"/v1/agent/config/{agent_name}",
            json={"enabled": False},
        )
