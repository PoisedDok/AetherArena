"""
Qwen3-TTS Engine for RealtimeTTS

High-quality text-to-speech engine using Qwen3-TTS (0.6B/1.7B CustomVoice).
Supports 10 languages, 9 premium speakers, and streaming generation.

Requires:
- pip install qwen-tts torch soundfile numpy

@.architecture
Incoming: RealtimeTTS TextToAudioStream / RealtimeTTSIntegration --- {str text, voice config}
Processing: synthesize() --- {JOB_GENERATE_AUDIO: Qwen3TTSModel.generate_custom_voice -> PCM16 chunks -> self.queue}
Outgoing: self.queue (PCM16 int16 bytes) --- {bytes audio chunks at 24kHz mono}
"""

from .base_engine import BaseEngine
from typing import List, Union, Optional
import numpy as np
import traceback
import time
import logging
import re

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
    pass  # Running standalone (tests, experiments) — metrics disabled


# ──────────────────────────────────────────────────────────────
# Voice definition
# ──────────────────────────────────────────────────────────────

class Qwen3Voice:
    """Voice configuration for Qwen3-TTS CustomVoice models."""

    def __init__(self, name: str, description: str = "", native_language: str = "English"):
        self.name = name
        self.description = description
        self.native_language = native_language

    def __repr__(self):
        return f"Qwen3Voice({self.name}, lang={self.native_language})"


# Canonical voice registry (CustomVoice model speakers)
QWEN3_VOICES = [
    Qwen3Voice("Ryan", "Dynamic male voice with strong rhythmic drive", "English"),
    Qwen3Voice("Aiden", "Sunny American male voice with clear midrange", "English"),
    Qwen3Voice("Vivian", "Bright, slightly edgy young female voice", "Chinese"),
    Qwen3Voice("Serena", "Warm, gentle young female voice", "Chinese"),
    Qwen3Voice("Uncle_Fu", "Seasoned male voice with low, mellow timbre", "Chinese"),
    Qwen3Voice("Dylan", "Youthful Beijing male voice, clear natural timbre", "Chinese"),
    Qwen3Voice("Eric", "Lively Chengdu male voice, slightly husky brightness", "Chinese"),
    Qwen3Voice("Ono_Anna", "Playful Japanese female voice, light nimble timbre", "Japanese"),
    Qwen3Voice("Sohee", "Warm Korean female voice with rich emotion", "Korean"),
]

QWEN3_VOICE_NAMES = {v.name for v in QWEN3_VOICES}


# ──────────────────────────────────────────────────────────────
# Engine
# ──────────────────────────────────────────────────────────────

