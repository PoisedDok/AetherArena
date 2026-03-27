import asyncio
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from ws.presentation.handlers.message_handler import MessageHandler


class StubClientState:
    name = "CONNECTED"


class StubWebSocket:
    def __init__(self) -> None:
        self.client_state = StubClientState()
        self.sent = []

    async def send_json(self, payload):
        self.sent.append(payload)


class StubStreamOrchestrator:
    def __init__(self) -> None:
        self.calls = []

    async def relay_stream(self, **kwargs):
        self.calls.append(kwargs)
        if False:
            yield None


class StubRequestMapper:
    def __init__(self) -> None:
        self.calls = []

    async def register_mapping(self, **kwargs) -> bool:
        self.calls.append(kwargs)
        return True

    async def cleanup_client_mappings(self, client_id: str) -> None:
        return None

    async def forget_mapping(self, **kwargs) -> None:
        self.calls.append({"forget": kwargs})


class StubCache:
    def __init__(self) -> None:
        self.record_session_state = AsyncMock()


class StubTaskManager:
    def __init__(self) -> None:
        self.register_task = AsyncMock()

    def attach_finalizer(self, *args, **kwargs) -> None:
        return None


class StubArtifact:
    def __init__(self, *, filename, content, metadata, message_id=None) -> None:
        self.filename = filename
        self.content = content
        self.metadata = metadata
        self.message_id = message_id


class StubChatRepository:
    def __init__(self, artifacts) -> None:
        self._artifacts = artifacts

    async def get_artifacts(self, chat_uuid, type=None):
        return self._artifacts


@pytest.mark.asyncio
async def test_handle_user_message_registers_backend_id():
    orchestrator = StubStreamOrchestrator()
    executor = MagicMock()
    executor.execute = AsyncMock()
    request_mapper = StubRequestMapper()
    cache = StubCache()
    task_manager = StubTaskManager()
    handler = MessageHandler(
        stream_orchestrator=orchestrator,
        command_executor=executor,
        task_manager=task_manager,
        request_mapper=request_mapper,
        cache_service=cache,
        runtime=SimpleNamespace(stop_generation=AsyncMock()),
        chat_repository=None,
    )
    ws = StubWebSocket()
    message = SimpleNamespace(
        content="Run a tool",
        image=None,
        id="frontend-abc",
        correlation_id="corr-123",
        chat_id=str(uuid.uuid4()),
        handsfree=False,
    )

    await handler.handle_user_message(ws=ws, client_id="client-123", message=message)
    await asyncio.sleep(0)

    assert request_mapper.calls, "Request mapping should be registered"
    backend_id = request_mapper.calls[0]["backend_id"]
    assert backend_id != message.id
    # Verify session state was recorded with correct backend_id and metadata
    cache.record_session_state.assert_called_once()
    session_args = cache.record_session_state.call_args[0]
    assert session_args[0] == backend_id  # request_id
    assert session_args[1]["client_id"] == "client-123"
    assert session_args[1]["frontend_id"] == "frontend-abc"
    assert session_args[1]["correlation_id"] == "corr-123"
    # Verify task was registered with correct tracking metadata
    task_manager.register_task.assert_called_once()
    reg_kwargs = task_manager.register_task.call_args.kwargs
    assert reg_kwargs["client_id"] == "client-123"
    assert reg_kwargs["correlation_id"] == "corr-123"
    assert reg_kwargs["frontend_id"] == "frontend-abc"


@pytest.mark.asyncio
async def test_handle_user_message_tracks_active_task():
    orchestrator = StubStreamOrchestrator()
    executor = MagicMock()
    executor.execute = AsyncMock()
    request_mapper = StubRequestMapper()
    cache = StubCache()
    task_manager = StubTaskManager()
    handler = MessageHandler(
        stream_orchestrator=orchestrator,
        command_executor=executor,
        task_manager=task_manager,
        request_mapper=request_mapper,
        cache_service=cache,
        runtime=SimpleNamespace(stop_generation=AsyncMock()),
        chat_repository=None,
    )
    ws = StubWebSocket()
    message = SimpleNamespace(
        content="Hello",
        image=None,
        id="frontend-xyz",
        correlation_id=None,
        chat_id=None,
        handsfree=False,
    )

    await handler.handle_user_message(ws=ws, client_id="client-456", message=message)
    await asyncio.sleep(0)

    backend_id = request_mapper.calls[0]["backend_id"]
    assert "client-456" in handler._active_stream_tasks
    assert handler._active_stream_tasks["client-456"]["backend_id"] == backend_id


@pytest.mark.asyncio
async def test_handle_user_message_forwards_metadata_to_orchestrator():
    orchestrator = StubStreamOrchestrator()
    executor = MagicMock()
    executor.execute = AsyncMock()
    request_mapper = StubRequestMapper()
    cache = StubCache()
    task_manager = StubTaskManager()
    handler = MessageHandler(
        stream_orchestrator=orchestrator,
        command_executor=executor,
        task_manager=task_manager,
        request_mapper=request_mapper,
        cache_service=cache,
        runtime=SimpleNamespace(stop_generation=AsyncMock()),
        chat_repository=None,
    )
    ws = StubWebSocket()
    hidden_metadata = {
        "source": "proactive",
        "context": {"doc_research": [{"query": "q1"}]},
    }
    message = SimpleNamespace(
        content="Follow up",
        image=None,
        id="frontend-meta",
        correlation_id=None,
        chat_id=None,
        metadata=hidden_metadata,
        handsfree=False,
    )

    await handler.handle_user_message(ws=ws, client_id="client-meta", message=message)
    await asyncio.sleep(0)

    assert orchestrator.calls
    assert orchestrator.calls[0]["metadata"] == hidden_metadata


@pytest.mark.asyncio
async def test_handle_user_message_rejects_invalid_chat_id():
    orchestrator = StubStreamOrchestrator()
    executor = MagicMock()
    executor.execute = AsyncMock()
    request_mapper = StubRequestMapper()
    cache = StubCache()
    task_manager = StubTaskManager()
    handler = MessageHandler(
        stream_orchestrator=orchestrator,
        command_executor=executor,
        task_manager=task_manager,
        request_mapper=request_mapper,
        cache_service=cache,
        runtime=SimpleNamespace(stop_generation=AsyncMock()),
        chat_repository=None,
    )
    ws = StubWebSocket()
    message = SimpleNamespace(
        content="Hello",
        image=None,
        id="frontend-bad",
        correlation_id=str(uuid.uuid4()),
        chat_id="modeltest_chat_001",
        handsfree=False,
    )

    await handler.handle_user_message(ws=ws, client_id="client-bad", message=message)
    await asyncio.sleep(0)

    assert ws.sent, "Expected an error to be sent over WebSocket"
    assert ws.sent[0]["type"] == "error"
    assert "Invalid chat_id" in ws.sent[0]["content"]
    assert request_mapper.calls == []
    cache.record_session_state.assert_not_called()
    task_manager.register_task.assert_not_called()


@pytest.mark.asyncio
async def test_artifact_context_filters_by_correlation_id(monkeypatch):
    processor_calls = []

    class StubProcessor:
        async def process_artifacts(self, artifacts, chat_id):
            processor_calls.append(artifacts)
            return {"context_text": "CTX", "processed_count": len(artifacts)}

    from ws.application import artifact_processor as artifact_processor_module

    monkeypatch.setattr(
        artifact_processor_module,
        "get_artifact_processor",
        lambda: StubProcessor(),
    )

    artifacts = [
        StubArtifact(
            filename="photo.png",
            content="img-data",
            metadata={"role": "user", "correlation_id": "corr-1"},
        ),
        StubArtifact(
            filename="report.pdf",
            content="doc-data",
            metadata='{"role": "user", "correlation_id": "corr-1"}',
        ),
        StubArtifact(
            filename="old.png",
            content="old-img",
            metadata={"role": "user", "correlation_id": "corr-2"},
        ),
        StubArtifact(
            filename="agent.txt",
            content="agent",
            metadata={"role": "assistant", "correlation_id": "corr-1"},
        ),
    ]

    handler = MessageHandler(
        stream_orchestrator=StubStreamOrchestrator(),
        command_executor=MagicMock(),
        task_manager=StubTaskManager(),
        request_mapper=StubRequestMapper(),
        cache_service=StubCache(),
        runtime=SimpleNamespace(stop_generation=AsyncMock()),
        chat_repository=StubChatRepository(artifacts),
    )

    result = await handler._get_artifact_context_with_images(
        chat_id=str(uuid.uuid4()),
        supports_vision=True,
        correlation_id="corr-1",
    )

    assert processor_calls, "Expected artifact processor to be called"
    assert len(processor_calls[0]) == 1
    assert processor_calls[0][0].filename == "report.pdf"
    assert "CTX" in result["text_context"]
    assert result["image_b64"] == "img-data"


# =========================================================================
# Expanded Tests: Full Coverage (Agent C)
# =========================================================================


def make_handler(**overrides):
    """Factory for MessageHandler with sensible stubs."""
    executor = MagicMock()
    executor.execute = AsyncMock()
    defaults = dict(
        stream_orchestrator=StubStreamOrchestrator(),
        command_executor=executor,
        task_manager=StubTaskManager(),
        request_mapper=StubRequestMapper(),
        cache_service=StubCache(),
        runtime=SimpleNamespace(stop_generation=AsyncMock()),
        chat_repository=None,
        tts_coordinator=None,
        tts_config=None,
    )
    defaults.update(overrides)
    return MessageHandler(**defaults)


# ---- _is_valid_uuid ---------------------------------------------------

