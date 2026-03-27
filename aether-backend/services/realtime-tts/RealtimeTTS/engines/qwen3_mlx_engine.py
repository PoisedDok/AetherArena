"""
Qwen3-TTS MLX Engine for RealtimeTTS

Apple Silicon native TTS using mlx-audio.  3-6x faster than PyTorch MPS
for the same model.  Uses Metal-native kernels and unified memory — no
CPU↔GPU copies.

Requires:
- pip install mlx-audio

@.architecture
Incoming: RealtimeTTS TextToAudioStream / RealtimeTTSIntegration --- {str text, voice config}
Processing: synthesize() --- {JOB_GENERATE_AUDIO: mlx_audio model.generate -> PCM16 -> self.queue}
Outgoing: self.queue (PCM16 int16 bytes) --- {bytes audio at 24kHz mono}
"""

from .base_engine import BaseEngine
from typing import List, Union
import numpy as np
import traceback
import time
import logging

logger = logging.getLogger(__name__)

# ── Metrics (optional — available when running inside aether-backend) ──
_tts_synthesis_duration = None
_tts_synthesis_total = None
_tts_model_load_duration = None
_tts_audio_duration = None
try:
    from monitoring.metrics import get_registry as _get_registry
    _reg = _get_registry()
    _tts_synthesis_duration = _reg.histogram(
        'aether_tts_synthesis_duration_seconds',
        'TTS synthesis duration per sentence (seconds)',
        labels=['engine', 'voice'],
        buckets=[0.5, 1.0, 2.0, 3.0, 5.0, 7.0, 10.0, 15.0, 30.0, 60.0],
    )
    _tts_synthesis_total = _reg.counter(
        'aether_tts_synthesis_total',
        'Total TTS synthesis operations',
        labels=['engine', 'voice', 'status'],
    )
    _tts_model_load_duration = _reg.histogram(
        'aether_tts_model_load_duration_seconds',
        'TTS model load/preload duration (seconds)',
        labels=['engine'],
        buckets=[1.0, 5.0, 10.0, 20.0, 30.0, 60.0, 120.0],
    )
    _tts_audio_duration = _reg.histogram(
        'aether_tts_audio_duration_seconds',
        'Generated audio duration per sentence (seconds)',
        labels=['engine', 'voice'],
        buckets=[0.5, 1.0, 2.0, 3.0, 5.0, 10.0, 15.0, 30.0],
    )
except Exception:
    pass  # Running standalone or on non-Apple-Silicon — metrics disabled


# ──────────────────────────────────────────────────────────────
# Voice definition (shared with qwen3_engine.py)
# ──────────────────────────────────────────────────────────────

class Qwen3MLXVoice:
    """Voice config for Qwen3-TTS MLX CustomVoice models."""

    def __init__(self, name: str, description: str = "", native_language: str = "English"):
        self.name = name
        self.description = description
        self.native_language = native_language

    def __repr__(self):
        return f"Qwen3MLXVoice({self.name}, lang={self.native_language})"


# Canonical voice registry — MUST match PyTorch QWEN3_VOICES exactly (9 speakers)
QWEN3_MLX_VOICES = [
    Qwen3MLXVoice("Ryan", "Dynamic male voice with strong rhythmic drive", "English"),
    Qwen3MLXVoice("Aiden", "Sunny American male voice with clear midrange", "English"),
    Qwen3MLXVoice("Vivian", "Bright, slightly edgy young female voice", "Chinese"),
    Qwen3MLXVoice("Serena", "Warm, gentle young female voice", "Chinese"),
    Qwen3MLXVoice("Uncle_Fu", "Seasoned male voice with low, mellow timbre", "Chinese"),
    Qwen3MLXVoice("Dylan", "Youthful Beijing male voice, clear natural timbre", "Chinese"),
    Qwen3MLXVoice("Eric", "Lively Chengdu male voice, slightly husky brightness", "Chinese"),
    Qwen3MLXVoice("Ono_Anna", "Playful Japanese female voice, light nimble timbre", "Japanese"),
    Qwen3MLXVoice("Sohee", "Warm Korean female voice with rich emotion", "Korean"),
]

QWEN3_MLX_VOICE_NAMES = {v.name for v in QWEN3_MLX_VOICES}


# ──────────────────────────────────────────────────────────────
# Engine
# ──────────────────────────────────────────────────────────────

