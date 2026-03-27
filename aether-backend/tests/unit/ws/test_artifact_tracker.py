"""
Unit tests for ws.domain.services.artifact_tracker

Tests ArtifactTracker:
- store_artifact_id: with/without raw_type
- get_artifact_id: normalized, raw_type, original_type fallback chain
- is_already_linked / mark_as_linked: deduplication
- clear_linked: clears linked set only
- reset: clears everything
- has_artifact_type: existence check

Pure domain logic — no mocks needed.

Bugs found: 0
"""


from ws.domain.services.artifact_tracker import ArtifactTracker


# ---------------------------------------------------------------------------
# Initial state
# ---------------------------------------------------------------------------

class TestInitialState:
    """Verify clean initial state."""

    def test_no_artifact_ids(self):
        """No artifact IDs stored initially."""
        t = ArtifactTracker()
        assert t.get_artifact_id("code") is None

    def test_no_linked_artifacts(self):
        """No artifacts linked initially."""
        t = ArtifactTracker()
        assert t.is_already_linked("art-001") is False

    def test_has_artifact_type_false(self):
        """has_artifact_type returns False for any type."""
        t = ArtifactTracker()
        assert t.has_artifact_type("code") is False


# ---------------------------------------------------------------------------
# store_artifact_id
# ---------------------------------------------------------------------------

class TestStoreArtifactId:
    """Tests for store_artifact_id."""

    def test_store_and_retrieve(self):
        """Stored artifact ID is retrievable by event_type."""
        t = ArtifactTracker()
        t.store_artifact_id("code", "art-001")
        assert t.get_artifact_id("code") == "art-001"

    def test_overwrite_existing(self):
        """Storing same event_type overwrites previous value."""
        t = ArtifactTracker()
        t.store_artifact_id("code", "art-001")
        t.store_artifact_id("code", "art-002")
        assert t.get_artifact_id("code") == "art-002"

    def test_multiple_types(self):
        """Different event types stored independently."""
        t = ArtifactTracker()
        t.store_artifact_id("code", "art-001")
        t.store_artifact_id("output", "art-002")
        assert t.get_artifact_id("code") == "art-001"
        assert t.get_artifact_id("output") == "art-002"

    def test_raw_type_stored_when_different(self):
        """raw_type is stored as alias when different from event_type."""
        t = ArtifactTracker()
        t.store_artifact_id("code", "art-001", raw_type="computer.code")
        assert t.get_artifact_id("code") == "art-001"
        assert t.get_artifact_id("computer.code") == "art-001"

    def test_raw_type_same_as_event_type_not_duplicated(self):
        """raw_type equal to event_type does not create duplicate entry."""
        t = ArtifactTracker()
        t.store_artifact_id("code", "art-001", raw_type="code")
        assert t.get_artifact_id("code") == "art-001"

    def test_raw_type_none_ignored(self):
        """raw_type=None does not create extra entry."""
        t = ArtifactTracker()
        t.store_artifact_id("code", "art-001", raw_type=None)
        assert t.get_artifact_id("code") == "art-001"

    def test_raw_type_empty_string_ignored(self):
        """raw_type="" is falsy, so ignored."""
        t = ArtifactTracker()
        t.store_artifact_id("code", "art-001", raw_type="")
        # "" is falsy, so no raw_type entry is created
        assert t.get_artifact_id("") is None


# ---------------------------------------------------------------------------
# get_artifact_id fallback chain
# ---------------------------------------------------------------------------

class TestGetArtifactIdFallback:
    """Tests for get_artifact_id with raw_type and original_type fallbacks."""

    def test_normalized_type_found(self):
        """First lookup by normalized event_type succeeds."""
        t = ArtifactTracker()
        t.store_artifact_id("code", "art-001")
        assert t.get_artifact_id("code") == "art-001"

    def test_raw_type_fallback(self):
        """Falls back to raw_type when event_type not found."""
        t = ArtifactTracker()
        t.store_artifact_id("computer.code", "art-001")
        # "code" is not stored, but "computer.code" is
        result = t.get_artifact_id("code", raw_type="computer.code")
        assert result == "art-001"

    def test_original_type_fallback(self):
        """Falls back to original_type when both event_type and raw_type fail."""
        t = ArtifactTracker()
        t.store_artifact_id("console", "art-001")
        result = t.get_artifact_id("output", raw_type="raw_output", original_type="console")
        assert result == "art-001"

    def test_all_miss_returns_none(self):
        """Returns None when all three lookups fail."""
        t = ArtifactTracker()
        result = t.get_artifact_id("code", raw_type="computer.code", original_type="console")
        assert result is None

    def test_normalized_takes_priority_over_raw(self):
        """Normalized type is checked first, even if raw_type also exists."""
        t = ArtifactTracker()
        t.store_artifact_id("code", "art-NORMALIZED")
        t.store_artifact_id("computer.code", "art-RAW")
        result = t.get_artifact_id("code", raw_type="computer.code")
        assert result == "art-NORMALIZED"

    def test_raw_takes_priority_over_original(self):
        """raw_type is checked before original_type."""
        t = ArtifactTracker()
        t.store_artifact_id("computer.code", "art-RAW")
        t.store_artifact_id("console", "art-ORIGINAL")
        result = t.get_artifact_id("missing", raw_type="computer.code", original_type="console")
        assert result == "art-RAW"

    def test_none_raw_type_skips_fallback(self):
        """None raw_type is treated as missing — skips that lookup."""
        t = ArtifactTracker()
        t.store_artifact_id("console", "art-001")
        result = t.get_artifact_id("missing", raw_type=None, original_type="console")
        assert result == "art-001"

    def test_none_original_type_skips_fallback(self):
        """None original_type is treated as missing — returns None."""
        t = ArtifactTracker()
        result = t.get_artifact_id("missing", raw_type="also_missing", original_type=None)
        assert result is None


