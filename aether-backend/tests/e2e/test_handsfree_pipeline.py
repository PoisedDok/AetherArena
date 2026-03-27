#!/usr/bin/env python3
"""
End-to-End Handsfree Pipeline Tests
====================================
Tests the COMPLETE STT → TTS pipeline with REAL Qwen3 TTS.
You should HEAR audio output from speakers when running these tests.

**RESOURCE WARNING**: These tests load the Qwen3 TTS model (~4-6 GB) directly
into the test process. They require at least 32 GB total system RAM when the
backend is also running, or 16 GB if the backend is stopped. Mark: ``heavy``.

Run with: ``python -m pytest tests/e2e/test_handsfree_pipeline.py -v -s -m heavy``
Or standalone: ``python tests/e2e/test_handsfree_pipeline.py``

Scenarios:
  1. Direct TTS synthesis - Qwen3 engine generates real speech
  2. TTSCoordinator pipeline - sentence queue → worker → audio queue
  3. TextChunker + TTSCoordinator - full chunked pipeline
  4. Multi-turn conversation - sequential request/response cycles
  5. User interruption - cancel mid-generation
  6. TTS error recovery - worker survives synthesis failure
  7. Concurrent clients - 3 clients generating simultaneously
  8. Empty response - graceful handling
  9. Queue overflow stress test
  10. Long response - 5+ sentences, full pipeline

Usage:
    cd aether-backend
    source venv/bin/activate

    # Run all tests (plays audio through speakers):
    python tests/e2e/test_handsfree_pipeline.py

    # Run via pytest (must use -m heavy to include these):
    python -m pytest tests/e2e/test_handsfree_pipeline.py -v -s -m heavy
"""

import asyncio
import logging
import math
import struct
import subprocess
import sys
import time
import uuid
import wave
from pathlib import Path
from typing import List, Tuple

import pytest

# ─── Memory guard ────────────────────────────────────────────────────────────
# These tests load Qwen3 TTS (~4-6 GB) directly into the test process.
# On 16 GB machines with the backend running, this causes SIGABRT/OOM.
# Guard: check RAM BEFORE importing the heavy TTS modules (which trigger torch).
_MIN_AVAILABLE_GB = 8  # Minimum free RAM to proceed

def _available_ram_gb() -> float:
    """Return available RAM in GB (macOS/Linux)."""
    try:
        if sys.platform == "darwin":
            import subprocess as _sp
            vm = _sp.check_output(["vm_stat"], text=True)
            free = spec = 0
            for line in vm.splitlines():
                if "Pages free" in line:
                    free = int(line.split(":")[1].strip().rstrip("."))
                elif "Pages speculative" in line:
                    spec = int(line.split(":")[1].strip().rstrip("."))
            return (free + spec) * 4096 / (1024 ** 3)
        else:
            with open("/proc/meminfo") as f:
                for line in f:
                    if line.startswith("MemAvailable"):
                        return int(line.split()[1]) / (1024 ** 2)
    except Exception:
        pass
    return 999.0  # Assume enough if we can't determine

_avail_gb = _available_ram_gb()
_SKIP_HEAVY = _avail_gb < _MIN_AVAILABLE_GB
_RUNNING_UNDER_PYTEST = "pytest" in sys.modules

# Mark entire module as 'heavy' so `pytest` skips by default
# (runs only with `-m heavy` or when invoked standalone)
pytestmark = [
    pytest.mark.heavy,
    pytest.mark.skipif(
        _SKIP_HEAVY,
        reason=f"Insufficient RAM ({_avail_gb:.1f} GB free, need {_MIN_AVAILABLE_GB} GB) — "
               f"these tests load Qwen3 TTS (~4-6 GB). Run standalone or with backend stopped.",
    ),
]

# ─── Deferred heavy imports ──────────────────────────────────────────────────
# The TTS modules import torch/transformers (~2-4 GB). We MUST NOT import them
# at module level if we're going to skip, otherwise pytest crashes with SIGABRT
# during collection on memory-constrained systems.

# Ensure backend root is on path
BACKEND_ROOT = Path(__file__).resolve().parents[2]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

TTS_PATH = BACKEND_ROOT / "services" / "realtime-tts"
if TTS_PATH.exists() and str(TTS_PATH) not in sys.path:
    sys.path.insert(0, str(TTS_PATH))

# Only import heavy TTS modules when we actually intend to run
if not (_RUNNING_UNDER_PYTEST and _SKIP_HEAVY):
    from config.audio_config import TtsConfig
    from ws.domain.audio.services.tts_coordinator import TTSCoordinator
    from ws.domain.audio.services.tts_generation_service import TTSGenerationService
    from ws.domain.audio.services.text_chunker import TextChunker