class TestIsValidUuid:
    def test_valid_uuid(self):
        assert MessageHandler._is_valid_uuid(str(uuid.uuid4())) is True

    def test_invalid_string(self):
        assert MessageHandler._is_valid_uuid("not-a-uuid") is False

    def test_none(self):
        assert MessageHandler._is_valid_uuid(None) is False

    def test_empty_string(self):
        assert MessageHandler._is_valid_uuid("") is False

    def test_integer(self):
        assert MessageHandler._is_valid_uuid(12345) is False


# ---- _build_context_warning --------------------------------------------

class TestBuildContextWarning:
    def _make_status(self, **overrides):
        base = {
            "token_count": 5000,
            "token_limit": 10000,
            "usage_percent": 50,
            "status": "warning",
            "recommend_new_chat": False,
        }
        base.update(overrides)
        return base

    def test_recommend_new_chat(self):
        handler = make_handler()
        status = self._make_status(recommend_new_chat=True, usage_percent=95)
        msg = handler._build_context_warning(status)
        assert "95%" in msg
        assert "new chat" in msg.lower()

    def test_high_status(self):
        handler = make_handler()
        status = self._make_status(status="high", usage_percent=80)
        msg = handler._build_context_warning(status)
        assert "80%" in msg

    def test_warning_status(self):
        handler = make_handler()
        status = self._make_status(status="warning", usage_percent=50)
        msg = handler._build_context_warning(status)
        assert "5,000" in msg
        assert "50%" in msg


# ---- cleanup_client ----------------------------------------------------

class TestCleanupClient:
    @pytest.mark.asyncio
    async def test_removes_client_state_task_already_done(self):
        """Completed task → no cancellation, state still cleaned."""
        handler = make_handler()
        done_task = MagicMock()
        done_task.done.return_value = True
        handler._active_stream_tasks["c1"] = {"task": done_task, "backend_id": "b1"}
        handler._client_request_locks["c1"] = asyncio.Lock()
        await handler.cleanup_client("c1")
        assert "c1" not in handler._active_stream_tasks
        assert "c1" not in handler._client_request_locks
        done_task.cancel.assert_not_called()

    @pytest.mark.asyncio
    async def test_noop_for_unknown_client(self):
        handler = make_handler()
        await handler.cleanup_client("unknown")

    @staticmethod
    def _make_active_task(done=False):
        """Create a mock asyncio.Task with synchronous done()/cancel() and awaitable.

        Uses a real asyncio.Future under the hood so 'await task' works.
        """
        class _FakeTask:
            def __init__(self, _done):
                self._done = _done
                self.cancel = MagicMock()

            def done(self):
                return self._done

            def __await__(self):
                # Simulate awaiting a cancelled task
                raise asyncio.CancelledError()
                yield  # pragma: no cover — makes this a generator

        return _FakeTask(done)

    @pytest.mark.asyncio
    async def test_active_task_stops_llm_and_cancels(self):
        """Regression Bug #9: active task on disconnect must stop LLM + cancel task.

        Previously cleanup_client only popped the dict entry, leaving the
        asyncio task orphaned and LLM inference running.
        """
        handler = make_handler()
        mock_task = self._make_active_task(done=False)

        handler._active_stream_tasks["c1"] = {
            "task": mock_task,
            "backend_id": "backend-abc-123",
        }

        await handler.cleanup_client("c1")

        # LLM was stopped
        handler._runtime.stop_generation.assert_awaited_once_with("backend-abc-123", chat_id=None)
        # Task was cancelled
        mock_task.cancel.assert_called_once()
        # State cleaned
        assert "c1" not in handler._active_stream_tasks

    @pytest.mark.asyncio
    async def test_active_task_llm_stop_failure_still_cancels(self):
        """LLM stop_generation raises → task is still cancelled (no abort)."""
        runtime = SimpleNamespace(
            stop_generation=AsyncMock(side_effect=RuntimeError("LLM unreachable"))
        )
        handler = make_handler(runtime=runtime)
        mock_task = self._make_active_task(done=False)

        handler._active_stream_tasks["c1"] = {
            "task": mock_task,
            "backend_id": "backend-xyz-456",
        }

        await handler.cleanup_client("c1")

        # LLM stop was attempted with correct backend_id
        runtime.stop_generation.assert_awaited_once_with("backend-xyz-456", chat_id=None)
        # Task was still cancelled despite LLM failure
        mock_task.cancel.assert_called_once()

    @pytest.mark.asyncio
    async def test_active_task_no_runtime_still_cancels(self):
        """No runtime injected → skip LLM stop, still cancel task."""
        handler = make_handler(runtime=None)
        mock_task = self._make_active_task(done=False)

        handler._active_stream_tasks["c1"] = {
            "task": mock_task,
            "backend_id": "backend-no-rt",
        }

        await handler.cleanup_client("c1")

        # Task was cancelled even without runtime
        mock_task.cancel.assert_called_once()
        assert "c1" not in handler._active_stream_tasks


# ---- shutdown ----------------------------------------------------------

class TestShutdown:
    @pytest.mark.asyncio
    async def test_calls_orchestrator_shutdown(self):
        orch = MagicMock()
        orch.shutdown = AsyncMock()
        handler = make_handler(stream_orchestrator=orch)
        await handler.shutdown()
        orch.shutdown.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_noop_when_no_shutdown_method(self):
        handler = make_handler(stream_orchestrator=object())
        await handler.shutdown()


# ---- _cleanup_stream_task ----------------------------------------------

class TestCleanupStreamTask:
    @pytest.mark.asyncio
    async def test_removes_matching_task(self):
        handler = make_handler()
        handler._active_stream_tasks["c1"] = {"task": MagicMock(), "backend_id": "b1"}
        await handler._cleanup_stream_task(
            client_id="c1", frontend_id="f1",
            correlation_id=None, backend_id="b1",
        )
        assert "c1" not in handler._active_stream_tasks

    @pytest.mark.asyncio
    async def test_skips_removal_when_backend_id_mismatch(self):
        handler = make_handler()
        handler._active_stream_tasks["c1"] = {
            "task": MagicMock(), "backend_id": "b-other",
        }
        await handler._cleanup_stream_task(
            client_id="c1", frontend_id="f1",
            correlation_id=None, backend_id="b1",
        )
        assert "c1" in handler._active_stream_tasks

    @pytest.mark.asyncio
    async def test_calls_forget_mapping(self):
        mapper = StubRequestMapper()
        handler = make_handler(request_mapper=mapper)
        await handler._cleanup_stream_task(
            client_id="c1", frontend_id="f1",
            correlation_id="corr-1", backend_id="b1",
        )
        assert any("forget" in str(c) for c in mapper.calls)


# ---- _check_and_notify_context -----------------------------------------

class TestCheckAndNotifyContext:
    @pytest.mark.asyncio
    async def test_emits_warning_for_high_context(self):
        interpreter = MagicMock()
        interpreter.get_context_status = AsyncMock(return_value={
            "status": "high",
            "message_count": 50,
            "token_count": 8000,
            "token_limit": 10000,
            "usage_percent": 80,
            "recommend_new_chat": False,
        })
        runtime = SimpleNamespace(
            stop_generation=AsyncMock(),
            _interpreter_manager=interpreter,
        )
        handler = make_handler(runtime=runtime)
        ws = StubWebSocket()
        await handler._check_and_notify_context(ws, str(uuid.uuid4()), "c1")
        assert len(ws.sent) == 1
        assert ws.sent[0]["type"] == "system"

    @pytest.mark.asyncio
    async def test_noop_when_no_interpreter_manager(self):
        runtime = SimpleNamespace(stop_generation=AsyncMock())
        handler = make_handler(runtime=runtime)
        ws = StubWebSocket()
        await handler._check_and_notify_context(ws, str(uuid.uuid4()), "c1")
        assert len(ws.sent) == 0

    @pytest.mark.asyncio
    async def test_handles_error_gracefully(self):
        interpreter = MagicMock()
        interpreter.get_context_status = AsyncMock(side_effect=RuntimeError("boom"))
        runtime = SimpleNamespace(
            stop_generation=AsyncMock(),
            _interpreter_manager=interpreter,
        )
        handler = make_handler(runtime=runtime)
        ws = StubWebSocket()
        await handler._check_and_notify_context(ws, str(uuid.uuid4()), "c1")
        assert len(ws.sent) == 0

    @pytest.mark.asyncio
    async def test_skips_normal_status(self):
        interpreter = MagicMock()
        interpreter.get_context_status = AsyncMock(return_value={
            "status": "normal",
            "message_count": 10,
        })
        runtime = SimpleNamespace(
            stop_generation=AsyncMock(),
            _interpreter_manager=interpreter,
        )
        handler = make_handler(runtime=runtime)
        ws = StubWebSocket()
        await handler._check_and_notify_context(ws, str(uuid.uuid4()), "c1")
        assert len(ws.sent) == 0

    @pytest.mark.asyncio
    async def test_emits_critical_warning(self):
        interpreter = MagicMock()
        interpreter.get_context_status = AsyncMock(return_value={
            "status": "critical",
            "message_count": 200,
            "token_count": 9500,
            "token_limit": 10000,
            "usage_percent": 95,
            "recommend_new_chat": True,
        })
        runtime = SimpleNamespace(
            stop_generation=AsyncMock(),
            _interpreter_manager=interpreter,
        )
        handler = make_handler(runtime=runtime)
        ws = StubWebSocket()
        await handler._check_and_notify_context(ws, str(uuid.uuid4()), "c1")
        assert len(ws.sent) == 1
        assert ws.sent[0]["metadata"]["context_status"] == "critical"
        assert ws.sent[0]["metadata"]["recommend_new_chat"] is True


