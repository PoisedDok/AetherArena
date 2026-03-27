"""
Unit Tests: Events — data/database/events.py

Coverage of write_event and link_message_artifact.
Mock boundary: SupabasePersistenceGateway.insert.
"""

import pytest
from unittest.mock import AsyncMock

from data.database.uow import SupabaseRequestContext, SupabaseUnitOfWork
from data.database.events import write_event, link_message_artifact


@pytest.fixture
def uow():
    gw = AsyncMock()
    ctx = SupabaseRequestContext(
        request_id="req-1",
        correlation_id="corr-1",
        session_id="sess-1",
        user_id="user-1",
    )
    return SupabaseUnitOfWork(gateway=gw, context=ctx)


class TestWriteEvent:

    @pytest.mark.asyncio
    async def test_write_event_returns_first_record(self, uow):
        uow.gateway.insert.return_value = [{"id": "evt-1", "event_type": "chat.sent"}]

        result = await write_event(
            uow,
            event_type="chat.sent",
            details={"message_id": "m1"},
        )

        assert result["id"] == "evt-1"
        uow.gateway.insert.assert_awaited_once()
        call_args = uow.gateway.insert.call_args
        assert call_args[0][0] == "events"
        payload = call_args[0][1]
        assert payload["event_type"] == "chat.sent"
        assert payload["source"] == "http"
        assert payload["severity"] == "info"
        assert payload["request_id"] == "req-1"
        assert payload["session_id"] == "sess-1"
        assert payload["user_id"] == "user-1"

    @pytest.mark.asyncio
    async def test_write_event_overrides_context(self, uow):
        uow.gateway.insert.return_value = [{"id": "evt-2"}]

        result = await write_event(
            uow,
            event_type="error",
            details={},
            request_id="override-req",
            user_id="override-user",
            severity="error",
            source="ws",
        )

        payload = uow.gateway.insert.call_args[0][1]
        assert payload["request_id"] == "override-req"
        assert payload["user_id"] == "override-user"
        assert payload["severity"] == "error"
        assert payload["source"] == "ws"

    @pytest.mark.asyncio
    async def test_write_event_non_list_return(self, uow):
        """Gateway returns dict directly instead of list."""
        uow.gateway.insert.return_value = {"id": "evt-3"}

        result = await write_event(uow, event_type="test", details={})
        assert result["id"] == "evt-3"

    @pytest.mark.asyncio
    async def test_write_event_empty_list_return(self, uow):
        """Gateway returns empty list."""
        uow.gateway.insert.return_value = []
        result = await write_event(uow, event_type="test", details={})
        assert result == []


class TestLinkMessageArtifact:

    @pytest.mark.asyncio
    async def test_link_returns_record(self, uow):
        uow.gateway.insert.return_value = [{"id": "link-1"}]

        result = await link_message_artifact(
            uow,
            message_id="msg-1",
            artifact_id="art-1",
            event_id="evt-1",
        )

        assert result["id"] == "link-1"
        payload = uow.gateway.insert.call_args[0][1]
        assert payload["message_id"] == "msg-1"
        assert payload["artifact_id"] == "art-1"
        assert payload["event_id"] == "evt-1"

    @pytest.mark.asyncio
    async def test_link_no_event_id(self, uow):
        uow.gateway.insert.return_value = [{"id": "link-2"}]

        await link_message_artifact(uow, message_id="m", artifact_id="a")

        payload = uow.gateway.insert.call_args[0][1]
        assert payload["event_id"] is None

    @pytest.mark.asyncio
    async def test_link_non_list_return(self, uow):
        uow.gateway.insert.return_value = {"id": "link-3"}
        result = await link_message_artifact(uow, message_id="m", artifact_id="a")
        assert result["id"] == "link-3"
