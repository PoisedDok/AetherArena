"""
Unit tests for ws.domain.builders.phase_detector

Tests:
- detect_phase: role/type/format → phase mapping
- is_phase_transition: transition detection
- validate_phase: phase validation
- EXECUTION_PHASES constant

Pure domain logic — no mocks needed.

Bugs found: 0
"""


from ws.domain.builders.phase_detector import (
    EXECUTION_PHASES,
    detect_phase,
    is_phase_transition,
    validate_phase,
)


# ---------------------------------------------------------------------------
# EXECUTION_PHASES constant
# ---------------------------------------------------------------------------

class TestExecutionPhases:
    """Verify EXECUTION_PHASES constant."""

    def test_correct_phases_in_order(self):
        """Phases are writing → executing → output."""
        assert EXECUTION_PHASES == ["writing", "executing", "output"]

    def test_is_list(self):
        """EXECUTION_PHASES is a list (ordered)."""
        assert isinstance(EXECUTION_PHASES, list)


# ---------------------------------------------------------------------------
# detect_phase — writing phase
# ---------------------------------------------------------------------------

class TestDetectPhaseWriting:
    """Tests for writing phase detection."""

    def test_assistant_code_is_writing(self):
        """assistant:code → writing."""
        assert detect_phase("assistant", "code") == "writing"

    def test_assistant_code_with_format(self):
        """assistant:code+python → writing (format ignored for writing)."""
        assert detect_phase("assistant", "code", "python") == "writing"

    def test_assistant_code_case_insensitive(self):
        """Case insensitive role/type."""
        assert detect_phase("ASSISTANT", "CODE") == "writing"
        assert detect_phase("Assistant", "Code") == "writing"


# ---------------------------------------------------------------------------
# detect_phase — executing phase
# ---------------------------------------------------------------------------

class TestDetectPhaseExecuting:
    """Tests for executing phase detection."""

    def test_computer_code_echo_is_executing(self):
        """computer:code → executing (code echo = execution started)."""
        assert detect_phase("computer", "code") == "executing"

    def test_computer_code_echo_with_format_is_executing(self):
        """computer:code+python → executing (format irrelevant)."""
        assert detect_phase("computer", "code", "python") == "executing"

    def test_computer_code_echo_case_insensitive(self):
        """Case insensitive for code echo."""
        assert detect_phase("COMPUTER", "CODE") == "executing"
        assert detect_phase("Computer", "Code", "Python") == "executing"

    def test_computer_output_console_is_executing(self):
        """computer:output+console → executing."""
        assert detect_phase("computer", "output", "console") == "executing"

    def test_computer_output_console_case_insensitive(self):
        """Case insensitive."""
        assert detect_phase("COMPUTER", "OUTPUT", "CONSOLE") == "executing"


# ---------------------------------------------------------------------------
# detect_phase — output phase
# ---------------------------------------------------------------------------

class TestDetectPhaseOutput:
    """Tests for output phase detection."""

    def test_computer_output_html(self):
        """computer:output+html → output."""
        assert detect_phase("computer", "output", "html") == "output"

    def test_computer_output_json(self):
        """computer:output+json → output."""
        assert detect_phase("computer", "output", "json") == "output"

    def test_computer_output_markdown(self):
        """computer:output+markdown → output."""
        assert detect_phase("computer", "output", "markdown") == "output"

    def test_computer_output_text(self):
        """computer:output+text → output."""
        assert detect_phase("computer", "output", "text") == "output"

    def test_computer_output_unknown_format(self):
        """computer:output+unknown_format → output (any non-console format)."""
        assert detect_phase("computer", "output", "csv") == "output"


# ---------------------------------------------------------------------------
# detect_phase — None returns (no phase)
# ---------------------------------------------------------------------------

class TestDetectPhaseNone:
    """Tests for events that do not trigger a phase."""

    def test_user_message_no_phase(self):
        """user:message → None."""
        assert detect_phase("user", "message") is None

    def test_assistant_message_no_phase(self):
        """assistant:message → None."""
        assert detect_phase("assistant", "message") is None

    def test_computer_output_no_format(self):
        """computer:output with no format → None (format required for output phase)."""
        assert detect_phase("computer", "output") is None

    def test_computer_output_none_format(self):
        """computer:output with format=None → None."""
        assert detect_phase("computer", "output", None) is None

    def test_server_message_no_phase(self):
        """server:message → None."""
        assert detect_phase("server", "message") is None

    def test_unknown_role_no_phase(self):
        """unknown:code → None."""
        assert detect_phase("unknown", "code") is None

    def test_assistant_output_no_phase(self):
        """assistant:output → None (only computer:output is a phase)."""
        assert detect_phase("assistant", "output", "html") is None


# ---------------------------------------------------------------------------
# is_phase_transition
# ---------------------------------------------------------------------------

class TestIsPhaseTransition:
    """Tests for is_phase_transition."""

    def test_none_to_writing(self):
        """None → writing = True (start of phases)."""
        assert is_phase_transition(None, "writing") is True

    def test_writing_to_executing(self):
        """writing → executing = True."""
        assert is_phase_transition("writing", "executing") is True

    def test_executing_to_output(self):
        """executing → output = True."""
        assert is_phase_transition("executing", "output") is True

    def test_same_phase_no_transition(self):
        """writing → writing = False."""
        assert is_phase_transition("writing", "writing") is False

    def test_new_phase_none_no_transition(self):
        """executing → None = False."""
        assert is_phase_transition("executing", None) is False

    def test_both_none_no_transition(self):
        """None → None = False."""
        assert is_phase_transition(None, None) is False

    def test_backwards_transition(self):
        """output → writing = True (new cycle, still a transition)."""
        assert is_phase_transition("output", "writing") is True

    def test_skip_phase(self):
        """writing → output = True (skipping executing is valid)."""
        assert is_phase_transition("writing", "output") is True


# ---------------------------------------------------------------------------
# validate_phase
# ---------------------------------------------------------------------------

class TestValidatePhase:
    """Tests for validate_phase."""

    def test_none_is_valid(self):
        """None is valid (no phase)."""
        assert validate_phase(None) is True

    def test_writing_is_valid(self):
        """'writing' is valid."""
        assert validate_phase("writing") is True

    def test_executing_is_valid(self):
        """'executing' is valid."""
        assert validate_phase("executing") is True

    def test_output_is_valid(self):
        """'output' is valid."""
        assert validate_phase("output") is True

    def test_unknown_phase_invalid(self):
        """Unknown phase returns False."""
        assert validate_phase("unknown") is False

    def test_empty_string_invalid(self):
        """Empty string is not a valid phase."""
        assert validate_phase("") is False

    def test_case_sensitive(self):
        """Phase validation is case-sensitive."""
        assert validate_phase("Writing") is False
        assert validate_phase("EXECUTING") is False