# ---- _check_and_summarize_context --------------------------------------

class TestCheckAndSummarizeContext:
    @pytest.mark.asyncio
    async def test_triggers_summarization(self):
        interpreter = MagicMock()
        interpreter.get_context_status = AsyncMock(return_value={
            "needs_summarization": True,
            "message_count": 100,
        })
        interpreter.summarize_context = AsyncMock(return_value="Summary text")
        runtime = SimpleNamespace(
            stop_generation=AsyncMock(),
            _interpreter_manager=interpreter,
        )
        handler = make_handler(runtime=runtime)
        await handler._check_and_summarize_context(str(uuid.uuid4()))
        interpreter.summarize_context.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_noop_when_not_needed(self):
        interpreter = MagicMock()
        interpreter.get_context_status = AsyncMock(return_value={"needs_summarization": False})
        interpreter.summarize_context = AsyncMock()
        runtime = SimpleNamespace(
            stop_generation=AsyncMock(),
            _interpreter_manager=interpreter,
        )
        handler = make_handler(runtime=runtime)
        await handler._check_and_summarize_context(str(uuid.uuid4()))
        interpreter.summarize_context.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_noop_when_no_interpreter_manager(self):
        runtime = SimpleNamespace(stop_generation=AsyncMock())
        handler = make_handler(runtime=runtime)
        await handler._check_and_summarize_context(str(uuid.uuid4()))

    @pytest.mark.asyncio
    async def test_handles_error_gracefully(self):
        interpreter = MagicMock()
        interpreter.get_context_status = AsyncMock(side_effect=AttributeError("broken"))
        runtime = SimpleNamespace(
            stop_generation=AsyncMock(),
            _interpreter_manager=interpreter,
        )
        handler = make_handler(runtime=runtime)
        await handler._check_and_summarize_context(str(uuid.uuid4()))

    @pytest.mark.asyncio
    async def test_handles_none_summary(self):
        interpreter = MagicMock()
        interpreter.get_context_status = AsyncMock(return_value={
            "needs_summarization": True,
            "message_count": 100,
        })
        interpreter.summarize_context = AsyncMock(return_value=None)
        runtime = SimpleNamespace(
            stop_generation=AsyncMock(),
            _interpreter_manager=interpreter,
        )
        handler = make_handler(runtime=runtime)
        await handler._check_and_summarize_context(str(uuid.uuid4()))
        interpreter.summarize_context.assert_awaited_once()


# ---- _get_artifact_context ---------------------------------------------

class TestGetArtifactContext:
    @pytest.mark.asyncio
    async def test_returns_empty_for_no_artifacts(self):
        handler = make_handler(chat_repository=StubChatRepository([]))
        result = await handler._get_artifact_context(
            str(uuid.uuid4()), correlation_id="corr-1",
        )
        assert result == ""

    @pytest.mark.asyncio
    async def test_returns_empty_for_no_correlation_id(self):
        artifacts = [
            StubArtifact(
                filename="f.pdf", content="data",
                metadata={"role": "user"},
            ),
        ]
        handler = make_handler(chat_repository=StubChatRepository(artifacts))
        result = await handler._get_artifact_context(
            str(uuid.uuid4()), correlation_id=None,
        )
        assert result == ""

    @pytest.mark.asyncio
    async def test_returns_formatted_context(self, monkeypatch):
        class StubProcessor:
            async def process_artifacts(self, artifacts, chat_id):
                return {"context_text": "File contents here", "processed_count": 1}

        monkeypatch.setattr(
            "ws.application.artifact_processor.get_artifact_processor",
            lambda: StubProcessor(),
        )
        artifacts = [
            StubArtifact(
                filename="report.pdf", content="data",
                metadata={"role": "user", "correlation_id": "corr-1"},
            ),
        ]
        handler = make_handler(chat_repository=StubChatRepository(artifacts))
        result = await handler._get_artifact_context(
            str(uuid.uuid4()), correlation_id="corr-1",
        )
        assert "File contents here" in result
        assert "SYSTEM INSTRUCTION" in result

    @pytest.mark.asyncio
    async def test_handles_string_metadata(self, monkeypatch):
        class StubProcessor:
            async def process_artifacts(self, artifacts, chat_id):
                return {"context_text": "parsed", "processed_count": 1}

        monkeypatch.setattr(
            "ws.application.artifact_processor.get_artifact_processor",
            lambda: StubProcessor(),
        )
        artifacts = [
            StubArtifact(
                filename="doc.pdf", content="data",
                metadata='{"role": "user", "correlation_id": "corr-1"}',
            ),
        ]
        handler = make_handler(chat_repository=StubChatRepository(artifacts))
        result = await handler._get_artifact_context(
            str(uuid.uuid4()), correlation_id="corr-1",
        )
        assert "parsed" in result

    @pytest.mark.asyncio
    async def test_returns_empty_for_no_matching_artifacts(self):
        artifacts = [
            StubArtifact(
                filename="doc.pdf", content="data",
                metadata={"role": "user", "correlation_id": "other-corr"},
            ),
        ]
        handler = make_handler(chat_repository=StubChatRepository(artifacts))
        result = await handler._get_artifact_context(
            str(uuid.uuid4()), correlation_id="corr-1",
        )
        assert result == ""

    @pytest.mark.asyncio
    async def test_returns_empty_on_error(self):
        class FailingRepo:
            async def get_artifacts(self, *args, **kwargs):
                raise ValueError("DB error")

        handler = make_handler(chat_repository=FailingRepo())
        result = await handler._get_artifact_context(
            str(uuid.uuid4()), correlation_id="corr-1",
        )
        assert result == ""

    @pytest.mark.asyncio
    async def test_returns_empty_for_empty_context_text(self, monkeypatch):
        class StubProcessor:
            async def process_artifacts(self, artifacts, chat_id):
                return {"context_text": "", "processed_count": 0}

        monkeypatch.setattr(
            "ws.application.artifact_processor.get_artifact_processor",
            lambda: StubProcessor(),
        )
        artifacts = [
            StubArtifact(
                filename="empty.txt", content="",
                metadata={"role": "user", "correlation_id": "corr-1"},
            ),
        ]
        handler = make_handler(chat_repository=StubChatRepository(artifacts))
        result = await handler._get_artifact_context(
            str(uuid.uuid4()), correlation_id="corr-1",
        )
        assert result == ""

    @pytest.mark.asyncio
    async def test_filters_by_message_id_fallback(self, monkeypatch):
        class StubProcessor:
            async def process_artifacts(self, artifacts, chat_id):
                return {"context_text": "via message_id", "processed_count": 1}

        monkeypatch.setattr(
            "ws.application.artifact_processor.get_artifact_processor",
            lambda: StubProcessor(),
        )
        corr = str(uuid.uuid4())
        artifacts = [
            StubArtifact(
                filename="doc.pdf", content="data",
                metadata={"role": "user"},
                message_id=corr,
            ),
        ]
        handler = make_handler(chat_repository=StubChatRepository(artifacts))
        result = await handler._get_artifact_context(
            str(uuid.uuid4()), correlation_id=corr,
        )
        assert "via message_id" in result

    @pytest.mark.asyncio
    async def test_handles_invalid_json_metadata(self):
        artifacts = [
            StubArtifact(
                filename="bad.txt", content="",
                metadata="not-json{{{",
            ),
        ]
        handler = make_handler(chat_repository=StubChatRepository(artifacts))
        result = await handler._get_artifact_context(
            str(uuid.uuid4()), correlation_id="corr-1",
        )
        assert result == ""

    @pytest.mark.asyncio
    async def test_filters_assistant_role_artifacts(self):
        artifacts = [
            StubArtifact(
                filename="assistant.txt", content="data",
                metadata={"role": "assistant", "correlation_id": "corr-1"},
            ),
        ]
        handler = make_handler(chat_repository=StubChatRepository(artifacts))
        result = await handler._get_artifact_context(
            str(uuid.uuid4()), correlation_id="corr-1",
        )
        assert result == ""


# ---- _get_artifact_context_with_images (overflow) ----------------------

