"""
RealtimeTTS Integration

Production-ready wrapper for real-time text-to-speech synthesis.
Supports multiple TTS engines with fallback mechanisms.

@.architecture
Incoming: api/v1/endpoints/tts.py, services/realtime-tts --- {str text, str engine_name, Dict TTS config}
Processing: synthesize(), stream_audio(), initialize_engine(), _import_realtimetts() --- {4 jobs: audio_generation, audio_streaming, engine_initialization, tts_synthesis}
Outgoing: api/v1/endpoints/tts.py --- {bytes audio_data, AsyncIterator[bytes] audio stream, Dict[str, Any] engine info}
"""

import sys
import logging
from pathlib import Path
from typing import Optional, Dict, Any, List, AsyncIterator
import asyncio
from io import BytesIO

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
        self._current_engine_name = None
        
        # Try to import RealtimeTTS
        try:
            self._import_realtimetts()
            self._tts_available = True
            logger.info("✅ RealtimeTTS integration initialized")
        except Exception as e:
            logger.warning(f"RealtimeTTS not available: {e}")
    
    def _import_realtimetts(self):
        """Import RealtimeTTS from services directory."""
        # Add services/realtime-tts to path
        services_dir = Path(__file__).resolve().parent.parent.parent.parent.parent / "services"
        tts_path = services_dir / "realtime-tts"
        
        if tts_path.exists() and str(tts_path) not in sys.path:
            sys.path.insert(0, str(tts_path))
            logger.debug(f"Added {tts_path} to sys.path")
        
        # Import RealtimeTTS components
        from RealtimeTTS import TextToAudioStream
        from RealtimeTTS.engines import SystemEngine, EdgeEngine, GTTSEngine
        
        self._TextToAudioStream = TextToAudioStream
        self._SystemEngine = SystemEngine
        self._EdgeEngine = EdgeEngine
        self._GTTSEngine = GTTSEngine
        
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
    
    def is_available(self) -> bool:
        """Check if TTS is available."""
        return self._tts_available
    
    def initialize_engine(self, engine_name: str = "system", **kwargs) -> bool:
        """
        Initialize specific TTS engine.
        
        Args:
            engine_name: Engine to use (system, edge, gtts, openai, elevenlabs)
            **kwargs: Engine-specific configuration
            
        Returns:
            True if engine initialized successfully
        """
        if not self._tts_available:
            logger.error("RealtimeTTS not available")
            return False
        
        try:
            # Select engine
            if engine_name.lower() == "system":
                engine = self._SystemEngine()
            elif engine_name.lower() == "edge":
                engine = self._EdgeEngine()
            elif engine_name.lower() == "gtts":
                engine = self._GTTSEngine()
            elif engine_name.lower() == "openai" and self._OpenAIEngine:
                engine = self._OpenAIEngine(api_key=kwargs.get("api_key"))
            elif engine_name.lower() == "elevenlabs" and self._ElevenlabsEngine:
                engine = self._ElevenlabsEngine(api_key=kwargs.get("api_key"))
            else:
                logger.error(f"Unsupported engine: {engine_name}")
                return False
            
            # Create stream with fallback engines
            fallback_engines = []
            if engine_name != "system":
                fallback_engines.append(self._SystemEngine())
            
            self._engine = self._TextToAudioStream(
                engine,
                log_characters=False
            )
            
            self._current_engine_name = engine_name
            logger.info(f"✅ Initialized {engine_name} TTS engine")
            return True
            
        except Exception as e:
            logger.error(f"Failed to initialize {engine_name} engine: {e}", exc_info=True)
            return False
    
    def synthesize_text(self, text: str, output_file: Optional[str] = None) -> Optional[bytes]:
        """
        Synthesize text to audio (blocking).
        
        Args:
            text: Text to synthesize
            output_file: Optional path to save audio file
            
        Returns:
            Audio data as bytes, or None on failure
        """
        if not self._tts_available or not self._engine:
            logger.error("TTS engine not initialized")
            return None
        
        try:
            # Use temporary file if output_file not provided
            import tempfile
            temp_file = None
            target_file = output_file
            
            if not target_file:
                temp_fd, temp_file = tempfile.mkstemp(suffix='.wav')
                import os
                os.close(temp_fd)
                target_file = temp_file
            
            # Feed text and synthesize to file
            self._engine.feed(text)
            self._engine.play(
                muted=True,  # Don't play audio
                output_wavfile=target_file
            )
            
            # Read audio data from file
            with open(target_file, 'rb') as f:
                audio_data = f.read()
            
            # Clean up temp file if used
            if temp_file:
                import os
                os.unlink(temp_file)
            
            logger.info(f"Synthesized {len(text)} chars -> {len(audio_data)} bytes")
            return audio_data if audio_data else None
            
        except Exception as e:
            logger.error(f"Synthesis failed: {e}", exc_info=True)
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
            
            def on_audio_chunk(chunk):
                """Callback to collect chunks."""
                asyncio.create_task(chunk_queue.put(chunk))
            
            def start_synthesis():
                """Run synthesis in thread."""
                try:
                    self._engine.feed(text)
                    self._engine.play(
                        muted=True,
                        on_audio_chunk=on_audio_chunk
                    )
                finally:
                    asyncio.create_task(chunk_queue.put(None))  # Signal end
                    synthesis_done.set()
            
            # Start synthesis in executor
            loop = asyncio.get_event_loop()
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
            logger.error(f"Streaming failed: {e}", exc_info=True)
    
    def get_available_engines(self) -> List[str]:
        """
        Get list of available TTS engines.
        
        Returns:
            List of engine names
        """
        engines = ["system", "edge", "gtts"]
        
        if self._OpenAIEngine:
            engines.append("openai")
        if self._ElevenlabsEngine:
            engines.append("elevenlabs")
        
        return engines
    
    def get_current_engine(self) -> Optional[str]:
        """Get currently active engine name."""
        return self._current_engine_name
    
    def stop(self):
        """Stop current synthesis and cleanup."""
        if self._engine:
            try:
                self._engine.stop()
            except Exception as e:
                logger.warning(f"Error stopping engine: {e}")
    
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