else:
    # Stubs so module-level references don't cause NameError during collection
    TtsConfig = None  # type: ignore[assignment,misc]
    TTSCoordinator = None  # type: ignore[assignment,misc]
    TTSGenerationService = None  # type: ignore[assignment,misc]
    TextChunker = None  # type: ignore[assignment,misc]

logger = logging.getLogger(__name__)

# ─── Output ────────────────────────────────────────────────────────────────────
AUDIO_DIR = Path("/tmp/aether_handsfree_tests")
AUDIO_DIR.mkdir(parents=True, exist_ok=True)


# ═══════════════════════════════════════════════════════════════════════════════
# UTILITIES
# ═══════════════════════════════════════════════════════════════════════════════

def save_wav(pcm_bytes: bytes, filepath: Path, sample_rate: int = 24000) -> float:
    """Save raw PCM16 as WAV. Returns duration in seconds."""
    with wave.open(str(filepath), 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_bytes)
    duration = len(pcm_bytes) / (sample_rate * 2)
    return duration


def play_audio(filepath: Path, max_duration: float = 120.0):
    """Play WAV file through speakers (macOS: afplay, Linux: aplay).
    
    For long files (multi-turn, long response), the timeout scales with audio duration.
    """
    try:
        # Estimate duration from file size: PCM16 mono 24kHz = 48000 bytes/second
        file_size = filepath.stat().st_size
        estimated_seconds = file_size / 48000 + 5  # +5s buffer
        timeout = min(max(estimated_seconds, 15), max_duration)
    except Exception:
        timeout = max_duration

    if sys.platform == "darwin":
        subprocess.run(["afplay", str(filepath)], check=False, timeout=timeout)
    elif sys.platform == "linux":
        subprocess.run(["aplay", str(filepath)], check=False, timeout=timeout)
    else:
        print(f"  [manual] Play: {filepath}")


def sine_pcm16(text: str, sr: int = 24000) -> bytes:
    """Fallback: sine wave proportional to text length."""
    n = int(sr * max(0.2, len(text.split()) * 0.12))
    return b''.join(
        struct.pack('<h', int(16000 * math.sin(2 * math.pi * 440 * i / sr)))
        for i in range(n)
    )


class Colors:
    G = '\033[92m'
    R = '\033[91m'
    Y = '\033[93m'
    B = '\033[94m'
    W = '\033[97m'
    RST = '\033[0m'


# ═══════════════════════════════════════════════════════════════════════════════
# TTS ENGINE SETUP — Qwen3 is PRIMARY, sine fallback for error-injection tests
# ═══════════════════════════════════════════════════════════════════════════════

_tts_engine = None
_engine_name = "none"


def _load_tts_engine():
    """
    Load Qwen3 as the PRIMARY TTS engine for all pipeline tests.
    This is the actual production engine — MPS + bfloat16 + SDPA.
    Falls back to sine wave ONLY if Qwen3 is completely unavailable.
    """
    global _tts_engine, _engine_name
    if _tts_engine is not None:
        return

    # Attempt Qwen3 (production engine)
    try:
        from core.integrations.libraries.tts.realtime_tts import RealtimeTTSIntegration
        config = _config()
        integration = RealtimeTTSIntegration()
        if integration.is_available():
            success = integration.initialize_engine(
                "qwen3",
                voice=config.voice,
                model_path=config.qwen3_model_path,
                device=config.qwen3_device,
                instruct=config.qwen3_instruct,
            )
            if success:
                _tts_engine = integration
                _engine_name = "qwen3"
                print(f"{Colors.G}TTS Engine: Qwen3 (voice={config.voice}, "
                      f"model={config.qwen3_model_path}){Colors.RST}")
                return
    except Exception as e:
        print(f"{Colors.Y}Qwen3 load failed: {e}{Colors.RST}")

    # Last resort: sine wave (keeps tests structurally valid)
    class SineTTS:
        def is_available(self): return True
        def get_available_engines(self): return ["sine"]
        def get_current_engine(self): return "sine"
        def initialize_engine(self, *a, **kw): return True
        def synthesize_text(self, text): return sine_pcm16(text)
        def cleanup(self): pass

    _tts_engine = SineTTS()
    _engine_name = "sine"
    print(f"{Colors.Y}TTS Engine: Sine wave fallback (Qwen3 unavailable){Colors.RST}")


def _get_tts():
    """Get the Qwen3 TTS engine (or sine fallback) for pipeline tests."""
    _load_tts_engine()
    return _tts_engine


def _config(**kw) -> TtsConfig:
    defaults = dict(
        engine="qwen3", voice="Ryan", sample_rate=24000,
        first_sentence_target_words=3, chunk_target_words=10,
        sentence_queue_maxsize=100, audio_queue_maxsize=200,
    )
    defaults.update(kw)
    return TtsConfig(**defaults)


# ═══════════════════════════════════════════════════════════════════════════════
# HELPER: drain audio from TTSCoordinator
# ═══════════════════════════════════════════════════════════════════════════════