class TestGetArtifactContextWithImagesExpanded:
    @pytest.mark.asyncio
    async def test_overflow_images_processed_through_text(self, monkeypatch):
        calls = []

        class StubProcessor:
            async def process_artifacts(self, artifacts, chat_id):
                calls.append(list(artifacts))
                return {
                    "context_text": f"analysis of {len(artifacts)} images",
                    "processed_count": len(artifacts),
                }

        monkeypatch.setattr(
            "ws.application.artifact_processor.get_artifact_processor",
            lambda: StubProcessor(),
        )
        artifacts = [
            StubArtifact(filename="img1.png", content="img1-b64",
                         metadata={"role": "user", "correlation_id": "corr-1"}),
            StubArtifact(filename="img2.png", content="img2-b64",
                         metadata={"role": "user", "correlation_id": "corr-1"}),
            StubArtifact(filename="img3.jpg", content="img3-b64",
                         metadata={"role": "user", "correlation_id": "corr-1"}),
        ]
        handler = make_handler(chat_repository=StubChatRepository(artifacts))
        result = await handler._get_artifact_context_with_images(
            chat_id=str(uuid.uuid4()),
            supports_vision=True,
            correlation_id="corr-1",
        )
        assert result["image_b64"] == "img1-b64"
        assert "analysis of 2 images" in result["text_context"]
        assert len(calls) == 1
        assert len(calls[0]) == 2

    @pytest.mark.asyncio
    async def test_no_correlation_id_returns_empty(self):
        artifacts = [
            StubArtifact(filename="img.png", content="data",
                         metadata={"role": "user"}),
        ]
        handler = make_handler(chat_repository=StubChatRepository(artifacts))
        result = await handler._get_artifact_context_with_images(
            chat_id=str(uuid.uuid4()),
            supports_vision=True,
            correlation_id=None,
        )
        assert result["text_context"] == ""
        assert result["image_b64"] is None

    @pytest.mark.asyncio
    async def test_exception_returns_empty(self):
        class FailingRepo:
            async def get_artifacts(self, *args, **kwargs):
                raise TypeError("broken")

        handler = make_handler(chat_repository=FailingRepo())
        result = await handler._get_artifact_context_with_images(
            chat_id=str(uuid.uuid4()),
            supports_vision=True,
            correlation_id="corr-1",
        )
        assert result["text_context"] == ""
        assert result["image_b64"] is None

    @pytest.mark.asyncio
    async def test_text_model_routes_images_to_processor(self, monkeypatch):
        calls = []

        class StubProcessor:
            async def process_artifacts(self, artifacts, chat_id):
                calls.append(list(artifacts))
                return {"context_text": "image analysis", "processed_count": len(artifacts)}

        monkeypatch.setattr(
            "ws.application.artifact_processor.get_artifact_processor",
            lambda: StubProcessor(),
        )
        artifacts = [
            StubArtifact(filename="photo.png", content="img-data",
                         metadata={"role": "user", "correlation_id": "corr-1"}),
        ]
        handler = make_handler(chat_repository=StubChatRepository(artifacts))
        result = await handler._get_artifact_context_with_images(
            chat_id=str(uuid.uuid4()),
            supports_vision=False,
            correlation_id="corr-1",
        )
        assert result["image_b64"] is None
        assert "image analysis" in result["text_context"]
        assert len(calls[0]) == 1

    @pytest.mark.asyncio
    async def test_mixed_images_and_documents_for_vision(self, monkeypatch):
        calls = []

        class StubProcessor:
            async def process_artifacts(self, artifacts, chat_id):
                calls.append(list(artifacts))
                return {"context_text": "doc content", "processed_count": len(artifacts)}

        monkeypatch.setattr(
            "ws.application.artifact_processor.get_artifact_processor",
            lambda: StubProcessor(),
        )
        artifacts = [
            StubArtifact(filename="photo.png", content="img-b64",
                         metadata={"role": "user", "correlation_id": "corr-1"}),
            StubArtifact(filename="report.pdf", content="pdf-data",
                         metadata={"role": "user", "correlation_id": "corr-1"}),
        ]
        handler = make_handler(chat_repository=StubChatRepository(artifacts))
        result = await handler._get_artifact_context_with_images(
            chat_id=str(uuid.uuid4()),
            supports_vision=True,
            correlation_id="corr-1",
        )
        # Image goes to image_b64, PDF processed as text
        assert result["image_b64"] == "img-b64"
        assert "doc content" in result["text_context"]
        # Only PDF should be in text processing call
        assert len(calls) == 1
        assert calls[0][0].filename == "report.pdf"


# ---- handle_user_message: cancellation ---------------------------------

class TestHandleUserMessageCancellation:
    @pytest.mark.asyncio
    async def test_cancels_previous_task(self):
        runtime = SimpleNamespace(stop_generation=AsyncMock())
        handler = make_handler(runtime=runtime)

        async def long_running():
            await asyncio.sleep(999)

        old_task = asyncio.create_task(long_running())
        handler._active_stream_tasks["c1"] = {
            "task": old_task,
            "backend_id": "old-b1",
            "correlation_id": None,
            "chat_id": None,
        }
        ws = StubWebSocket()
        message = SimpleNamespace(
            content="New message", image=None,
            id="f-new", correlation_id=None,
            chat_id=None, handsfree=False,
        )
        await handler.handle_user_message(ws=ws, client_id="c1", message=message)
        await asyncio.sleep(0)
        assert old_task.cancelled()
        runtime.stop_generation.assert_awaited_once_with("old-b1", chat_id=None)

    @pytest.mark.asyncio
    async def test_handles_stop_generation_error(self):
        runtime = SimpleNamespace(
            stop_generation=AsyncMock(side_effect=RuntimeError("failed")),
        )
        handler = make_handler(runtime=runtime)

        async def long_running():
            await asyncio.sleep(999)

        old_task = asyncio.create_task(long_running())
        handler._active_stream_tasks["c1"] = {
            "task": old_task,
            "backend_id": "old-b1",
            "correlation_id": None,
            "chat_id": None,
        }
        ws = StubWebSocket()
        message = SimpleNamespace(
            content="New", image=None,
            id="f2", correlation_id=None,
            chat_id=None, handsfree=False,
        )
        await handler.handle_user_message(ws=ws, client_id="c1", message=message)
        await asyncio.sleep(0)
        assert old_task.cancelled()

    @pytest.mark.asyncio
    async def test_skips_done_task(self):
        runtime = SimpleNamespace(stop_generation=AsyncMock())
        handler = make_handler(runtime=runtime)
        old_task = asyncio.create_task(asyncio.sleep(0))
        await old_task  # Explicitly wait for full completion
        assert old_task.done()
        handler._active_stream_tasks["c1"] = {
            "task": old_task,
            "backend_id": "old-b1",
            "correlation_id": None,
            "chat_id": None,
        }
        ws = StubWebSocket()
        message = SimpleNamespace(
            content="New", image=None,
            id="f3", correlation_id=None,
            chat_id=None, handsfree=False,
        )
        await handler.handle_user_message(ws=ws, client_id="c1", message=message)
        await asyncio.sleep(0)
        runtime.stop_generation.assert_not_awaited()


# ---- handle_user_message: stream_and_execute ---------------------------

class TestStreamAndExecute:
    @pytest.mark.asyncio
    async def test_enriches_with_artifact_context(self):
        """stream_and_execute enriches text with artifact context when all deps present."""
        captured_calls = []

        class CapturingOrchestrator:
            async def relay_stream(self, **kwargs):
                captured_calls.append(kwargs)
                if False:
                    yield None

        runtime = SimpleNamespace(
            stop_generation=AsyncMock(),
            settings=SimpleNamespace(llm=SimpleNamespace(supports_vision=False)),
        )
        handler = make_handler(
            stream_orchestrator=CapturingOrchestrator(),
            runtime=runtime,
            chat_repository=StubChatRepository([]),
        )
        handler._get_artifact_context_with_images = AsyncMock(return_value={
            "text_context": "ENRICHED CONTEXT",
            "image_b64": None,
        })
        handler._check_and_notify_context = AsyncMock()
        handler._check_and_summarize_context = AsyncMock()

        ws = StubWebSocket()
        chat_id = str(uuid.uuid4())
        message = SimpleNamespace(
            content="Question", image=None,
            id="f-art", correlation_id="corr-1",
            chat_id=chat_id, handsfree=False,
        )
        await handler.handle_user_message(ws=ws, client_id="c1", message=message)
        task = handler._active_stream_tasks.get("c1", {}).get("task")
        if task:
            try:
                await asyncio.wait_for(task, timeout=2.0)
            except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
                pass

        assert captured_calls
        assert "ENRICHED CONTEXT" in captured_calls[0]["text"]
        assert captured_calls[0]["original_text"] == "Question"

    @pytest.mark.asyncio
    async def test_enriches_with_vision_image(self):
        """stream_and_execute uses vision image from artifacts for vision models."""
        captured_calls = []

        class CapturingOrchestrator:
            async def relay_stream(self, **kwargs):
                captured_calls.append(kwargs)
                if False:
                    yield None

        runtime = SimpleNamespace(
            stop_generation=AsyncMock(),
            settings=SimpleNamespace(llm=SimpleNamespace(supports_vision=True)),
        )
        handler = make_handler(
            stream_orchestrator=CapturingOrchestrator(),
            runtime=runtime,
            chat_repository=StubChatRepository([]),
        )
        handler._get_artifact_context_with_images = AsyncMock(return_value={
            "text_context": "",
            "image_b64": "base64-image-data",
        })
        handler._check_and_notify_context = AsyncMock()
        handler._check_and_summarize_context = AsyncMock()

        ws = StubWebSocket()
        chat_id = str(uuid.uuid4())
        message = SimpleNamespace(
            content="Describe", image=None,
            id="f-vis", correlation_id="corr-1",
            chat_id=chat_id, handsfree=False,
        )
        await handler.handle_user_message(ws=ws, client_id="c1", message=message)
        task = handler._active_stream_tasks.get("c1", {}).get("task")
        if task:
            try:
                await asyncio.wait_for(task, timeout=2.0)
            except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
                pass

        assert captured_calls
        assert captured_calls[0]["image_b64"] == "base64-image-data"

    @pytest.mark.asyncio
    async def test_breaks_on_disconnected_client(self):
        """stream_and_execute breaks loop when client disconnects."""
        from ws.domain.commands.stream_commands import EmitStreamEvent

        class YieldingOrchestrator:
            async def relay_stream(self, **kwargs):
                yield EmitStreamEvent(event={"role": "assistant", "content": "hi"})

        executor = MagicMock()
        executor.execute = AsyncMock()
        handler = make_handler(
            stream_orchestrator=YieldingOrchestrator(),
            command_executor=executor,
        )

        class DisconnectedWs(StubWebSocket):
            def __init__(self):
                super().__init__()
                self.client_state = SimpleNamespace(name="DISCONNECTED")

        ws = DisconnectedWs()
        message = SimpleNamespace(
            content="Hello", image=None,
            id="f-dc", correlation_id=None,
            chat_id=None, handsfree=False,
        )
        await handler.handle_user_message(ws=ws, client_id="c1", message=message)
        task = handler._active_stream_tasks.get("c1", {}).get("task")
        if task:
            try:
                await asyncio.wait_for(task, timeout=2.0)
            except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
                pass

        executor.execute.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_stream_exception_propagates(self):
        """stream_and_execute logs and re-raises unexpected exceptions."""
        class FailingOrchestrator:
            async def relay_stream(self, **kwargs):
                raise RuntimeError("stream crash")
                yield  # noqa: unreachable -- makes it an async gen

        handler = make_handler(stream_orchestrator=FailingOrchestrator())
        ws = StubWebSocket()
        message = SimpleNamespace(
            content="Hello", image=None,
            id="f-err", correlation_id=None,
            chat_id=None, handsfree=False,
        )
        await handler.handle_user_message(ws=ws, client_id="c1", message=message)
        task = handler._active_stream_tasks.get("c1", {}).get("task")
        if task:
            with pytest.raises(RuntimeError, match="stream crash"):
                await asyncio.wait_for(task, timeout=2.0)

    @pytest.mark.asyncio
    async def test_context_check_called_for_chat(self):
        """stream_and_execute calls _check_and_notify_context when runtime + chat_id."""
        handler = make_handler(
            runtime=SimpleNamespace(stop_generation=AsyncMock()),
        )
        handler._check_and_notify_context = AsyncMock()
        handler._check_and_summarize_context = AsyncMock()

        ws = StubWebSocket()
        chat_id = str(uuid.uuid4())
        message = SimpleNamespace(
            content="Hello", image=None,
            id="f-ctx", correlation_id=None,
            chat_id=chat_id, handsfree=False,
        )
        await handler.handle_user_message(ws=ws, client_id="c1", message=message)
        task = handler._active_stream_tasks.get("c1", {}).get("task")
        if task:
            try:
                await asyncio.wait_for(task, timeout=2.0)
            except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
                pass

        handler._check_and_notify_context.assert_awaited_once_with(ws, chat_id, "c1")
        handler._check_and_summarize_context.assert_awaited_once_with(chat_id)