class Qwen3MLXEngine(BaseEngine):
    """
    Qwen3-TTS engine via mlx-audio — Apple Silicon native.

    Key advantages over PyTorch MPS path:
      - Metal-native kernels optimised for M-series SIMD groups
      - Zero-copy unified memory (no CPU↔GPU transfer overhead)
      - Efficient KV-cache for autoregressive generation
      - 8-bit quantised: ~24 tok/s, RTF 1.44x (faster than real-time)
      - 4-bit quantised: ~29 tok/s, RTF 1.57x

    Same BaseEngine interface as Qwen3Engine — drop-in replacement.
    24 kHz PCM16 mono output, single-push to queue per sentence.
    """

    # Class-level model cache
    _shared_model = None
    _shared_model_path = None

    # Voice name → mlx-audio language code mapping.
    # mlx-audio uses lowercase full names: "english", "chinese", etc.
    # Explicit language prevents auto-detection instability on short chunks.
    _VOICE_LANGUAGE_MAP = {v.name.lower(): v.native_language.lower() for v in QWEN3_MLX_VOICES}

    def __init__(
        self,
        voice: Union[str, Qwen3MLXVoice] = "Ryan",
        model_path: str = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit",
        instruct: str = "",
        language: str = "",
        debug: bool = False,
    ):
        """
        Args:
            voice: Speaker name (Ryan/Aiden/Vivian/Serena/Dylan/Eric).
            model_path: HuggingFace MLX model ID or local directory.
            instruct: Natural-language style instruction (1.7B models).
            language: Language code override ("english"/"chinese"/etc).
                      Empty or None → auto-resolve from voice's native language.
            debug: Enable verbose logging.
        """
        self._init_voice = voice
        self._init_model_path = model_path
        self._init_instruct = instruct
        self._init_language = language
        self._init_debug = debug

    def post_init(self):
        """Called by BaseInitMeta after BaseEngine.__init__() resets defaults."""
        self.engine_name = "qwen3_mlx"
        self.model_path = self._init_model_path
        self.instruct = self._init_instruct
        self.debug = self._init_debug
        self._sample_rate = 24000

        # CRITICAL: Replace torch.multiprocessing.Event with threading.Event.
        # BaseEngine.__init__() creates self.stop_synthesis_event = mp.Event()
        # which allocates a POSIX semaphore.  When MLX + torch coexist in the
        # same process, the resource_tracker segfaults on shutdown trying to
        # clean up these semaphores.  MLX engine is single-process — threading
        # Event is sufficient and avoids the SIGSEGV.
        import threading
        self.stop_synthesis_event = threading.Event()

        # Voice state — set_voice() also resolves current_language
        self.current_voice: str = "Ryan"
        self.current_language: str = "english"
        self.set_voice(self._init_voice)

        # Explicit language override from config (takes precedence over voice default)
        if self._init_language:
            self.current_language = self._init_language.lower()

        if self.debug:
            logger.info(
                f"[Qwen3MLX] Constructed: voice={self.current_voice}, "
                f"lang={self.current_language}, model={self.model_path}"
            )

    # ── Model lifecycle ────────────────────────────────────────

    def _ensure_model_loaded(self):
        """
        Lazy-load MLX model on first use.  Uses class-level cache.

        MLX handles device placement automatically (unified memory).
        No dtype/device/attention parameters needed — mlx-audio
        reads quantisation config from the model repo.
        """
        if (
            Qwen3MLXEngine._shared_model is not None
            and Qwen3MLXEngine._shared_model_path == self.model_path
        ):
            return

        from mlx_audio.tts.utils import load_model

        t0 = time.time()
        logger.info(f"[Qwen3MLX] Loading model {self.model_path} …")

        model = load_model(self.model_path)

        elapsed = time.time() - t0
        logger.info(f"[Qwen3MLX] Model loaded in {elapsed:.1f}s")

        Qwen3MLXEngine._shared_model = model
        Qwen3MLXEngine._shared_model_path = self.model_path

    def preload(self):
        """
        Eagerly load model + warmup inference.

        Call when handsfree mode activates.  Absorbs ~5-10s model load
        + Metal kernel compilation so first user utterance is fast.
        """
        t0 = time.time()
        self._ensure_model_loaded()
        load_time = time.time() - t0

        # Warmup: short generation to trigger Metal kernel compilation
        model = Qwen3MLXEngine._shared_model
        if model is not None:
            try:
                gen_kwargs = dict(
                    text="Hello.",
                    voice=self.current_voice,
                    lang_code=self.current_language,
                    verbose=False,
                    max_tokens=75,
                )
                if self.instruct:
                    gen_kwargs["instruct"] = self.instruct
                for _ in model.generate(**gen_kwargs):
                    break  # Only need first result
            except Exception:
                pass  # Non-fatal warmup

        total = time.time() - t0

        # Record model load duration metric
        if _tts_model_load_duration is not None:
            try:
                _tts_model_load_duration.observe(total, engine="qwen3_mlx")
            except Exception:
                pass

        logger.info(
            f"[Qwen3MLX] Preload complete: model={load_time:.1f}s, "
            f"warmup={total - load_time:.1f}s, total={total:.1f}s"
        )

    # ── Synthesis (core contract) ──────────────────────────────

    def synthesize(self, text: str) -> bool:
        """
        Synthesize *text* into PCM16 and push to ``self.queue`` in ONE shot.

        Uses mlx-audio's model.generate() which returns GenerationResult
        with .audio as mlx.core.array float32 and .sample_rate = 24000.

        Returns True on success, False on failure.
        """
        start_time = time.time()
        try:
            self._ensure_model_loaded()
            model = Qwen3MLXEngine._shared_model

            # Build generation kwargs.
            # CRITICAL: lang_code must be a full lowercase name ("english",
            # "chinese", etc.) matching the model's codec_language_id keys.
            # "en" does NOT match "english" → model falls back to nothink mode
            # (no language embedding) → inconsistent prosody between chunks.
            gen_kwargs = dict(
                text=text,
                voice=self.current_voice,
                lang_code=self.current_language,
                verbose=False,
                max_tokens=1200,
            )
            if self.instruct:
                gen_kwargs["instruct"] = self.instruct

            # Generate — returns iterator of GenerationResult
            audio_float32 = None
            sr = self._sample_rate
            for result in model.generate(**gen_kwargs):
                audio_float32 = np.array(result.audio)
                sr = result.sample_rate
                break  # Single text → single result

            if audio_float32 is None or len(audio_float32) == 0:
                logger.error("[Qwen3MLX] model.generate returned empty")
                return False

            self._sample_rate = sr

            # Clip and convert to PCM16 — ONE chunk, no fake splitting
            audio_float32 = np.clip(audio_float32, -1.0, 1.0)
            audio_int16 = (audio_float32 * 32767).astype(np.int16).tobytes()

            self.queue.put(audio_int16)
            audio_secs = len(audio_float32) / sr
            self.audio_duration += audio_secs

            elapsed = time.time() - start_time
            logger.info(
                f"[Qwen3MLX] {len(text)} chars → "
                f"{audio_secs:.1f}s audio in {elapsed:.1f}s "
                f"(RTF={audio_secs/elapsed:.2f}x)"
            )

            # ── Metrics: success ──
            if _tts_synthesis_duration is not None:
                try:
                    _tts_synthesis_duration.observe(elapsed, engine="qwen3_mlx", voice=self.current_voice)
                    _tts_synthesis_total.inc(engine="qwen3_mlx", voice=self.current_voice, status="success")
                    _tts_audio_duration.observe(audio_secs, engine="qwen3_mlx", voice=self.current_voice)
                except Exception:
                    pass

            return True

        except Exception as e:
            traceback.print_exc()
            logger.error(f"[Qwen3MLX] Synthesis failed: {e}")

            # ── Metrics: failure ──
            if _tts_synthesis_total is not None:
                try:
                    _tts_synthesis_total.inc(engine="qwen3_mlx", voice=self.current_voice, status="failure")
                except Exception:
                    pass

            return False

    # ── Voice management ───────────────────────────────────────

    def set_voice(self, voice: Union[str, Qwen3MLXVoice]):
        """
        Set active voice for subsequent ``synthesize`` calls.

        Also resolves ``current_language`` from the voice's native language.
        Explicit language via constructor/set_voice_parameters takes precedence.
        """
        if isinstance(voice, Qwen3MLXVoice):
            self.current_voice = voice.name
            self.current_language = voice.native_language.lower()
        elif isinstance(voice, str):
            matched = None
            for v in QWEN3_MLX_VOICES:
                if voice == v.name or voice.lower() == v.name.lower():
                    matched = v
                    break
            self.current_voice = matched.name if matched else voice
            # Resolve language from voice registry
            self.current_language = self._VOICE_LANGUAGE_MAP.get(
                self.current_voice.lower(), "english"
            )
        else:
            self.current_voice = str(voice)
            self.current_language = "english"

        if self.debug:
            logger.info(
                f"[Qwen3MLX] Voice set to: {self.current_voice} "
                f"(lang={self.current_language})"
            )

    def get_voices(self) -> List[Qwen3MLXVoice]:
        """Return the canonical list of Qwen3 MLX speakers."""
        return list(QWEN3_MLX_VOICES)

    def set_voice_parameters(self, **kwargs):
        """Accept arbitrary voice parameters."""
        if "instruct" in kwargs:
            self.instruct = kwargs["instruct"]
        if "language" in kwargs and kwargs["language"]:
            self.current_language = kwargs["language"].lower()

    # ── Stream info (BaseEngine contract) ──────────────────────

    def get_stream_info(self):
        """Return (format, channels, sample_rate) for PyAudio compat."""
        import pyaudio
        return (pyaudio.paInt16, 1, self._sample_rate)

    # ── Shutdown ───────────────────────────────────────────────

    def shutdown(self):
        """Release the model from memory."""
        if Qwen3MLXEngine._shared_model is not None:
            logger.info("[Qwen3MLX] Shutting down — releasing model")
            del Qwen3MLXEngine._shared_model
            Qwen3MLXEngine._shared_model = None
            Qwen3MLXEngine._shared_model_path = None

            # Clear MLX cache
            try:
                import mlx.core as mx
                mx.clear_cache()
            except Exception:
                pass

        # Drain queue
        while not self.queue.empty():
            try:
                self.queue.get_nowait()
            except Exception:
                break

        logger.info("[Qwen3MLX] Shutdown complete")
