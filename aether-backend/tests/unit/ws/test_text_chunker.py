"""
Unit Tests: ws/domain/audio/services/text_chunker.py

Pure domain logic: no mocks needed. Tests text chunking algorithm for TTS
(break point detection, sentence extraction, word count targeting).

Direct import bypasses ws.domain.audio.__init__ which chains heavy audio
deps (openwakeword, pyannote, torch) that are not in the test environment.
TextChunker itself imports only `typing.Optional`.
"""

import importlib.util
import os


# Direct import: bypass ws.domain.audio.__init__ heavy deps
_spec = importlib.util.spec_from_file_location(
    "text_chunker",
    os.path.join(
        os.path.dirname(__file__),
        "..", "..", "..", "ws", "domain", "audio", "services", "text_chunker.py",
    ),
)
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
TextChunker = _module.TextChunker


# =========================================================================
# __init__
# =========================================================================


class TestInit:
    def test_default_sizes(self):
        chunker = TextChunker()
        assert chunker.first_size == 8
        assert chunker.target_size == 18
        assert chunker.current_text == []
        assert chunker.found_first_sentence is False

    def test_custom_sizes(self):
        chunker = TextChunker(first_size=5, target_size=12)
        assert chunker.first_size == 5
        assert chunker.target_size == 12

    def test_semantic_breaks_populated(self):
        chunker = TextChunker()
        assert chunker.semantic_breaks["however"] == 4
        assert chunker.semantic_breaks["and"] == 2
        assert len(chunker.semantic_breaks) == 13

    def test_punctuation_priorities_populated(self):
        chunker = TextChunker()
        assert chunker.punctuation_priorities["."] == 5
        assert chunker.punctuation_priorities[","] == 3
        assert len(chunker.punctuation_priorities) == 7


# =========================================================================
# should_process
# =========================================================================


class TestShouldProcess:
    def test_text_ending_with_period(self):
        chunker = TextChunker()
        assert chunker.should_process("Hello world.") is True

    def test_text_ending_with_exclamation(self):
        chunker = TextChunker()
        assert chunker.should_process("Hello!") is True

    def test_text_ending_with_question(self):
        chunker = TextChunker()
        assert chunker.should_process("Is this real?") is True

    def test_text_ending_with_comma(self):
        chunker = TextChunker()
        assert chunker.should_process("Hello,") is True

    def test_text_ending_with_semicolon(self):
        chunker = TextChunker()
        assert chunker.should_process("Hello;") is True

    def test_text_ending_with_colon(self):
        chunker = TextChunker()
        assert chunker.should_process("Hello:") is True

    def test_text_ending_with_dash(self):
        chunker = TextChunker()
        assert chunker.should_process("Hello-") is True

    def test_text_without_punctuation_under_target(self):
        chunker = TextChunker()
        assert chunker.should_process("Hello world") is False

    def test_text_without_punctuation_meets_first_target(self):
        chunker = TextChunker(first_size=3)
        assert chunker.should_process("one two three") is True

    def test_text_without_punctuation_meets_subsequent_target(self):
        chunker = TextChunker(target_size=3)
        chunker.found_first_sentence = True
        assert chunker.should_process("one two three") is True

    def test_uses_first_size_before_first_sentence(self):
        chunker = TextChunker(first_size=2, target_size=100)
        assert chunker.found_first_sentence is False
        assert chunker.should_process("one two") is True

    def test_uses_target_size_after_first_sentence(self):
        chunker = TextChunker(first_size=2, target_size=100)
        chunker.found_first_sentence = True
        assert chunker.should_process("one two") is False

    def test_empty_string(self):
        chunker = TextChunker()
        assert chunker.should_process("") is False

    def test_whitespace_only(self):
        chunker = TextChunker()
        assert chunker.should_process("   ") is False


# =========================================================================
# find_break_point
# =========================================================================