# ---------------------------------------------------------------------------
# is_already_linked / mark_as_linked
# ---------------------------------------------------------------------------

class TestLinkedArtifacts:
    """Tests for artifact deduplication."""

    def test_not_linked_initially(self):
        """Artifact is not linked before mark_as_linked."""
        t = ArtifactTracker()
        assert t.is_already_linked("art-001") is False

    def test_linked_after_mark(self):
        """Artifact is linked after mark_as_linked."""
        t = ArtifactTracker()
        t.mark_as_linked("art-001")
        assert t.is_already_linked("art-001") is True

    def test_different_artifact_not_linked(self):
        """Marking one artifact does not link another."""
        t = ArtifactTracker()
        t.mark_as_linked("art-001")
        assert t.is_already_linked("art-002") is False

    def test_double_mark_is_safe(self):
        """Marking same artifact twice is idempotent (set)."""
        t = ArtifactTracker()
        t.mark_as_linked("art-001")
        t.mark_as_linked("art-001")
        assert t.is_already_linked("art-001") is True

    def test_multiple_artifacts_linked(self):
        """Multiple artifacts can be linked independently."""
        t = ArtifactTracker()
        t.mark_as_linked("art-001")
        t.mark_as_linked("art-002")
        assert t.is_already_linked("art-001") is True
        assert t.is_already_linked("art-002") is True


# ---------------------------------------------------------------------------
# clear_linked
# ---------------------------------------------------------------------------

class TestClearLinked:
    """Tests for clear_linked."""

    def test_clears_linked_set(self):
        """clear_linked removes all linked artifacts."""
        t = ArtifactTracker()
        t.mark_as_linked("art-001")
        t.mark_as_linked("art-002")
        t.clear_linked()
        assert t.is_already_linked("art-001") is False
        assert t.is_already_linked("art-002") is False

    def test_preserves_artifact_id_map(self):
        """clear_linked does NOT clear the artifact_id_map."""
        t = ArtifactTracker()
        t.store_artifact_id("code", "art-001")
        t.mark_as_linked("art-001")
        t.clear_linked()
        assert t.get_artifact_id("code") == "art-001"

    def test_clear_empty_set_is_safe(self):
        """Clearing empty linked set is safe."""
        t = ArtifactTracker()
        t.clear_linked()


# ---------------------------------------------------------------------------
# reset
# ---------------------------------------------------------------------------

class TestReset:
    """Tests for reset."""

    def test_clears_artifact_id_map(self):
        """reset clears artifact_id_map."""
        t = ArtifactTracker()
        t.store_artifact_id("code", "art-001")
        t.reset()
        assert t.get_artifact_id("code") is None

    def test_clears_linked_artifacts(self):
        """reset clears linked artifacts."""
        t = ArtifactTracker()
        t.mark_as_linked("art-001")
        t.reset()
        assert t.is_already_linked("art-001") is False

    def test_clears_both(self):
        """reset clears both maps."""
        t = ArtifactTracker()
        t.store_artifact_id("code", "art-001")
        t.mark_as_linked("art-001")
        t.reset()
        assert t.get_artifact_id("code") is None
        assert t.is_already_linked("art-001") is False

    def test_usable_after_reset(self):
        """Tracker is usable after reset."""
        t = ArtifactTracker()
        t.store_artifact_id("code", "art-001")
        t.reset()
        t.store_artifact_id("output", "art-002")
        assert t.get_artifact_id("output") == "art-002"


# ---------------------------------------------------------------------------
# has_artifact_type
# ---------------------------------------------------------------------------

class TestHasArtifactType:
    """Tests for has_artifact_type."""

    def test_returns_true_when_stored(self):
        """Returns True after store_artifact_id."""
        t = ArtifactTracker()
        t.store_artifact_id("code", "art-001")
        assert t.has_artifact_type("code") is True

    def test_returns_false_when_not_stored(self):
        """Returns False for unstored type."""
        t = ArtifactTracker()
        assert t.has_artifact_type("code") is False

    def test_returns_true_for_raw_type(self):
        """Returns True for raw_type alias."""
        t = ArtifactTracker()
        t.store_artifact_id("code", "art-001", raw_type="computer.code")
        assert t.has_artifact_type("computer.code") is True

    def test_returns_false_after_reset(self):
        """Returns False after reset."""
        t = ArtifactTracker()
        t.store_artifact_id("code", "art-001")
        t.reset()
        assert t.has_artifact_type("code") is False
