"""
Tests for workers/handlers/base_handler.py

Covers: BaseHandler constructor, complete_job, fail_job, _extract_job_metadata,
_log_job_start, _log_job_end.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

from workers.handlers.base_handler import BaseHandler
from data.database.persistence_gateway import SupabasePersistenceGateway


class ConcreteHandler(BaseHandler):
    """Concrete implementation for testing abstract base class."""
    async def execute(self, job):
        pass


def _make_gateway():
    gw = MagicMock(spec=SupabasePersistenceGateway)
    gw.rpc = AsyncMock()
    return gw


@pytest.fixture
def handler():
    gw = _make_gateway()
    return ConcreteHandler(gw), gw


class TestConstructor:
    def test_init(self, handler):
        h, gw = handler
        assert h._gateway is gw

    def test_abstract_prevents_instantiation(self):
        gw = _make_gateway()
        with pytest.raises(TypeError):
            BaseHandler(gw)


class TestCompleteJob:
    @pytest.mark.asyncio
    async def test_complete_job(self, handler):
        h, gw = handler
        job_id = uuid4()
        await h.complete_job(job_id, result={"items": 5})
        gw.rpc.assert_called_once_with("complete_job", {"p_job_id": str(job_id)})

    @pytest.mark.asyncio
    async def test_complete_job_db_error_suppressed(self, handler):
        h, gw = handler
        gw.rpc.side_effect = Exception("DB error")
        await h.complete_job(uuid4())
        # Should not raise


class TestFailJob:
    @pytest.mark.asyncio
    async def test_fail_permanent(self, handler):
        h, gw = handler
        job_id = uuid4()
        await h.fail_job(job_id, "out of memory", retry=False)
        gw.rpc.assert_called_once_with("fail_job", {
            "p_job_id": str(job_id),
            "p_error_message": "out of memory",
            "p_retry": False,
        })

    @pytest.mark.asyncio
    async def test_fail_with_retry(self, handler):
        h, gw = handler
        job_id = uuid4()
        await h.fail_job(job_id, "timeout", retry=True)
        gw.rpc.assert_called_once()
        call_args = gw.rpc.call_args[0][1]
        assert call_args["p_retry"] is True

    @pytest.mark.asyncio
    async def test_fail_job_db_error_suppressed(self, handler):
        h, gw = handler
        gw.rpc.side_effect = Exception("DB error")
        await h.fail_job(uuid4(), "error")


class TestExtractMetadata:
    def test_dict_metadata(self, handler):
        h, _ = handler
        result = h._extract_job_metadata({"metadata": {"key": "value"}})
        assert result == {"key": "value"}

    def test_none_metadata(self, handler):
        h, _ = handler
        result = h._extract_job_metadata({"metadata": None})
        assert result == {}

    def test_json_string_metadata(self, handler):
        h, _ = handler
        result = h._extract_job_metadata({"metadata": '{"key": "val"}'})
        assert result == {"key": "val"}

    def test_invalid_json_string(self, handler):
        h, _ = handler
        result = h._extract_job_metadata({"metadata": "not json"})
        assert result == {}

    def test_missing_metadata(self, handler):
        h, _ = handler
        result = h._extract_job_metadata({})
        assert result == {}


class TestLogging:
    def test_log_job_start(self, handler):
        h, _ = handler
        h._log_job_start({"id": str(uuid4()), "job_type": "test", "entity_id": "e1"})

    def test_log_job_end(self, handler):
        h, _ = handler
        h._log_job_end({"id": str(uuid4()), "job_type": "test"}, duration=1.5)