class TestFindBreakPoint:
    def test_short_text_returns_full_length(self):
        """Words <= target_size → returns len(words)."""
        chunker = TextChunker()
        result = chunker.find_break_point(["hello", "world"], 5)
        assert result == 2

    def test_exact_target_returns_full_length(self):
        chunker = TextChunker()
        words = ["a", "b", "c"]
        result = chunker.find_break_point(words, 3)
        assert result == 3

    def test_period_gets_highest_priority(self):
        chunker = TextChunker()
        words = ["Hello", "world.", "This", "is", "a", "test", "sentence", "here", "now", "ok"]
        # Target 5: period at index 1 (priority 5), should win
        result = chunker.find_break_point(words, 5)
        assert result == 2  # index 1 + 1

    def test_comma_break_point(self):
        chunker = TextChunker()
        words = ["The", "quick", "brown,", "fox", "jumps", "over", "the", "lazy", "dog"]
        # Target 5, comma at index 2 (priority 3)
        result = chunker.find_break_point(words, 5)
        assert result == 3  # index 2 + 1

    def test_semantic_break_word(self):
        chunker = TextChunker()
        words = ["He", "ran", "fast", "however", "she", "was", "faster", "and", "won"]
        # Target 5: "however" at index 3 (priority 4), "and" at index 7 outside scan range
        result = chunker.find_break_point(words, 5)
        # "however" at index 3, priority 4 → best break
        assert result == 4  # index 3 + 1

    def test_no_break_points_returns_target(self):
        chunker = TextChunker()
        # Words with no punctuation and no semantic break words
        words = ["one", "two", "three", "four", "five", "six", "seven", "eight"]
        result = chunker.find_break_point(words, 5)
        assert result == 5  # fallback to target_size

    def test_priority_beats_distance(self):
        """Higher priority break wins even if farther from target."""
        chunker = TextChunker()
        # comma at index 1 (priority 3), period at index 6 (priority 5)
        words = ["Hello,", "world", "this", "is", "a", "test", "sentence.", "more", "words"]
        # Target 5, scan range 0..7
        # comma at 0 (pri 3, dist -5), period at 6 (pri 5, dist -1)
        result = chunker.find_break_point(words, 5)
        assert result == 7  # period at index 6 wins (higher priority)

    def test_distance_tiebreaks_same_priority(self):
        """Same priority: closer to target wins."""
        chunker = TextChunker()
        # Two commas: at index 1 and index 4
        words = ["Hello,", "world", "this", "is", "test,", "more", "stuff", "here"]
        # Target 5, both commas at priority 3
        # index 1: distance = -|1-5| = -4
        # index 4: distance = -|4-5| = -1 (closer)
        result = chunker.find_break_point(words, 5)
        assert result == 5  # index 4 + 1 (closer comma)

    def test_punctuation_overrides_semantic(self):
        """Word ending with punctuation AND being semantic: punctuation priority wins."""
        chunker = TextChunker()
        # "however," has both semantic (4) and punctuation (3) → max = 4
        words = ["one", "two", "however,", "four", "five", "six", "seven", "eight"]
        result = chunker.find_break_point(words, 5)
        assert result == 3  # "however," at index 2, priority 4

    def test_scan_range_is_target_plus_3(self):
        """Scan range should be target + 3 words."""
        chunker = TextChunker()
        # Period at index 7 (target=5, 5+3=8, so index 7 IS in range)
        words = ["a", "b", "c", "d", "e", "f", "g", "h.", "i", "j"]
        result = chunker.find_break_point(words, 5)
        assert result == 8  # index 7 + 1 (period found within scan range)

    def test_break_outside_scan_range_ignored(self):
        """Break points beyond target+3 are not considered."""
        chunker = TextChunker()
        # Period at index 9 (target=5, 5+3=8, index 9 is OUT of range)
        words = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j."]
        result = chunker.find_break_point(words, 5)
        assert result == 5  # No break in range → fallback to target


# =========================================================================
# process
# =========================================================================


