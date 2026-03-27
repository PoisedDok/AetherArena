"""
Unit Tests: Unit of Work — data/database/uow.py

Coverage of SupabaseRequestContext (to_attributes, with_extras)
and SupabaseUnitOfWork (lifecycle, span tracing, child creation).
"""

import pytest
from unittest.mock import MagicMock

from data.database.uow import SupabaseRequestContext, SupabaseUnitOfWork


class TestSupabaseRequestContext:

    def test_to_attributes_full(self):
        ctx = SupabaseRequestContext(
            request_id="r1",
            correlation_id="c1",
            session_id="s1",
            user_id="u1",
            actor_id="a1",
            extras={"custom": "val"},
        )
        attrs = ctx.to_attributes()
        assert attrs["request.id"] == "r1"
        assert attrs["correlation.id"] == "c1"
        assert attrs["session.id"] == "s1"
        assert attrs["user.id"] == "u1"
        assert attrs["actor.id"] == "a1"
        assert attrs["custom"] == "val"

    def test_to_attributes_filters_none(self):
        ctx = SupabaseRequestContext(request_id="r1")
        attrs = ctx.to_attributes()
        assert "request.id" in attrs
        assert "correlation.id" not in attrs
        assert "session.id" not in attrs

    def test_with_extras_merges(self):
        ctx = SupabaseRequestContext(request_id="r1", extras={"a": 1})
        ctx2 = ctx.with_extras(b=2)
        assert ctx2.extras == {"a": 1, "b": 2}
        assert ctx.extras == {"a": 1}  # original unchanged (frozen)

    def test_with_extras_skips_none(self):
        ctx = SupabaseRequestContext(request_id="r1")
        ctx2 = ctx.with_extras(x=None, y="kept")
        assert "x" not in ctx2.extras
        assert ctx2.extras["y"] == "kept"

    def test_immutable(self):
        ctx = SupabaseRequestContext(request_id="r1")
        with pytest.raises(AttributeError):
            ctx.request_id = "changed"


class TestSupabaseUnitOfWork:

    @pytest.fixture
    def gateway(self):
        return MagicMock()

    @pytest.fixture
    def context(self):
        return SupabaseRequestContext(request_id="r1", session_id="s1")

    def test_init_requires_gateway(self):
        ctx = SupabaseRequestContext(request_id="r1")
        with pytest.raises(ValueError, match="persistence gateway"):
            SupabaseUnitOfWork(gateway=None, context=ctx)

    @pytest.mark.asyncio
    async def test_context_manager(self, gateway, context):
        uow = SupabaseUnitOfWork(gateway=gateway, context=context)
        async with uow as entered:
            assert entered is uow

    def test_gateway_property(self, gateway, context):
        uow = SupabaseUnitOfWork(gateway=gateway, context=context)
        assert uow.gateway is gateway

    def test_child_creates_new_uow(self, gateway, context):
        uow = SupabaseUnitOfWork(gateway=gateway, context=context)
        child = uow.child(task="processing")
        assert child is not uow
        assert child.gateway is gateway
        assert child.context.extras["task"] == "processing"
        assert child.context.request_id == "r1"

    @pytest.mark.asyncio
    async def test_close_finishes_span(self, gateway, context):
        uow = SupabaseUnitOfWork(gateway=gateway, context=context)
        async with uow:
            pass
        # After exiting, span_ctx should be None
        assert uow._span_ctx is None

    @pytest.mark.asyncio
    async def test_span_error_handled(self, gateway, context):
        """Span finish failure is logged, not propagated."""
        uow = SupabaseUnitOfWork(gateway=gateway, context=context)
        mock_span = MagicMock()
        mock_span.__exit__ = MagicMock(side_effect=RuntimeError("span crash"))
        uow._span_ctx = mock_span

        # Should not raise
        await uow.__aexit__(None, None, None)
        assert uow._span_ctx is None
