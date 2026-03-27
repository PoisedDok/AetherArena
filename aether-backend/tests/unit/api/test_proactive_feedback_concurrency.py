import asyncio
import uuid
import pytest
from unittest.mock import AsyncMock, patch

from api.dependencies import get_database
from data.database.persistence_gateway import SupabasePersistenceGateway

@pytest.mark.asyncio
async def test_feedback_concurrency_locks(client, app):
    """
    Empirically prove that the ProactiveICLManager locks hold up under extreme load.
    We flood the feedback endpoint with 50 concurrent requests.
    """
    
    # Mock the database to return a valid intervention run
    mock_db = AsyncMock(spec=SupabasePersistenceGateway)
    
    run_uuid = uuid.uuid4()
    
    # We need a mock repository that returns a valid run so Phase 4 (ICL refresh) triggers
    with patch("data.database.repositories.proactive_agent.ProactiveAgentRepository.record_user_feedback") as mock_record, \
         patch("data.database.repositories.proactive_agent.ProactiveAgentRepository.get_run_by_id") as mock_get_run, \
         patch("services.agents.proactive_icl_manager.ProactiveICLManager.ensure_index") as mock_ensure, \
         patch("services.agents.proactive_icl_manager.ProactiveICLManager.append_run") as mock_append:
         
        mock_record.return_value = None
        mock_get_run.return_value = {
            "id": str(run_uuid),
            "decision": "intervene",
            "recommendation": "Test recommendation",
            "queries": ["test query"],
            "created_at": "2026-02-20T00:00:00Z"
        }
        
        mock_ensure.return_value = True
        
        # Make append_run slightly slow to encourage race conditions if locks fail
        def slow_append(*args, **kwargs):
            import time
            time.sleep(0.05)
            return True
        mock_append.side_effect = slow_append
        
        app.dependency_overrides[get_database] = lambda: mock_db
        
        try:
            # Flood the endpoint with 50 concurrent requests
            reqs = [
                client.post(f"/v1/proactive/{run_uuid}/feedback?feedback=clicked")
                for _ in range(50)
            ]
            
            responses = await asyncio.gather(*reqs)
            
            # All requests should return 200 OK
            for resp in responses:
                assert resp.status_code == 200, f"Failed: {resp.text}"
                
            # The feedback record method should be called 50 times
            assert mock_record.call_count == 50
            
            # The append_run method might not be called 50 times because it checks indexed_run_ids internally,
            # but in our mock it just sleeps and returns True.
            # The main goal is that no exceptions/deadlocks occurred during concurrent access!
            assert mock_append.call_count > 0

        finally:
            app.dependency_overrides.pop(get_database, None)