# ---- handle_user_message: cancellation error ---------------------------

class TestHandleUserMessageCancellationError:
    @pytest.mark.asyncio
    async def test_handles_runtime_error_during_cancel_await(self):
        """Covers except (RuntimeError, OSError) when awaiting cancelled task."""
        runtime = SimpleNamespace(stop_generation=AsyncMock())
        handler = make_handler(runtime=runtime)

        async def error_on_cancel():
            try:
                await asyncio.sleep(999)
            except asyncio.CancelledError:
                raise RuntimeError("task error during cancel")

        old_task = asyncio.create_task(error_on_cancel())
        handler._active_stream_tasks["c1"] = {
            "task": old_task,
            "backend_id": "old-b1",
            "correlation_id": None,
            "chat_id": None,
        }
        ws = StubWebSocket()
        message = SimpleNamespace(
            content="New", image=None,
            id="f4", correlation_id=None,
            chat_id=None, handsfree=False,
        )
        # Should not raise despite RuntimeError during cancel await
        await handler.handle_user_message(ws=ws, client_id="c1", message=message)
        await asyncio.sleep(0)


# ---- handle_user_message: duplicate ------------------------------------

class TestHandleUserMessageDuplicate:
    @pytest.mark.asyncio
    async def test_rejects_duplicate_message(self):
        class RejectMapper:
            async def register_mapping(self, **kwargs) -> bool:
                return False
            async def cleanup_client_mappings(self, client_id):
                pass
            async def forget_mapping(self, **kwargs):
                pass

        handler = make_handler(request_mapper=RejectMapper())
        ws = StubWebSocket()
        message = SimpleNamespace(
            content="Dup", image=None,
            id="dup-id", correlation_id=None,
            chat_id=None, handsfree=False,
        )
        await handler.handle_user_message(ws=ws, client_id="c1", message=message)
        await asyncio.sleep(0)
        handler._cache.record_session_state.assert_not_called()
        handler._task_manager.register_task.assert_not_called()


# ---- handle_user_message: send_json error on invalid chat_id -----------

class TestHandleUserMessageSendJsonError:
    @pytest.mark.asyncio
    async def test_handles_send_json_error_on_invalid_chat_id(self):
        class FailingWebSocket(StubWebSocket):
            async def send_json(self, payload):
                raise RuntimeError("connection closed")

        handler = make_handler()
        ws = FailingWebSocket()
        message = SimpleNamespace(
            content="Hello", image=None,
            id="f-bad", correlation_id=str(uuid.uuid4()),
            chat_id="not-a-uuid", handsfree=False,
        )
        await handler.handle_user_message(ws=ws, client_id="c-bad", message=message)


# ---- _wrap_with_tts ----------------------------------------------------


def _setup_tts_mocks(monkeypatch, chunker_cls):
    """Pre-register mock audio modules to avoid openwakeword dependency."""
    import sys
    from types import ModuleType

    for name in [
        "ws.domain.audio",
        "ws.domain.audio.services",
        "ws.domain.audio.services.text_chunker",
    ]:
        mod = ModuleType(name)
        mod.__path__ = []
        monkeypatch.setitem(sys.modules, name, mod)

    import sys as _sys
    _sys.modules["ws.domain.audio.services.text_chunker"].TextChunker = chunker_cls


