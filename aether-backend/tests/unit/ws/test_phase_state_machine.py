"""
Unit tests for ws.domain.services.phase_state_machine

Tests PhaseStateMachine:
- Initial state
- Phase tracking (update_phase, get_current_phase)
- Artifact tracking (track_artifact_type)
- Cycle detection (is_new_code_cycle)
- Reset behavior (reset)
- Full lifecycle sequences

Pure domain logic — no mocks needed.

Bugs found: 0
"""


from ws.domain.services.phase_state_machine import PhaseStateMachine


# ---------------------------------------------------------------------------
# Initial state
# ---------------------------------------------------------------------------

class TestInitialState:
    """Verify clean initial state."""

    def test_initial_phase_is_none(self):
        """Phase starts as None."""
        sm = PhaseStateMachine()
        assert sm.get_current_phase() is None

    def test_initial_not_new_cycle(self):
        """No cycle detected in fresh state (last_artifact_type is None)."""
        sm = PhaseStateMachine()
        assert sm.is_new_code_cycle("code") is False

    def test_initial_not_new_cycle_for_output(self):
        """Output artifact in fresh state is not a new cycle."""
        sm = PhaseStateMachine()
        assert sm.is_new_code_cycle("output") is False


# ---------------------------------------------------------------------------
# update_phase and get_current_phase
# ---------------------------------------------------------------------------

class TestUpdatePhase:
    """Tests for update_phase / get_current_phase."""

    def test_update_returns_true_on_change(self):
        """Phase change returns True."""
        sm = PhaseStateMachine()
        assert sm.update_phase("writing") is True

    def test_update_returns_false_on_same(self):
        """Same phase returns False."""
        sm = PhaseStateMachine()
        sm.update_phase("writing")
        assert sm.update_phase("writing") is False

    def test_phase_stored_correctly(self):
        """get_current_phase reflects last update."""
        sm = PhaseStateMachine()
        sm.update_phase("writing")
        assert sm.get_current_phase() == "writing"

    def test_phase_transitions(self):
        """Full writing → executing → output transition."""
        sm = PhaseStateMachine()
        assert sm.update_phase("writing") is True
        assert sm.get_current_phase() == "writing"

        assert sm.update_phase("executing") is True
        assert sm.get_current_phase() == "executing"

        assert sm.update_phase("output") is True
        assert sm.get_current_phase() == "output"

    def test_backwards_transition(self):
        """Phase can go backwards (output → writing for new cycle)."""
        sm = PhaseStateMachine()
        sm.update_phase("output")
        assert sm.update_phase("writing") is True
        assert sm.get_current_phase() == "writing"

    def test_update_from_none_to_phase(self):
        """First update from None returns True."""
        sm = PhaseStateMachine()
        assert sm.update_phase("executing") is True

    def test_update_with_arbitrary_string(self):
        """update_phase accepts any string, no validation."""
        sm = PhaseStateMachine()
        assert sm.update_phase("unknown_phase") is True
        assert sm.get_current_phase() == "unknown_phase"


# ---------------------------------------------------------------------------
# track_artifact_type
# ---------------------------------------------------------------------------

class TestTrackArtifactType:
    """Tests for track_artifact_type."""

    def test_tracks_code(self):
        """'code' artifact is tracked."""
        sm = PhaseStateMachine()
        sm.track_artifact_type("code")
        # Verify by checking cycle detection behavior
        assert sm.is_new_code_cycle("code") is False  # code after code = not new

    def test_tracks_output(self):
        """'output' artifact is tracked."""
        sm = PhaseStateMachine()
        sm.track_artifact_type("output")
        # Now code after output = new cycle
        assert sm.is_new_code_cycle("code") is True

    def test_ignores_unknown_type(self):
        """Unknown artifact types are ignored."""
        sm = PhaseStateMachine()
        sm.track_artifact_type("image")
        # _last_artifact_type stays None
        assert sm.is_new_code_cycle("code") is False

    def test_ignores_empty_string(self):
        """Empty string is ignored."""
        sm = PhaseStateMachine()
        sm.track_artifact_type("")
        assert sm.is_new_code_cycle("code") is False

    def test_overwrites_previous(self):
        """Tracking a new type overwrites the previous."""
        sm = PhaseStateMachine()
        sm.track_artifact_type("output")
        sm.track_artifact_type("code")
        # Last is now 'code', so code after code = not new cycle
        assert sm.is_new_code_cycle("code") is False

    def test_unknown_after_valid_preserves_valid(self):
        """Unknown type does not clear previously tracked valid type."""
        sm = PhaseStateMachine()
        sm.track_artifact_type("output")
        sm.track_artifact_type("image")  # ignored
        # Last is still 'output'
        assert sm.is_new_code_cycle("code") is True