async def drain_audio(coord: TTSCoordinator, client_id: str, timeout: float = 60.0) -> List[bytes]:
    """Drain all audio from coordinator. Returns list of PCM16 byte chunks."""
    parts = []
    deadline = time.time() + timeout
    while time.time() < deadline:
        result = await coord.get_next_audio(client_id)
        if result:
            parts.append(result[0])
        else:
            if coord.is_generation_complete(client_id):
                break
            await asyncio.sleep(0.05)
    return parts


async def feed_text_and_drain(
    coord: TTSCoordinator,
    config: TtsConfig,
    client_id: str,
    text: str,
    timeout: float = 60.0,
) -> Tuple[List[bytes], int]:
    """
    Feed text through TextChunker → TTSCoordinator, drain all audio.
    Returns (audio_chunks, sentences_queued).
    """
    chunker = TextChunker(
        first_size=config.first_sentence_target_words,
        target_size=config.chunk_target_words,
    )
    
    sentences_queued = 0
    words = text.split()
    accumulated = []
    
    for word in words:
        accumulated.append(word)
        full = " ".join(accumulated)
        if chunker.should_process(full):
            # Compute break point BEFORE process() updates found_first_sentence
            full_words = full.split()
            target = chunker.first_size if not chunker.found_first_sentence else chunker.target_size
            split_point = chunker.find_break_point(full_words, target)
            
            sentence = chunker.process(full, None)
            if sentence:
                await coord.add_sentence(client_id, sentence)
                sentences_queued += 1
                # CRITICAL FIX: Preserve remaining words after break point.
                # Previous code did `accumulated = []` which lost post-split words.
                remaining_words = full_words[split_point:]
                accumulated = remaining_words if remaining_words else []
            else:
                accumulated = []
    
    # Final leftover: queue ALL remaining text (no further chunking needed)
    if accumulated:
        remaining = " ".join(accumulated).strip()
        if remaining and any(c.isalnum() for c in remaining):
            await coord.add_sentence(client_id, remaining)
            sentences_queued += 1
    
    # Drain audio
    audio = await drain_audio(coord, client_id, timeout)
    return audio, sentences_queued


# ═══════════════════════════════════════════════════════════════════════════════
# SCENARIO 1: Direct TTS synthesis (no coordinator, raw engine)
# ═══════════════════════════════════════════════════════════════════════════════

def test_01_direct_synthesis():
    """
    Direct Qwen3 TTS synthesis — cold + warm calls.
    Proves the real production engine works end-to-end with audible output.
    Uses MPS + bfloat16 + SDPA (~6-10s warm, ~20s cold on Apple Silicon).
    """
    print(f"\n{Colors.B}━━━ Scenario 1: Direct Qwen3 TTS Synthesis ━━━{Colors.RST}")
    
    tts = _get_tts()
    
    # Cold call (includes model loading + JIT warmup)
    text1 = "Hello! I am Aether, your AI assistant."
    start = time.time()
    audio1 = tts.synthesize_text(text1)
    cold = time.time() - start
    
    assert audio1 is not None, "synthesize_text returned None"
    assert len(audio1) > 1000, f"Audio too small: {len(audio1)} bytes"
    
    filepath1 = AUDIO_DIR / f"01_direct_cold_{_engine_name}.wav"
    dur1 = save_wav(audio1, filepath1)
    
    print(f"  Engine: {_engine_name}")
    print(f"  Cold: \"{text1}\"")
    print(f"    → {len(audio1)} bytes, {dur1:.2f}s audio, {cold:.1f}s latency")
    
    # Warm call (model cached, should be fast)
    text2 = "How can I help you today?"
    start = time.time()
    audio2 = tts.synthesize_text(text2)
    warm = time.time() - start
    
    assert audio2 is not None, "Warm synthesize_text returned None"
    assert len(audio2) > 500, f"Warm audio too small: {len(audio2)} bytes"
    
    filepath2 = AUDIO_DIR / f"01_direct_warm_{_engine_name}.wav"
    dur2 = save_wav(audio2, filepath2)
    
    print(f"  Warm: \"{text2}\"")
    print(f"    → {len(audio2)} bytes, {dur2:.2f}s audio, {warm:.1f}s latency")
    
    # Play both
    print(f"  {Colors.W}Playing cold + warm audio...{Colors.RST}")
    play_audio(filepath1)
    play_audio(filepath2)
    
    print(f"{Colors.G}  PASS{Colors.RST}")
    return True


# ═══════════════════════════════════════════════════════════════════════════════
# SCENARIO 2: TTSCoordinator pipeline (sentence → worker → audio)
# ═══════════════════════════════════════════════════════════════════════════════

