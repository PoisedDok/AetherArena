"""
Unit Tests: RequestMapper

Tests the frontend↔backend ID mapping service — registration,
resolution, duplicate detection, forget/cleanup, and concurrency.

Pure in-memory, no mocks needed (operates on internal dicts).
"""

import asyncio


from ws.application.lifecycle.request_mapper import RequestMapper


# =========================================================================
# Helpers
# =========================================================================

CLIENT_1 = "client-001"
CLIENT_2 = "client-002"
FRONTEND_1 = "fe-req-001"
FRONTEND_2 = "fe-req-002"
BACKEND_1 = "be-req-001"
BACKEND_2 = "be-req-002"
BACKEND_3 = "be-req-003"
CORR_1 = "corr-001"
CORR_2 = "corr-002"


# =========================================================================
# Init
# =========================================================================

class TestInit:
    """Tests for RequestMapper.__init__."""

    def test_default_state(self):
        """Starts with empty maps."""
        mapper = RequestMapper()
        assert len(mapper._client_request_map) == 0
        assert len(mapper._backend_request_index) == 0


# =========================================================================
# register_mapping
# =========================================================================

class TestRegisterMapping:
    """Tests for RequestMapper.register_mapping."""

    async def test_register_basic_backend_id_only(self):
        """Register with backend_id only (no frontend/correlation)."""
        mapper = RequestMapper()
        result = await mapper.register_mapping(
            client_id=CLIENT_1,
            frontend_id=None,
            correlation_id=None,
            backend_id=BACKEND_1,
        )
        assert result is True
        # Backend_id maps to itself
        resolved = await mapper.resolve_backend_id(CLIENT_1, BACKEND_1)
        assert resolved == BACKEND_1

    async def test_register_with_frontend_id(self):
        """Register with frontend_id → resolves to backend_id."""
        mapper = RequestMapper()
        result = await mapper.register_mapping(
            client_id=CLIENT_1,
            frontend_id=FRONTEND_1,
            correlation_id=None,
            backend_id=BACKEND_1,
        )
        assert result is True
        resolved = await mapper.resolve_backend_id(CLIENT_1, FRONTEND_1)
        assert resolved == BACKEND_1

    async def test_register_with_correlation_id(self):
        """Register with correlation_id → resolves to backend_id."""
        mapper = RequestMapper()
        result = await mapper.register_mapping(
            client_id=CLIENT_1,
            frontend_id=None,
            correlation_id=CORR_1,
            backend_id=BACKEND_1,
        )
        assert result is True
        resolved = await mapper.resolve_backend_id(CLIENT_1, CORR_1)
        assert resolved == BACKEND_1

    async def test_register_with_all_ids(self):
        """Register with all three IDs — all resolve to backend_id."""
        mapper = RequestMapper()
        result = await mapper.register_mapping(
            client_id=CLIENT_1,
            frontend_id=FRONTEND_1,
            correlation_id=CORR_1,
            backend_id=BACKEND_1,
        )
        assert result is True

        # All three keys resolve to backend_id
        assert await mapper.resolve_backend_id(CLIENT_1, FRONTEND_1) == BACKEND_1
        assert await mapper.resolve_backend_id(CLIENT_1, CORR_1) == BACKEND_1
        assert await mapper.resolve_backend_id(CLIENT_1, BACKEND_1) == BACKEND_1

    async def test_duplicate_detection_different_backend_id(self):
        """Same frontend_id mapped to different backend_id → duplicate (False)."""
        mapper = RequestMapper()
        await mapper.register_mapping(
            client_id=CLIENT_1,
            frontend_id=FRONTEND_1,
            correlation_id=None,
            backend_id=BACKEND_1,
        )
        result = await mapper.register_mapping(
            client_id=CLIENT_1,
            frontend_id=FRONTEND_1,
            correlation_id=None,
            backend_id=BACKEND_2,  # Different backend_id
        )
        assert result is False

    async def test_same_backend_id_not_duplicate(self):
        """Re-registering same frontend→backend mapping → NOT a duplicate (True)."""
        mapper = RequestMapper()
        await mapper.register_mapping(
            client_id=CLIENT_1,
            frontend_id=FRONTEND_1,
            correlation_id=None,
            backend_id=BACKEND_1,
        )
        result = await mapper.register_mapping(
            client_id=CLIENT_1,
            frontend_id=FRONTEND_1,
            correlation_id=None,
            backend_id=BACKEND_1,  # Same backend_id
        )
        assert result is True

    async def test_duplicate_detection_on_correlation_id(self):
        """Same correlation_id mapped to different backend_id → duplicate."""
        mapper = RequestMapper()
        await mapper.register_mapping(
            client_id=CLIENT_1,
            frontend_id=None,
            correlation_id=CORR_1,
            backend_id=BACKEND_1,
        )
        result = await mapper.register_mapping(
            client_id=CLIENT_1,
            frontend_id=None,
            correlation_id=CORR_1,
            backend_id=BACKEND_2,
        )
        assert result is False

    async def test_duplicate_detection_on_backend_id_key(self):
        """Backend_id as key mapped to different backend_id → duplicate."""
        mapper = RequestMapper()
        # Register backend_1 as both key and value
        await mapper.register_mapping(
            client_id=CLIENT_1,
            frontend_id=BACKEND_2,  # Use BACKEND_2 as frontend_id
            correlation_id=None,
            backend_id=BACKEND_1,
        )
        # Now try to register BACKEND_2 as backend_id — BACKEND_2 is already
        # a key mapped to BACKEND_1
        result = await mapper.register_mapping(
            client_id=CLIENT_1,
            frontend_id=None,
            correlation_id=None,
            backend_id=BACKEND_2,
        )
        assert result is False

    async def test_backend_index_populated(self):
        """Backend index stores client_id, frontend_id, correlation_id."""
        mapper = RequestMapper()
        await mapper.register_mapping(
            client_id=CLIENT_1,
            frontend_id=FRONTEND_1,
            correlation_id=CORR_1,
            backend_id=BACKEND_1,
        )
        index_entry = mapper._backend_request_index.get(BACKEND_1)
        assert index_entry is not None
        assert index_entry["client_id"] == CLIENT_1
        assert index_entry["frontend_id"] == FRONTEND_1
        assert index_entry["correlation_id"] == CORR_1

    async def test_different_clients_same_frontend_id_detected_as_duplicate(self):
        """Global index detects cross-client frontend_id collisions.

        The RequestMapper uses a global (cross-client) index for deduplication.
        If two different clients try to register the same frontend_id with
        different backend_ids, the second registration is rejected and the
        first mapping is preserved.  See register_mapping() and the class
        docstring for the rationale.
        """
        mapper = RequestMapper()
        await mapper.register_mapping(
            client_id=CLIENT_1,
            frontend_id=FRONTEND_1,
            correlation_id=None,
            backend_id=BACKEND_1,
        )
        result = await mapper.register_mapping(
            client_id=CLIENT_2,
            frontend_id=FRONTEND_1,  # Same frontend_id, different client
            correlation_id=None,
            backend_id=BACKEND_2,
        )
        # Global dedup: second registration rejected because FRONTEND_1
        # already maps to BACKEND_1 in the global index.
        assert result is False
        # First mapping preserved for all clients
        assert await mapper.resolve_backend_id(CLIENT_1, FRONTEND_1) == BACKEND_1
        assert await mapper.resolve_backend_id(CLIENT_2, FRONTEND_1) == BACKEND_1