class TestProcess:
    def test_empty_string_returns_empty(self):
        chunker = TextChunker()
        assert chunker.process("") == ""

    def test_whitespace_only_returns_empty(self):
        chunker = TextChunker()
        assert chunker.process("   ") == ""

    def test_first_sentence_extraction(self):
        chunker = TextChunker(first_size=3)
        text = "one two three four five"
        result = chunker.process(text)
        assert result == "one two three"
        assert chunker.found_first_sentence is True

    def test_subsequent_sentence_uses_target_size(self):
        chunker = TextChunker(first_size=2, target_size=4)
        # First sentence
        chunker.process("one two three four five")
        assert chunker.found_first_sentence is True
        # Second sentence uses target_size=4
        result = chunker.process("six seven eight nine ten eleven")
        assert result == "six seven eight nine"

    def test_strips_trailing_comma(self):
        """Line 168: chunk.rstrip(',') removes trailing comma."""
        chunker = TextChunker(first_size=3)
        text = "hello, world here now more"
        result = chunker.process(text)
        # "hello," at index 0 has comma priority → break at index 1
        # chunk = "hello," → rstrip(",") = "hello"
        assert not result.endswith(",")

    def test_sets_found_first_sentence_flag(self):
        chunker = TextChunker(first_size=2)
        assert chunker.found_first_sentence is False
        chunker.process("hello world extra")
        assert chunker.found_first_sentence is True

    def test_non_alphanumeric_chunk_returns_empty(self):
        """Line 166: chunk without alphanumeric chars returns empty string."""
        chunker = TextChunker(first_size=1)
        # Single word that is just punctuation
        result = chunker.process("... !!!")
        # "..." is the chunk, has no alphanumeric → returns ""
        assert result == ""

    def test_sentence_with_punctuation_break(self):
        chunker = TextChunker(first_size=10)
        text = "The quick brown fox. Jumps over the lazy dog and more words"
        result = chunker.process(text)
        # Period at "fox." (index 3) has priority 5
        assert result == "The quick brown fox."

    def test_process_with_audio_queue_ignored(self):
        """_audio_queue parameter is unused (API compat)."""
        chunker = TextChunker(first_size=3)
        result = chunker.process("one two three four", _audio_queue="ignored")
        assert result == "one two three"


# =========================================================================
# Integration / State Machine Tests
# =========================================================================


class TestStateMachine:
    """Test the chunker as a stateful processor across multiple calls."""

    def test_first_then_subsequent_sizes(self):
        """First chunk uses first_size, later chunks use target_size."""
        chunker = TextChunker(first_size=2, target_size=4)

        # First call: 2-word chunk
        r1 = chunker.process("alpha beta gamma delta epsilon zeta eta theta")
        assert r1 == "alpha beta"

        # Second call: 4-word chunk
        r2 = chunker.process("gamma delta epsilon zeta eta theta iota kappa")
        assert r2 == "gamma delta epsilon zeta"

    def test_should_process_and_process_workflow(self):
        """Simulate accumulation → should_process → process cycle."""
        chunker = TextChunker(first_size=3, target_size=5)
        accumulated = ""

        # Add words one at a time
        for word in ["Hello", "beautiful", "world."]:
            accumulated += " " + word if accumulated else word

        # Period ending → should_process returns True
        assert chunker.should_process(accumulated) is True

        result = chunker.process(accumulated)
        assert result == "Hello beautiful world."
        assert chunker.found_first_sentence is True

    def test_reset_state(self):
        """Verify state can be manually reset for new conversation."""
        chunker = TextChunker(first_size=2)
        chunker.process("hello world extra")
        assert chunker.found_first_sentence is True

        # Manual reset (as caller would do for new conversation)
        chunker.found_first_sentence = False
        chunker.current_text = []
        assert chunker.found_first_sentence is False

        # First chunk should use first_size again
        r = chunker.process("new conversation here starts now")
        assert r == "new conversation"


# =========================================================================
# Remaining-Text Preservation (Regression)
# =========================================================================