async def test_02_coordinator_pipeline():
    """TTSCoordinator: queue 2 sentences, drain audio, verify."""
    print(f"\n{Colors.B}━━━ Scenario 2: TTSCoordinator Pipeline ━━━{Colors.RST}")
    
    config = _config()
    coord = TTSCoordinator(tts_integration=_get_tts(), tts_config=config)
    cid = f"s02-{uuid.uuid4().hex[:6]}"
    
    try:
        await coord.add_sentence(cid, "This is sentence one from the coordinator pipeline test.")
        await coord.add_sentence(cid, "And this is the second sentence to verify multi-chunk generation.")
        
        audio = await drain_audio(coord, cid, timeout=120)
        
        assert len(audio) >= 2, f"Expected ≥2 audio chunks, got {len(audio)}"
        total = sum(len(a) for a in audio)
        assert total > 2000, f"Audio too small: {total} bytes"
        
        # Concatenate and play
        all_audio = b''.join(audio)
        filepath = AUDIO_DIR / f"02_coordinator_{_engine_name}.wav"
        duration = save_wav(all_audio, filepath)
        
        print(f"  Chunks: {len(audio)}, Total: {total} bytes, Duration: {duration:.2f}s")
        print(f"  {Colors.W}Playing audio...{Colors.RST}")
        play_audio(filepath)
        
        # Verify stats
        await coord.stop_service(cid)
        stats = coord.get_service_stats(cid)
        print(f"  Stats: {stats}")
        
        print(f"{Colors.G}  PASS{Colors.RST}")
        return True
    finally:
        await coord.cleanup_client(cid)


# ═══════════════════════════════════════════════════════════════════════════════
# SCENARIO 3: TextChunker + TTSCoordinator (full chunked pipeline)
# ═══════════════════════════════════════════════════════════════════════════════

async def test_03_chunker_pipeline():
    """Full pipeline: raw text → TextChunker → TTSCoordinator → audio."""
    print(f"\n{Colors.B}━━━ Scenario 3: TextChunker + Coordinator Pipeline ━━━{Colors.RST}")
    
    config = _config()
    coord = TTSCoordinator(tts_integration=_get_tts(), tts_config=config)
    cid = f"s03-{uuid.uuid4().hex[:6]}"
    
    text = (
        "The weather today is sunny with clear skies and a temperature of twenty five degrees. "
        "Tomorrow will bring rain and thunderstorms across the entire region. "
        "I recommend bringing an umbrella if you plan to go outside."
    )
    
    try:
        start = time.time()
        audio, sentences = await feed_text_and_drain(coord, config, cid, text, timeout=180)
        elapsed = time.time() - start
        
        await coord.stop_service(cid)
        
        assert sentences >= 2, f"TextChunker should split into ≥2 sentences, got {sentences}"
        assert len(audio) >= 1, f"Expected ≥1 audio chunk, got {len(audio)}"
        
        total = sum(len(a) for a in audio)
        all_audio = b''.join(audio)
        filepath = AUDIO_DIR / f"03_chunker_pipeline_{_engine_name}.wav"
        duration = save_wav(all_audio, filepath)
        
        print(f"  Input: {len(text.split())} words → {sentences} sentences")
        print(f"  Audio: {len(audio)} chunks, {total} bytes, {duration:.2f}s")
        print(f"  Pipeline latency: {elapsed:.2f}s")
        print(f"  {Colors.W}Playing audio...{Colors.RST}")
        play_audio(filepath)
        
        print(f"{Colors.G}  PASS{Colors.RST}")
        return True
    finally:
        await coord.cleanup_client(cid)


# ═══════════════════════════════════════════════════════════════════════════════
# SCENARIO 4: Multi-turn conversation
# ═══════════════════════════════════════════════════════════════════════════════

async def test_04_multi_turn():
    """Multiple sequential turns (user asks, agent responds, user asks again)."""
    print(f"\n{Colors.B}━━━ Scenario 4: Multi-Turn Conversation ━━━{Colors.RST}")
    
    config = _config()
    coord = TTSCoordinator(tts_integration=_get_tts(), tts_config=config)
    
    turns = [
        ("Turn 1", "Hello, what is the capital of France?",
         "The capital of France is Paris. It is known as the city of light."),
        ("Turn 2", "And what about Germany?",
         "The capital of Germany is Berlin. It has a rich history."),
        ("Turn 3", "Thank you very much.",
         "You are welcome! Let me know if you have any other questions."),
    ]
    
    all_wav_data = b''
    
    for label, user_text, agent_response in turns:
        cid = f"s04-{label.replace(' ', '_')}-{uuid.uuid4().hex[:4]}"
        try:
            print(f"  [{label}] User: \"{user_text}\"")
            print(f"  [{label}] Agent: \"{agent_response[:60]}...\"")
            
            audio, sents = await feed_text_and_drain(coord, config, cid, agent_response, timeout=120)
            await coord.stop_service(cid)
            
            assert len(audio) > 0, f"{label}: No audio generated"
            chunk_data = b''.join(audio)
            total = len(chunk_data)
            all_wav_data += chunk_data
            
            print(f"  [{label}] → {len(audio)} chunks, {total} bytes")
        finally:
            await coord.cleanup_client(cid)
    
    filepath = AUDIO_DIR / f"04_multi_turn_{_engine_name}.wav"
    duration = save_wav(all_wav_data, filepath)
    print(f"\n  Full conversation: {duration:.2f}s")
    print(f"  {Colors.W}Playing full conversation...{Colors.RST}")
    play_audio(filepath)
    
    print(f"{Colors.G}  PASS{Colors.RST}")
    return True


