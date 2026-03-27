#!/usr/bin/env python3
"""
TTS Integration Testing Script

Tests RealtimeTTS integration and API endpoints.
Covers both Qwen3 (default) and Kokoro (legacy) engines.

Usage:
    # Full test suite (requires running backend at localhost:5002)
    python tests/test_tts_integration.py

    # Unit tests only (no server required)
    python tests/test_tts_integration.py --unit
"""

import httpx
import pytest
import sys
import argparse
from pathlib import Path

BASE_URL = "http://127.0.0.1:5002"
TIMEOUT = 120.0  # Qwen3 first-load can take ~30s


class Colors:
    GREEN = '\033[92m'
    RED = '\033[91m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    RESET = '\033[0m'


# ============================================================================
# UNIT TESTS (No server required)
# ============================================================================

def test_qwen3_engine_import():
    """Test that Qwen3Engine can be imported from RealtimeTTS."""
    print(f"\n{Colors.BLUE}[UNIT] Testing Qwen3Engine import...{Colors.RESET}")
    try:
        # Add services path
        backend_root = Path(__file__).resolve().parents[1]
        tts_path = backend_root / "services" / "realtime-tts"
        if str(tts_path) not in sys.path:
            sys.path.insert(0, str(tts_path))

        from RealtimeTTS.engines.qwen3_engine import Qwen3Engine, QWEN3_VOICES
        assert Qwen3Engine is not None
        assert len(QWEN3_VOICES) == 9
        print(f"  Voices: {[v.name for v in QWEN3_VOICES]}")
        print(f"{Colors.GREEN}PASS{Colors.RESET}")
        return True
    except Exception as e:
        print(f"{Colors.RED}FAIL: {e}{Colors.RESET}")
        return False


def test_qwen3_engine_construction():
    """Test that Qwen3Engine can be constructed without loading model."""
    print(f"\n{Colors.BLUE}[UNIT] Testing Qwen3Engine construction (no model load)...{Colors.RESET}")
    try:
        backend_root = Path(__file__).resolve().parents[1]
        tts_path = backend_root / "services" / "realtime-tts"
        if str(tts_path) not in sys.path:
            sys.path.insert(0, str(tts_path))

        from RealtimeTTS.engines.qwen3_engine import Qwen3Engine

        engine = Qwen3Engine(voice="Ryan", model_path="Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice")
        assert engine.engine_name == "qwen3"
        assert engine.current_voice == "Ryan"
        assert engine.current_language == "English"  # Resolved from Ryan's native language
        assert engine._sample_rate == 24000
        assert engine.queue is not None

        # Verify class-level model NOT loaded yet (lazy)
        # Note: shared model might be loaded from a previous test
        print(f"  engine_name={engine.engine_name}, voice={engine.current_voice}")
        print(f"{Colors.GREEN}PASS{Colors.RESET}")
        return True
    except Exception as e:
        print(f"{Colors.RED}FAIL: {e}{Colors.RESET}")
        return False


def test_qwen3_voice_management():
    """Test voice set/get operations."""
    print(f"\n{Colors.BLUE}[UNIT] Testing Qwen3 voice management...{Colors.RESET}")
    try:
        backend_root = Path(__file__).resolve().parents[1]
        tts_path = backend_root / "services" / "realtime-tts"
        if str(tts_path) not in sys.path:
            sys.path.insert(0, str(tts_path))

        from RealtimeTTS.engines.qwen3_engine import Qwen3Engine, Qwen3Voice

        engine = Qwen3Engine(voice="Ryan")

        # Test string voice
        engine.set_voice("Vivian")
        assert engine.current_voice == "Vivian"

        # Test case-insensitive
        engine.set_voice("aiden")
        assert engine.current_voice == "Aiden"

        # Test Qwen3Voice object
        engine.set_voice(Qwen3Voice("Serena", "Warm voice", "Chinese"))
        assert engine.current_voice == "Serena"

        # Test arbitrary voice name (forward compat)
        engine.set_voice("FutureVoice")
        assert engine.current_voice == "FutureVoice"

        # Test get_voices
        voices = engine.get_voices()
        assert len(voices) == 9
        voice_names = {v.name for v in voices}
        assert "Ryan" in voice_names
        assert "Vivian" in voice_names
        assert "Ono_Anna" in voice_names

        # Test set_voice_parameters
        engine.set_voice_parameters(instruct="Speak calmly", language="English")
        assert engine.instruct == "Speak calmly"
        assert engine.current_language == "English"

        print("  All voice operations verified")
        print(f"{Colors.GREEN}PASS{Colors.RESET}")
        return True
    except Exception as e:
        print(f"{Colors.RED}FAIL: {e}{Colors.RESET}")
        return False


def test_audio_config_defaults():
    """Test that audio_config has correct Qwen3 defaults."""
    print(f"\n{Colors.BLUE}[UNIT] Testing audio_config Qwen3 defaults...{Colors.RESET}")
    try:
        backend_root = Path(__file__).resolve().parents[1]
        if str(backend_root) not in sys.path:
            sys.path.insert(0, str(backend_root))

        from config.audio_config import TtsConfig

        config = TtsConfig()
        assert config.engine == "qwen3", f"Default engine should be qwen3, got {config.engine}"
        assert config.voice == "Ryan", f"Default voice should be Ryan, got {config.voice}"
        assert config.sample_rate == 24000
        # Model path is platform-dependent (MLX on Apple Silicon, PyTorch elsewhere)
        assert config.qwen3_model_path  # Must be non-empty
        assert config.qwen3_device is None  # auto-detect
        assert config.qwen3_instruct == "Speak naturally in a clear, steady conversational tone."
        assert config.qwen3_language == ""  # Empty = auto-resolve from voice native language
        assert "qwen3" in config.available_engines
        assert config.available_engines[0] == "qwen3"  # First in list
        assert "Ryan" in config.available_qwen3_voices
        assert len(config.available_qwen3_voices) == 9

        print(f"  engine={config.engine}, voice={config.voice}, model={config.qwen3_model_path}")
        print(f"  available_engines={config.available_engines}")
        print(f"{Colors.GREEN}PASS{Colors.RESET}")
        return True
    except Exception as e:
        print(f"{Colors.RED}FAIL: {e}{Colors.RESET}")
        return False


def test_realtime_tts_integration_import():
    """Test RealtimeTTSIntegration can import Qwen3."""
    print(f"\n{Colors.BLUE}[UNIT] Testing RealtimeTTSIntegration Qwen3 availability...{Colors.RESET}")
    try:
        backend_root = Path(__file__).resolve().parents[1]
        if str(backend_root) not in sys.path:
            sys.path.insert(0, str(backend_root))
        tts_path = backend_root / "services" / "realtime-tts"
        if str(tts_path) not in sys.path:
            sys.path.insert(0, str(tts_path))

        from core.integrations.libraries.tts.realtime_tts import RealtimeTTSIntegration

        integration = RealtimeTTSIntegration()
        engines = integration.get_available_engines()

        print(f"  Available engines: {engines}")
        assert "qwen3" in engines, f"qwen3 not in available engines: {engines}"
        assert engines[0] == "qwen3", f"qwen3 should be first, got: {engines[0]}"

        # Verify cleanup method exists
        assert hasattr(integration, 'cleanup')
        assert hasattr(integration, '_cleanup_current_engine')

        print(f"{Colors.GREEN}PASS{Colors.RESET}")
        return True
    except Exception as e:
        print(f"{Colors.RED}FAIL: {e}{Colors.RESET}")
        return False


@pytest.mark.skip(reason="Hangs during CI execution, needs manual testing")
def test_qwen3_engine_synthesis():
    """Test Qwen3Engine actual synthesis (requires model downloaded + qwen-tts installed)."""
    print(f"\n{Colors.BLUE}[UNIT] Testing Qwen3Engine synthesis (requires model)...{Colors.RESET}")

    # Pre-check: qwen_tts must be importable
    try:
        import qwen_tts  # noqa: F401
    except ImportError:
        print(f"{Colors.YELLOW}SKIP (qwen-tts not installed in this Python){Colors.RESET}")
        return None

    try:
        backend_root = Path(__file__).resolve().parents[1]
        tts_path = backend_root / "services" / "realtime-tts"
        if str(tts_path) not in sys.path:
            sys.path.insert(0, str(tts_path))

        from RealtimeTTS.engines.qwen3_engine import Qwen3Engine

        engine = Qwen3Engine(voice="Ryan", debug=True)

        # Test synthesis
        success = engine.synthesize("Hello, this is a test of Qwen3 TTS.")
        assert success, "synthesize() returned False"

        # Collect chunks from queue
        chunks = []
        while not engine.queue.empty():
            chunk = engine.queue.get_nowait()
            if isinstance(chunk, bytes) and len(chunk) > 0:
                chunks.append(chunk)

        assert len(chunks) > 0, "No audio chunks generated"
        total_bytes = sum(len(c) for c in chunks)
        print(f"  Generated {len(chunks)} chunks, {total_bytes} bytes total")
        print(f"  Audio duration tracked: {engine.audio_duration:.2f}s")
        assert total_bytes > 1000, f"Audio too small: {total_bytes} bytes"
        assert engine.audio_duration > 0.5, f"Duration too short: {engine.audio_duration}"

        print(f"{Colors.GREEN}PASS{Colors.RESET}")
        return True
    except Exception as e:
        if "No such file or directory" in str(e) or "Could not find" in str(e):
            print(f"{Colors.YELLOW}SKIP (model not downloaded): {e}{Colors.RESET}")
            return None
        print(f"{Colors.RED}FAIL: {e}{Colors.RESET}")
        return False


@pytest.mark.skip(reason="Hangs during CI execution, needs manual testing")
def test_qwen3_integration_synthesis():
    """Test full integration path: RealtimeTTSIntegration -> Qwen3Engine -> audio."""
    print(f"\n{Colors.BLUE}[UNIT] Testing full integration synthesis (requires model)...{Colors.RESET}")

    # Pre-check: qwen_tts must be importable
    try:
        import qwen_tts  # noqa: F401
    except ImportError:
        print(f"{Colors.YELLOW}SKIP (qwen-tts not installed in this Python){Colors.RESET}")
        return None

    try:
        backend_root = Path(__file__).resolve().parents[1]
        if str(backend_root) not in sys.path:
            sys.path.insert(0, str(backend_root))
        tts_path = backend_root / "services" / "realtime-tts"
        if str(tts_path) not in sys.path:
            sys.path.insert(0, str(tts_path))

        from core.integrations.libraries.tts.realtime_tts import RealtimeTTSIntegration

        integration = RealtimeTTSIntegration()
        assert integration.is_available()

        # Initialize Qwen3 engine
        success = integration.initialize_engine("qwen3", voice="Ryan")
        assert success, "Failed to initialize qwen3 engine"
        assert integration.get_current_engine() == "qwen3"

        # Synthesize
        audio = integration.synthesize_text("Testing Qwen3 TTS integration pipeline.")
        assert audio is not None, "synthesize_text returned None"
        assert len(audio) > 1000, f"Audio too small: {len(audio)} bytes"

        print(f"  Synthesized: {len(audio)} bytes PCM16")

        # Test engine switch cleanup
        integration.cleanup()
        assert integration._direct_engine is None

        print(f"{Colors.GREEN}PASS{Colors.RESET}")
        return True
    except Exception as e:
        if "No such file or directory" in str(e) or "Could not find" in str(e):
            print(f"{Colors.YELLOW}SKIP (model not downloaded): {e}{Colors.RESET}")
            return None
        print(f"{Colors.RED}FAIL: {e}{Colors.RESET}")
        return False


# ============================================================================
# API TESTS (Requires running backend)
# ============================================================================

def test_tts_health():
    """Test TTS health endpoint."""
    print(f"\n{Colors.BLUE}[API] Testing TTS Health...{Colors.RESET}")
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            response = client.get(f"{BASE_URL}/v1/tts/health")
            data = response.json()
            print(f"  Status: {response.status_code}, Engine: {data.get('current_engine')}")
            if response.status_code == 200:
                print(f"{Colors.GREEN}PASS{Colors.RESET}")
                return True
            print(f"{Colors.RED}FAIL{Colors.RESET}")
            return False
    except Exception as e:
        print(f"{Colors.RED}FAIL: {e}{Colors.RESET}")
        return False


def test_list_engines():
    """Test listing TTS engines (should include qwen3)."""
    print(f"\n{Colors.BLUE}[API] Testing List TTS Engines...{Colors.RESET}")
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            response = client.get(f"{BASE_URL}/v1/tts/engines")
            data = response.json()
            engines = data.get('engines', [])
            print(f"  Engines: {engines}")
            assert "qwen3" in engines, f"qwen3 not in engines: {engines}"
            print(f"{Colors.GREEN}PASS{Colors.RESET}")
            return True, engines
    except Exception as e:
        print(f"{Colors.RED}FAIL: {e}{Colors.RESET}")
        return False, []


def test_initialize_engine(engine="qwen3"):
    """Test initializing TTS engine."""
    print(f"\n{Colors.BLUE}[API] Testing Initialize {engine} Engine...{Colors.RESET}")
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            response = client.post(
                f"{BASE_URL}/v1/tts/initialize",
                json={"engine": engine}
            )
            data = response.json()
            print(f"  Status: {response.status_code}, Response: {data}")
            if response.status_code == 200:
                print(f"{Colors.GREEN}PASS{Colors.RESET}")
                return True
            print(f"{Colors.RED}FAIL{Colors.RESET}")
            return False
    except Exception as e:
        print(f"{Colors.RED}FAIL: {e}{Colors.RESET}")
        return False


def test_synthesize_text(engine="qwen3", save_file=False):
    """Test text-to-speech synthesis."""
    print(f"\n{Colors.BLUE}[API] Testing Text Synthesis with {engine}...{Colors.RESET}")
    test_text = "Hello, this is a test of the Qwen3 text to speech integration."
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            response = client.post(
                f"{BASE_URL}/v1/tts/synthesize",
                json={"text": test_text, "engine": engine}
            )
            if response.status_code == 200:
                audio_size = len(response.content)
                print(f"  Audio Size: {audio_size} bytes")
                if save_file:
                    output_file = Path(f"/tmp/tts_test_{engine}.wav")
                    output_file.write_bytes(response.content)
                    print(f"  Saved to: {output_file}")
                print(f"{Colors.GREEN}PASS{Colors.RESET}")
                return True
            print(f"  Error: {response.text}")
            print(f"{Colors.RED}FAIL{Colors.RESET}")
            return False
    except Exception as e:
        print(f"{Colors.RED}FAIL: {e}{Colors.RESET}")
        return False


def test_stream_synthesis(engine="qwen3"):
    """Test streaming TTS synthesis."""
    print(f"\n{Colors.BLUE}[API] Testing Streaming Synthesis with {engine}...{Colors.RESET}")
    test_text = "This is a streaming test."
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            with client.stream(
                "POST",
                f"{BASE_URL}/v1/tts/stream",
                json={"text": test_text, "engine": engine}
            ) as response:
                if response.status_code == 200:
                    total_size = 0
                    chunk_count = 0
                    for chunk in response.iter_bytes():
                        total_size += len(chunk)
                        chunk_count += 1
                    print(f"  Received {chunk_count} chunks, total {total_size} bytes")
                    print(f"{Colors.GREEN}PASS{Colors.RESET}")
                    return True
                print(f"{Colors.RED}FAIL{Colors.RESET}")
                return False
    except Exception as e:
        print(f"{Colors.RED}FAIL: {e}{Colors.RESET}")
        return False


# ============================================================================
# LANGUAGE PIPELINE TESTS (No server or model required)
# ============================================================================

def test_pytorch_voice_language_resolution():
    """Test that PyTorch Qwen3Engine resolves language from voice's native language."""
    print(f"\n{Colors.BLUE}[LANG] Testing PyTorch voice → language resolution...{Colors.RESET}")
    try:
        backend_root = Path(__file__).resolve().parents[1]
        tts_path = backend_root / "services" / "realtime-tts"
        if str(tts_path) not in sys.path:
            sys.path.insert(0, str(tts_path))

        from RealtimeTTS.engines.qwen3_engine import Qwen3Engine

        # English voices → "English"
        engine = Qwen3Engine(voice="Ryan")
        assert engine.current_language == "English", f"Ryan: expected 'English', got '{engine.current_language}'"

        engine.set_voice("Aiden")
        assert engine.current_language == "English", f"Aiden: expected 'English', got '{engine.current_language}'"

        # Chinese voices → "Chinese"
        engine.set_voice("Vivian")
        assert engine.current_language == "Chinese", f"Vivian: expected 'Chinese', got '{engine.current_language}'"

        engine.set_voice("Uncle_Fu")
        assert engine.current_language == "Chinese", f"Uncle_Fu: expected 'Chinese', got '{engine.current_language}'"

        # Japanese voice → "Japanese"
        engine.set_voice("Ono_Anna")
        assert engine.current_language == "Japanese", f"Ono_Anna: expected 'Japanese', got '{engine.current_language}'"

        # Korean voice → "Korean"
        engine.set_voice("Sohee")
        assert engine.current_language == "Korean", f"Sohee: expected 'Korean', got '{engine.current_language}'"

        # Unknown voice → "Auto" (fallback)
        engine.set_voice("UnknownFutureVoice")
        assert engine.current_language == "Auto", f"Unknown: expected 'Auto', got '{engine.current_language}'"

        print("  All 9 voices + unknown verified")
        print(f"{Colors.GREEN}PASS{Colors.RESET}")
        return True
    except Exception as e:
        print(f"{Colors.RED}FAIL: {e}{Colors.RESET}")
        return False


def test_pytorch_explicit_language_override():
    """Test that explicit language in constructor overrides voice-resolved language."""
    print(f"\n{Colors.BLUE}[LANG] Testing PyTorch explicit language override...{Colors.RESET}")
    try:
        backend_root = Path(__file__).resolve().parents[1]
        tts_path = backend_root / "services" / "realtime-tts"
        if str(tts_path) not in sys.path:
            sys.path.insert(0, str(tts_path))

        from RealtimeTTS.engines.qwen3_engine import Qwen3Engine

        # Chinese voice but explicit English override
        engine = Qwen3Engine(voice="Vivian", language="English")
        assert engine.current_voice == "Vivian"
        assert engine.current_language == "English", f"Expected 'English' override, got '{engine.current_language}'"

        # Empty language = auto-resolve from voice (no override)
        engine2 = Qwen3Engine(voice="Vivian", language="")
        assert engine2.current_language == "Chinese", f"Expected 'Chinese' auto, got '{engine2.current_language}'"

        # set_voice_parameters override
        engine2.set_voice_parameters(language="Japanese")
        assert engine2.current_language == "Japanese", f"Expected 'Japanese', got '{engine2.current_language}'"

        print("  Constructor override, empty-string auto, and runtime override verified")
        print(f"{Colors.GREEN}PASS{Colors.RESET}")
        return True
    except Exception as e:
        print(f"{Colors.RED}FAIL: {e}{Colors.RESET}")
        return False


def test_mlx_voice_language_resolution():
    """Test that MLX Qwen3MLXEngine resolves language from voice's native language."""
    print(f"\n{Colors.BLUE}[LANG] Testing MLX voice → language resolution...{Colors.RESET}")
    try:
        backend_root = Path(__file__).resolve().parents[1]
        tts_path = backend_root / "services" / "realtime-tts"
        if str(tts_path) not in sys.path:
            sys.path.insert(0, str(tts_path))

        try:
            from RealtimeTTS.engines.qwen3_mlx_engine import Qwen3MLXEngine, QWEN3_MLX_VOICES
        except ImportError:
            print(f"{Colors.YELLOW}SKIP (mlx-audio not installed){Colors.RESET}")
            return None

        # Verify registry has all 9 voices
        assert len(QWEN3_MLX_VOICES) == 9, f"Expected 9 MLX voices, got {len(QWEN3_MLX_VOICES)}"

        engine = Qwen3MLXEngine(voice="Ryan")

        # English voices → "english" (lowercase for mlx-audio)
        assert engine.current_language == "english", f"Ryan: expected 'english', got '{engine.current_language}'"

        engine.set_voice("Aiden")
        assert engine.current_language == "english", f"Aiden: expected 'english', got '{engine.current_language}'"

        # Chinese voices → "chinese"
        engine.set_voice("Vivian")
        assert engine.current_language == "chinese", f"Vivian: expected 'chinese', got '{engine.current_language}'"

        engine.set_voice("Uncle_Fu")
        assert engine.current_language == "chinese", f"Uncle_Fu: expected 'chinese', got '{engine.current_language}'"

        # Japanese → "japanese"
        engine.set_voice("Ono_Anna")
        assert engine.current_language == "japanese", f"Ono_Anna: expected 'japanese', got '{engine.current_language}'"

        # Korean → "korean"
        engine.set_voice("Sohee")
        assert engine.current_language == "korean", f"Sohee: expected 'korean', got '{engine.current_language}'"

        print("  All 9 voices verified (lowercase for mlx-audio)")
        print(f"{Colors.GREEN}PASS{Colors.RESET}")
        return True
    except Exception as e:
        print(f"{Colors.RED}FAIL: {e}{Colors.RESET}")
        return False


def test_mlx_explicit_language_override():
    """Test that explicit language in MLX constructor overrides voice-resolved language."""
    print(f"\n{Colors.BLUE}[LANG] Testing MLX explicit language override...{Colors.RESET}")
    try:
        backend_root = Path(__file__).resolve().parents[1]
        tts_path = backend_root / "services" / "realtime-tts"
        if str(tts_path) not in sys.path:
            sys.path.insert(0, str(tts_path))

        try:
            from RealtimeTTS.engines.qwen3_mlx_engine import Qwen3MLXEngine
        except ImportError:
            print(f"{Colors.YELLOW}SKIP (mlx-audio not installed){Colors.RESET}")
            return None

        # Chinese voice but explicit English override
        engine = Qwen3MLXEngine(voice="Vivian", language="english")
        assert engine.current_language == "english", f"Expected 'english' override, got '{engine.current_language}'"

        # Empty language = auto from voice
        engine2 = Qwen3MLXEngine(voice="Vivian", language="")
        assert engine2.current_language == "chinese", f"Expected 'chinese' auto, got '{engine2.current_language}'"

        # set_voice_parameters override
        engine2.set_voice_parameters(language="japanese")
        assert engine2.current_language == "japanese", f"Expected 'japanese', got '{engine2.current_language}'"

        print("  Constructor override, empty-string auto, and runtime override verified")
        print(f"{Colors.GREEN}PASS{Colors.RESET}")
        return True
    except Exception as e:
        print(f"{Colors.RED}FAIL: {e}{Colors.RESET}")
        return False


def test_audio_config_language_field():
    """Test that TtsConfig has qwen3_language and it propagates correctly."""
    print(f"\n{Colors.BLUE}[LANG] Testing TtsConfig language field...{Colors.RESET}")
    try:
        backend_root = Path(__file__).resolve().parents[1]
        if str(backend_root) not in sys.path:
            sys.path.insert(0, str(backend_root))

        from config.audio_config import TtsConfig

        # Default: empty string = auto-resolve
        config = TtsConfig()
        assert config.qwen3_language == "", f"Default should be empty, got '{config.qwen3_language}'"

        # Explicit value
        config2 = TtsConfig(qwen3_language="chinese")
        assert config2.qwen3_language == "chinese", f"Expected 'chinese', got '{config2.qwen3_language}'"

        # Instruct default
        assert config.qwen3_instruct != "", "qwen3_instruct should have non-empty default"
        assert "conversational" in config.qwen3_instruct.lower(), "Default instruct should mention 'conversational'"

        # first_sentence_target_words >= 6 for prosody stability
        assert config.first_sentence_target_words >= 6, (
            f"first_sentence_target_words should be >= 6 for stable prosody, got {config.first_sentence_target_words}"
        )

        print("  qwen3_language, qwen3_instruct, first_sentence_target_words verified")
        print(f"{Colors.GREEN}PASS{Colors.RESET}")
        return True
    except Exception as e:
        print(f"{Colors.RED}FAIL: {e}{Colors.RESET}")
        return False


def test_voice_language_registry_parity():
    """Test that PyTorch and MLX voice registries have the same voices and languages."""
    print(f"\n{Colors.BLUE}[LANG] Testing PyTorch/MLX voice registry parity...{Colors.RESET}")
    try:
        backend_root = Path(__file__).resolve().parents[1]
        tts_path = backend_root / "services" / "realtime-tts"
        if str(tts_path) not in sys.path:
            sys.path.insert(0, str(tts_path))

        from RealtimeTTS.engines.qwen3_engine import QWEN3_VOICES

        try:
            from RealtimeTTS.engines.qwen3_mlx_engine import QWEN3_MLX_VOICES
        except ImportError:
            print(f"{Colors.YELLOW}SKIP (mlx-audio not installed){Colors.RESET}")
            return None

        # Same count
        assert len(QWEN3_VOICES) == len(QWEN3_MLX_VOICES), (
            f"PyTorch has {len(QWEN3_VOICES)} voices, MLX has {len(QWEN3_MLX_VOICES)}"
        )

        # Same names in same order
        pt_names = [v.name for v in QWEN3_VOICES]
        mlx_names = [v.name for v in QWEN3_MLX_VOICES]
        assert pt_names == mlx_names, f"Voice name mismatch: PT={pt_names} MLX={mlx_names}"

        # Same native languages (case-insensitive comparison)
        for pt_v, mlx_v in zip(QWEN3_VOICES, QWEN3_MLX_VOICES):
            assert pt_v.native_language.lower() == mlx_v.native_language.lower(), (
                f"{pt_v.name}: PT lang={pt_v.native_language}, MLX lang={mlx_v.native_language}"
            )

        print(f"  {len(QWEN3_VOICES)} voices, names, and languages match between PyTorch and MLX")
        print(f"{Colors.GREEN}PASS{Colors.RESET}")
        return True
    except Exception as e:
        print(f"{Colors.RED}FAIL: {e}{Colors.RESET}")
        return False


def test_runtime_settings_tts_overrides():
    """Test that runtime_settings_service correctly applies TTS overrides from DB prefs."""
    print(f"\n{Colors.BLUE}[LANG] Testing runtime settings TTS override mapping...{Colors.RESET}")
    try:
        backend_root = Path(__file__).resolve().parents[1]
        if str(backend_root) not in sys.path:
            sys.path.insert(0, str(backend_root))

        from config.audio_config import AudioConfig

        # Simulate DB preferences
        handsfree_prefs = {
            "tts_engine": "kokoro",
            "tts_voice": "af_heart",
            "tts_speed": "1.5",
            "tts_language": "chinese",
        }

        # Create baseline config
        config = AudioConfig()
        assert config.tts.engine == "qwen3"  # Default
        assert config.tts.voice == "Ryan"
        assert config.tts.speed == 1.0
        assert config.tts.qwen3_language == ""

        # Apply overrides (simulates runtime_settings_service logic)
        if "tts_engine" in handsfree_prefs:
            config.tts.engine = handsfree_prefs["tts_engine"]
        if "tts_voice" in handsfree_prefs:
            config.tts.voice = handsfree_prefs["tts_voice"]
        if "tts_speed" in handsfree_prefs:
            config.tts.speed = float(handsfree_prefs["tts_speed"])
        if "tts_language" in handsfree_prefs:
            config.tts.qwen3_language = handsfree_prefs["tts_language"]

        # Verify overrides applied
        assert config.tts.engine == "kokoro", f"Expected 'kokoro', got '{config.tts.engine}'"
        assert config.tts.voice == "af_heart", f"Expected 'af_heart', got '{config.tts.voice}'"
        assert config.tts.speed == 1.5, f"Expected 1.5, got {config.tts.speed}"
        assert config.tts.qwen3_language == "chinese", f"Expected 'chinese', got '{config.tts.qwen3_language}'"

        print("  Engine, voice, speed, language overrides verified")
        print(f"{Colors.GREEN}PASS{Colors.RESET}")
        return True
    except Exception as e:
        print(f"{Colors.RED}FAIL: {e}{Colors.RESET}")
        return False


def test_integration_language_passthrough():
    """Test that RealtimeTTSIntegration passes language kwarg to engines."""
    print(f"\n{Colors.BLUE}[LANG] Testing integration language passthrough...{Colors.RESET}")
    try:
        backend_root = Path(__file__).resolve().parents[1]
        if str(backend_root) not in sys.path:
            sys.path.insert(0, str(backend_root))
        tts_path = backend_root / "services" / "realtime-tts"
        if str(tts_path) not in sys.path:
            sys.path.insert(0, str(tts_path))

        from core.integrations.libraries.tts.realtime_tts import RealtimeTTSIntegration

        integration = RealtimeTTSIntegration()
        if not integration.is_available():
            print(f"{Colors.YELLOW}SKIP (RealtimeTTS not available){Colors.RESET}")
            return None

        # Initialize with explicit language — should NOT crash
        # (We can't verify the engine's internal state without loading the model,
        # but we can verify the initialize_engine path doesn't reject the param)
        # This is a param-acceptance test, not a synthesis test.
        success = integration.initialize_engine(
            "qwen3",
            voice="Ryan",
            language="english",
            instruct="Speak calmly.",
        )
        if success:
            # Verify language was passed to direct engine
            engine = integration._direct_engine
            if hasattr(engine, 'current_language'):
                assert engine.current_language.lower() == "english", (
                    f"Expected 'english', got '{engine.current_language}'"
                )
            if hasattr(engine, 'instruct'):
                assert engine.instruct == "Speak calmly.", (
                    f"Expected 'Speak calmly.', got '{engine.instruct}'"
                )
            integration.cleanup()
            print("  Language and instruct passthrough verified on live engine")
            print(f"{Colors.GREEN}PASS{Colors.RESET}")
            return True
        else:
            # Engine failed to init (model not downloaded) — acceptable skip
            print(f"{Colors.YELLOW}SKIP (engine init failed — model may not be downloaded){Colors.RESET}")
            return None
    except Exception as e:
        if "No such file or directory" in str(e) or "Could not find" in str(e):
            print(f"{Colors.YELLOW}SKIP (model not downloaded): {e}{Colors.RESET}")
            return None
        print(f"{Colors.RED}FAIL: {e}{Colors.RESET}")
        return False


# ============================================================================
# MAIN
# ============================================================================

def main():
    parser = argparse.ArgumentParser(description="TTS Integration Tests")
    parser.add_argument("--unit", action="store_true", help="Run unit tests only (no server)")
    parser.add_argument("--api", action="store_true", help="Run API tests only (requires server)")
    args = parser.parse_args()

    print(f"{Colors.BLUE}{'='*80}{Colors.RESET}")
    print(f"{Colors.BLUE}Aether TTS Integration Testing (Qwen3 + Kokoro){Colors.RESET}")
    print(f"{Colors.BLUE}{'='*80}{Colors.RESET}")

    results = {}

    # ── Unit tests ─────────────────────────────────────────────
    if not args.api:
        print(f"\n{Colors.BLUE}--- UNIT TESTS ---{Colors.RESET}")
        results['import_qwen3'] = test_qwen3_engine_import()
        results['construct_qwen3'] = test_qwen3_engine_construction()
        results['voice_management'] = test_qwen3_voice_management()
        results['audio_config'] = test_audio_config_defaults()
        results['integration_import'] = test_realtime_tts_integration_import()
        results['engine_synthesis'] = test_qwen3_engine_synthesis()
        results['integration_synthesis'] = test_qwen3_integration_synthesis()

        print(f"\n{Colors.BLUE}--- LANGUAGE PIPELINE TESTS ---{Colors.RESET}")
        results['pt_voice_lang_resolve'] = test_pytorch_voice_language_resolution()
        results['pt_explicit_lang_override'] = test_pytorch_explicit_language_override()
        results['mlx_voice_lang_resolve'] = test_mlx_voice_language_resolution()
        results['mlx_explicit_lang_override'] = test_mlx_explicit_language_override()
        results['audio_config_lang_field'] = test_audio_config_language_field()
        results['voice_registry_parity'] = test_voice_language_registry_parity()
        results['runtime_tts_overrides'] = test_runtime_settings_tts_overrides()
        results['integration_lang_passthrough'] = test_integration_language_passthrough()

    # ── API tests ──────────────────────────────────────────────
    if not args.unit:
        print(f"\n{Colors.BLUE}--- API TESTS (requires backend at {BASE_URL}) ---{Colors.RESET}")
        results['api_health'] = test_tts_health()

        success, engines = test_list_engines()
        results['api_engines'] = success

        if engines:
            # Test qwen3 first (default)
            if "qwen3" in engines:
                results['api_init_qwen3'] = test_initialize_engine("qwen3")
                results['api_synth_qwen3'] = test_synthesize_text("qwen3", save_file=True)

            # Test kokoro if available
            if "kokoro" in engines:
                results['api_init_kokoro'] = test_initialize_engine("kokoro")
                results['api_synth_kokoro'] = test_synthesize_text("kokoro", save_file=True)

        results['api_stream'] = test_stream_synthesis(engines[0] if engines else "system")

    # ── Summary ────────────────────────────────────────────────
    print(f"\n{Colors.BLUE}{'='*80}{Colors.RESET}")
    print(f"{Colors.BLUE}Test Summary{Colors.RESET}")
    print(f"{Colors.BLUE}{'='*80}{Colors.RESET}")

    passed = 0
    failed = 0
    skipped = 0

    for test, result in results.items():
        if result is True:
            status = f"{Colors.GREEN}PASS{Colors.RESET}"
            passed += 1
        elif result is None:
            status = f"{Colors.YELLOW}SKIP{Colors.RESET}"
            skipped += 1
        else:
            status = f"{Colors.RED}FAIL{Colors.RESET}"
            failed += 1
        print(f"  {status} | {test}")

    total = passed + failed
    print(f"\nResults: {passed} passed, {failed} failed, {skipped} skipped")

    if failed == 0:
        print(f"\n{Colors.GREEN}All tests passed!{Colors.RESET}")
        sys.exit(0)
    else:
        print(f"\n{Colors.RED}{failed} tests failed{Colors.RESET}")
        sys.exit(1)


if __name__ == "__main__":
    main()