class TestRemainingTextPreservation:
    """
    REGRESSION: _wrap_with_tts previously did ``chunker.current_text = []``
    after process(), silently dropping words beyond the break point.

    These tests verify the CALLER pattern: after calling ``process()``, the
    caller must compute the remaining words and carry them forward.  The
    TextChunker itself does NOT store or return remaining text; it is the
    caller's responsibility.  These tests document the correct caller pattern.
    """

    def test_remaining_words_after_break(self):
        """Words after break point must be preserved by caller."""
        chunker = TextChunker(first_size=3, target_size=6)

        text = "one two three four five six seven eight nine ten"
        words = text.split()

        # Caller computes break BEFORE process() changes found_first_sentence
        target = chunker.first_size if not chunker.found_first_sentence else chunker.target_size
        split_point = chunker.find_break_point(words, target)

        sentence = chunker.process(text, None)
        assert sentence  # Should extract something

        remaining_words = words[split_point:]
        remaining = " ".join(remaining_words)

        # Remaining must contain all words that were NOT in the sentence
        sentence_word_count = split_point
        assert len(remaining_words) == len(words) - sentence_word_count
        assert remaining  # Must not be empty (10 words, break ≤ first_size + 3)

    def test_no_remaining_when_all_words_consumed(self):
        """If break point == len(words), remaining is empty."""
        chunker = TextChunker(first_size=10, target_size=10)

        text = "one two three"  # 3 words, target 10 → all consumed
        words = text.split()
        target = chunker.first_size
        split_point = chunker.find_break_point(words, target)

        sentence = chunker.process(text, None)
        assert sentence == "one two three"
        remaining = words[split_point:]
        assert remaining == []

    def test_accumulate_remaining_then_reprocess(self):
        """
        Simulate the _wrap_with_tts accumulation loop:
        accumulate → should_process → process → carry remaining → repeat.
        """
        chunker = TextChunker(first_size=3, target_size=6)
        all_sentences = []
        accumulated = []

        # Simulate token-by-token streaming
        tokens = "The quick brown fox jumps over the lazy dog today".split()

        for token in tokens:
            accumulated.append(token)
            full = " ".join(accumulated)

            if chunker.should_process(full):
                full_words = full.split()
                target = chunker.first_size if not chunker.found_first_sentence else chunker.target_size
                split_point = chunker.find_break_point(full_words, target)

                sentence = chunker.process(full, None)
                if sentence:
                    all_sentences.append(sentence)
                    # Carry remaining forward
                    remaining_words = full_words[split_point:]
                    accumulated = remaining_words if remaining_words else []

        # Queue final leftover
        if accumulated:
            final = " ".join(accumulated).strip()
            if final:
                all_sentences.append(final)

        # ALL words must appear in output (no loss)
        all_output_words = " ".join(all_sentences).split()
        assert set(all_output_words) == set(tokens), (
            f"WORD LOSS DETECTED!\n"
            f"  Input:  {tokens}\n"
            f"  Output: {all_output_words}\n"
            f"  Missing: {set(tokens) - set(all_output_words)}"
        )
        assert len(all_output_words) == len(tokens), (
            f"Word count mismatch: input={len(tokens)}, output={len(all_output_words)}"
        )

    def test_long_text_no_punctuation_no_loss(self):
        """
        Edge case: 20+ words with NO punctuation.
        Multiple chunks needed, caller must carry remaining each time.
        """
        chunker = TextChunker(first_size=4, target_size=6)
        all_sentences = []
        accumulated = []

        # 20 words, zero punctuation
        tokens = [f"word{i}" for i in range(20)]

        for token in tokens:
            accumulated.append(token)
            full = " ".join(accumulated)

            if chunker.should_process(full):
                full_words = full.split()
                target = chunker.first_size if not chunker.found_first_sentence else chunker.target_size
                split_point = chunker.find_break_point(full_words, target)

                sentence = chunker.process(full, None)
                if sentence:
                    all_sentences.append(sentence)
                    remaining_words = full_words[split_point:]
                    accumulated = remaining_words if remaining_words else []

        if accumulated:
            all_sentences.append(" ".join(accumulated))

        all_output_words = " ".join(all_sentences).split()
        assert len(all_output_words) == 20, (
            f"Lost words! Got {len(all_output_words)}/20: {all_output_words}"
        )