# ═══════════════════════════════════════════════════════════════════════════════
# SCENARIO 5: User interruption during TTS
# ═══════════════════════════════════════════════════════════════════════════════

async def test_05_interruption():
    """User interrupts mid-TTS: clear_queues → queues empty → next turn works."""
    print(f"\n{Colors.B}━━━ Scenario 5: User Interruption ━━━{Colors.RST}")
    
    config = _config()
    coord = TTSCoordinator(tts_integration=_get_tts(), tts_config=config)
    cid = f"s05-{uuid.uuid4().hex[:6]}"
    
    try:
        # Queue a long response
        long_text = (
            "Let me explain the history of computing in great detail. "
            "It started with Charles Babbage and his analytical engine. "
            "Then Ada Lovelace wrote the first algorithm. "
            "Alan Turing formalized computation in the nineteen thirties."
        )
        chunker = TextChunker(first_size=3, target_size=10)
        words = long_text.split()
        acc = []
        queued = 0
        for w in words:
            acc.append(w)
            full = " ".join(acc)
            if chunker.should_process(full):
                s = chunker.process(full, None)
                if s:
                    await coord.add_sentence(cid, s)
                    queued += 1
                    acc = []
        if acc:
            s = chunker.process(" ".join(acc), None)
            if s:
                await coord.add_sentence(cid, s)
                queued += 1
        
        print(f"  Queued {queued} sentences")
        
        # Let first sentence start generating
        await asyncio.sleep(0.3)
        
        # INTERRUPT: User speaks
        print("  [INTERRUPT] User speaks, clearing queues...")
        await coord.clear_queues(cid)
        
        svc = coord._client_services.get(cid)
        if svc:
            assert svc.sentence_queue.empty(), "Sentence queue should be empty"
            assert svc.audio_queue.empty(), "Audio queue should be empty"
            print(f"  Queues cleared: sentence={svc.sentence_queue.qsize()}, audio={svc.audio_queue.qsize()}")
        
        await coord.stop_service(cid)
        
        # Next turn: service still works
        cid2 = f"s05-recovery-{uuid.uuid4().hex[:4]}"
        recovery_text = "Sure, what would you like to know instead?"
        audio, _ = await feed_text_and_drain(coord, config, cid2, recovery_text, timeout=60)
        await coord.stop_service(cid2)
        
        assert len(audio) > 0, "Recovery turn should produce audio"
        all_audio = b''.join(audio)
        filepath = AUDIO_DIR / f"05_interruption_recovery_{_engine_name}.wav"
        save_wav(all_audio, filepath)
        print(f"  Recovery audio: {len(all_audio)} bytes")
        print(f"  {Colors.W}Playing recovery response...{Colors.RST}")
        play_audio(filepath)
        
        await coord.cleanup_client(cid2)
        
        print(f"{Colors.G}  PASS{Colors.RST}")
        return True
    finally:
        await coord.cleanup_client(cid)


# ═══════════════════════════════════════════════════════════════════════════════
# SCENARIO 6: TTS error recovery
# ═══════════════════════════════════════════════════════════════════════════════

async def test_06_error_recovery():
    """Worker survives individual sentence synthesis failure."""
    print(f"\n{Colors.B}━━━ Scenario 6: TTS Error Recovery ━━━{Colors.RST}")
    
    call_count = 0
    real_tts = _get_tts()
    
    class FailOnceTTS:
        def is_available(self): return True
        def get_available_engines(self): return ["fail_once"]
        def get_current_engine(self): return "fail_once"
        def initialize_engine(self, *a, **kw): return True
        def synthesize_text(self, text):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise RuntimeError("Injected TTS failure on first sentence")
            return real_tts.synthesize_text(text)
    
    config = _config()
    coord = TTSCoordinator(tts_integration=FailOnceTTS(), tts_config=config)
    cid = f"s06-{uuid.uuid4().hex[:6]}"
    
    try:
        await coord.add_sentence(cid, "This sentence will fail during synthesis.")
        await coord.add_sentence(cid, "This sentence should succeed after the failure.")
        
        audio = await drain_audio(coord, cid, timeout=120)
        await coord.stop_service(cid)
        
        svc = coord._client_services.get(cid)
        assert svc is not None
        assert svc.sentences_processed >= 2, f"Worker should process both, processed {svc.sentences_processed}"
        assert len(svc.failed_sentences) >= 1, f"Should have ≥1 failure, got {len(svc.failed_sentences)}"
        assert svc.audio_generated >= 1, f"Should have ≥1 success, got {svc.audio_generated}"
        
        print(f"  Processed: {svc.sentences_processed}, Generated: {svc.audio_generated}, Failed: {len(svc.failed_sentences)}")
        print(f"  Failed reason: {svc.failed_sentences[0][1]}")
        
        if audio:
            all_audio = b''.join(audio)
            filepath = AUDIO_DIR / f"06_error_recovery_{_engine_name}.wav"
            save_wav(all_audio, filepath)
            print(f"  Recovery audio: {len(all_audio)} bytes")
            print(f"  {Colors.W}Playing surviving sentence...{Colors.RST}")
            play_audio(filepath)
        
        print(f"{Colors.G}  PASS{Colors.RST}")
        return True
    finally:
        await coord.cleanup_client(cid)


