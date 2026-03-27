"""
@.architecture

Incoming: presentation (via parameters, NO WebSocket) --- {str, Dict, primitives}
Processing: stream orchestration, artifact coordination, trail lifecycle --- {5 jobs: JOB_ORCHESTRATE, JOB_COORDINATE, JOB_TRACK_STATE, JOB_TRANSFORM, JOB_VALIDATE}
Outgoing: presentation (command list) --- {List[Command], pure data}

Stream Orchestrator - Clean Architecture Implementation

Application service for streaming chat responses with clean separation of concerns.

Architecture:
- NO WebSocket parameter (clean architecture principle)
- Uses domain services for pure business logic:
  * ArtifactTracker: Artifact ID management and deduplication
  * PhaseStateMachine: Execution phase state machine
  * MessageAccumulator: Message content accumulation
  * EventNormalizer: Event filtering, normalization, content coercion
- Uses application services for I/O concerns:
  * UserMessagePersister: User message persistence + artifact linking
  * AssistantTextFlusher: Deduplicated assistant text flush
  * RuntimeSettingsApplicator: Pre-stream settings resolution
  * ChatSummarizationService: Background auto-summarization
- Returns List[Command] for presentation layer to execute
- Delegates trail operations to TrailCoordinator
- Delegates cache operations to CacheService

Flow:
1. Resolve runtime settings (RuntimeSettingsApplicator)
2. Persist user message (UserMessagePersister)
3. Stream events from RuntimeEngine
4. Normalize events (EventNormalizer)
5. Track state using domain services (pure logic, NO I/O)
6. Build commands (NO emission at this layer)
7. Yield commands for presentation layer to execute
8. Flush remaining assistant text (AssistantTextFlusher)
9. Trigger auto-summarization (ChatSummarizationService)
"""

import asyncio
import logging
from typing import Any, Dict, List, Optional, Union
from uuid import UUID

# Protocols
from ws.protocols import MessageRole, MessageType

# Domain services (clean architecture)
from ws.domain import (
    ArtifactTracker,
    PhaseStateMachine,
    MessageAccumulator,
    EventNormalizer,
    EmitStreamEvent,
    EmitStreamEnd,
    EmitStreamCompletion,
    EmitStreamStop,
    EmitStreamError,
    EmitGroupCreated,
    EmitSubgroupCreated,
    EmitNodeStatusUpdated,
    EmitArtifactLinked,
    EmitSubgroupCompleted,
    EmitAgentMessageSequence,
)
from ws.domain.builders.event_enricher import enrich_event, generate_artifact_id
from ws.domain.builders.artifact_detector import (
    is_artifact_type,
    normalize_artifact_type,
    ARTIFACT_TYPES,
    LEGACY_OUTPUT_TYPES,
)
from ws.domain.builders.phase_detector import detect_phase, EXECUTION_PHASES

# Application services (extracted concerns)
from ws.application.user_message_persister import UserMessagePersister
from ws.application.assistant_text_flusher import AssistantTextFlusher
from ws.application.runtime_settings_applicator import RuntimeSettingsApplicator
from ws.application.chat_summarization_service import ChatSummarizationService


logger = logging.getLogger(__name__)

# Type alias for commands
Command = Union[
    EmitStreamEvent,
    EmitStreamEnd,
    EmitStreamCompletion,
    EmitStreamStop,
    EmitStreamError,
    EmitGroupCreated,
    EmitSubgroupCreated,
    EmitNodeStatusUpdated,
    EmitArtifactLinked,
    EmitSubgroupCompleted,
    EmitAgentMessageSequence,
]