# =========================================================================
# resolve_backend_id
# =========================================================================

class TestResolveBackendId:
    """Tests for RequestMapper.resolve_backend_id."""

    async def test_resolve_existing_mapping(self):
        """Known frontend_id → returns backend_id."""
        mapper = RequestMapper()
        await mapper.register_mapping(
            client_id=CLIENT_1,
            frontend_id=FRONTEND_1,
            correlation_id=None,
            backend_id=BACKEND_1,
        )
        result = await mapper.resolve_backend_id(CLIENT_1, FRONTEND_1)
        assert result == BACKEND_1

    async def test_resolve_returns_input_when_not_found(self):
        """Unknown request_id → returns input unchanged."""
        mapper = RequestMapper()
        result = await mapper.resolve_backend_id(CLIENT_1, "unknown-id")
        assert result == "unknown-id"

    async def test_resolve_unknown_client(self):
        """Unknown client_id → returns input unchanged."""
        mapper = RequestMapper()
        result = await mapper.resolve_backend_id("no-such-client", FRONTEND_1)
        assert result == FRONTEND_1

    async def test_resolve_by_backend_id(self):
        """Backend_id resolves to itself."""
        mapper = RequestMapper()
        await mapper.register_mapping(
            client_id=CLIENT_1,
            frontend_id=FRONTEND_1,
            correlation_id=None,
            backend_id=BACKEND_1,
        )
        result = await mapper.resolve_backend_id(CLIENT_1, BACKEND_1)
        assert result == BACKEND_1

    async def test_resolve_by_correlation_id(self):
        """Correlation_id resolves to backend_id."""
        mapper = RequestMapper()
        await mapper.register_mapping(
            client_id=CLIENT_1,
            frontend_id=None,
            correlation_id=CORR_1,
            backend_id=BACKEND_1,
        )
        result = await mapper.resolve_backend_id(CLIENT_1, CORR_1)
        assert result == BACKEND_1