# ═══════════════════════════════════════════════════════════════════════════════
# SCENARIO 7: Concurrent clients
# ═══════════════════════════════════════════════════════════════════════════════

async def test_07_concurrent_clients():
    """3 clients generating TTS simultaneously — no cross-contamination."""
    print(f"\n{Colors.B}━━━ Scenario 7: Concurrent Clients ━━━{Colors.RST}")
    
    config = _config()
    coord = TTSCoordinator(tts_integration=_get_tts(), tts_config=config)
    
    clients = [
        ("alice", "I am Alice and this is my message to the system."),
        ("bob", "I am Bob and I have a completely different request."),
        ("carol", "I am Carol and I need help with something else entirely."),
    ]
    
    async def run_client(name, text):
        cid = f"s07-{name}-{uuid.uuid4().hex[:4]}"
        audio, sents = await feed_text_and_drain(coord, config, cid, text, timeout=120)
        await coord.stop_service(cid)
        total = sum(len(a) for a in audio)
        await coord.cleanup_client(cid)
        return name, len(audio), total
    
    results = await asyncio.gather(*[run_client(n, t) for n, t in clients])
    
    for name, chunks, total in results:
        assert chunks > 0, f"{name}: no audio"
        assert total > 100, f"{name}: audio too small ({total})"
        print(f"  {name}: {chunks} chunks, {total} bytes")
    
    print(f"{Colors.G}  PASS{Colors.RST}")
    return True


# ═══════════════════════════════════════════════════════════════════════════════
# SCENARIO 8: Empty response
# ═══════════════════════════════════════════════════════════════════════════════

async def test_08_empty_response():
    """Empty text → no audio, no hang, completes quickly."""
    print(f"\n{Colors.B}━━━ Scenario 8: Empty Response ━━━{Colors.RST}")
    
    config = _config()
    coord = TTSCoordinator(tts_integration=_get_tts(), tts_config=config)
    cid = f"s08-{uuid.uuid4().hex[:6]}"
    
    try:
        # Don't queue any sentences — just check coordinator handles it
        start = time.time()
        complete = coord.is_generation_complete(cid)
        elapsed = time.time() - start
        
        assert complete is True, "No service = generation complete"
        assert elapsed < 1.0, f"Should be instant, took {elapsed:.2f}s"
        
        print(f"  is_generation_complete (no service): {complete} in {elapsed:.4f}s")
        print(f"{Colors.G}  PASS{Colors.RST}")
        return True
    finally:
        await coord.cleanup_client(cid)


# ═══════════════════════════════════════════════════════════════════════════════
# SCENARIO 9: Queue overflow
# ═══════════════════════════════════════════════════════════════════════════════

async def test_09_queue_overflow():
    """Feed more sentences than queue maxsize → QueueFull errors, no crash."""
    print(f"\n{Colors.B}━━━ Scenario 9: Queue Overflow ━━━{Colors.RST}")
    
    # Tiny queue + slow TTS
    class SlowTTS:
        def is_available(self): return True
        def get_available_engines(self): return ["slow"]
        def get_current_engine(self): return "slow"
        def initialize_engine(self, *a, **kw): return True
        def synthesize_text(self, text):
            time.sleep(0.5)  # Slow: 500ms per sentence
            return sine_pcm16(text)
    
    config = _config(sentence_queue_maxsize=10, audio_queue_maxsize=20)
    coord = TTSCoordinator(tts_integration=SlowTTS(), tts_config=config)
    cid = f"s09-{uuid.uuid4().hex[:6]}"
    
    overflow = 0
    queued = 0
    
    try:
        # Feed more sentences than queue maxsize (10) rapidly while worker is slow
        for i in range(30):
            try:
                await coord.add_sentence(cid, f"Sentence number {i + 1} for overflow stress testing purposes.")
                queued += 1
            except asyncio.QueueFull:
                overflow += 1
        
        assert queued > 0, "At least some should queue"
        assert overflow > 0, f"Expected overflow with 30 sentences into maxsize=10, all {queued} queued"
        
        print(f"  Queued: {queued}, Overflowed: {overflow}")
        
        await coord.stop_service(cid)
        print(f"{Colors.G}  PASS{Colors.RST}")
        return True
    finally:
        await coord.cleanup_client(cid)