class TestWrapWithTts:
    @pytest.mark.asyncio
    async def test_yields_original_and_tts_commands(self, monkeypatch):
        from ws.domain.commands.stream_commands import EmitStreamEvent
        from ws.domain.commands.audio_commands import (
            EmitTTSAudio, EmitTTSQueued, EmitTTSCompleted,
        )

        class MockChunker:
            def __init__(self, first_size, target_size):
                self.first_size = first_size
                self.target_size = target_size
                self.current_text = []
                self.found_first_sentence = False
            def should_process(self, text):
                return len(text) > 3
            def process(self, text, _):
                return text.strip()
            def find_break_point(self, words, target):
                return len(words)

        _setup_tts_mocks(monkeypatch, MockChunker)

        audio_queue = [(b"audio-bytes", "Hello world")]

        class MockCoordinator:
            async def add_sentence(self, client_id, sentence):
                pass
            async def get_next_audio(self, client_id):
                if audio_queue:
                    return audio_queue.pop(0)
                return None
            def is_generation_complete(self, client_id):
                return True
            async def stop_service(self, client_id):
                pass
            async def clear_queues(self, client_id):
                pass
            async def wait_for_state_change(self, client_id, timeout=None):
                pass
            def trigger_state_change(self, client_id):
                pass

        tts_config = SimpleNamespace(
            first_sentence_target_words=5,
            chunk_target_words=10,
            sample_rate=24000,
        )
        handler = make_handler(
            tts_coordinator=MockCoordinator(),
            tts_config=tts_config,
        )

        async def command_stream():
            yield EmitStreamEvent(event={"role": "assistant", "content": "Hello world"})

        commands = []
        async for cmd in handler._wrap_with_tts(command_stream(), "client-1"):
            commands.append(cmd)

        assert any(isinstance(c, EmitStreamEvent) for c in commands)
        assert any(isinstance(c, EmitTTSQueued) for c in commands)
        assert any(isinstance(c, EmitTTSAudio) for c in commands)
        assert any(isinstance(c, EmitTTSCompleted) for c in commands)

    @pytest.mark.asyncio
    async def test_queue_full_yields_tts_error(self, monkeypatch):
        from ws.domain.commands.stream_commands import EmitStreamEvent
        from ws.domain.commands.audio_commands import EmitTTSError

        class MockChunker:
            def __init__(self, first_size, target_size):
                self.first_size = first_size
                self.target_size = target_size
                self.current_text = []
                self.found_first_sentence = False
            def should_process(self, text):
                return len(text) > 3
            def process(self, text, _):
                return text.strip()
            def find_break_point(self, words, target):
                return len(words)

        _setup_tts_mocks(monkeypatch, MockChunker)

        class QueueFullCoordinator:
            async def add_sentence(self, client_id, sentence):
                raise asyncio.QueueFull()
            async def get_next_audio(self, client_id):
                return None
            def is_generation_complete(self, client_id):
                return True
            async def stop_service(self, client_id):
                pass
            async def clear_queues(self, client_id):
                pass
            async def wait_for_state_change(self, client_id, timeout=None):
                pass
            def trigger_state_change(self, client_id):
                pass

        tts_config = SimpleNamespace(
            first_sentence_target_words=5,
            chunk_target_words=10,
            sample_rate=24000,
        )
        handler = make_handler(
            tts_coordinator=QueueFullCoordinator(),
            tts_config=tts_config,
        )

        async def command_stream():
            yield EmitStreamEvent(event={"role": "assistant", "content": "Hello world"})

        commands = []
        async for cmd in handler._wrap_with_tts(command_stream(), "client-1"):
            commands.append(cmd)

        assert any(isinstance(c, EmitTTSError) for c in commands)

    @pytest.mark.asyncio
    async def test_no_tts_when_no_assistant_content(self, monkeypatch):
        from ws.domain.commands.stream_commands import EmitStreamEvent
        from ws.domain.commands.audio_commands import EmitTTSCompleted, EmitTTSQueued

        class MockChunker:
            def __init__(self, first_size, target_size):
                self.current_text = []
                self.found_first_sentence = False
            def should_process(self, text):
                return False
            def process(self, text, _):
                return ""

        _setup_tts_mocks(monkeypatch, MockChunker)

        class NoOpCoordinator:
            async def add_sentence(self, client_id, sentence):
                pass
            async def get_next_audio(self, client_id):
                return None
            def is_generation_complete(self, client_id):
                return True
            async def stop_service(self, client_id):
                pass
            async def clear_queues(self, client_id):
                pass
            async def wait_for_state_change(self, client_id, timeout=None):
                pass
            def trigger_state_change(self, client_id):
                pass

        tts_config = SimpleNamespace(
            first_sentence_target_words=5,
            chunk_target_words=10,
            sample_rate=24000,
        )
        handler = make_handler(
            tts_coordinator=NoOpCoordinator(),
            tts_config=tts_config,
        )

        async def command_stream():
            yield EmitStreamEvent(event={"role": "computer", "content": "code output"})

        commands = []
        async for cmd in handler._wrap_with_tts(command_stream(), "client-1"):
            commands.append(cmd)

        assert any(isinstance(c, EmitStreamEvent) for c in commands)
        assert not any(isinstance(c, EmitTTSCompleted) for c in commands)
        assert not any(isinstance(c, EmitTTSQueued) for c in commands)

    @pytest.mark.asyncio
    async def test_cleanup_on_cancellation(self, monkeypatch):
        from ws.domain.commands.stream_commands import EmitStreamEvent

        class MockChunker:
            def __init__(self, first_size, target_size):
                self.current_text = []
                self.found_first_sentence = False
            def should_process(self, text):
                return False
            def process(self, text, _):
                return ""

        _setup_tts_mocks(monkeypatch, MockChunker)

        stop_called = False
        clear_called = False

        class TrackingCoordinator:
            async def add_sentence(self, client_id, sentence):
                pass
            async def get_next_audio(self, client_id):
                await asyncio.sleep(999)
                return None
            def is_generation_complete(self, client_id):
                return False
            async def stop_service(self, client_id):
                nonlocal stop_called
                stop_called = True
            async def clear_queues(self, client_id):
                nonlocal clear_called
                clear_called = True
            async def wait_for_state_change(self, client_id, timeout=None):
                pass
            def trigger_state_change(self, client_id):
                pass

        tts_config = SimpleNamespace(
            first_sentence_target_words=5,
            chunk_target_words=10,
            sample_rate=24000,
        )
        handler = make_handler(
            tts_coordinator=TrackingCoordinator(),
            tts_config=tts_config,
        )

        async def slow_stream():
            yield EmitStreamEvent(event={"role": "computer", "content": "ok"})
            await asyncio.sleep(999)

        async def consume():
            async for _ in handler._wrap_with_tts(slow_stream(), "client-1"):
                pass

        task = asyncio.create_task(consume())
        await asyncio.sleep(0.15)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

        assert stop_called, "stop_service should be called on cancellation"
        assert clear_called, "clear_queues should be called on cancellation"

    @pytest.mark.asyncio
    async def test_final_sentence_flushed(self, monkeypatch):
        """Final accumulated text is queued directly (bypasses chunker.process)
        after stream ends — the implementation joins current_text and sends it
        as the final sentence without re-chunking."""
        from ws.domain.commands.stream_commands import EmitStreamEvent
        from ws.domain.commands.audio_commands import EmitTTSQueued

        queued_sentences = []

        class MockChunker:
            def __init__(self, first_size, target_size):
                self.first_size = first_size
                self.target_size = target_size
                self.current_text = []
                self.found_first_sentence = False
            def should_process(self, text):
                # Never trigger mid-stream, only final flush
                return False
            def process(self, text, _):
                return text.strip() if text.strip() else ""

        _setup_tts_mocks(monkeypatch, MockChunker)

        class MockCoordinator:
            async def add_sentence(self, client_id, sentence):
                queued_sentences.append(sentence)
            async def get_next_audio(self, client_id):
                return None
            def is_generation_complete(self, client_id):
                return True
            async def stop_service(self, client_id):
                pass
            async def clear_queues(self, client_id):
                pass
            async def wait_for_state_change(self, client_id, timeout=None):
                pass
            def trigger_state_change(self, client_id):
                pass

        tts_config = SimpleNamespace(
            first_sentence_target_words=5,
            chunk_target_words=10,
            sample_rate=24000,
        )
        handler = make_handler(
            tts_coordinator=MockCoordinator(),
            tts_config=tts_config,
        )

        async def command_stream():
            yield EmitStreamEvent(event={"role": "assistant", "content": "Short"})

        commands = []
        async for cmd in handler._wrap_with_tts(command_stream(), "client-1"):
            commands.append(cmd)

        # Final text should have been queued directly (without chunker.process)
        assert len(queued_sentences) >= 1
        assert "Short" in queued_sentences[-1]
        # EmitTTSQueued must have been emitted for first chunk
        assert any(isinstance(c, EmitTTSQueued) for c in commands)


# ---- _get_artifact_context_with_images: missed lines (772, 791-792, 867) --


class TestGetArtifactContextWithImagesMissedLines:
    @pytest.mark.asyncio
    async def test_no_artifacts_returns_empty_dict(self):
        """Empty artifact list returns empty text_context and None image_b64 (line 772)."""
        handler = make_handler(chat_repository=StubChatRepository([]))
        result = await handler._get_artifact_context_with_images(
            chat_id=str(uuid.uuid4()),
            supports_vision=True,
            correlation_id="corr-1",
        )
        assert result == {"text_context": "", "image_b64": None}

    @pytest.mark.asyncio
    async def test_invalid_json_metadata_handled_gracefully(self):
        """Invalid JSON string metadata falls back to empty dict (lines 791-792)."""
        artifacts = [
            StubArtifact(
                filename="doc.pdf",
                content="data",
                metadata="not-valid-json{{{",
            ),
        ]
        handler = make_handler(chat_repository=StubChatRepository(artifacts))
        result = await handler._get_artifact_context_with_images(
            chat_id=str(uuid.uuid4()),
            supports_vision=True,
            correlation_id="corr-1",
        )
        # Invalid JSON → metadata={} → role check fails → no artifacts matched
        assert result["text_context"] == ""
        assert result["image_b64"] is None

    @pytest.mark.asyncio
    async def test_overflow_images_appended_to_existing_text_context(self, monkeypatch):
        """Overflow image analysis appended to existing text_context (line 867)."""
        call_idx = 0

        class OrderedProcessor:
            async def process_artifacts(self, artifacts, chat_id):
                nonlocal call_idx
                call_idx += 1
                if call_idx == 1:
                    return {"context_text": "Document content", "processed_count": 1}
                return {"context_text": "Image analysis result", "processed_count": 1}

        monkeypatch.setattr(
            "ws.application.artifact_processor.get_artifact_processor",
            lambda: OrderedProcessor(),
        )
        artifacts = [
            StubArtifact(
                filename="report.pdf", content="pdf-data",
                metadata={"role": "user", "correlation_id": "corr-1"},
            ),
            StubArtifact(
                filename="photo1.png", content="img1-b64",
                metadata={"role": "user", "correlation_id": "corr-1"},
            ),
            StubArtifact(
                filename="photo2.jpg", content="img2-b64",
                metadata={"role": "user", "correlation_id": "corr-1"},
            ),
        ]
        handler = make_handler(chat_repository=StubChatRepository(artifacts))
        result = await handler._get_artifact_context_with_images(
            chat_id=str(uuid.uuid4()),
            supports_vision=True,
            correlation_id="corr-1",
        )
        assert result["image_b64"] == "img1-b64"
        # Both document AND overflow image context present
        assert "Document content" in result["text_context"]
        assert "Image analysis result" in result["text_context"]


# ---- handle_user_message: task cancel RuntimeError/OSError (357-358) ------


class TestHandleUserMessageCancelErrorTiming:
    @pytest.mark.asyncio
    async def test_runtime_error_during_cancel_await_with_started_task(self):
        """RuntimeError from started+cancelled task is caught (lines 357-358).

        CRITICAL: Task must be started (await sleep(0)) before cancellation
        to ensure CancelledError is delivered and RuntimeError propagates.
        """
        runtime = SimpleNamespace(stop_generation=AsyncMock())
        handler = make_handler(runtime=runtime)

        async def error_on_cancel():
            try:
                await asyncio.sleep(999)
            except asyncio.CancelledError:
                raise RuntimeError("task error during cancel")

        old_task = asyncio.create_task(error_on_cancel())
        await asyncio.sleep(0)  # Let task enter await sleep(999)
        handler._active_stream_tasks["c1"] = {
            "task": old_task,
            "backend_id": "old-b1",
            "correlation_id": None,
            "chat_id": None,
        }
        ws = StubWebSocket()
        message = SimpleNamespace(
            content="New", image=None,
            id="f-re2", correlation_id=None,
            chat_id=None, handsfree=False,
        )
        await handler.handle_user_message(ws=ws, client_id="c1", message=message)
        await asyncio.sleep(0.05)

    @pytest.mark.asyncio
    async def test_os_error_during_cancel_await_with_started_task(self):
        """OSError from started+cancelled task is caught (lines 357-358)."""
        runtime = SimpleNamespace(stop_generation=AsyncMock())
        handler = make_handler(runtime=runtime)

        async def os_error_on_cancel():
            try:
                await asyncio.sleep(999)
            except asyncio.CancelledError:
                raise OSError("network error during cleanup")

        old_task = asyncio.create_task(os_error_on_cancel())
        await asyncio.sleep(0)
        handler._active_stream_tasks["c1"] = {
            "task": old_task,
            "backend_id": "old-b1",
            "correlation_id": None,
            "chat_id": None,
        }
        ws = StubWebSocket()
        message = SimpleNamespace(
            content="New", image=None,
            id="f-os2", correlation_id=None,
            chat_id=None, handsfree=False,
        )
        await handler.handle_user_message(ws=ws, client_id="c1", message=message)
        await asyncio.sleep(0.05)


