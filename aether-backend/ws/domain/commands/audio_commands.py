"""
@.architecture
Incoming: none (pure data structures)
Processing: none (DTOs only)
Outgoing: presentation/command_executor --- {dataclass instances}

Audio Commands - Command DTOs for TTS audio emission

Pure data structures, NO logic.
MessageHandler yields these, CommandExecutor executes them.

Pattern: Follows ws/domain/commands/stream_commands.py
"""

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class AudioCommand:
    """Base class for audio commands."""
    pass


@dataclass(frozen=True)
class EmitTTSAudio(AudioCommand):
    """
    Command to emit TTS audio chunk.
    
    Attributes:
        client_id: Client identifier for routing
        audio_data: Base64-encoded PCM16 audio
        format: Audio format (pcm16/wav)
        sample_rate: Sample rate in Hz (24000 native for Qwen3/Kokoro)
        chat_id: Chat identifier for frontend routing (REQUIRED by ArtifactsStreamOrchestrator contract)
    """
    client_id: str
    audio_data: str
    format: str
    sample_rate: int
    chat_id: Optional[str] = None


@dataclass(frozen=True)
class EmitTTSQueued(AudioCommand):
    """
    Command to signal first TTS chunk queued (frontend transitions to SPEAKING state).
    
    Attributes:
        client_id: Client identifier for routing
        chat_id: Chat identifier for frontend routing (REQUIRED by ArtifactsStreamOrchestrator contract)
    """
    client_id: str
    chat_id: Optional[str] = None


@dataclass(frozen=True)
class EmitTTSCompleted(AudioCommand):
    """
    Command to signal TTS generation completed (frontend auto-loops to LISTENING).
    
    Attributes:
        client_id: Client identifier for routing
        chat_id: Chat identifier for frontend routing (REQUIRED by ArtifactsStreamOrchestrator contract)
    """
    client_id: str
    chat_id: Optional[str] = None


@dataclass(frozen=True)
class EmitSleepWordDetected(AudioCommand):
    """
    Command to signal sleep word detected (frontend disables handsfree).
    
    Attributes:
        client_id: Client identifier for routing
        text: The transcript that triggered sleep word detection
        chat_id: Chat identifier for frontend routing (REQUIRED by ArtifactsStreamOrchestrator contract)
    """
    client_id: str
    text: Optional[str] = None
    chat_id: Optional[str] = None


@dataclass(frozen=True)
class EmitTTSError(AudioCommand):
    """
    Command to signal TTS generation error (queue full, timeout, generation failure).
    
    Frontend response: Transition from SPEAKING to LISTENING, show error toast, clear TTS queue.
    
    Attributes:
        client_id: Client identifier for routing
        error_type: Error type ('queue_full', 'timeout', 'generation_failed')
        message: Human-readable error message
        chat_id: Chat identifier for frontend routing (REQUIRED by ArtifactsStreamOrchestrator contract)
    """
    client_id: str
    error_type: str
    message: str
    chat_id: Optional[str] = None
