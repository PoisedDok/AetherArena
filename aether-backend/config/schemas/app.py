from typing import List
from pydantic import Field, field_validator
from pydantic_settings import SettingsConfigDict

from config.schemas.core import AetherBaseSettings
from config.schemas.ai import ServiceProviderConfig


class AgentUiSettings(AetherBaseSettings):
    """Frontend polling defaults for agent-related UIs."""
    jobs_poll_interval_ms: int = 5000
    index_health_poll_interval_ms: int = 300000
    
    model_config = SettingsConfigDict(env_prefix="AGENT_UI_")


class UiSettings(AetherBaseSettings):
    """UI defaults and performance preferences."""
    widget_size: int = 300
    normal_width: int = 1000
    normal_height: int = 800
    widget_margin: int = 24
    update_interval: int = 100
    effects_mode: str = "full"  # full | reduced
    visualizer_mode: str = "cosmos"  # cosmos (premium orb) | neural (node mesh)

    model_config = SettingsConfigDict(env_prefix="UI_")

    @field_validator('effects_mode')
    @classmethod
    def validate_effects_mode(cls, v: str) -> str:
        allowed = ['full', 'reduced']
        if v not in allowed:
            raise ValueError(f"effects_mode must be one of {allowed}")
        return v

    @field_validator('visualizer_mode')
    @classmethod
    def validate_visualizer_mode(cls, v: str) -> str:
        allowed = ['neural', 'cosmos']
        if v not in allowed:
            raise ValueError(f"visualizer_mode must be one of {allowed}")
        return v


class UserProfileSettings(AetherBaseSettings):
    """User profile personalization settings."""
    name: str = ""
    username: str = ""
    
    model_config = SettingsConfigDict(env_prefix="USER_PROFILE_")


class SummaryServiceSettings(AetherBaseSettings):
    """Chat summarization configuration."""
    enabled: bool = True
    auto_summarize: bool = False  # Auto-summarize disabled by default (user-configurable from settings)
    
    # Per-service provider override (default: aether_inference, model from central config)
    provider_config: ServiceProviderConfig = Field(default_factory=ServiceProviderConfig)
    
    # LLM generation parameters (LFM 1.2B needs temp >= 0.6 to avoid degenerate loops)
    temperature: float = 0.6
    max_tokens: int = 30720  # ~30K -- local models have 128K+ context
    max_tokens_brief: int = 8192  # Brief summaries still get reasonable headroom
    
    # Size-adaptive thresholds (message counts)
    small_chat_threshold: int = 5    # 1-5 messages: minimal summary
    medium_chat_threshold: int = 30  # 6-30 messages: standard summary
    large_chat_threshold: int = 100  # 31-100 messages: DocumentUtility extractive pipeline
    # 100+ messages: same pipeline (scales to any size, no truncation)
    
    # Token budget for conversation text sent to LLM (rough char estimate: 1 token ~ 4 chars)
    max_conversation_chars: int = 24000  # ~6000 tokens for conversation content
    
    # Prompt template (user-configurable via /v1/settings/ -> summary preference group)
    # Uses Python str.format() placeholders:
    #   {instruction}        - per-summary-type instruction (brief/technical/executive/full)
    #   {title_max_length}   - max chars for title
    #   {key_points_max}     - max number of key points
    #   {size_hint}          - adaptive hint about conversation length
    system_prompt_template: str = (
        "You are a precise chat summarization engine. Your output MUST be valid JSON.\n"
        "\n"
        "Analyze the conversation below and produce a JSON object with EXACTLY these fields:\n"
        '{{\n'
        '  "title": "<concise descriptive title, max {title_max_length} chars>",\n'
        '  "summary": "<1-3 sentence narrative summary of the entire conversation>",\n'
        '  "key_points": ["<point 1>", "<point 2>", ...],\n'
        '  "entities": {{"people": ["..."], "technologies": ["..."], "concepts": ["..."]}},\n'
        '  "topics": ["<topic 1>", "<topic 2>", ...]\n'
        '}}\n'
        "\n"
        "Rules:\n"
        "- title: Capture the CORE subject. Not generic (avoid 'Chat Summary' or 'Discussion'). Max {title_max_length} chars.\n"
        "- summary: A prose paragraph (1-3 sentences) that a reader can scan to understand what happened.\n"
        "- key_points: Up to {key_points_max} bullet points covering decisions, actions, conclusions, or open questions. "
        "Each point should be a complete, standalone sentence.\n"
        "- entities: Categorized into people, technologies, concepts. Only include entities actually discussed (not just mentioned in passing). "
        "Omit empty categories.\n"
        "- topics: 2-5 high-level topic tags.\n"
        "\n"
        "{instruction}\n"
        "\n"
        "{size_hint}\n"
        "\n"
        "Output ONLY the JSON object. No markdown, no code fences, no explanation."
    )
    
    # Content limits
    title_max_length: int = 100
    key_points_max: int = 8
    fallback_content_length: int = 300
    
    # Search defaults
    default_search_limit: int = 10
    
    # Summary types
    valid_summary_types: List[str] = Field(
        default_factory=lambda: ["full", "brief", "technical", "executive"]
    )
    
    model_config = SettingsConfigDict(env_prefix="SUMMARY_SERVICE_")
    
    @field_validator('temperature')
    @classmethod
    def validate_temperature(cls, v: float) -> float:
        """Validate temperature is between 0.0 and 2.0."""
        if not 0.0 <= v <= 2.0:
            raise ValueError('temperature must be between 0.0 and 2.0')
        return v


class ResearchServiceSettings(AetherBaseSettings):
    """Research and prompt enhancer agent configuration."""
    # Per-service provider override (default: aether_inference, model from central config)
    provider_config: ServiceProviderConfig = Field(default_factory=ServiceProviderConfig)

    model_config = SettingsConfigDict(env_prefix="RESEARCH_SERVICE_")


class ContextExportSettings(AetherBaseSettings):
    """Context export defaults for context summaries."""
    summary_template: str = "Chat with {message_count} messages using {token_count} tokens"
    key_points_max: int = 5
    include_artifacts: bool = False

    model_config = SettingsConfigDict(env_prefix="CONTEXT_EXPORT_")