# ---------------------------------------------------------------------------
# is_new_code_cycle
# ---------------------------------------------------------------------------

class TestIsNewCodeCycle:
    """Tests for is_new_code_cycle."""

    def test_code_after_output_is_new(self):
        """code after output = TRUE (new cycle)."""
        sm = PhaseStateMachine()
        sm.track_artifact_type("output")
        assert sm.is_new_code_cycle("code") is True

    def test_code_after_code_is_not_new(self):
        """code after code = FALSE."""
        sm = PhaseStateMachine()
        sm.track_artifact_type("code")
        assert sm.is_new_code_cycle("code") is False

    def test_output_after_output_is_not_new(self):
        """output after output = FALSE (must be 'code' to be new cycle)."""
        sm = PhaseStateMachine()
        sm.track_artifact_type("output")
        assert sm.is_new_code_cycle("output") is False

    def test_output_after_code_is_not_new(self):
        """output after code = FALSE."""
        sm = PhaseStateMachine()
        sm.track_artifact_type("code")
        assert sm.is_new_code_cycle("output") is False

    def test_unknown_current_type_is_not_new(self):
        """Unknown current artifact type = FALSE."""
        sm = PhaseStateMachine()
        sm.track_artifact_type("output")
        assert sm.is_new_code_cycle("image") is False

    def test_does_not_mutate_state(self):
        """is_new_code_cycle is a query, does not change state."""
        sm = PhaseStateMachine()
        sm.track_artifact_type("output")
        sm.is_new_code_cycle("code")
        sm.is_new_code_cycle("code")
        # Still True on repeated calls — no state mutation
        assert sm.is_new_code_cycle("code") is True


# ---------------------------------------------------------------------------
# reset
# ---------------------------------------------------------------------------

class TestReset:
    """Tests for reset."""

    def test_resets_phase_to_none(self):
        """Phase becomes None after reset."""
        sm = PhaseStateMachine()
        sm.update_phase("executing")
        sm.reset()
        assert sm.get_current_phase() is None

    def test_preserves_last_artifact_type(self):
        """_last_artifact_type is NOT reset (by design, for cross-subgroup cycle detection)."""
        sm = PhaseStateMachine()
        sm.track_artifact_type("output")
        sm.reset()
        # Cycle detection still works after reset
        assert sm.is_new_code_cycle("code") is True

    def test_double_reset(self):
        """Double reset is safe."""
        sm = PhaseStateMachine()
        sm.update_phase("writing")
        sm.reset()
        sm.reset()
        assert sm.get_current_phase() is None

    def test_update_after_reset(self):
        """update_phase works after reset."""
        sm = PhaseStateMachine()
        sm.update_phase("output")
        sm.reset()
        assert sm.update_phase("writing") is True
        assert sm.get_current_phase() == "writing"


# ---------------------------------------------------------------------------
# Full lifecycle sequence
# ---------------------------------------------------------------------------

class TestFullLifecycle:
    """End-to-end lifecycle tests."""

    def test_complete_cycle_then_new_cycle(self):
        """writing→executing→output, then code = NEW cycle."""
        sm = PhaseStateMachine()

        sm.update_phase("writing")
        sm.track_artifact_type("code")

        sm.update_phase("executing")

        sm.update_phase("output")
        sm.track_artifact_type("output")

        # New code after output = new cycle
        assert sm.is_new_code_cycle("code") is True

    def test_reset_mid_cycle(self):
        """Reset during cycle clears phase but preserves artifact tracking."""
        sm = PhaseStateMachine()

        sm.update_phase("writing")
        sm.track_artifact_type("code")

        sm.reset()
        assert sm.get_current_phase() is None

        # Start new subgroup — artifact memory persists
        sm.update_phase("writing")
        sm.track_artifact_type("code")
        assert sm.is_new_code_cycle("code") is False