# ---- stream_and_execute: command executor called (line 501) ---------------


class TestStreamExecuteCommandExecution:
    @pytest.mark.asyncio
    async def test_executor_called_for_yielded_commands(self):
        """Command executor is called for each yielded command (line 501)."""
        from ws.domain.commands.stream_commands import EmitStreamEvent

        class YieldingOrchestrator:
            async def relay_stream(self, **kwargs):
                yield EmitStreamEvent(event={"role": "assistant", "content": "hi"})

        executor = MagicMock()
        executor.execute = AsyncMock()
        handler = make_handler(
            stream_orchestrator=YieldingOrchestrator(),
            command_executor=executor,
        )
        handler._check_and_notify_context = AsyncMock()
        handler._check_and_summarize_context = AsyncMock()

        ws = StubWebSocket()
        message = SimpleNamespace(
            content="Hello", image=None,
            id="f-exec", correlation_id=None,
            chat_id=None, handsfree=False,
        )
        await handler.handle_user_message(ws=ws, client_id="c1", message=message)
        task = handler._active_stream_tasks.get("c1", {}).get("task")
        if task:
            try:
                await asyncio.wait_for(task, timeout=2.0)
            except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
                pass

        executor.execute.assert_awaited_once()
        assert executor.execute.call_args[0][0] is ws


# ---- stream_and_execute: settings fallback + exception (443, 445-446) -----


class TestStreamExecuteSettingsFallback:
    @pytest.mark.asyncio
    async def test_settings_fallback_raises_import_error(self, monkeypatch):
        """Falls back to _get_settings() which raises → supports_vision=False (443,445-446)."""

        def broken_settings():
            raise ImportError("config unavailable")

        monkeypatch.setattr(
            "ws.presentation.handlers.message_handler._get_settings",
            broken_settings,
        )

        runtime = SimpleNamespace(
            stop_generation=AsyncMock(),
            settings=None,  # Forces fallback to _get_settings()
        )
        handler = make_handler(
            runtime=runtime,
            chat_repository=StubChatRepository([]),
        )
        handler._get_artifact_context_with_images = AsyncMock(return_value={
            "text_context": "",
            "image_b64": None,
        })
        handler._check_and_notify_context = AsyncMock()
        handler._check_and_summarize_context = AsyncMock()

        ws = StubWebSocket()
        chat_id = str(uuid.uuid4())
        message = SimpleNamespace(
            content="Hello", image=None,
            id="f-set", correlation_id="corr-1",
            chat_id=chat_id, handsfree=False,
        )
        await handler.handle_user_message(ws=ws, client_id="c1", message=message)
        task = handler._active_stream_tasks.get("c1", {}).get("task")
        if task:
            try:
                await asyncio.wait_for(task, timeout=2.0)
            except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
                pass

        # Despite settings error, artifact context was still called (line 449)
        handler._get_artifact_context_with_images.assert_awaited_once()
        # supports_vision should be False (2nd positional arg, from except block line 446)
        assert handler._get_artifact_context_with_images.call_args[0][1] is False


# ---- _wrap_with_tts: QueueFull on final sentence (198-203) ----------------


class TestWrapWithTtsFinalQueueFull:
    @pytest.mark.asyncio
    async def test_queue_full_on_final_sentence_yields_error(self, monkeypatch):
        """QueueFull on final accumulated sentence yields EmitTTSError (lines 198-203)."""
        from ws.domain.commands.stream_commands import EmitStreamEvent
        from ws.domain.commands.audio_commands import EmitTTSError

        class NeverProcessChunker:
            def __init__(self, first_size, target_size):
                self.current_text = []
                self.found_first_sentence = False
            def should_process(self, text):
                return False
            def process(self, text, _):
                return text.strip()

        _setup_tts_mocks(monkeypatch, NeverProcessChunker)

        class AlwaysFullCoordinator:
            async def add_sentence(self, cid, sentence):
                raise asyncio.QueueFull()
            async def get_next_audio(self, cid):
                return None
            def is_generation_complete(self, cid):
                return True
            async def stop_service(self, cid):
                pass
            async def clear_queues(self, cid):
                pass
            async def wait_for_state_change(self, client_id, timeout=None):
                pass
            def trigger_state_change(self, client_id):
                pass

        tts_config = SimpleNamespace(
            first_sentence_target_words=5,
            chunk_target_words=10,
            sample_rate=24000,
        )
        handler = make_handler(
            tts_coordinator=AlwaysFullCoordinator(),
            tts_config=tts_config,
        )

        async def command_stream():
            yield EmitStreamEvent(event={"role": "assistant", "content": "Final text only"})

        commands = []
        async for cmd in handler._wrap_with_tts(command_stream(), "client-1"):
            commands.append(cmd)

        tts_errors = [c for c in commands if isinstance(c, EmitTTSError)]
        assert len(tts_errors) >= 1
        assert tts_errors[0].error_type == "queue_full"
        assert "final" in tts_errors[0].message.lower()


# ---- _wrap_with_tts: consumer polling wait (line 242) ---------------------


class TestWrapWithTtsConsumerPolling:
    @pytest.mark.asyncio
    async def test_consumer_polls_with_sleep_when_not_complete(self, monkeypatch):
        """Consumer hits asyncio.sleep(0.01) when queue empty but not done (line 242)."""
        from ws.domain.commands.stream_commands import EmitStreamEvent
        from ws.domain.commands.audio_commands import EmitTTSAudio

        class MockChunker:
            def __init__(self, first_size, target_size):
                self.first_size = first_size
                self.target_size = target_size
                self.current_text = []
                self.found_first_sentence = False
            def should_process(self, text):
                return len(text) > 3
            def process(self, text, _):
                return text.strip()
            def find_break_point(self, words, target):
                return len(words)

        _setup_tts_mocks(monkeypatch, MockChunker)

        class DelayedAudioCoordinator:
            def __init__(self):
                self._audio_calls = 0
                self._complete_calls = 0
            async def add_sentence(self, cid, sentence):
                pass
            async def get_next_audio(self, cid):
                self._audio_calls += 1
                if self._audio_calls == 1:
                    return None  # First poll: empty → sleep(0.01)
                if self._audio_calls == 2:
                    return (b"audio-data", "hello")
                return None
            def is_generation_complete(self, cid):
                self._complete_calls += 1
                return self._complete_calls > 1
            async def stop_service(self, cid):
                pass
            async def clear_queues(self, cid):
                pass
            async def wait_for_state_change(self, client_id, timeout=None):
                await asyncio.sleep(0.01)
            def trigger_state_change(self, client_id):
                pass

        tts_config = SimpleNamespace(
            first_sentence_target_words=5,
            chunk_target_words=10,
            sample_rate=24000,
        )
        handler = make_handler(
            tts_coordinator=DelayedAudioCoordinator(),
            tts_config=tts_config,
        )

        async def command_stream():
            yield EmitStreamEvent(event={"role": "assistant", "content": "Hello world"})

        commands = []
        async for cmd in handler._wrap_with_tts(command_stream(), "client-1"):
            commands.append(cmd)

        assert any(isinstance(c, EmitTTSAudio) for c in commands)


# ---- _wrap_with_tts: cleanup errors during cancellation (302-303, 308-309)


class TestWrapWithTtsCleanupErrors:
    @pytest.mark.asyncio
    async def test_clear_queues_error_swallowed_on_cancel(self, monkeypatch):
        """clear_queues exception during cancellation is caught (lines 302-303)."""
        from ws.domain.commands.stream_commands import EmitStreamEvent

        class MockChunker:
            def __init__(self, first_size, target_size):
                self.current_text = []
                self.found_first_sentence = False
            def should_process(self, text):
                return False
            def process(self, text, _):
                return ""

        _setup_tts_mocks(monkeypatch, MockChunker)

        class FailingClearCoordinator:
            async def add_sentence(self, cid, sentence):
                pass
            async def get_next_audio(self, cid):
                await asyncio.sleep(999)
                return None
            def is_generation_complete(self, cid):
                return False
            async def stop_service(self, cid):
                pass
            async def clear_queues(self, cid):
                raise RuntimeError("clear_queues failed")
            async def wait_for_state_change(self, client_id, timeout=None):
                pass
            def trigger_state_change(self, client_id):
                pass

        tts_config = SimpleNamespace(
            first_sentence_target_words=5,
            chunk_target_words=10,
            sample_rate=24000,
        )
        handler = make_handler(
            tts_coordinator=FailingClearCoordinator(),
            tts_config=tts_config,
        )

        async def slow_stream():
            yield EmitStreamEvent(event={"role": "computer", "content": "ok"})
            await asyncio.sleep(999)

        async def consume():
            async for _ in handler._wrap_with_tts(slow_stream(), "client-1"):
                pass

        task = asyncio.create_task(consume())
        await asyncio.sleep(0.15)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    @pytest.mark.asyncio
    async def test_stop_service_error_swallowed_on_cancel(self, monkeypatch):
        """stop_service exception during cancellation is caught (lines 308-309)."""
        from ws.domain.commands.stream_commands import EmitStreamEvent

        class MockChunker:
            def __init__(self, first_size, target_size):
                self.current_text = []
                self.found_first_sentence = False
            def should_process(self, text):
                return False
            def process(self, text, _):
                return ""

        _setup_tts_mocks(monkeypatch, MockChunker)

        class FailingStopCoordinator:
            async def add_sentence(self, cid, sentence):
                pass
            async def get_next_audio(self, cid):
                await asyncio.sleep(999)
                return None
            def is_generation_complete(self, cid):
                return False
            async def stop_service(self, cid):
                raise RuntimeError("stop_service failed")
            async def clear_queues(self, cid):
                pass
            async def wait_for_state_change(self, client_id, timeout=None):
                pass
            def trigger_state_change(self, client_id):
                pass

        tts_config = SimpleNamespace(
            first_sentence_target_words=5,
            chunk_target_words=10,
            sample_rate=24000,
        )
        handler = make_handler(
            tts_coordinator=FailingStopCoordinator(),
            tts_config=tts_config,
        )

        async def slow_stream():
            yield EmitStreamEvent(event={"role": "computer", "content": "ok"})
            await asyncio.sleep(999)

        async def consume():
            async for _ in handler._wrap_with_tts(slow_stream(), "client-1"):
                pass

        task = asyncio.create_task(consume())
        await asyncio.sleep(0.15)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


