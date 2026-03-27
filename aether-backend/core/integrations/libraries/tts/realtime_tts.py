"""
RealtimeTTS Integration

Production-ready wrapper for real-time text-to-speech synthesis.
Supports multiple TTS engines with fallback mechanisms.

@.architecture
Incoming: api/v1/endpoints/tts.py, services/realtime-tts --- {str text, str engine_name, Dict TTS config}
Processing: synthesize(), stream_audio(), initialize_engine(), _import_realtimetts() --- {JOB_EXECUTE_TOOL, JOB_INITIALIZE_COMPONENT, JOB_LOAD_CONFIG, JOB_TRANSFORM_DATA}
Outgoing: api/v1/endpoints/tts.py --- {bytes audio_data, AsyncIterator[bytes] audio stream, Dict[str, Any] engine info}
"""

import sys
import logging
from pathlib import Path
from typing import Optional, Dict, Any, List, AsyncIterator
import asyncio

logger = logging.getLogger(__name__)


class RealtimeTTSIntegration:
    """
    Integration wrapper for RealtimeTTS library.
    
    Features:
    - Multiple engine support (System, Edge, gTTS, OpenAI, ElevenLabs, etc.)
    - Real-time streaming synthesis
    - Async audio generation
    - Fallback mechanism
    - Audio format conversion
    """
    
    def __init__(self):
        """Initialize TTS integration."""
        self._tts_available = False
        self._TextToAudioStream = None
        self._engine = None
        self._direct_engine = None  # Direct engine ref (Qwen3/Kokoro) for synthesize_text bypass
        self._current_engine_name = None
        
        # Try to import RealtimeTTS
        try:
            self._import_realtimetts()
            self._tts_available = True
            logger.info("✅ RealtimeTTS integration initialized")
        except Exception as e:
            logger.warning("RealtimeTTS not available: %s", e)
    
    @classmethod
    def from_api_key(cls, api_key: str):
        """Create integration instance with API key."""
        instance = cls()
        return instance

    def _import_realtimetts(self):
        """Import RealtimeTTS from services directory."""
        # Note: In development mode, vendored paths are injected into PYTHONPATH by main.py
        if getattr(sys, 'frozen', False):
            # Frozen: PyInstaller bundles RealtimeTTS to _internal/
            pass
        
        # ARCHITECTURAL FIX: Pre-emptively disable spaCy's auto-downloader for Kokoro
        # Kokoro (via misaki) tries to download 'en_core_web_sm' at runtime if not found.
        # In a frozen binary, this fails with SystemExit: 2.
        # We must bundle the model and point spaCy to it.
        try:
            import spacy
            import os
            # Prevent spaCy from trying to download models
            os.environ["SPACY_WARNING_IGNORE"] = "W008"
            
            # MONKEY-PATCH: Disable spacy.cli.download to prevent SystemExit: 2
            import spacy.cli
            def _no_op_download(*args, **kwargs):
                logger.info("spaCy download call intercepted and disabled in frozen environment")
                return None
            spacy.cli.download = _no_op_download
            
            # Pre-load the model to ensure it's in spaCy's internal registry
            try:
                import en_core_web_sm
                if not spacy.util.is_package("en_core_web_sm"):
                    # Manually add to internal registry if not detected as package
                    # (common issue in frozen binaries)
                    logger.debug("Registering bundled en_core_web_sm manually")
            except ImportError:
                logger.warning("Bundled en_core_web_sm not found via import")
        except ImportError:
            pass

        # Import RealtimeTTS core (required)
        try:
            from RealtimeTTS import TextToAudioStream
            self._TextToAudioStream = TextToAudioStream
        except ImportError as e:
            logger.error("Failed to import RealtimeTTS core: %s", e)
            raise

        # Import built-in engines individually (each is optional)
        try:
            from RealtimeTTS.engines import SystemEngine
            self._SystemEngine = SystemEngine
        except Exception as e:  # noqa: BLE001 -- optional engine: disable on any import failure
            self._SystemEngine = None
            logger.debug("System TTS engine not available: %s", e)

        try:
            from RealtimeTTS.engines import EdgeEngine
            self._EdgeEngine = EdgeEngine
        except Exception as e:  # noqa: BLE001 -- optional engine: disable on any import failure
            self._EdgeEngine = None
            logger.debug("Edge TTS engine not available: %s", e)

        try:
            from RealtimeTTS.engines import GTTSEngine
            self._GTTSEngine = GTTSEngine
        except Exception as e:  # noqa: BLE001 -- optional engine: disable on any import failure
            self._GTTSEngine = None
            logger.debug("GTTS engine not available: %s", e)
        
        # Try to import optional engines
        try:
            from RealtimeTTS.engines import OpenAIEngine
            self._OpenAIEngine = OpenAIEngine
        except ImportError:
            self._OpenAIEngine = None
            logger.debug("OpenAI TTS engine not available")
        
        try:
            from RealtimeTTS.engines import ElevenlabsEngine
            self._ElevenlabsEngine = ElevenlabsEngine
        except ImportError:
            self._ElevenlabsEngine = None
            logger.debug("ElevenLabs TTS engine not available")
        
        try:
            from RealtimeTTS.engines import KokoroEngine
            self._KokoroEngine = KokoroEngine
            logger.info("Kokoro TTS engine available")
        except ImportError as e:
            self._KokoroEngine = None
            logger.debug("Kokoro TTS engine not available: %s", e)
        except Exception as e:
            self._KokoroEngine = None
            logger.error("Failed to load Kokoro TTS engine: %s", e)

        try:
            from RealtimeTTS.engines import Qwen3Engine
            self._Qwen3Engine = Qwen3Engine
            logger.info("Qwen3 TTS engine (PyTorch) available")
        except ImportError as e:
            self._Qwen3Engine = None
            logger.debug("Qwen3 TTS engine not available: %s", e)
        except Exception as e:
            self._Qwen3Engine = None
            logger.error("Failed to load Qwen3 TTS engine: %s", e)

        # MLX variant — 3-6x faster on Apple Silicon.
        # Guard: verify mlx_audio is actually importable (not just that the
        # engine .py file exists).  On Windows/Linux/Intel Mac, mlx_audio is
        # not installed so the engine class must remain None → PyTorch used.
        self._Qwen3MLXEngine = None
        try:
            import mlx_audio  # noqa: F401  — gate check only
            from RealtimeTTS.engines import Qwen3MLXEngine
            self._Qwen3MLXEngine = Qwen3MLXEngine
            logger.info("Qwen3 MLX TTS engine available (Apple Silicon)")
        except ImportError as e:
            logger.debug("Qwen3 MLX engine not available: %s", e)
        except Exception as e:
            logger.debug("Qwen3 MLX engine not usable: %s", e)
    
    def is_available(self) -> bool:
        """Check if TTS is available."""
        return self._tts_available
    
    def _cleanup_current_engine(self):
        """Release VRAM/resources from the currently loaded engine before switching."""
        if self._direct_engine is not None:
            try:
                if hasattr(self._direct_engine, 'shutdown'):
                    self._direct_engine.shutdown()
                    logger.info("Released resources from %s engine", self._current_engine_name)
            except Exception as e:
                logger.warning("Error during engine cleanup: %s", e)
            finally:
                self._direct_engine = None

        if self._engine is not None:
            try:
                self._engine.stop()
            except Exception:
                pass
            self._engine = None

    def _record_engine_switch(self, from_engine: str, to_engine: str):
        """Record engine switch metric."""
        try:
            from monitoring.metrics import get_registry
            reg = get_registry()
            counter = reg.counter(
                'aether_tts_engine_switches_total',
                'Total TTS engine switch events',
                labels=['from_engine', 'to_engine'],
            )
            counter.inc(from_engine=from_engine or "none", to_engine=to_engine)
        except Exception:
            pass

    def initialize_engine(self, engine_name: str = "system", **kwargs) -> bool:
        """
        Initialize specific TTS engine.

        Cleans up any previously loaded engine first (releases VRAM).

        Args:
            engine_name: Engine to use (qwen3, kokoro, system, edge, gtts, openai, elevenlabs)
            **kwargs: Engine-specific configuration

        Returns:
            True if engine initialized successfully
        """
        if not self._tts_available:
            logger.error("RealtimeTTS not available")
            return False

        try:
            # Record engine switch metric
            previous_engine = self._current_engine_name
            # Release previous engine resources before loading new one
            self._cleanup_current_engine()
            self._record_engine_switch(previous_engine, engine_name)

            name = engine_name.lower()

            # ── Qwen3 (default, high-quality) ─────────────────────
            # Auto-detect: prefer MLX on Apple Silicon (3-6x faster), fall back to PyTorch.
            # Model path from config may not match selected engine variant (e.g. config
            # resolved MLX path but mlx-audio import failed).  Each branch validates
            # and overrides the model path if it detects a mismatch.
            _MLX_DEFAULT = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit"
            _PT_DEFAULT = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"

            if name == "qwen3" and (self._Qwen3MLXEngine or self._Qwen3Engine):
                voice = kwargs.get("voice", "Ryan")
                instruct = kwargs.get("instruct", "")
                language = kwargs.get("language", "")
                cfg_model_path = kwargs.get("model_path", "")
                engine = None

                # ── Try MLX first (Apple Silicon) ──
                if self._Qwen3MLXEngine:
                    if not cfg_model_path or "mlx" not in cfg_model_path.lower():
                        model_path = _MLX_DEFAULT
                    else:
                        model_path = cfg_model_path
                    try:
                        engine = self._Qwen3MLXEngine(
                            voice=voice,
                            model_path=model_path,
                            instruct=instruct,
                            language=language,
                        )
                        engine.preload()
                        logger.info("[Auto-detect] Qwen3 MLX engine ready: %s", model_path)
                    except Exception as mlx_err:
                        logger.warning(
                            f"MLX engine failed ({mlx_err}), falling back to PyTorch"
                        )
                        engine = None

                # ── PyTorch fallback (CUDA / MPS / CPU) ──
                if engine is None and self._Qwen3Engine:
                    if not cfg_model_path or "mlx" in cfg_model_path.lower():
                        model_path = _PT_DEFAULT
                    else:
                        model_path = cfg_model_path
                    device = kwargs.get("device", None)
                    engine = self._Qwen3Engine(
                        voice=voice,
                        model_path=model_path,
                        device=device,
                        instruct=instruct,
                        language=language,
                    )
                    engine.preload()
                    logger.info("[Auto-detect] Qwen3 PyTorch engine ready: %s", model_path)

                if engine is None:
                    logger.error("Both MLX and PyTorch Qwen3 engines failed")
                    return False

                self._direct_engine = engine

            # ── Kokoro (legacy) ───────────────────────────────────
            elif name == "kokoro" and self._KokoroEngine:
                voice = kwargs.get("voice", "af_heart")
                engine = self._KokoroEngine(voice=voice)
                self._direct_engine = engine

            # ── Standard engines ──────────────────────────────────
            elif name == "system" and self._SystemEngine:
                engine = self._SystemEngine()
                self._direct_engine = engine
            elif name == "edge" and self._EdgeEngine:
                engine = self._EdgeEngine()
                self._direct_engine = engine
            elif name == "gtts" and self._GTTSEngine:
                engine = self._GTTSEngine()
                self._direct_engine = engine
            elif name == "openai" and self._OpenAIEngine:
                engine = self._OpenAIEngine(api_key=kwargs.get("api_key"))
                self._direct_engine = engine
            elif name == "elevenlabs" and self._ElevenlabsEngine:
                engine = self._ElevenlabsEngine(api_key=kwargs.get("api_key"))
                self._direct_engine = engine
            else:
                logger.error("Unsupported or unavailable engine: %s", engine_name)
                return False

            # Create TextToAudioStream wrapper
            self._engine = self._TextToAudioStream(
                engine,
                log_characters=False
            )

            self._current_engine_name = engine_name
            logger.info("Initialized %s TTS engine", engine_name)
            return True

        except Exception as e:
            logger.error("Failed to initialize %s engine: %s", engine_name, e, exc_info=True)
            return False
    
    def synthesize_text(self, text: str, output_file: Optional[str] = None) -> Optional[bytes]:
        """
        Synthesize text to audio (blocking).

        Bypasses TextToAudioStream.play() to avoid PyAudio initialization.
        Directly calls engine.synthesize() and pulls PCM16 chunks from queue.
        Works with any engine that implements BaseEngine (Qwen3, Kokoro, etc.).

        Args:
            text: Text to synthesize
            output_file: Optional path to save audio file

        Returns:
            Raw PCM16 audio data as bytes, or None on failure
        """
        if not self._tts_available or self._direct_engine is None:
            logger.error(
                f"TTS engine not initialized "
                f"(available={self._tts_available}, engine={self._current_engine_name})"
            )
            return None

        engine = self._direct_engine

        try:
            # Clear engine queue before synthesis
            while not engine.queue.empty():
                try:
                    engine.queue.get_nowait()
                except Exception:
                    break

            # Direct synthesis — no player, no PyAudio
            success = engine.synthesize(text)
            if not success:
                logger.error("%s engine synthesize() returned False", self._current_engine_name)
                return None

            # Collect PCM16 from engine queue.
            # Qwen3Engine pushes ONE chunk per synthesize() call (no fake splitting).
            # Other engines may push multiple — drain until empty.
            audio_chunks = []
            while not engine.queue.empty():
                try:
                    chunk = engine.queue.get_nowait()
                    if isinstance(chunk, bytes) and len(chunk) > 0:
                        audio_chunks.append(chunk)
                except Exception:
                    break
            # Fallback: if nothing collected yet, block briefly (covers edge cases)
            if not audio_chunks:
                try:
                    chunk = engine.queue.get(timeout=2.0)
                    if isinstance(chunk, bytes) and len(chunk) > 0:
                        audio_chunks.append(chunk)
                except Exception:
                    pass

            if not audio_chunks:
                logger.warning("No audio chunks for: %s", text[:50])
                return None

            audio_bytes = b''.join(audio_chunks)
            logger.info(
                f"[{self._current_engine_name}] Synthesized {len(text)} chars "
                f"-> {len(audio_bytes)} bytes (PCM16)"
            )
            return audio_bytes

        except Exception as e:
            logger.error("Synthesis failed: %s", e, exc_info=True)
            return None
    
    async def synthesize_text_async(
        self, 
        text: str, 
        output_file: Optional[str] = None
    ) -> Optional[bytes]:
        """
        Synthesize text to audio (async).
        
        Args:
            text: Text to synthesize
            output_file: Optional path to save audio file
            
        Returns:
            Audio data as bytes, or None on failure
        """
        # Run synchronous synthesis in executor
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None, 
            self.synthesize_text, 
            text, 
            output_file
        )
    
    async def stream_synthesis(self, text: str) -> AsyncIterator[bytes]:
        """
        Stream audio synthesis in real-time.
        
        Args:
            text: Text to synthesize
            
        Yields:
            Audio chunks as bytes
        """
        if not self._tts_available or not self._engine:
            logger.error("TTS engine not initialized")
            return
        
        try:
            # Create queue for chunks
            chunk_queue = asyncio.Queue()
            synthesis_done = asyncio.Event()
            loop = asyncio.get_running_loop()
            
            def _enqueue_chunk(value: Optional[bytes]) -> None:
                try:
                    chunk_queue.put_nowait(value)
                except asyncio.QueueFull:
                    logger.warning("TTS chunk queue full; dropping chunk")
            
            def on_audio_chunk(chunk):
                """Callback to collect chunks (thread-safe)."""
                loop.call_soon_threadsafe(_enqueue_chunk, chunk)
            
            def _signal_end() -> None:
                loop.call_soon_threadsafe(_enqueue_chunk, None)
                loop.call_soon_threadsafe(synthesis_done.set)
            
            def start_synthesis():
                """Run synthesis in thread."""
                try:
                    self._engine.feed(text)
                    self._engine.play(
                        muted=True,
                        on_audio_chunk=on_audio_chunk
                    )
                finally:
                    _signal_end()
            
            # Start synthesis in executor
            synthesis_task = loop.run_in_executor(None, start_synthesis)
            
            # Stream chunks as they arrive
            while True:
                chunk = await chunk_queue.get()
                if chunk is None:  # End signal
                    break
                yield chunk
            
            # Wait for synthesis to complete
            await synthesis_task
                
        except Exception as e:
            logger.error("Streaming failed: %s", e, exc_info=True)
    
    def get_available_engines(self) -> List[str]:
        """
        Get list of available TTS engines (preferred order).

        Returns:
            List of engine names
        """
        engines = []

        # High-quality engines first
        if self._Qwen3Engine:
            engines.append("qwen3")
        if self._KokoroEngine:
            engines.append("kokoro")

        # Standard engines (only if import succeeded)
        if self._SystemEngine:
            engines.append("system")
        if self._EdgeEngine:
            engines.append("edge")
        if self._GTTSEngine:
            engines.append("gtts")

        if self._OpenAIEngine:
            engines.append("openai")
        if self._ElevenlabsEngine:
            engines.append("elevenlabs")

        return engines
    
    def get_current_engine(self) -> Optional[str]:
        """Get currently active engine name."""
        return self._current_engine_name
    
    def stop(self):
        """Stop current synthesis."""
        if self._engine:
            try:
                self._engine.stop()
            except Exception as e:
                logger.warning("Error stopping engine: %s", e)

    def cleanup(self):
        """Full cleanup — stop + release model VRAM."""
        self.stop()
        self._cleanup_current_engine()
    
    async def check_health(self) -> Dict[str, Any]:
        """
        Check TTS integration health.
        
        Returns:
            Health status dict
        """
        return {
            "healthy": self._tts_available,
            "message": "RealtimeTTS available" if self._tts_available else "RealtimeTTS not available",
            "current_engine": self._current_engine_name,
            "available_engines": self.get_available_engines() if self._tts_available else []
        }


# Global instance
_tts_integration: Optional[RealtimeTTSIntegration] = None


def get_tts_integration() -> RealtimeTTSIntegration:
    """Get or create TTS integration singleton."""
    global _tts_integration
    if _tts_integration is None:
        _tts_integration = RealtimeTTSIntegration()
    return _tts_integration