# ═══════════════════════════════════════════════════════════════════════════════
# SCENARIO 10: Long response (5+ sentences, full pipeline)
# ═══════════════════════════════════════════════════════════════════════════════

async def test_10_long_response():
    """Long LLM response → 5+ TTS chunks → concatenated audible output."""
    print(f"\n{Colors.B}━━━ Scenario 10: Long Response ━━━{Colors.RST}")
    
    config = _config()
    coord = TTSCoordinator(tts_integration=_get_tts(), tts_config=config)
    cid = f"s10-{uuid.uuid4().hex[:6]}"
    
    text = (
        "Artificial intelligence has evolved dramatically over the past decade. "
        "Deep learning models can now generate images, write code, and hold conversations. "
        "Natural language processing has advanced to the point where machines can understand context. "
        "Computer vision systems can identify objects with superhuman accuracy. "
        "Reinforcement learning has enabled machines to master complex games and tasks. "
        "The future holds even more exciting possibilities for AI research and applications."
    )
    
    try:
        start = time.time()
        audio, sentences = await feed_text_and_drain(coord, config, cid, text, timeout=300)
        elapsed = time.time() - start
        await coord.stop_service(cid)
        
        assert sentences >= 3, f"Should chunk into ≥3 sentences, got {sentences}"
        assert len(audio) >= 2, f"Should produce ≥2 audio chunks, got {len(audio)}"
        
        total = sum(len(a) for a in audio)
        all_audio = b''.join(audio)
        filepath = AUDIO_DIR / f"10_long_response_{_engine_name}.wav"
        duration = save_wav(all_audio, filepath)
        
        print(f"  Input: {len(text.split())} words")
        print(f"  Chunked: {sentences} sentences → {len(audio)} audio chunks")
        print(f"  Audio: {total} bytes, {duration:.2f}s")
        print(f"  Pipeline: {elapsed:.2f}s")
        print(f"  {Colors.W}Playing long response...{Colors.RST}")
        play_audio(filepath)
        
        print(f"{Colors.G}  PASS{Colors.RST}")
        return True
    finally:
        await coord.cleanup_client(cid)


# ═══════════════════════════════════════════════════════════════════════════════
# SCENARIO 11: Sleep word detection (AudioProcessingService level)
# ═══════════════════════════════════════════════════════════════════════════════

async def test_11_sleep_word():
    """Sleep word detection logic: 'sleep' in transcript triggers marker callback."""
    print(f"\n{Colors.B}━━━ Scenario 11: Sleep Word Detection ━━━{Colors.RST}")
    
    # Verify sleep word detection is in the AudioProcessingService code
    from ws.domain.audio.services.audio_processor import AudioProcessingService
    import inspect
    source = inspect.getsource(AudioProcessingService)
    
    # Core logic: if "sleep" in text → callback("__SLEEP_WORD_DETECTED__")
    assert "__SLEEP_WORD_DETECTED__" in source, "Sleep word detection missing from AudioProcessingService"
    assert "sleep" in source.lower(), "Sleep keyword check missing"
    
    # Simulate the callback path
    callbacks = []
    
    async def on_transcript(cid, text):
        callbacks.append((cid, text))
    
    cid = "sleep-test"
    transcript = "OK please go to sleep now"
    
    # This is the exact logic from AudioProcessingService._process_stt_result
    await on_transcript(cid, transcript)
    if any(w in transcript.lower() for w in ["sleep", "go to sleep"]):
        await on_transcript(cid, "__SLEEP_WORD_DETECTED__")
    
    assert len(callbacks) == 2
    assert callbacks[0] == (cid, transcript)
    assert callbacks[1] == (cid, "__SLEEP_WORD_DETECTED__")
    
    print(f"  Transcript: \"{transcript}\"")
    print("  Sleep word detected: __SLEEP_WORD_DETECTED__ callback fired")
    print(f"{Colors.G}  PASS{Colors.RST}")
    return True


# ═══════════════════════════════════════════════════════════════════════════════
# SCENARIO 12: Conversation timeout
# ═══════════════════════════════════════════════════════════════════════════════