class StreamOrchestrator:
    """
    Stream orchestrator using TRUE clean architecture.

    NO WebSocket in application layer.
    Yields commands for presentation to execute.
    Delegates concerns to focused services:
    - EventNormalizer: event filtering/normalization (domain)
    - UserMessagePersister: user message DB persistence (application)
    - AssistantTextFlusher: assistant text flush (application)
    - RuntimeSettingsApplicator: pre-stream settings (application)
    - ChatSummarizationService: background summarization (application)
    """

    def __init__(
        self,
        *,
        runtime: Any,
        trail_coordinator: Any,
        cache_service: Any,
        chat_repository: Optional[Any] = None,
        event_normalizer: Optional[EventNormalizer] = None,
        user_message_persister: Optional[UserMessagePersister] = None,
        assistant_text_flusher: Optional[AssistantTextFlusher] = None,
        settings_applicator: Optional[RuntimeSettingsApplicator] = None,
        summarization_service: Optional[ChatSummarizationService] = None,
    ):
        """
        Initialize stream orchestrator.

        Args:
            runtime: RuntimeEngine instance
            trail_coordinator: Trail hierarchy coordinator
            cache_service: Cache service for session state
            chat_repository: Optional chat repository for message persistence
            event_normalizer: Optional EventNormalizer (created if not provided)
            user_message_persister: Optional UserMessagePersister (created if not provided)
            assistant_text_flusher: Optional AssistantTextFlusher (created if not provided)
            settings_applicator: Optional RuntimeSettingsApplicator (created if not provided)
            summarization_service: Optional ChatSummarizationService (created if not provided)
        """
        self._runtime = runtime
        self._trail_coordinator = trail_coordinator
        self._cache_service = cache_service
        self._chat_repository = chat_repository
        self._logger = logger
        self._background_tasks: set[asyncio.Task] = set()

        # Injected services (with sensible defaults for backward compat)
        self._event_normalizer = event_normalizer or EventNormalizer()
        self._user_message_persister = user_message_persister or UserMessagePersister(
            chat_repository=chat_repository
        )
        self._assistant_text_flusher = assistant_text_flusher or AssistantTextFlusher(
            chat_repository=chat_repository
        )
        self._settings_applicator = settings_applicator or RuntimeSettingsApplicator()
        self._summarization_service = summarization_service or ChatSummarizationService(
            chat_repository=chat_repository
        )

    async def relay_stream(
        self,
        *,
        client_id: str,
        request_id: str,
        frontend_id: Optional[str],
        text: str,
        original_text: Optional[str] = None,
        image_b64: Optional[str] = None,
        correlation_id: Optional[str] = None,
        chat_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ):
        """
        Orchestrate streaming chat response.

        Yields commands incrementally for presentation layer to execute.

        Args:
            client_id: WebSocket client ID
            request_id: Backend-generated request ID
            frontend_id: Optional frontend-provided ID
            text: User message text
            original_text: Original user text for DB persistence
            image_b64: Optional base64-encoded image
            correlation_id: Optional correlation ID
            chat_id: Optional chat ID for conversation grouping
            metadata: Optional hidden user-message metadata to persist

        Yields:
            Commands for presentation layer to execute
        """
        # Initialize domain services
        artifact_tracker = ArtifactTracker()
        phase_machine = PhaseStateMachine()
        message_accumulator = MessageAccumulator(user_message=text)

        # Counters and state
        sequence_counter = 0
        artifact_counters: Dict[str, int] = {}
        artifact_content_parts: Dict[str, List[str]] = {}
        sent_start_per_type: Dict[str, bool] = {}
        last_artifact_type: Optional[str] = None
        subgroup_created_for_cycle = False
        sent_end = False
        agent_message_sequence_sent = False
        trail_hierarchy: Optional[Dict[str, Any]] = None
        generator_closed = False
        cancelled = False
        errored = False
        error_detail: Optional[str] = None

        # Track full assistant text for sequential message persistence
        full_assistant_text_parts: List[str] = []

        # Record initial state
        await self._record_session_state(
            request_id, client_id, frontend_id, correlation_id, chat_id, "active"
        )

        # -- Phase 1: Pre-stream setup --

        # Apply DB-backed runtime settings BEFORE streaming
        await self._settings_applicator.apply(
            runtime=self._runtime,
            chat_repository=self._chat_repository,
            chat_id=chat_id,
        )

        # Persist user message FIRST (before trail creation)
        user_msg_id = None
        if chat_id:
            persist_result = await self._user_message_persister.persist_user_message(
                chat_id=chat_id,
                text=text,
                original_text=original_text,
                correlation_id=correlation_id,
                metadata=metadata,
            )
            user_msg_id = persist_result.user_msg_id
            for cmd in persist_result.commands:
                yield cmd

        # -- Phase 2: Stream loop --

        # Determine if thinking tokens should be shown
        show_thinking = True
        try:
            settings_obj = getattr(self._runtime, "settings", None)
            if settings_obj is not None:
                llm_settings = getattr(settings_obj, "llm", None)
                if llm_settings is not None:
                    # Could be dict or object depending on settings resolution
                    if isinstance(llm_settings, dict):
                        show_thinking = llm_settings.get("show_thinking", True)
                    else:
                        show_thinking = getattr(llm_settings, "show_thinking", True)
        except Exception as e:
            self._logger.debug("Failed to resolve show_thinking from settings: %s", e)

        try:
            async for event in self._runtime.stream_chat(
                client_id=client_id,
                text=text,
                image_b64=image_b64,
                request_id=request_id,
                chat_id=chat_id,
                show_thinking=show_thinking,
            ):
                # Normalize event (filter + coerce + enforce contracts)
                normalized = self._event_normalizer.normalize(event)
                if normalized is None:
                    continue
                # Use normalized event from here
                event = normalized
                
                # CRITICAL: Always inject chat_id so frontend IPC routing passes validation
                if chat_id:
                    event["chat_id"] = chat_id

                # Handle stop/error signals from runtime
                event_role = event.get("role")
                event_type = event.get("type")
                if event_role == MessageRole.SERVER and event_type in {MessageType.STOPPED, MessageType.ERROR}:
                    sequence_counter += 1
                    if event_type == MessageType.STOPPED:
                        cancelled = True
                    else:
                        errored = True
                        error_detail = event.get("message") or event.get("content") or "runtime_error"
                    enriched = enrich_event(
                        event,
                        backend_id=request_id,
                        frontend_id=frontend_id,
                        correlation_id=correlation_id,
                        chat_id=chat_id,
                        sequence=sequence_counter,
                    )
                    yield EmitStreamEvent(event=enriched)
                    break

                # PHASE DETECTION & TRAIL CREATION
                new_phase = detect_phase(
                    role=event.get("role", ""),
                    event_type=event.get("type", ""),
                    event_format=event.get("format"),
                )

                current_phase_before = phase_machine.get_current_phase()
                phase_changed = phase_machine.update_phase(new_phase)

                # Complete current trail when transitioning back to text
                if (
                    phase_changed
                    and current_phase_before in EXECUTION_PHASES
                    and new_phase is None
                    and trail_hierarchy
                ):
                    completion_cmds = await self._complete_trail_hierarchy(trail_hierarchy)
                    for cmd in completion_cmds:
                        yield cmd
                    self._logger.info(
                        "Completed trail hierarchy after %s phase: subgroup=%s",
                        current_phase_before,
                        trail_hierarchy.get("subgroup_id"),
                    )
                    trail_hierarchy = None

                if new_phase:
                    if new_phase != "writing":
                        subgroup_created_for_cycle = False

                    # ── FORWARD PHASE TRANSITIONS ──────────────────────
                    # Node lifecycle is driven by phase changes, NOT
                    # artifact linking.  Without this, executing/output
                    # nodes stay at timer=0 because computer:code shares
                    # the same artifact ID as assistant:code (should_link
                    # is False), blocking status updates in the artifact
                    # handler.
                    if (
                        phase_changed
                        and trail_hierarchy
                        and current_phase_before is not None
                        and new_phase in ("executing", "output")
                    ):
                        fwd_cmds = await self._emit_forward_phase_transition(
                            trail_hierarchy=trail_hierarchy,
                            from_phase=current_phase_before,
                            to_phase=new_phase,
                            chat_id=chat_id,
                        )
                        for cmd in fwd_cmds:
                            yield cmd

                    # Handle trail hierarchy creation for code executions
                    if (
                        new_phase == "writing"
                        and chat_id
                        and self._trail_coordinator
                        and not subgroup_created_for_cycle
                        and (phase_changed or last_artifact_type == "output")
                    ):
                        if not trail_hierarchy:
                            # CASE 1: No active hierarchy
                            try:
                                if self._chat_repository:
                                    await self._chat_repository.ensure_chat_exists(
                                        chat_id=UUID(chat_id),
                                        title="New Chat",
                                    )

                                # Reserve sequence for agent message container
                                if not agent_message_sequence_sent:
                                    try:
                                        if self._trail_coordinator._trail_repo:
                                            reserved_seq = await self._trail_coordinator._trail_repo.get_next_chat_sequence(chat_id)
                                            yield EmitAgentMessageSequence(
                                                chat_id=chat_id,
                                                sequence_in_chat=reserved_seq,
                                                backend_id=request_id,
                                            )
                                            agent_message_sequence_sent = True
                                            self._logger.info("Timeline anchored: Reserved sequence %d for assistant message", reserved_seq)
                                    except (ConnectionError, TimeoutError, ValueError, KeyError, OSError) as e:
                                        self._logger.error("Failed to reserve assistant sequence: %s", e)

                                # Flush assistant text BEFORE first trail creation
                                flush_cmd = await self._assistant_text_flusher.flush_if_pending(
                                    chat_id=chat_id,
                                    parts=full_assistant_text_parts,
                                    user_msg_id=user_msg_id,
                                )
                                if flush_cmd:
                                    yield flush_cmd

                                # Check if group already exists for THIS user message
                                existing_group = None
                                if self._trail_coordinator._trail_repo and user_msg_id:
                                    existing_group = await self._trail_coordinator._trail_repo.get_group_by_user_message_id(user_msg_id)

                                if existing_group:
                                    # GROUP EXISTS - create additional subgroup
                                    next_subgroup_seq = await self._trail_coordinator._calculate_subgroup_sequence(chat_id)
                                    subgroup_data = await self._trail_coordinator.create_subgroup(
                                        chat_id=chat_id,
                                        group_id=str(existing_group["id"]),
                                        execution_group=f"exec_{request_id[:8]}_{next_subgroup_seq}",
                                        backend_id=request_id,
                                        frontend_id=frontend_id,
                                    )
                                    if subgroup_data:
                                        trail_hierarchy = subgroup_data
                                        subgroup_created_for_cycle = True
                                        await self._prepare_subgroup_artifacts(
                                            artifact_tracker=artifact_tracker,
                                            artifact_counters=artifact_counters,
                                            request_id=request_id,
                                            chat_id=chat_id,
                                            subgroup_id=subgroup_data["subgroup_id"],
                                            writing_node_id=subgroup_data["writing_node_id"],
                                            output_node_id=subgroup_data["output_node_id"],
                                        )
                                        yield EmitSubgroupCreated(
                                            chat_id=chat_id,
                                            subgroup_id=subgroup_data["subgroup_id"],
                                            group_id=subgroup_data["group_id"],
                                            execution_group=subgroup_data["execution_group"],
                                            writing_node_id=subgroup_data["writing_node_id"],
                                            executing_node_id=subgroup_data["executing_node_id"],
                                            output_node_id=subgroup_data["output_node_id"],
                                            backend_id=request_id,
                                            subgroup_sequence_number=subgroup_data["subgroup_sequence_number"],
                                            sequence_in_chat=subgroup_data["sequence_in_chat"],
                                            frontend_id=frontend_id,
                                            correlation_id=correlation_id,
                                        )
                                else:
                                    # NO GROUP - create first group + subgroup
                                    next_subgroup_seq = await self._trail_coordinator._calculate_subgroup_sequence(chat_id)
                                    hierarchy = await self._trail_coordinator.create_hierarchy(
                                        chat_id=chat_id,
                                        user_message=message_accumulator.get_user_message()[:500],
                                        agent_message=message_accumulator.get_agent_message()[:500],
                                        execution_group=f"exec_{request_id[:8]}_{next_subgroup_seq}",
                                        backend_id=request_id,
                                        frontend_id=frontend_id,
                                        correlation_id=correlation_id,
                                        user_message_id=user_msg_id,
                                    )
                                    if hierarchy:
                                        trail_hierarchy = {
                                            "chat_id": chat_id,
                                            "group_id": hierarchy["group_id"],
                                            "subgroup_id": hierarchy["subgroup_id"],
                                            "writing_node_id": hierarchy["writing_node_id"],
                                            "executing_node_id": hierarchy["executing_node_id"],
                                            "output_node_id": hierarchy["output_node_id"],
                                        }
                                        yield EmitGroupCreated(
                                            chat_id=chat_id,
                                            group_id=hierarchy["group_id"],
                                            sequence_number=hierarchy["sequence_number"],
                                            backend_id=request_id,
                                            frontend_id=frontend_id,
                                            correlation_id=correlation_id,
                                        )
                                        yield EmitSubgroupCreated(
                                            chat_id=chat_id,
                                            subgroup_id=hierarchy["subgroup_id"],
                                            group_id=hierarchy["group_id"],
                                            execution_group=hierarchy["execution_group"],
                                            writing_node_id=hierarchy["writing_node_id"],
                                            executing_node_id=hierarchy["executing_node_id"],
                                            output_node_id=hierarchy["output_node_id"],
                                            backend_id=request_id,
                                            subgroup_sequence_number=hierarchy["subgroup_sequence_number"],
                                            sequence_in_chat=hierarchy["sequence_in_chat"],
                                            frontend_id=frontend_id,
                                            correlation_id=correlation_id,
                                        )
                                        subgroup_created_for_cycle = True
                                        await self._prepare_subgroup_artifacts(
                                            artifact_tracker=artifact_tracker,
                                            artifact_counters=artifact_counters,
                                            request_id=request_id,
                                            chat_id=chat_id,
                                            subgroup_id=hierarchy["subgroup_id"],
                                            writing_node_id=hierarchy["writing_node_id"],
                                            output_node_id=hierarchy["output_node_id"],
                                        )
                            except (ConnectionError, TimeoutError, ValueError, KeyError, OSError) as e:
                                self._logger.error("Failed to create trail hierarchy: %s", e, exc_info=True)
                        else:
                            # CASE 2: New code cycle while old hierarchy is still active
                            try:
                                if phase_changed:
                                    phase_machine.reset()

                                    # Complete previous subgroup (all nodes + subgroup)
                                    completion_cmds = await self._complete_trail_hierarchy(trail_hierarchy)
                                    for cmd in completion_cmds:
                                        yield cmd

                                    # Flush pending assistant text before new subgroup
                                    flush_cmd = await self._assistant_text_flusher.flush_if_pending(
                                        chat_id=chat_id,
                                        parts=full_assistant_text_parts,
                                        user_msg_id=user_msg_id,
                                    )
                                    if flush_cmd:
                                        yield flush_cmd

                                    # Create additional subgroup in existing group
                                    next_subgroup_seq = await self._trail_coordinator._calculate_subgroup_sequence(chat_id)
                                    subgroup_data = await self._trail_coordinator.create_subgroup(
                                        chat_id=chat_id,
                                        group_id=trail_hierarchy["group_id"],
                                        execution_group=f"exec_{request_id[:8]}_{next_subgroup_seq}",
                                        backend_id=request_id,
                                        frontend_id=frontend_id,
                                    )
                                    if subgroup_data:
                                        trail_hierarchy = subgroup_data
                                        subgroup_created_for_cycle = True
                                        await self._prepare_subgroup_artifacts(
                                            artifact_tracker=artifact_tracker,
                                            artifact_counters=artifact_counters,
                                            request_id=request_id,
                                            chat_id=chat_id,
                                            subgroup_id=subgroup_data["subgroup_id"],
                                            writing_node_id=subgroup_data["writing_node_id"],
                                            output_node_id=subgroup_data["output_node_id"],
                                        )

                                        yield EmitSubgroupCreated(
                                            chat_id=chat_id,
                                            subgroup_id=subgroup_data["subgroup_id"],
                                            group_id=subgroup_data["group_id"],
                                            execution_group=subgroup_data["execution_group"],
                                            writing_node_id=subgroup_data["writing_node_id"],
                                            executing_node_id=subgroup_data["executing_node_id"],
                                            output_node_id=subgroup_data["output_node_id"],
                                            backend_id=request_id,
                                            subgroup_sequence_number=subgroup_data["subgroup_sequence_number"],
                                            sequence_in_chat=subgroup_data["sequence_in_chat"],
                                            frontend_id=frontend_id,
                                            correlation_id=correlation_id,
                                        )
                            except (ConnectionError, TimeoutError, ValueError, KeyError, OSError) as e:
                                self._logger.error("Failed to create additional trail subgroup: %s", e, exc_info=True)

                # Handle start markers
                if event.get("start"):
                    cmds = self._handle_start_marker(
                        event=event,
                        sent_start_per_type=sent_start_per_type,
                        artifact_tracker=artifact_tracker,
                        artifact_counters=artifact_counters,
                        sequence=sequence_counter,
                        request_id=request_id,
                        frontend_id=frontend_id,
                        correlation_id=correlation_id,
                        chat_id=chat_id,
                        user_msg_id=user_msg_id,
                    )
                    for cmd in cmds:
                        yield cmd
                    continue

                # Handle content deltas
                if self._is_content_delta(event):
                    sequence_counter += 1
                    content = event.get("content", "")
                    if content:
                        full_assistant_text_parts.append(content)

                    cmds = await self._handle_content_delta(
                        event=event,
                        sequence=sequence_counter,
                        request_id=request_id,
                        frontend_id=frontend_id,
                        correlation_id=correlation_id,
                        chat_id=chat_id,
                        message_accumulator=message_accumulator,
                        user_msg_id=user_msg_id,
                    )
                    for cmd in cmds:
                        yield cmd
                        if isinstance(cmd, EmitSubgroupCreated) and not trail_hierarchy:
                            trail_hierarchy = {
                                "chat_id": chat_id,
                                "group_id": cmd.group_id,
                                "subgroup_id": cmd.subgroup_id,
                                "writing_node_id": cmd.writing_node_id,
                                "executing_node_id": cmd.executing_node_id,
                                "output_node_id": cmd.output_node_id,
                            }
                    continue

                # Handle artifact events
                event_type = event.get("type", "").lower()
                is_artifact_event = event_type in ARTIFACT_TYPES or event_type in LEGACY_OUTPUT_TYPES

                if is_artifact_event and event_type != "message":
                    sequence_counter += 1
                    cmds, trail_hierarchy, last_artifact_type, subgroup_created_in_artifact = await self._process_artifact_event(
                        event=event,
                        sequence=sequence_counter,
                        request_id=request_id,
                        frontend_id=frontend_id,
                        correlation_id=correlation_id,
                        chat_id=chat_id,
                        artifact_tracker=artifact_tracker,
                        artifact_counters=artifact_counters,
                        artifact_content_parts=artifact_content_parts,
                        trail_hierarchy=trail_hierarchy,
                        user_msg_id=user_msg_id,
                        last_artifact_type=last_artifact_type,
                        full_assistant_text_parts=full_assistant_text_parts,
                        subgroup_created_for_code_event=subgroup_created_for_cycle,
                    )
                    if subgroup_created_in_artifact:
                        subgroup_created_for_cycle = True
                    for cmd in cmds:
                        yield cmd
                    continue

                # Handle end markers
                if event.get("end"):
                    sent_end = True
                    sequence_counter += 1

                    artifact_id_for_end = None
                    event_type = event.get("type")
                    if event_type and is_artifact_type(event_type):
                        artifact_type, _ = normalize_artifact_type(event_type, event.get("format"))
                        artifact_id_for_end = artifact_tracker.get_artifact_id(artifact_type)

                    end_marker = enrich_event(
                        event,
                        backend_id=request_id,
                        frontend_id=frontend_id,
                        correlation_id=correlation_id,
                        chat_id=chat_id,
                        sequence=sequence_counter,
                        artifact_id=artifact_id_for_end,
                        execution_group=request_id,
                        message_id=str(user_msg_id) if user_msg_id else None,
                    )
                    yield EmitStreamEnd(end_message=end_marker)
                    continue

                # Handle all other events
                sequence_counter += 1
                enriched = enrich_event(
                    event,
                    backend_id=request_id,
                    frontend_id=frontend_id,
                    correlation_id=correlation_id,
                    chat_id=chat_id,
                    sequence=sequence_counter,
                )
                yield EmitStreamEvent(event=enriched)

        except asyncio.CancelledError:
            self._logger.info("Stream cancelled: %s", request_id)
            cancelled = True
            yield EmitStreamStop(
                request_id=request_id,
                correlation_id=correlation_id,
                chat_id=chat_id,
            )
            raise

        except GeneratorExit:
            self._logger.debug("Generator exit (client disconnect): %s", request_id)
            generator_closed = True
            raise

        except Exception as e:  # noqa: BLE001 -- outermost stream handler: must emit error command to client instead of crashing WS connection
            # Broad catch is intentional: outermost handler in relay_stream().
            # MUST catch all exceptions to emit EmitStreamError to the client
            # rather than crashing the WebSocket connection.
            self._logger.warning("Stream error: %s: %s", request_id, e)
            errored = True
            error_detail = str(e)
            yield EmitStreamError(
                request_id=request_id,
                correlation_id=correlation_id,
                chat_id=chat_id,
            )

        finally:
            # -- Phase 3: Finalization --

            # Flush remaining assistant text
            if chat_id and user_msg_id:
                try:
                    flush_cmd = await self._assistant_text_flusher.flush_if_pending(
                        chat_id=chat_id,
                        parts=full_assistant_text_parts,
                        user_msg_id=user_msg_id,
                    )
                    if flush_cmd:
                        self._logger.info(
                            "Assistant message persisted: chat=%s", chat_id[:8]
                        )
                except (ConnectionError, TimeoutError, ValueError, KeyError, OSError) as e:
                    self._logger.error("Failed to persist assistant message: %s", e, exc_info=True)

            should_emit = not generator_closed

            # Send end marker if not already sent
            if not sent_end and should_emit and not cancelled and not errored:
                sequence_counter += 1
                end_marker = enrich_event(
                    {"role": MessageRole.ASSISTANT, "type": MessageType.MESSAGE, "end": True},
                    backend_id=request_id,
                    frontend_id=frontend_id,
                    correlation_id=correlation_id,
                    chat_id=chat_id,
                    sequence=sequence_counter,
                )
                yield EmitStreamEnd(end_message=end_marker)

            # Complete the last trail hierarchy
            if trail_hierarchy:
                try:
                    completion_cmds = await self._complete_trail_hierarchy(trail_hierarchy)
                    if should_emit:
                        for cmd in completion_cmds:
                            yield cmd
                    self._logger.info("Completed final trail hierarchy: subgroup=%s", trail_hierarchy.get("subgroup_id"))
                except (ConnectionError, TimeoutError, ValueError, KeyError, OSError) as completion_error:
                    self._logger.error("Failed to complete final trail hierarchy: %s", completion_error)

                # AUTO-SUMMARIZATION: Trigger after each completed turn
                if chat_id and not cancelled and not errored:
                    self._track_background_task(
                        asyncio.create_task(
                            self._summarization_service.check_and_summarize(chat_id)
                        )
                    )

            # Send completion
            if should_emit and not cancelled and not errored:
                sequence_counter += 1
                completion_msg = enrich_event(
                    {"role": MessageRole.SERVER, "type": MessageType.COMPLETION},
                    backend_id=request_id,
                    frontend_id=frontend_id,
                    correlation_id=correlation_id,
                    chat_id=chat_id,
                    sequence=sequence_counter,
                )
                yield EmitStreamCompletion(completion_message=completion_msg)

            # Record final state
            if generator_closed:
                final_state = "disconnected"
            elif cancelled:
                final_state = "cancelled"
            elif errored:
                final_state = "error"
            else:
                final_state = "completed"
            await self._record_session_state(
                request_id,
                client_id,
                frontend_id,
                correlation_id,
                chat_id,
                final_state,
                error_detail if errored else None,
            )

            self._logger.info("Stream orchestration complete: %s", request_id)

    def _handle_start_marker(
        self,
        *,
        event: Dict[str, Any],
        sent_start_per_type: Dict[str, bool],
        artifact_tracker: ArtifactTracker,
        artifact_counters: Dict[str, int],
        sequence: int,
        request_id: str,
        frontend_id: Optional[str],
        correlation_id: Optional[str],
        chat_id: Optional[str],
        user_msg_id: Optional[str] = None,
    ) -> List[Command]:
        """Handle start marker event."""
        cmds: List[Command] = []

        event_type = event.get("type")
        if event_type and not sent_start_per_type.get(event_type):
            sent_start_per_type[event_type] = True

            artifact_id_for_start = None
            if is_artifact_type(event_type):
                artifact_type, _ = normalize_artifact_type(event_type, event.get("format"))
                
                # Check if already pre-generated by _prepare_subgroup_artifacts
                artifact_id = artifact_tracker.get_artifact_id(artifact_type)
                
                if not artifact_id:
                    artifact_counters[artifact_type] = artifact_counters.get(artifact_type, 0) + 1
                    artifact_index = artifact_counters[artifact_type]
    
                    artifact_id = generate_artifact_id(
                        backend_id=request_id,
                        event_type=artifact_type,
                        artifact_counter=artifact_index,
                    )
    
                    artifact_tracker.store_artifact_id(
                        event_type=artifact_type,
                        artifact_id=artifact_id,
                    )
                
                artifact_id_for_start = artifact_id

            enriched_start = enrich_event(
                event,
                backend_id=request_id,
                frontend_id=frontend_id,
                correlation_id=correlation_id,
                chat_id=chat_id,
                sequence=sequence,
                artifact_id=artifact_id_for_start,
                execution_group=request_id,
                message_id=str(user_msg_id) if user_msg_id else None,
            )
            cmds.append(EmitStreamEvent(event=enriched_start))

        return cmds

    async def _handle_content_delta(
        self,
        *,
        event: Dict[str, Any],
        sequence: int,
        request_id: str,
        frontend_id: Optional[str],
        correlation_id: Optional[str],
        chat_id: Optional[str],
        message_accumulator: MessageAccumulator,
        user_msg_id: Optional[str] = None,
    ) -> List[Command]:
        """Handle content delta event."""
        cmds: List[Command] = []

        content = event.get("content", "")
        message_accumulator.add_agent_content(content)

        enriched = enrich_event(
            event,
            backend_id=request_id,
            frontend_id=frontend_id,
            correlation_id=correlation_id,
            chat_id=chat_id,
            sequence=sequence,
            message_id=str(user_msg_id) if user_msg_id else None,
        )
        cmds.append(EmitStreamEvent(event=enriched))

        return cmds

    async def _process_artifact_event(
        self,
        *,
        event: Dict[str, Any],
        sequence: int,
        request_id: str,
        frontend_id: Optional[str],
        correlation_id: Optional[str],
        chat_id: Optional[str],
        artifact_tracker: ArtifactTracker,
        artifact_counters: Dict[str, int],
        artifact_content_parts: Dict[str, List[str]],
        trail_hierarchy: Optional[Dict[str, Any]],
        user_msg_id: Optional[str] = None,
        last_artifact_type: Optional[str] = None,
        full_assistant_text_parts: Optional[List[str]] = None,
        subgroup_created_for_code_event: bool = False,
    ) -> tuple[List[Command], Optional[Dict[str, Any]], str, bool]:
        """Process artifact-related event."""
        cmds: List[Command] = []
        subgroup_created = False

        artifact_type, artifact_format = normalize_artifact_type(
            event_type=event.get("type", "code"),
            event_format=event.get("format"),
            event_role=event.get("role"),
        )

        # Track new artifact if needed
        if not artifact_tracker.has_artifact_type(artifact_type):
            artifact_counters[artifact_type] = artifact_counters.get(artifact_type, 0) + 1
            artifact_index = artifact_counters[artifact_type]

            artifact_id = generate_artifact_id(
                backend_id=request_id,
                event_type=artifact_type,
                artifact_counter=artifact_index,
            )

            artifact_tracker.store_artifact_id(
                event_type=artifact_type,
                artifact_id=artifact_id,
            )

        # Multi-execution subgroup creation
        role = event.get("role")
        if (
            role == "assistant"
            and artifact_type == "code"
            and trail_hierarchy
            and last_artifact_type == "output"
            and not subgroup_created_for_code_event
            and self._trail_coordinator
        ):
            try:
                # Complete previous subgroup (all nodes + subgroup)
                completion_cmds = await self._complete_trail_hierarchy(trail_hierarchy)
                cmds.extend(completion_cmds)

                # Flush assistant text before new subgroup
                if full_assistant_text_parts and self._chat_repository:
                    flush_cmd = await self._assistant_text_flusher.flush_if_pending(
                        chat_id=chat_id,
                        parts=full_assistant_text_parts,
                        user_msg_id=user_msg_id,
                    )
                    if flush_cmd:
                        cmds.append(flush_cmd)

                # Create additional subgroup in existing group
                next_subgroup_seq = await self._trail_coordinator._calculate_subgroup_sequence(chat_id)
                subgroup_data = await self._trail_coordinator.create_subgroup(
                    chat_id=chat_id,
                    group_id=trail_hierarchy["group_id"],
                    execution_group=f"exec_{request_id[:8]}_{next_subgroup_seq}",
                    backend_id=request_id,
                    frontend_id=frontend_id,
                )
                if subgroup_data:
                    trail_hierarchy = subgroup_data
                    subgroup_created = True
                    await self._prepare_subgroup_artifacts(
                        artifact_tracker=artifact_tracker,
                        artifact_counters=artifact_counters,
                        request_id=request_id,
                        chat_id=chat_id,
                        subgroup_id=subgroup_data["subgroup_id"],
                        writing_node_id=subgroup_data["writing_node_id"],
                        output_node_id=subgroup_data["output_node_id"],
                    )

                    cmds.append(
                        EmitSubgroupCreated(
                            chat_id=chat_id,
                            subgroup_id=subgroup_data["subgroup_id"],
                            group_id=subgroup_data["group_id"],
                            execution_group=subgroup_data["execution_group"],
                            writing_node_id=subgroup_data["writing_node_id"],
                            executing_node_id=subgroup_data["executing_node_id"],
                            output_node_id=subgroup_data["output_node_id"],
                            backend_id=request_id,
                            subgroup_sequence_number=subgroup_data["subgroup_sequence_number"],
                            sequence_in_chat=subgroup_data["sequence_in_chat"],
                            frontend_id=frontend_id,
                        )
                    )
            except (ConnectionError, TimeoutError, ValueError, KeyError, OSError) as e:
                self._logger.error("Failed fallback subgroup creation: %s", e, exc_info=True)

        # Handle output artifacts - gap detection for new output IDs
        if role == "computer" and artifact_type == "output" and trail_hierarchy:
            existing_output_artifact = artifact_tracker.get_artifact_id("output")

            is_new_output_block = (
                existing_output_artifact
                and artifact_tracker.is_already_linked(existing_output_artifact)
                and last_artifact_type != "output"
            )

            if is_new_output_block:
                artifact_counters[artifact_type] = artifact_counters.get(artifact_type, 0) + 1
                artifact_index = artifact_counters[artifact_type]

                new_output_artifact_id = generate_artifact_id(
                    backend_id=request_id,
                    event_type=artifact_type,
                    artifact_counter=artifact_index,
                )

                artifact_tracker.store_artifact_id(
                    event_type=artifact_type,
                    artifact_id=new_output_artifact_id,
                )

        # Retrieve artifact_id AFTER gap detection
        artifact_id = artifact_tracker.get_artifact_id(
            event_type=artifact_type,
            raw_type=event.get("type"),
        )
        if not artifact_id:
            artifact_counters[artifact_type] = artifact_counters.get(artifact_type, 0) + 1
            artifact_id = generate_artifact_id(
                backend_id=request_id,
                event_type=artifact_type,
                artifact_counter=artifact_counters[artifact_type],
            )
            artifact_tracker.store_artifact_id(
                event_type=artifact_type,
                artifact_id=artifact_id,
            )

        # Accumulate artifact content for persistence
        if artifact_id:
            artifact_content_parts.setdefault(artifact_id, [])
            content_chunk = event.get("content")
            if content_chunk is not None:
                artifact_content_parts[artifact_id].append(content_chunk)

        # Trail linking
        target_node_id = None

        # Emergency hierarchy creation
        if not trail_hierarchy and chat_id and artifact_id and self._trail_coordinator:
            try:
                self._logger.warning("Emergency trail creation: artifact %s received without active hierarchy", artifact_id)
                next_subgroup_seq = await self._trail_coordinator._calculate_subgroup_sequence(chat_id)
                hierarchy = await self._trail_coordinator.create_hierarchy(
                    chat_id=chat_id,
                    user_message="[Emergency Context]",
                    agent_message="[Emergency Context]",
                    execution_group=f"exec_emergency_{request_id[:8]}_{next_subgroup_seq}",
                    backend_id=request_id,
                    frontend_id=frontend_id,
                    correlation_id=correlation_id,
                    user_message_id=user_msg_id,
                )
                if hierarchy:
                    trail_hierarchy = {
                        "chat_id": chat_id,
                        "group_id": hierarchy["group_id"],
                        "subgroup_id": hierarchy["subgroup_id"],
                        "writing_node_id": hierarchy["writing_node_id"],
                        "executing_node_id": hierarchy["executing_node_id"],
                        "output_node_id": hierarchy["output_node_id"],
                        "execution_group": hierarchy["execution_group"],
                    }
                    cmds.append(EmitGroupCreated(
                        chat_id=chat_id,
                        group_id=hierarchy["group_id"],
                        sequence_number=hierarchy["sequence_number"],
                        backend_id=request_id,
                        frontend_id=frontend_id,
                        correlation_id=correlation_id,
                    ))
                    cmds.append(EmitSubgroupCreated(
                        chat_id=chat_id,
                        subgroup_id=hierarchy["subgroup_id"],
                        group_id=hierarchy["group_id"],
                        execution_group=hierarchy["execution_group"],
                        writing_node_id=hierarchy["writing_node_id"],
                        executing_node_id=hierarchy["executing_node_id"],
                        output_node_id=hierarchy["output_node_id"],
                        backend_id=request_id,
                        subgroup_sequence_number=hierarchy["subgroup_sequence_number"],
                        sequence_in_chat=hierarchy["sequence_in_chat"],
                        frontend_id=frontend_id,
                        correlation_id=correlation_id,
                    ))
                    self._logger.info("Emergency trail hierarchy established for artifact %s", artifact_id)
            except (ConnectionError, TimeoutError, ValueError, KeyError, OSError) as e:
                self._logger.error("Failed to create emergency trail hierarchy: %s", e, exc_info=True)

        if trail_hierarchy and chat_id and artifact_id:
            role = event.get("role")
            should_link = not artifact_tracker.is_already_linked(artifact_id)

            # Map artifact to node and update status
            if role == "assistant" and artifact_type == "code":
                target_node_id = trail_hierarchy["writing_node_id"]
                if should_link:
                    if self._trail_coordinator:
                        try:
                            await self._trail_coordinator.update_node_status(
                                node_id=target_node_id,
                                status="active",
                            )
                        except (ConnectionError, TimeoutError, ValueError, OSError) as status_error:
                            self._logger.warning("Failed to update writing node status: %s", status_error)
                    cmds.append(
                        EmitNodeStatusUpdated(
                            chat_id=chat_id,
                            group_id=trail_hierarchy["group_id"],
                            node_id=target_node_id,
                            status="active",
                            subgroup_id=trail_hierarchy["subgroup_id"],
                        )
                    )
            elif role == "computer" and artifact_type == "code":
                # Node status updates handled by _emit_forward_phase_transition
                # (writing→completed, executing→active) in the main stream loop.
                # Only set target_node_id for artifact linking.
                target_node_id = trail_hierarchy["executing_node_id"]
            elif role == "computer" and artifact_type == "output":
                # Node status updates handled by _emit_forward_phase_transition
                # (executing→completed, output→active) in the main stream loop.
                # Only set target_node_id for artifact linking.
                target_node_id = trail_hierarchy["output_node_id"]
            else:
                target_node_id = trail_hierarchy["writing_node_id"]

            if self._chat_repository and target_node_id:
                artifact_content = "".join(artifact_content_parts.get(artifact_id, []))
                if not artifact_content:
                    artifact_content = event.get("content")
                
                # Check truthiness of stripped string to prevent empty persistence
                if isinstance(artifact_content, str):
                    artifact_content = artifact_content.strip()
                    if not artifact_content:
                        artifact_content = None

                if artifact_content is not None and event.get("end"):
                    try:
                        metadata = {"format": artifact_format} if artifact_format else {}
                        message_uuid = UUID(user_msg_id) if isinstance(user_msg_id, str) else user_msg_id
                        await self._chat_repository.create_artifact(
                            chat_id=UUID(chat_id),
                            type=artifact_type,
                            content=artifact_content,
                            language=artifact_format if artifact_type == "code" else None,
                            artifact_id=artifact_id,
                            message_id=message_uuid if user_msg_id else None,
                            metadata=metadata,
                            subgroup_id=UUID(trail_hierarchy["subgroup_id"]),
                            node_id=UUID(target_node_id),
                        )
                    except (ConnectionError, TimeoutError, ValueError, KeyError, OSError) as art_error:
                        self._logger.warning("Failed to persist artifact to DB: %s", art_error)

            # Emit completion for the node if artifact is done
            if event.get("end") and target_node_id:
                if self._trail_coordinator:
                    try:
                        await self._trail_coordinator.update_node_status(
                            node_id=target_node_id, status="completed"
                        )
                    except (ConnectionError, TimeoutError, ValueError, OSError) as status_error:
                        self._logger.warning("Failed to update node to completed: %s", status_error)
                
                cmds.append(
                    EmitNodeStatusUpdated(
                        chat_id=chat_id,
                        group_id=trail_hierarchy["group_id"],
                        node_id=target_node_id,
                        status="completed",
                        subgroup_id=trail_hierarchy["subgroup_id"],
                    )
                )

                # If this is the output node, the cycle is complete!
                if target_node_id == trail_hierarchy.get("output_node_id"):
                    try:
                        if self._trail_coordinator:
                            await self._trail_coordinator.complete_hierarchy(
                                subgroup_id=trail_hierarchy["subgroup_id"],
                                output_node_id=target_node_id,
                            )
                    except (ConnectionError, TimeoutError, ValueError, KeyError, OSError) as h_error:
                        self._logger.warning("Failed to complete hierarchy: %s", h_error)
                        
                    cmds.append(
                        EmitSubgroupCompleted(
                            chat_id=chat_id,
                            group_id=trail_hierarchy["group_id"],
                            subgroup_id=trail_hierarchy["subgroup_id"],
                        )
                    )

            if should_link:
                cmds.append(
                    EmitArtifactLinked(
                        chat_id=chat_id,
                        group_id=trail_hierarchy["group_id"],
                        artifact_id=artifact_id,
                        subgroup_id=trail_hierarchy["subgroup_id"],
                        node_id=target_node_id,
                        artifact_type=artifact_type,
                        backend_id=request_id,
                    )
                )
                artifact_tracker.mark_as_linked(artifact_id)

        # Retrieve artifact_id for event enrichment
        artifact_id_for_event = artifact_id or artifact_tracker.get_artifact_id(
            event_type=artifact_type,
            raw_type=event.get("type"),
        )
        if not artifact_id_for_event:
            artifact_counters[artifact_type] = artifact_counters.get(artifact_type, 0) + 1
            artifact_id_for_event = generate_artifact_id(
                backend_id=request_id,
                event_type=artifact_type,
                artifact_counter=artifact_counters[artifact_type],
            )
            artifact_tracker.store_artifact_id(
                event_type=artifact_type,
                artifact_id=artifact_id_for_event,
            )

        # Set normalized format/type back into event
        if artifact_format and not event.get("format"):
            event["format"] = artifact_format
        if artifact_type != event.get("type"):
            event["type"] = artifact_type

        current_execution_group = trail_hierarchy.get("execution_group", request_id) if trail_hierarchy else request_id

        self._logger.info(
            "Emitting %s artifact: id=%s, format=%s, content_len=%d",
            artifact_type,
            artifact_id_for_event,
            artifact_format,
            len(str(event.get("content", ""))),
        )

        enriched = enrich_event(
            event,
            backend_id=request_id,
            frontend_id=frontend_id,
            correlation_id=correlation_id,
            chat_id=chat_id,
            sequence=sequence,
            artifact_id=artifact_id_for_event,
            execution_group=current_execution_group,
            message_id=str(user_msg_id) if user_msg_id else None,
        )

        cmds.append(EmitStreamEvent(event=enriched))

        return cmds, trail_hierarchy, artifact_type, subgroup_created

    async def _complete_trail_hierarchy(
        self,
        trail_hierarchy: Dict[str, Any],
    ) -> List[Command]:
        """Complete trail hierarchy and return commands.

        Catch-all: ensures ALL three nodes (writing, executing, output) reach
        "completed" in DB and on the frontend.  Individual node completions
        may have already fired via _emit_forward_phase_transition — duplicate
        "completed" updates are harmless (frontend re-adds the same CSS class,
        DB overwrites with the same value).

        Returns completion commands ONLY if the database update succeeds.
        On DB failure, returns empty list to maintain frontend/DB consistency.
        """
        commands: List[Command] = []

        chat_id = trail_hierarchy["chat_id"]
        group_id = trail_hierarchy["group_id"]
        subgroup_id = trail_hierarchy["subgroup_id"]
        writing_id = trail_hierarchy["writing_node_id"]
        executing_id = trail_hierarchy["executing_node_id"]
        output_id = trail_hierarchy["output_node_id"]

        # 1. Ensure writing + executing nodes are completed in DB
        #    (idempotent — no-op if already completed by forward transitions)
        for node_id in (writing_id, executing_id):
            try:
                if self._trail_coordinator:
                    await self._trail_coordinator.update_node_status(
                        node_id=node_id, status="completed",
                    )
            except (ConnectionError, TimeoutError, ValueError, OSError) as e:
                self._logger.warning(
                    "Catch-all node completion failed (%s): %s", node_id[:8], e,
                )

        # 2. Complete output node + subgroup via coordinator
        try:
            await self._trail_coordinator.complete_hierarchy(
                subgroup_id=subgroup_id,
                output_node_id=output_id,
            )
        except (ConnectionError, TimeoutError, ValueError, KeyError, OSError) as e:
            self._logger.warning("Database update for hierarchy completion failed: %s", e)
            return commands

        # 3. Emit completion commands for all three nodes
        for node_id in (writing_id, executing_id, output_id):
            commands.append(
                EmitNodeStatusUpdated(
                    chat_id=chat_id,
                    group_id=group_id,
                    node_id=node_id,
                    status="completed",
                    subgroup_id=subgroup_id,
                )
            )
        commands.append(
            EmitSubgroupCompleted(
                chat_id=chat_id,
                group_id=group_id,
                subgroup_id=subgroup_id,
            )
        )

        return commands

    async def _emit_forward_phase_transition(
        self,
        *,
        trail_hierarchy: Dict[str, Any],
        from_phase: Optional[str],
        to_phase: str,
        chat_id: Optional[str],
    ) -> List[Command]:
        """Emit node-status commands for forward phase transitions.

        Trail node lifecycle is driven by phase changes (from detect_phase),
        NOT by artifact linking.  This fixes the bug where executing/output
        nodes stay at timer=0 because computer:code shares the same artifact
        ID as assistant:code, causing should_link=False and blocking all
        node status updates in the artifact handler.

        Called from the main stream loop when phase_changed is True.
        Handles:
            writing  → executing : complete writing, activate executing
            writing  → output    : complete writing+executing, activate output
            executing → output   : complete executing, activate output
        """
        cmds: List[Command] = []
        group_id = trail_hierarchy["group_id"]
        subgroup_id = trail_hierarchy["subgroup_id"]
        writing_id = trail_hierarchy["writing_node_id"]
        executing_id = trail_hierarchy["executing_node_id"]
        output_id = trail_hierarchy["output_node_id"]

        async def _update_db(node_id: str, status: str) -> None:
            if self._trail_coordinator:
                try:
                    await self._trail_coordinator.update_node_status(
                        node_id=node_id, status=status,
                    )
                except (ConnectionError, TimeoutError, ValueError, OSError) as e:
                    self._logger.warning(
                        "Phase transition DB update failed (%s→%s): %s",
                        node_id[:8], status, e,
                    )

        def _status_cmd(node_id: str, status: str) -> EmitNodeStatusUpdated:
            return EmitNodeStatusUpdated(
                chat_id=chat_id,
                group_id=group_id,
                node_id=node_id,
                status=status,
                subgroup_id=subgroup_id,
            )

        if to_phase == "executing" and from_phase in (None, "writing"):
            # writing → executing (code echo or first console output)
            await _update_db(writing_id, "completed")
            cmds.append(_status_cmd(writing_id, "completed"))
            await _update_db(executing_id, "active")
            cmds.append(_status_cmd(executing_id, "active"))
            self._logger.info(
                "Phase transition: %s→executing (writing completed, executing active)",
                from_phase or "none",
            )

        elif to_phase == "output" and from_phase == "executing":
            # executing → output (first non-console output)
            await _update_db(executing_id, "completed")
            cmds.append(_status_cmd(executing_id, "completed"))
            await _update_db(output_id, "active")
            cmds.append(_status_cmd(output_id, "active"))
            self._logger.info("Phase transition: executing→output")

        elif to_phase == "output" and from_phase in (None, "writing"):
            # writing → output (skipping executing, e.g. direct HTML result)
            await _update_db(writing_id, "completed")
            cmds.append(_status_cmd(writing_id, "completed"))
            await _update_db(executing_id, "completed")
            cmds.append(_status_cmd(executing_id, "completed"))
            await _update_db(output_id, "active")
            cmds.append(_status_cmd(output_id, "active"))
            self._logger.info(
                "Phase transition: %s→output (skipped executing)",
                from_phase or "none",
            )

        return cmds

    async def _record_session_state(
        self,
        request_id: str,
        client_id: str,
        frontend_id: Optional[str],
        correlation_id: Optional[str],
        chat_id: Optional[str],
        state: str,
        error: Optional[str] = None,
    ) -> None:
        """Record session state to cache.

        Must never raise — called from the finally block of relay_stream().
        An exception here would mask the original stream error and crash finalization.
        """
        try:
            payload = {
                "client_id": client_id,
                "frontend_id": frontend_id,
                "correlation_id": correlation_id,
                "chat_id": chat_id,
                "state": state,
            }
            if error:
                payload["error"] = error

            await self._cache_service.record_session_state(request_id, payload)
        except Exception as e:
            self._logger.warning("Failed to record session state %s for %s: %s", state, request_id, e)

    async def _prepare_subgroup_artifacts(
        self,
        *,
        artifact_tracker: ArtifactTracker,
        artifact_counters: Dict[str, int],
        request_id: str,
        chat_id: Optional[str] = None,
        subgroup_id: Optional[str] = None,
        writing_node_id: Optional[str] = None,
        output_node_id: Optional[str] = None,
    ) -> None:
        """
        Reset tracker and pre-generate exactly 2 artifact IDs for new subgroup.
        Ensures consistency and avoids duplicate key violations.
        """
        artifact_tracker.reset()

        artifact_types = {
            "code": writing_node_id,
            "output": output_node_id,
        }

        for art_type, node_id in artifact_types.items():
            artifact_counters[art_type] = artifact_counters.get(art_type, 0) + 1
            art_id = generate_artifact_id(
                backend_id=request_id,
                event_type=art_type,
                artifact_counter=artifact_counters[art_type],
            )
            artifact_tracker.store_artifact_id(
                event_type=art_type,
                artifact_id=art_id,
            )

            if self._chat_repository and chat_id and subgroup_id and node_id:
                try:
                    await self._chat_repository.create_artifact(
                        chat_id=UUID(chat_id),
                        type=art_type,
                        content=None,
                        artifact_id=art_id,
                        subgroup_id=UUID(subgroup_id),
                        node_id=UUID(node_id),
                    )
                except (ConnectionError, TimeoutError, ValueError, KeyError, OSError) as e:
                    self._logger.warning("Failed to proactively create %s artifact: %s", art_type, e)

    def _is_content_delta(self, event: Dict[str, Any]) -> bool:
        """Check if event is content delta."""
        return (
            event.get("role") == MessageRole.ASSISTANT
            and event.get("type") == MessageType.MESSAGE
            and event.get("content")
            and not event.get("end")
        )

    def _track_background_task(self, task: asyncio.Task) -> None:
        self._background_tasks.add(task)

        def _on_done(done_task: asyncio.Task) -> None:
            self._background_tasks.discard(done_task)
            if done_task.cancelled():
                return
            exc = done_task.exception()
            if exc:
                self._logger.debug("Background task failed: %s", exc)

        task.add_done_callback(_on_done)

    async def shutdown(self) -> None:
        if not self._background_tasks:
            return
        tasks = list(self._background_tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._background_tasks.clear()