class Qwen3Engine(BaseEngine):
    """
    Qwen3-TTS engine adapter for RealtimeTTS.

    Implements the BaseEngine interface so it slots into the existing
    RealtimeTTS / TTSGenerationService dual-queue pipeline with zero
    changes to upstream code.

    Key design decisions:
    - **Lazy model loading**: The ~2 GB model is loaded on first
      ``synthesize()`` call, not at engine construction time.  This
      keeps startup fast and allows the caller to choose the device
      and dtype at construction.
    - **Single-push queue**: The ``qwen-tts`` local package does NOT
      support chunk-level streaming callbacks; ``generate_custom_voice``
      always returns complete audio.  Each sentence's audio is pushed
      to ``self.queue`` as ONE chunk — no fake slicing.  Real low
      latency comes from the upstream TextChunker producing SHORT
      sentences (3-10 words) and the dual-queue pipeline playing
      sentence N while generating sentence N+1.
    - **24 kHz PCM16 output**: Matches Kokoro's native format so the
      rest of the pipeline (base64 encoding, WebSocket transport,
      frontend ``AudioContext.decodeAudioData``) works unchanged.
    """

    # Class-level model cache — survives engine re-creation for same
    # model path, avoids redundant 30-second load cycles.
    _shared_model = None
    _shared_model_path = None

    def __init__(
        self,
        voice: Union[str, Qwen3Voice] = "Ryan",
        model_path: str = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
        device: Optional[str] = None,
        instruct: str = "",
        language: str = "",
        trim_silence: bool = True,
        silence_threshold: float = 0.005,
        extra_start_ms: int = 15,
        extra_end_ms: int = 15,
        fade_in_ms: int = 10,
        fade_out_ms: int = 10,
        debug: bool = False,
    ):
        """
        Args:
            voice: Speaker name (one of QWEN3_VOICE_NAMES) or Qwen3Voice.
            model_path: HuggingFace repo id **or** local directory.
            device: 'cuda:0' / 'mps' / 'cpu' / None (auto-detect).
            instruct: Natural-language style instruction (1.7B models).
            language: Language override ("English"/"Chinese"/etc).
                      Empty or None → auto-resolve from voice's native language.
            trim_silence: Whether to trim leading/trailing silence.
            silence_threshold: Amplitude below which audio is silence.
            extra_start_ms: Extra ms to trim from leading silence.
            extra_end_ms: Extra ms to trim from trailing silence.
            fade_in_ms: Fade-in duration after trimming.
            fade_out_ms: Fade-out duration after trimming.
            debug: Enable verbose logging.
        """
        # CRITICAL: BaseInitMeta calls BaseEngine.__init__() AFTER this
        # __init__ completes, which resets engine_name/queue/etc.
        # We stash constructor args here and apply them in post_init().
        self._init_voice = voice
        self._init_model_path = model_path
        self._init_device = device
        self._init_instruct = instruct
        self._init_language = language
        self._init_trim_silence = trim_silence
        self._init_silence_threshold = silence_threshold
        self._init_extra_start_ms = extra_start_ms
        self._init_extra_end_ms = extra_end_ms
        self._init_fade_in_ms = fade_in_ms
        self._init_fade_out_ms = fade_out_ms
        self._init_debug = debug

    def post_init(self):
        """Called by BaseInitMeta after BaseEngine.__init__() resets defaults."""
        self.engine_name = "qwen3"
        self.model_path = self._init_model_path
        self.device = self._init_device
        self.instruct = self._init_instruct
        self.trim_silence = self._init_trim_silence
        self.silence_threshold = self._init_silence_threshold
        self.extra_start_ms = self._init_extra_start_ms
        self.extra_end_ms = self._init_extra_end_ms
        self.fade_in_ms = self._init_fade_in_ms
        self.fade_out_ms = self._init_fade_out_ms
        self.debug = self._init_debug

        # Resolved at model-load time
        self._device_map: Optional[str] = None
        self._sample_rate = 24000  # Qwen3 native (matches Kokoro)

        # Voice state — set_voice() also resolves current_language
        self.current_voice: str = "Ryan"
        self.current_language: str = "English"
        self.set_voice(self._init_voice)

        # Explicit language override from config (takes precedence over voice default)
        if self._init_language:
            self.current_language = self._init_language

        if self.debug:
            logger.info(
                f"[Qwen3Engine] Constructed: voice={self.current_voice}, "
                f"lang={self.current_language}, model={self.model_path}, "
                f"device={self.device}"
            )

    # ── Model lifecycle ────────────────────────────────────────

    def _ensure_model_loaded(self):
        """
        Lazy-load Qwen3TTSModel on first use.  Uses class-level cache.
        
        Device/dtype/attention strategy (benchmarked):
          CUDA:  bfloat16 + flash_attention_2 (fastest, requires flash-attn)
          MPS:   bfloat16 + sdpa            (Apple Silicon GPU, ~7s/sentence)
          CPU:   float32  + eager           (fallback, ~60s/sentence)
        
        CRITICAL: MPS + SDPA + bfloat16 is ~10-17x faster than CPU + eager + float32.
        PyTorch >= 2.10 recommended for optimal MPS performance.
        """
        import torch

        # Re-use if same model path already loaded
        if (
            Qwen3Engine._shared_model is not None
            and Qwen3Engine._shared_model_path == self.model_path
        ):
            return

        from qwen_tts import Qwen3TTSModel

        # Global precision hint (reduces float32 matmul overhead)
        torch.set_float32_matmul_precision('high')

        # Auto-detect device
        if self.device is None:
            if torch.cuda.is_available():
                self._device_map = "cuda:0"
            elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                self._device_map = "mps"
            else:
                self._device_map = "cpu"
        else:
            self._device_map = self.device

        # Choose dtype + attention implementation based on device
        # Benchmarked: MPS+bf16+SDPA = ~7s/sentence vs CPU+fp32+eager = ~60s/sentence
        if "cuda" in self._device_map:
            dtype = torch.bfloat16
            # Try flash_attention_2 first (requires flash-attn package)
            try:
                import flash_attn  # noqa: F401
                attn = "flash_attention_2"
            except ImportError:
                attn = "sdpa"  # Fall back to PyTorch native SDPA
        elif "mps" in self._device_map:
            # Apple Silicon: bfloat16 supported on M1+, SDPA accelerated via Metal
            dtype = torch.bfloat16
            attn = "sdpa"
        else:
            # CPU fallback
            dtype = torch.float32
            attn = "eager"

        t0 = time.time()
        logger.info(
            f"[Qwen3Engine] Loading model {self.model_path} on {self._device_map} "
            f"(dtype={dtype}, attn={attn}) …"
        )

        model = Qwen3TTSModel.from_pretrained(
            self.model_path,
            device_map=self._device_map,
            dtype=dtype,
            attn_implementation=attn,
        )

        elapsed = time.time() - t0
        logger.info(f"[Qwen3Engine] Model loaded in {elapsed:.1f}s")

        # Store in class-level cache
        Qwen3Engine._shared_model = model
        Qwen3Engine._shared_model_path = self.model_path

    def preload(self):
        """
        Eagerly load model + run warmup inference.

        Call this when handsfree mode is activated (not on first user utterance).
        First inference after model load has ~3-5s extra overhead (MPS kernel
        compilation for SDPA).  A short warmup here absorbs that cost so the
        user's first sentence doesn't pay for it.
        """
        t0 = time.time()
        self._ensure_model_loaded()
        load_time = time.time() - t0

        # Warmup: generate a short utterance to trigger kernel compilation
        model = Qwen3Engine._shared_model
        if model is not None:
            try:
                model.generate_custom_voice(
                    text="Hello.",
                    language=self.current_language,
                    speaker=self.current_voice,
                    instruct=self.instruct if self.instruct else "",
                )
            except Exception:
                pass  # Non-fatal — just a warmup

        total = time.time() - t0

        # Record model load duration metric
        if _tts_model_load_duration is not None:
            try:
                _tts_model_load_duration.observe(total, engine="qwen3")
            except Exception:
                pass

        logger.info(
            f"[Qwen3Engine] Preload complete: model={load_time:.1f}s, "
            f"warmup={total - load_time:.1f}s, total={total:.1f}s"
        )

    # ── Emotion Parsing ───────────────────────────────────────

    def _extract_emotion_tags(self, text: str) -> tuple[str, str]:
        """
        Extract emotional/prosody tags from text (e.g. <happy>, [laugh]).
        Returns (cleaned_text, extracted_instruct).
        """
        # Look for <tag> or [tag]
        pattern = r'[<\[](.*?)[>\]]'
        tags = re.findall(pattern, text)
        cleaned_text = re.sub(pattern, '', text).strip()
        
        # Combine tags into instruct string
        extracted_instruct = ", ".join(tags).strip()
        return cleaned_text, extracted_instruct

    # ── Synthesis (core contract) ──────────────────────────────

    def synthesize(self, text: str) -> bool:
        """
        Synthesize *text* into PCM16 and push to ``self.queue`` in ONE shot.

        The qwen-tts local package does NOT support true chunk-level streaming
        callbacks — ``generate_custom_voice`` always returns complete audio.
        Splitting the result into fake 2-second chunks and drip-feeding the
        queue is pure overhead with zero latency benefit.

        Real low-latency strategy (what actually works):
          - TextChunker produces SHORT sentences (3-10 words).
          - Dual-queue pipeline plays sentence N while generating sentence N+1.
          - Each sentence's audio is pushed as a SINGLE chunk — no fake slicing.

        Returns True on success, False on failure.
        """
        start_time = time.time()
        try:
            self._ensure_model_loaded()
            model = Qwen3Engine._shared_model

            # Parse emotion/prosody tags from text
            clean_text, parsed_instruct = self._extract_emotion_tags(text)
            
            # If text is empty after removing tags, we skip synthesis
            if not clean_text:
                logger.debug(f"[Qwen3Engine] Text only contained tags, skipping synthesis: {text}")
                return True
                
            # Combine parsed instruct with base instruct
            final_instruct = self.instruct if self.instruct else ""
            if parsed_instruct:
                final_instruct = f"{final_instruct}, {parsed_instruct}".strip(", ")
                logger.info(f"[Qwen3Engine] Synthesizing with parsed emotion tags: {parsed_instruct}")

            # Generate complete sentence audio.
            # non_streaming_mode=True (default): full text input, most efficient
            # for local inference.  The =False mode "simulates streaming text
            # input" per Qwen docs but does NOT yield progressive audio — it
            # just feeds characters one-by-one internally.  Benchmarked: no
            # measurable benefit on MPS, slight overhead on CPU.
            wavs, sr = model.generate_custom_voice(
                text=clean_text,
                language=self.current_language,
                speaker=self.current_voice,
                instruct=final_instruct,
            )

            if not wavs or len(wavs) == 0:
                logger.error("[Qwen3Engine] generate_custom_voice returned empty")
                return False

            audio_float32 = wavs[0]  # numpy array, shape (samples,)
            self._sample_rate = sr

            # Trim leading/trailing silence
            if self.trim_silence:
                audio_float32 = self._trim_silence(
                    audio_float32,
                    sample_rate=sr,
                    silence_threshold=self.silence_threshold,
                    extra_start_ms=self.extra_start_ms,
                    extra_end_ms=self.extra_end_ms,
                    fade_in_ms=self.fade_in_ms,
                    fade_out_ms=self.fade_out_ms,
                )

            if len(audio_float32) == 0:
                logger.warning("[Qwen3Engine] Audio empty after silence trim")
                return False

            # Clip and convert to PCM16 — ONE chunk, no fake splitting
            audio_float32 = np.clip(audio_float32, -1.0, 1.0)
            audio_int16 = (audio_float32 * 32767).astype(np.int16).tobytes()

            self.queue.put(audio_int16)
            audio_secs = len(audio_float32) / sr
            self.audio_duration += audio_secs

            elapsed = time.time() - start_time
            logger.info(
                f"[Qwen3Engine] {len(text)} chars → "
                f"{audio_secs:.1f}s audio in {elapsed:.1f}s "
                f"(RTF={elapsed/audio_secs:.2f}x)"
            )

            # ── Metrics: success ──
            if _tts_synthesis_duration is not None:
                try:
                    _tts_synthesis_duration.observe(elapsed, engine="qwen3", voice=self.current_voice)
                    _tts_synthesis_total.inc(engine="qwen3", voice=self.current_voice, status="success")
                    _tts_audio_duration.observe(audio_secs, engine="qwen3", voice=self.current_voice)
                except Exception:
                    pass

            return True

        except Exception as e:
            traceback.print_exc()
            logger.error(f"[Qwen3Engine] Synthesis failed: {e}")

            # ── Metrics: failure ──
            if _tts_synthesis_total is not None:
                try:
                    _tts_synthesis_total.inc(engine="qwen3", voice=self.current_voice, status="failure")
                except Exception:
                    pass

            return False

    # ── Voice management ───────────────────────────────────────

    # Voice name → PyTorch qwen-tts language code mapping.
    # Official qwen-tts uses title-case: "English", "Chinese", "Auto".
    # Explicit language prevents auto-detection instability on short chunks.
    _VOICE_LANGUAGE_MAP = {v.name.lower(): v.native_language for v in QWEN3_VOICES}

    def set_voice(self, voice: Union[str, Qwen3Voice]):
        """
        Set active voice for subsequent ``synthesize`` calls.

        Also resolves ``current_language`` from the voice's native language.
        This ensures the model gets explicit language context even for
        short text chunks, preventing inconsistent prosody.
        """
        if isinstance(voice, Qwen3Voice):
            self.current_voice = voice.name
            self.current_language = voice.native_language
        elif isinstance(voice, str):
            # Accept exact match or case-insensitive lookup
            matched = None
            for v in QWEN3_VOICES:
                if voice == v.name:
                    matched = v
                    break
                if voice.lower() == v.name.lower():
                    matched = v
                    break
            if matched:
                self.current_voice = matched.name
                self.current_language = matched.native_language
            else:
                # Allow arbitrary names (forward compat with new model releases)
                self.current_voice = voice
                self.current_language = self._VOICE_LANGUAGE_MAP.get(
                    voice.lower(), "Auto"
                )
        else:
            self.current_voice = str(voice)
            self.current_language = "Auto"

        if self.debug:
            logger.info(
                f"[Qwen3Engine] Voice set to: {self.current_voice} "
                f"(lang={self.current_language})"
            )

    def get_voices(self) -> List[Qwen3Voice]:
        """Return the canonical list of Qwen3 CustomVoice speakers."""
        return list(QWEN3_VOICES)

    def set_voice_parameters(self, **kwargs):
        """Accept arbitrary voice parameters (instruct, language, etc.)."""
        if "instruct" in kwargs:
            self.instruct = kwargs["instruct"]
        if "language" in kwargs and kwargs["language"]:
            # Normalize to title-case for qwen-tts: "english" → "English"
            lang = kwargs["language"]
            self.current_language = lang.title() if lang else self.current_language

    # ── Stream info (BaseEngine contract) ──────────────────────

    def get_stream_info(self):
        """Return (format, channels, sample_rate) for PyAudio compat."""
        import pyaudio
        return (pyaudio.paInt16, 1, self._sample_rate)

    # ── Shutdown ───────────────────────────────────────────────

    def shutdown(self):
        """Release the model from memory and free VRAM."""
        import torch

        if Qwen3Engine._shared_model is not None:
            logger.info("[Qwen3Engine] Shutting down — releasing model")
            del Qwen3Engine._shared_model
            Qwen3Engine._shared_model = None
            Qwen3Engine._shared_model_path = None

            if torch.cuda.is_available():
                torch.cuda.empty_cache()

        # Drain queue
        while not self.queue.empty():
            try:
                self.queue.get_nowait()
            except Exception:
                break

        logger.info("[Qwen3Engine] Shutdown complete")