# =========================================================================
# forget_mapping
# =========================================================================

class TestForgetMapping:
    """Tests for RequestMapper.forget_mapping."""

    async def test_forget_removes_all_keys(self):
        """Forget removes frontend_id, correlation_id, and backend_id keys."""
        mapper = RequestMapper()
        await mapper.register_mapping(
            client_id=CLIENT_1,
            frontend_id=FRONTEND_1,
            correlation_id=CORR_1,
            backend_id=BACKEND_1,
        )
        await mapper.forget_mapping(
            client_id=CLIENT_1,
            frontend_id=FRONTEND_1,
            correlation_id=CORR_1,
            backend_id=BACKEND_1,
        )
        # All keys should be gone
        assert await mapper.resolve_backend_id(CLIENT_1, FRONTEND_1) == FRONTEND_1
        assert await mapper.resolve_backend_id(CLIENT_1, CORR_1) == CORR_1
        assert await mapper.resolve_backend_id(CLIENT_1, BACKEND_1) == BACKEND_1

    async def test_forget_removes_backend_index(self):
        """Forget removes entry from backend_request_index."""
        mapper = RequestMapper()
        await mapper.register_mapping(
            client_id=CLIENT_1,
            frontend_id=FRONTEND_1,
            correlation_id=None,
            backend_id=BACKEND_1,
        )
        await mapper.forget_mapping(
            client_id=CLIENT_1,
            frontend_id=FRONTEND_1,
            backend_id=BACKEND_1,
        )
        assert BACKEND_1 not in mapper._backend_request_index

    async def test_forget_uses_stored_keys_from_index(self):
        """Forget retrieves stored frontend/correlation from index."""
        mapper = RequestMapper()
        # Register with frontend_id and correlation_id
        await mapper.register_mapping(
            client_id=CLIENT_1,
            frontend_id=FRONTEND_1,
            correlation_id=CORR_1,
            backend_id=BACKEND_1,
        )
        # Forget with only backend_id (no frontend/correlation args)
        await mapper.forget_mapping(
            client_id=CLIENT_1,
            frontend_id=None,  # Not provided
            correlation_id=None,  # Not provided
            backend_id=BACKEND_1,
        )
        # Should still clean up FRONTEND_1 and CORR_1 from stored index
        assert await mapper.resolve_backend_id(CLIENT_1, FRONTEND_1) == FRONTEND_1
        assert await mapper.resolve_backend_id(CLIENT_1, CORR_1) == CORR_1

    async def test_forget_cleans_empty_client_map(self):
        """If client map becomes empty after forget, client entry is removed."""
        mapper = RequestMapper()
        await mapper.register_mapping(
            client_id=CLIENT_1,
            frontend_id=None,
            correlation_id=None,
            backend_id=BACKEND_1,
        )
        await mapper.forget_mapping(
            client_id=CLIENT_1,
            frontend_id=None,
            backend_id=BACKEND_1,
        )
        assert CLIENT_1 not in mapper._client_request_map

    async def test_forget_preserves_other_mappings(self):
        """Forgetting one mapping doesn't affect others for same client."""
        mapper = RequestMapper()
        await mapper.register_mapping(
            client_id=CLIENT_1,
            frontend_id=FRONTEND_1,
            correlation_id=None,
            backend_id=BACKEND_1,
        )
        await mapper.register_mapping(
            client_id=CLIENT_1,
            frontend_id=FRONTEND_2,
            correlation_id=None,
            backend_id=BACKEND_2,
        )
        await mapper.forget_mapping(
            client_id=CLIENT_1,
            frontend_id=FRONTEND_1,
            backend_id=BACKEND_1,
        )
        # BACKEND_2 mapping should still work
        assert await mapper.resolve_backend_id(CLIENT_1, FRONTEND_2) == BACKEND_2

    async def test_forget_nonexistent_no_error(self):
        """Forgetting a mapping that doesn't exist → no error."""
        mapper = RequestMapper()
        await mapper.forget_mapping(
            client_id="nonexistent",
            frontend_id=None,
            backend_id="nonexistent-backend",
        )
        # Should not raise


# =========================================================================
# cleanup_client_mappings
# =========================================================================