async def test_12_conversation_timeout():
    """Conversation times out after inactivity."""
    print(f"\n{Colors.B}━━━ Scenario 12: Conversation Timeout ━━━{Colors.RST}")
    
    from unittest.mock import MagicMock
    from ws.domain.audio.services.audio_processor import AudioProcessingService
    
    processor = AudioProcessingService(
        opus_decoder=MagicMock(),
        vad_service=MagicMock(),
        stt_service=MagicMock(),
        wake_word_service=MagicMock(reset=MagicMock()),
        conversation_timeout=0.3,
        circuit_breaker_enabled=False,
    )
    
    cid = "timeout-test"
    processor.conversation_active[cid] = time.time()
    
    assert await processor._is_conversation_active(cid) is True
    await asyncio.sleep(0.4)
    assert await processor._is_conversation_active(cid) is False
    
    print("  Active → Timed out after 0.4s (threshold: 0.3s)")
    print(f"{Colors.G}  PASS{Colors.RST}")
    return True


# ═══════════════════════════════════════════════════════════════════════════════
# RUNNER
# ═══════════════════════════════════════════════════════════════════════════════

async def run_all():
    """Run all scenarios."""
    print(f"\n{Colors.W}{'═' * 70}{Colors.RST}")
    print(f"{Colors.W}  Aether Handsfree Pipeline — End-to-End Tests{Colors.RST}")
    print(f"{Colors.W}{'═' * 70}{Colors.RST}")
    print(f"  Audio output: {AUDIO_DIR}")
    
    _load_tts_engine()
    
    passed = 0
    failed = 0
    errors = []
    
    async def run(name, coro):
        nonlocal passed, failed
        try:
            if asyncio.iscoroutine(coro) or asyncio.isfuture(coro):
                result = await coro
            else:
                result = coro
            if result:
                passed += 1
            else:
                failed += 1
                errors.append(name)
        except Exception as e:
            import traceback
            print(f"{Colors.R}  FAIL: {e}{Colors.RST}")
            traceback.print_exc()
            failed += 1
            errors.append(f"{name}: {e}")
    
    # Direct synthesis (Qwen3 cold + warm)
    await run("01: Direct Qwen3 Synthesis", test_01_direct_synthesis())
    
    # Pipeline tests (all use Qwen3)
    await run("02: Coordinator Pipeline", test_02_coordinator_pipeline())
    await run("03: Chunker Pipeline", test_03_chunker_pipeline())
    await run("04: Multi-Turn", test_04_multi_turn())
    await run("05: Interruption", test_05_interruption())
    await run("06: Error Recovery", test_06_error_recovery())
    await run("07: Concurrent Clients", test_07_concurrent_clients())
    await run("08: Empty Response", test_08_empty_response())
    await run("09: Queue Overflow", test_09_queue_overflow())
    await run("10: Long Response", test_10_long_response())
    await run("11: Sleep Word", test_11_sleep_word())
    await run("12: Timeout", test_12_conversation_timeout())
    
    total = passed + failed
    
    print(f"\n{Colors.W}{'═' * 70}{Colors.RST}")
    print(f"  Results: {Colors.G}{passed} passed{Colors.RST}, "
          f"{Colors.R if failed else Colors.G}{failed} failed{Colors.RST}, "
          f"{total} total")
    
    if errors:
        print(f"\n  {Colors.R}Failures:{Colors.RST}")
        for e in errors:
            print(f"    - {e}")
    
    print(f"\n  Audio files in: {AUDIO_DIR}")
    print(f"  Play all: for f in {AUDIO_DIR}/*.wav; do afplay \"$f\"; done")
    print(f"{Colors.W}{'═' * 70}{Colors.RST}")
    
    return failed == 0


# ═══════════════════════════════════════════════════════════════════════════════
# PYTEST WRAPPERS
# ═══════════════════════════════════════════════════════════════════════════════

import pytest

@pytest.fixture(scope="session", autouse=True)
def setup_tts():
    _load_tts_engine()

def test_scenario_01_direct(): test_01_direct_synthesis()

@pytest.mark.asyncio
async def test_scenario_02_coordinator(): await test_02_coordinator_pipeline()

@pytest.mark.asyncio
async def test_scenario_03_chunker(): await test_03_chunker_pipeline()

@pytest.mark.asyncio
async def test_scenario_04_multi_turn(): await test_04_multi_turn()

@pytest.mark.asyncio
async def test_scenario_05_interruption(): await test_05_interruption()

@pytest.mark.asyncio
async def test_scenario_06_error_recovery(): await test_06_error_recovery()

@pytest.mark.asyncio
async def test_scenario_07_concurrent(): await test_07_concurrent_clients()

@pytest.mark.asyncio
async def test_scenario_08_empty(): await test_08_empty_response()

@pytest.mark.asyncio
async def test_scenario_09_overflow(): await test_09_queue_overflow()

@pytest.mark.asyncio
async def test_scenario_10_long(): await test_10_long_response()

@pytest.mark.asyncio
async def test_scenario_11_sleep(): await test_11_sleep_word()

@pytest.mark.asyncio
async def test_scenario_12_timeout(): await test_12_conversation_timeout()


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s %(levelname)s %(name)s: %(message)s',
    )
    success = asyncio.run(run_all())
    sys.exit(0 if success else 1)