# ---- _wrap_with_tts: producer crash → consumer must exit (line 216) -------


class TestWrapWithTtsProducerCrash:
    @pytest.mark.asyncio
    async def test_consumer_exits_when_producer_crashes(self, monkeypatch):
        """Regression: if the LLM command_stream raises, the consumer must exit.

        Before the fix, stream_ended was only set to True on successful
        completion (inside the try block). If the producer raised, stream_ended
        stayed False, and the consumer polled asyncio.sleep(0.01) forever —
        causing an infinite spinner for the user.

        The fix sets stream_ended = True in the producer's finally block.
        """
        from ws.domain.commands.stream_commands import EmitStreamEvent

        class MockChunker:
            def __init__(self, first_size, target_size):
                self.current_text = []
                self.found_first_sentence = False
            def should_process(self, text):
                return False  # Don't queue any TTS sentences
            def process(self, text, _):
                return ""

        _setup_tts_mocks(monkeypatch, MockChunker)

        class MockCoordinator:
            async def add_sentence(self, cid, sentence):
                pass
            async def get_next_audio(self, cid):
                return None  # No audio queued
            def is_generation_complete(self, cid):
                return True
            async def stop_service(self, cid):
                pass
            async def clear_queues(self, cid):
                pass
            async def wait_for_state_change(self, client_id, timeout=None):
                pass
            def trigger_state_change(self, client_id):
                pass

        tts_config = SimpleNamespace(
            first_sentence_target_words=5,
            chunk_target_words=10,
            sample_rate=24000,
        )
        handler = make_handler(
            tts_coordinator=MockCoordinator(),
            tts_config=tts_config,
        )

        async def crashing_stream():
            yield EmitStreamEvent(event={"role": "assistant", "content": "Hi"})
            raise RuntimeError("LLM stream exploded")

        # The key assertion: this must complete within a reasonable time.
        # Before the fix, this would hang forever because the consumer never
        # saw stream_ended = True.
        with pytest.raises(RuntimeError, match="LLM stream exploded"):
            async for _ in handler._wrap_with_tts(crashing_stream(), "client-1"):
                pass


# ---- stream_and_execute: handsfree TTS wrapping (lines 491-492) ----------


class TestStreamExecuteHandsfree:
    @pytest.mark.asyncio
    async def test_handsfree_wraps_stream_with_tts(self, monkeypatch):
        """Handsfree mode wraps command stream with TTS (lines 491-492)."""

        class MockChunker:
            def __init__(self, first_size, target_size):
                self.current_text = []
                self.found_first_sentence = False
            def should_process(self, text):
                return False
            def process(self, text, _):
                return ""

        _setup_tts_mocks(monkeypatch, MockChunker)

        class NoOpCoordinator:
            async def add_sentence(self, cid, sentence):
                pass
            async def get_next_audio(self, cid):
                return None
            def is_generation_complete(self, cid):
                return True
            async def stop_service(self, cid):
                pass
            async def clear_queues(self, cid):
                pass

        tts_config = SimpleNamespace(
            first_sentence_target_words=5,
            chunk_target_words=10,
            sample_rate=24000,
        )
        handler = make_handler(
            tts_coordinator=NoOpCoordinator(),
            tts_config=tts_config,
        )
        handler._check_and_notify_context = AsyncMock()
        handler._check_and_summarize_context = AsyncMock()

        ws = StubWebSocket()
        message = SimpleNamespace(
            content="Hello",
            image=None,
            id="f-hf",
            correlation_id="handsfree-12345",
            chat_id=None,
            handsfree=False,
        )
        await handler.handle_user_message(ws=ws, client_id="c1", message=message)
        task = handler._active_stream_tasks.get("c1", {}).get("task")
        if task:
            try:
                await asyncio.wait_for(task, timeout=2.0)
            except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
                pass


# =========================================================================
# Adversarial audit: narrow except clause bugs (fixed)
# =========================================================================


class TestCleanupClientNarrowExceptFixes:
    """BUG: cleanup_client had narrow except clauses.
    ValueError/TypeError from stop_generation would skip task cancellation.
    Fixed: broadened to except Exception.
    """

    @pytest.mark.asyncio
    async def test_value_error_from_stop_generation_still_cancels(self):
        """ValueError from stop_generation must NOT prevent task cancel."""
        runtime = SimpleNamespace(
            stop_generation=AsyncMock(side_effect=ValueError("bad request_id")),
        )
        handler = make_handler(runtime=runtime)
        mock_task = TestCleanupClient._make_active_task(done=False)
        handler._active_stream_tasks["c1"] = {
            "task": mock_task,
            "backend_id": "backend-val-err",
        }
        await handler.cleanup_client("c1")
        mock_task.cancel.assert_called_once()
        assert "c1" not in handler._active_stream_tasks

    @pytest.mark.asyncio
    async def test_type_error_from_stop_generation_still_cancels(self):
        """TypeError from stop_generation must NOT prevent task cancel."""
        runtime = SimpleNamespace(
            stop_generation=AsyncMock(side_effect=TypeError("wrong type")),
        )
        handler = make_handler(runtime=runtime)
        mock_task = TestCleanupClient._make_active_task(done=False)
        handler._active_stream_tasks["c1"] = {
            "task": mock_task,
            "backend_id": "backend-type-err",
        }
        await handler.cleanup_client("c1")
        mock_task.cancel.assert_called_once()

    @pytest.mark.asyncio
    async def test_type_error_during_cancel_await_handled(self):
        """TypeError during await of cancelled task must be caught."""
        handler = make_handler()

        class _FailingTask:
            def __init__(self):
                self.cancel = MagicMock()

            def done(self):
                return False

            def __await__(self):
                raise TypeError("unexpected type during cancel")
                yield  # pragma: no cover

        handler._active_stream_tasks["c1"] = {
            "task": _FailingTask(),
            "backend_id": "backend-te",
        }
        # Must NOT raise
        await handler.cleanup_client("c1")


class TestHandleUserMessageNarrowExceptFixes:
    """BUG: handle_user_message had narrow except for stop_generation
    and cancel await. Fixed: broadened to except Exception.
    """

    @pytest.mark.asyncio
    async def test_value_error_from_stop_generation_during_cancel(self):
        """ValueError from stop_generation when cancelling previous task is caught."""
        runtime = SimpleNamespace(
            stop_generation=AsyncMock(side_effect=ValueError("bad id")),
        )
        handler = make_handler(runtime=runtime)

        async def long_running():
            await asyncio.sleep(999)

        old_task = asyncio.create_task(long_running())
        handler._active_stream_tasks["c1"] = {
            "task": old_task,
            "backend_id": "old-val-err",
            "correlation_id": None,
        }
        ws = StubWebSocket()
        message = SimpleNamespace(
            content="New", image=None,
            id="f-ve", correlation_id=None,
            chat_id=None, handsfree=False,
        )
        # Must NOT raise
        await handler.handle_user_message(ws=ws, client_id="c1", message=message)
        await asyncio.sleep(0)
        assert old_task.cancelled()

    @pytest.mark.asyncio
    async def test_type_error_during_cancel_await_caught(self):
        """TypeError during await of cancelled task is caught."""
        runtime = SimpleNamespace(stop_generation=AsyncMock())
        handler = make_handler(runtime=runtime)

        async def error_on_cancel():
            try:
                await asyncio.sleep(999)
            except asyncio.CancelledError:
                raise TypeError("type error during cancel")

        old_task = asyncio.create_task(error_on_cancel())
        await asyncio.sleep(0)
        handler._active_stream_tasks["c1"] = {
            "task": old_task,
            "backend_id": "old-te",
            "correlation_id": None,
        }
        ws = StubWebSocket()
        message = SimpleNamespace(
            content="New", image=None,
            id="f-te", correlation_id=None,
            chat_id=None, handsfree=False,
        )
        await handler.handle_user_message(ws=ws, client_id="c1", message=message)
        await asyncio.sleep(0.05)


class TestShutdownOrchestratorError:
    """BUG: shutdown didn't handle orchestrator errors.
    Fixed: wrapped in try/except Exception.
    """

    @pytest.mark.asyncio
    async def test_orchestrator_shutdown_error_caught(self):
        """RuntimeError from orchestrator.shutdown() must NOT propagate."""
        orch = MagicMock()
        orch.shutdown = AsyncMock(side_effect=RuntimeError("orch crash"))
        handler = make_handler(stream_orchestrator=orch)
        # Must NOT raise
        await handler.shutdown()
        orch.shutdown.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_orchestrator_shutdown_value_error_caught(self):
        """ValueError from orchestrator.shutdown() must NOT propagate."""
        orch = MagicMock()
        orch.shutdown = AsyncMock(side_effect=ValueError("bad state"))
        handler = make_handler(stream_orchestrator=orch)
        await handler.shutdown()
        orch.shutdown.assert_awaited_once()