class TestCleanupClientMappings:
    """Tests for RequestMapper.cleanup_client_mappings."""

    async def test_cleanup_removes_all_mappings(self):
        """Cleanup removes all mappings for a client."""
        mapper = RequestMapper()
        await mapper.register_mapping(
            client_id=CLIENT_1,
            frontend_id=FRONTEND_1,
            correlation_id=None,
            backend_id=BACKEND_1,
        )
        await mapper.register_mapping(
            client_id=CLIENT_1,
            frontend_id=FRONTEND_2,
            correlation_id=None,
            backend_id=BACKEND_2,
        )
        await mapper.cleanup_client_mappings(CLIENT_1)

        assert CLIENT_1 not in mapper._client_request_map
        assert await mapper.resolve_backend_id(CLIENT_1, FRONTEND_1) == FRONTEND_1
        assert await mapper.resolve_backend_id(CLIENT_1, FRONTEND_2) == FRONTEND_2

    async def test_cleanup_removes_backend_index_entries(self):
        """Cleanup removes all backend_request_index entries for client."""
        mapper = RequestMapper()
        await mapper.register_mapping(
            client_id=CLIENT_1,
            frontend_id=FRONTEND_1,
            correlation_id=None,
            backend_id=BACKEND_1,
        )
        await mapper.register_mapping(
            client_id=CLIENT_1,
            frontend_id=FRONTEND_2,
            correlation_id=None,
            backend_id=BACKEND_2,
        )
        await mapper.cleanup_client_mappings(CLIENT_1)

        assert BACKEND_1 not in mapper._backend_request_index
        assert BACKEND_2 not in mapper._backend_request_index

    async def test_cleanup_preserves_other_clients(self):
        """Cleanup for one client doesn't affect another."""
        mapper = RequestMapper()
        await mapper.register_mapping(
            client_id=CLIENT_1,
            frontend_id=FRONTEND_1,
            correlation_id=None,
            backend_id=BACKEND_1,
        )
        await mapper.register_mapping(
            client_id=CLIENT_2,
            frontend_id=FRONTEND_2,
            correlation_id=None,
            backend_id=BACKEND_2,
        )
        await mapper.cleanup_client_mappings(CLIENT_1)

        # CLIENT_2 should be unaffected
        assert await mapper.resolve_backend_id(CLIENT_2, FRONTEND_2) == BACKEND_2

    async def test_cleanup_nonexistent_client_no_error(self):
        """Cleanup for non-existent client → no error."""
        mapper = RequestMapper()
        await mapper.cleanup_client_mappings("no-such-client")
        # Should not raise

    async def test_cleanup_empty_client_no_error(self):
        """Cleanup after all mappings already forgotten → no error."""
        mapper = RequestMapper()
        await mapper.register_mapping(
            client_id=CLIENT_1,
            frontend_id=FRONTEND_1,
            correlation_id=None,
            backend_id=BACKEND_1,
        )
        await mapper.forget_mapping(
            client_id=CLIENT_1,
            frontend_id=FRONTEND_1,
            backend_id=BACKEND_1,
        )
        # Client entry may already be removed by forget
        await mapper.cleanup_client_mappings(CLIENT_1)
        # Should not raise


# =========================================================================
# Concurrency
# =========================================================================

class TestConcurrency:
    """Tests for thread-safety under concurrent access."""

    async def test_concurrent_register_and_resolve(self):
        """Concurrent registration and resolution should not corrupt state."""
        mapper = RequestMapper()

        async def register_and_resolve(idx):
            fid = f"fe-{idx}"
            bid = f"be-{idx}"
            cid = f"client-{idx % 3}"  # 3 clients
            await mapper.register_mapping(
                client_id=cid,
                frontend_id=fid,
                correlation_id=None,
                backend_id=bid,
            )
            resolved = await mapper.resolve_backend_id(cid, fid)
            assert resolved == bid

        # Run 20 concurrent registrations
        tasks = [register_and_resolve(i) for i in range(20)]
        await asyncio.gather(*tasks)

    async def test_concurrent_forget(self):
        """Concurrent forget should not raise or corrupt state."""
        mapper = RequestMapper()

        # Pre-register
        for i in range(10):
            await mapper.register_mapping(
                client_id=CLIENT_1,
                frontend_id=f"fe-{i}",
                correlation_id=None,
                backend_id=f"be-{i}",
            )

        async def forget_one(idx):
            await mapper.forget_mapping(
                client_id=CLIENT_1,
                frontend_id=f"fe-{idx}",
                backend_id=f"be-{idx}",
            )

        tasks = [forget_one(i) for i in range(10)]
        await asyncio.gather(*tasks)

        # All should be forgotten
        for i in range(10):
            result = await mapper.resolve_backend_id(CLIENT_1, f"fe-{i}")
            assert result == f"fe-{i}"  # Returns input (not found)
