"""
Unit Tests: ChatSummarizationService

Tests the background chat summarization service — preference checking,
HTTP API call for summarization, and error handling.

Bugs found and fixed:
1. ImportError not caught in check_and_summarize (line 79) — lazy import of
   PreferencesRepository can fail. Fixed: added ImportError to except clause.
2. ImportError not caught in _summarize (line 133) — lazy imports of httpx
   and config.settings can fail. Fixed: added ImportError to except clause.
3. AttributeError not caught in _summarize (line 133) — settings.http_client
   access can fail if settings object is misconfigured. Fixed: added
   AttributeError to except clause.
4. AttributeError not caught in _summarize (line 133) — response.json()
   returning None causes summary.get() to fail. Fixed: same AttributeError fix.
"""

import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4


from ws.application.chat_summarization_service import ChatSummarizationService


# =========================================================================
# Constants & Patch Targets
# =========================================================================

CHAT_ID = str(uuid4())

# Lazy import targets — patched at their SOURCE modules, not at the consuming module.
PATCH_PREFS = "data.database.repositories.preferences.PreferencesRepository"
PATCH_GET_SETTINGS = "config.settings.get_settings"
PATCH_HTTPX_CLIENT = "httpx.AsyncClient"


# =========================================================================
# Helpers
# =========================================================================

def _mock_settings(base_url="http://localhost:8765", timeout=30):
    """Create mock settings with base_url and http_client.llm_timeout."""
    return SimpleNamespace(
        base_url=base_url,
        http_client=SimpleNamespace(llm_timeout=timeout),
    )


def _mock_response(status_code=200, json_data=None):
    """Create mock HTTP response."""
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = json_data or {
        "title": "Test summary title",
        "llm_model": "liquid/lfm2.5-1.2b",
    }
    return resp


def _setup_http(mock_cls, status_code=200, json_data=None, post_side_effect=None):
    """Configure mock httpx.AsyncClient. Returns (client, response).

    Explicitly wires __aenter__ to return client (not a child mock)
    because AsyncMock.__aenter__ returns self.aenter by default.
    """
    response = _mock_response(status_code, json_data)
    client = AsyncMock()
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    if post_side_effect:
        client.post.side_effect = post_side_effect
    else:
        client.post.return_value = response
    mock_cls.return_value = client
    return client, response


def _svc(with_gateway=True):
    """Create ChatSummarizationService with mock chat_repository."""
    repo = MagicMock()
    if not with_gateway:
        repo._gateway = None
    return ChatSummarizationService(chat_repository=repo)


# =========================================================================
# Init
# =========================================================================

class TestInit:
    """Tests for ChatSummarizationService.__init__."""

    def test_stores_repo(self):
        repo = MagicMock()
        svc = ChatSummarizationService(chat_repository=repo)
        assert svc._chat_repository is repo

    def test_default_none_repo(self):
        svc = ChatSummarizationService()
        assert svc._chat_repository is None


# =========================================================================
# check_and_summarize — guard conditions
# =========================================================================

class TestCheckAndSummarizeGuards:
    """Tests for early-return guards (lines 44, 50)."""

    async def test_no_repo_returns_immediately(self):
        """No chat_repository (line 44) → returns before any logging or imports."""
        svc = ChatSummarizationService()
        with patch.object(svc._logger, "error") as mock_err, \
             patch.object(svc._logger, "info") as mock_info:
            await svc.check_and_summarize(CHAT_ID)
            mock_err.assert_not_called()
            mock_info.assert_not_called()

    @patch(PATCH_PREFS)
    async def test_no_gateway_returns_before_instantiation(self, mock_prefs_cls):
        """_gateway=None (line 50) → returns without instantiating PreferencesRepository."""
        svc = _svc(with_gateway=False)
        await svc.check_and_summarize(CHAT_ID)
        mock_prefs_cls.assert_not_called()


# =========================================================================
# check_and_summarize — preference logic
# =========================================================================

class TestCheckAndSummarizePreferences:
    """Tests for preference checking and _summarize gating (lines 56-77)."""

    @patch(PATCH_PREFS)
    async def test_pref_disabled_skips_summarize(self, mock_prefs_cls):
        """auto_summarize=False → _summarize not called."""
        instance = AsyncMock()
        instance.get_preference.return_value = {"auto_summarize": False}
        mock_prefs_cls.return_value = instance

        svc = _svc()
        svc._summarize = AsyncMock()
        await svc.check_and_summarize(CHAT_ID)

        instance.get_preference.assert_awaited_once_with(
            preference_key="summary",
            default_value={"auto_summarize": False},
        )
        svc._summarize.assert_not_awaited()

    @patch(PATCH_PREFS)
    async def test_pref_enabled_triggers_summarize(self, mock_prefs_cls):
        """auto_summarize=True → _summarize called with chat_id."""
        instance = AsyncMock()
        instance.get_preference.return_value = {"auto_summarize": True}
        mock_prefs_cls.return_value = instance

        svc = _svc()
        svc._summarize = AsyncMock()
        await svc.check_and_summarize(CHAT_ID)

        svc._summarize.assert_awaited_once_with(CHAT_ID)

    @patch(PATCH_PREFS)
    async def test_pref_not_dict_treated_as_disabled(self, mock_prefs_cls):
        """Non-dict value → isinstance check → is_enabled=False."""
        instance = AsyncMock()
        instance.get_preference.return_value = "not-a-dict"
        mock_prefs_cls.return_value = instance

        svc = _svc()
        svc._summarize = AsyncMock()
        await svc.check_and_summarize(CHAT_ID)

        svc._summarize.assert_not_awaited()

    @patch(PATCH_PREFS)
    async def test_pref_dict_without_auto_summarize_key(self, mock_prefs_cls):
        """Dict without 'auto_summarize' → .get() defaults to False."""
        instance = AsyncMock()
        instance.get_preference.return_value = {"other_key": True}
        mock_prefs_cls.return_value = instance

        svc = _svc()
        svc._summarize = AsyncMock()
        await svc.check_and_summarize(CHAT_ID)

        svc._summarize.assert_not_awaited()

    @patch(PATCH_PREFS)
    async def test_pref_none_return(self, mock_prefs_cls):
        """get_preference returns None → isinstance(None, dict)=False → disabled."""
        instance = AsyncMock()
        instance.get_preference.return_value = None
        mock_prefs_cls.return_value = instance

        svc = _svc()
        svc._summarize = AsyncMock()
        await svc.check_and_summarize(CHAT_ID)

        svc._summarize.assert_not_awaited()

    @patch(PATCH_PREFS)
    async def test_truthy_string_auto_summarize_value_triggers_summarize(self, mock_prefs_cls):
        """
        auto_summarize="false" (string) — truthy under bool(), so is_enabled=True.
        Documents the behavior: no type-checking on the value.
        """
        instance = AsyncMock()
        instance.get_preference.return_value = {"auto_summarize": "false"}
        mock_prefs_cls.return_value = instance

        svc = _svc()
        svc._summarize = AsyncMock()
        await svc.check_and_summarize(CHAT_ID)

        svc._summarize.assert_awaited_once_with(CHAT_ID)

    @patch(PATCH_PREFS)
    async def test_settings_ui_save_enabled_true_auto_summarize_false_does_not_trigger(self, mock_prefs_cls):
        """
        Real-world scenario: Settings UI always saves enabled=true (section visited),
        but the user toggled auto_summarize OFF. Service must NOT trigger.
        This proves the service checks 'auto_summarize', not 'enabled'.
        """
        instance = AsyncMock()
        instance.get_preference.return_value = {
            "enabled": True,
            "auto_summarize": False,
            "model": "liquid/lfm2.5-1.2b",
            "temperature": 0.3,
        }
        mock_prefs_cls.return_value = instance

        svc = _svc()
        svc._summarize = AsyncMock()
        await svc.check_and_summarize(CHAT_ID)

        svc._summarize.assert_not_awaited()

    @patch(PATCH_PREFS)
    async def test_settings_ui_save_enabled_true_auto_summarize_true_triggers(self, mock_prefs_cls):
        """
        Real-world scenario: Settings UI saves full config with auto_summarize=True.
        Service must trigger.
        """
        instance = AsyncMock()
        instance.get_preference.return_value = {
            "enabled": True,
            "auto_summarize": True,
            "model": "liquid/lfm2.5-1.2b",
            "temperature": 0.3,
        }
        mock_prefs_cls.return_value = instance

        svc = _svc()
        svc._summarize = AsyncMock()
        await svc.check_and_summarize(CHAT_ID)

        svc._summarize.assert_awaited_once_with(CHAT_ID)

    @patch(PATCH_PREFS)
    async def test_passes_gateway_to_prefs_constructor(self, mock_prefs_cls):
        """PreferencesRepository is instantiated with the repository's _gateway."""
        instance = AsyncMock()
        instance.get_preference.return_value = {"auto_summarize": False}
        mock_prefs_cls.return_value = instance

        repo = MagicMock()
        gateway_sentinel = MagicMock(name="gateway-sentinel")
        repo._gateway = gateway_sentinel

        svc = ChatSummarizationService(chat_repository=repo)
        await svc.check_and_summarize(CHAT_ID)

        mock_prefs_cls.assert_called_once_with(gateway_sentinel)


# =========================================================================
# check_and_summarize — error handling
# =========================================================================

class TestCheckAndSummarizeErrors:
    """Tests for exception handling in check_and_summarize (line 79)."""

    @patch(PATCH_PREFS)
    async def test_connection_error_caught(self, mock_prefs_cls):
        """ConnectionError → caught, error + debug logged."""
        instance = AsyncMock()
        instance.get_preference.side_effect = ConnectionError("DB down")
        mock_prefs_cls.return_value = instance

        svc = _svc()
        with patch.object(svc._logger, "error") as mock_err, \
             patch.object(svc._logger, "debug") as mock_debug:
            await svc.check_and_summarize(CHAT_ID)
            mock_err.assert_called_once()
            assert mock_err.call_args[0][0] == "Failed to check auto_summarize preference for chat %s: %s"
            assert mock_err.call_args[0][1] == CHAT_ID[:8]
            assert str(mock_err.call_args[0][2]) == "DB down"
            assert mock_err.call_args[1].get("exc_info") is False
            mock_debug.assert_called_once()

    @patch(PATCH_PREFS)
    async def test_timeout_error_caught(self, mock_prefs_cls):
        """TimeoutError → caught, error + debug logged."""
        instance = AsyncMock()
        instance.get_preference.side_effect = TimeoutError("timed out")
        mock_prefs_cls.return_value = instance

        svc = _svc()
        with patch.object(svc._logger, "error") as mock_err:
            await svc.check_and_summarize(CHAT_ID)
            mock_err.assert_called_once()
            assert str(mock_err.call_args[0][2]) == "timed out"

    @patch(PATCH_PREFS)
    async def test_value_error_caught(self, mock_prefs_cls):
        """ValueError → caught, error logged."""
        instance = AsyncMock()
        instance.get_preference.side_effect = ValueError("bad")
        mock_prefs_cls.return_value = instance

        svc = _svc()
        with patch.object(svc._logger, "error") as mock_err:
            await svc.check_and_summarize(CHAT_ID)
            mock_err.assert_called_once()
            assert str(mock_err.call_args[0][2]) == "bad"

    @patch(PATCH_PREFS)
    async def test_key_error_caught(self, mock_prefs_cls):
        """KeyError → caught, error logged."""
        instance = AsyncMock()
        instance.get_preference.side_effect = KeyError("missing")
        mock_prefs_cls.return_value = instance

        svc = _svc()
        with patch.object(svc._logger, "error") as mock_err:
            await svc.check_and_summarize(CHAT_ID)
            mock_err.assert_called_once()
            assert mock_err.call_args[0][0] == "Failed to check auto_summarize preference for chat %s: %s"

    async def test_import_error_caught(self):
        """ImportError from PreferencesRepository import → caught, error logged."""
        svc = _svc()
        with patch.dict(sys.modules, {"data.database.repositories.preferences": None}), \
             patch.object(svc._logger, "error") as mock_err:
            await svc.check_and_summarize(CHAT_ID)
            mock_err.assert_called_once()
            assert mock_err.call_args[0][0] == "Failed to check auto_summarize preference for chat %s: %s"


# =========================================================================
# _summarize — success paths
# =========================================================================

PATCH_AGENT_SERVICE = "application.agents.agent_service.AgentService"

class TestSummarize:
    """Tests for _summarize queueing logic."""

    @patch(PATCH_AGENT_SERVICE)
    async def test_success_queues_job(self, mock_agent_service_cls):
        """Valid chat_id → queues job successfully."""
        mock_instance = AsyncMock()
        mock_instance.queue_agent_job.return_value = "job-123"
        mock_agent_service_cls.return_value = mock_instance
        
        svc = _svc()
        with patch.object(svc._logger, "info") as mock_info:
            await svc._summarize(CHAT_ID)
            
            mock_agent_service_cls.assert_called_once_with(svc._chat_repository._gateway)
            mock_instance.queue_agent_job.assert_awaited_once_with(
                job_type="summarize_chat",
                payload={
                    "chat_id": CHAT_ID,
                    "summary_type": "full",
                    "force_regenerate": True
                },
                priority=50
            )
            mock_info.assert_called_once()
            assert mock_info.call_args[0][0] == "Auto-summary job queued: chat=%s, job_id=%s"

    @patch(PATCH_AGENT_SERVICE)
    async def test_no_job_id_logs_warning(self, mock_agent_service_cls):
        """Queueing returns None/falsy → logs warning."""
        mock_instance = AsyncMock()
        mock_instance.queue_agent_job.return_value = None
        mock_agent_service_cls.return_value = mock_instance
        
        svc = _svc()
        with patch.object(svc._logger, "warning") as mock_warn:
            await svc._summarize(CHAT_ID)
            
            mock_warn.assert_called_once()
            assert mock_warn.call_args[0][0] == "Failed to queue auto-summary job: chat=%s"

    async def test_no_gateway_returns_early(self):
        """No database gateway → logs error and returns."""
        svc = _svc(with_gateway=False)
        with patch.object(svc._logger, "error") as mock_err:
            await svc._summarize(CHAT_ID)
            
            mock_err.assert_called_once_with("Cannot queue auto-summary: no database gateway available")

    async def test_invalid_chat_uuid_returns_early(self):
        """Invalid chat UUID → logs error and returns."""
        svc = _svc()
        with patch.object(svc._logger, "error") as mock_err:
            await svc._summarize("not-a-uuid")
            
            mock_err.assert_called_once_with("Cannot queue auto-summary: invalid chat_id format")


# =========================================================================
# _summarize — error handling
# =========================================================================

class TestSummarizeErrors:
    """Tests for exception handling in _summarize."""

    @patch(PATCH_AGENT_SERVICE)
    async def test_connection_error_caught(self, mock_agent_service_cls):
        """ConnectionError → caught, error logged with chat_id and message."""
        mock_instance = AsyncMock()
        mock_instance.queue_agent_job.side_effect = ConnectionError("db down")
        mock_agent_service_cls.return_value = mock_instance
        
        svc = _svc()
        with patch.object(svc._logger, "error") as mock_err:
            await svc._summarize(CHAT_ID)
            
            mock_err.assert_called_once()
            assert mock_err.call_args[0][0] == "Auto-summarization error for chat %s: %s"
            assert mock_err.call_args[0][1] == CHAT_ID[:8]
            assert str(mock_err.call_args[0][2]) == "db down"

    @patch(PATCH_AGENT_SERVICE)
    async def test_timeout_error_caught(self, mock_agent_service_cls):
        """TimeoutError → caught, error logged."""
        mock_instance = AsyncMock()
        mock_instance.queue_agent_job.side_effect = TimeoutError("timed out")
        mock_agent_service_cls.return_value = mock_instance
        
        svc = _svc()
        with patch.object(svc._logger, "error") as mock_err:
            await svc._summarize(CHAT_ID)
            
            mock_err.assert_called_once()
            assert str(mock_err.call_args[0][2]) == "timed out"

    @patch(PATCH_AGENT_SERVICE)
    async def test_os_error_caught(self, mock_agent_service_cls):
        """OSError → caught, error logged."""
        mock_instance = AsyncMock()
        mock_instance.queue_agent_job.side_effect = OSError("network")
        mock_agent_service_cls.return_value = mock_instance
        
        svc = _svc()
        with patch.object(svc._logger, "error") as mock_err:
            await svc._summarize(CHAT_ID)
            
            mock_err.assert_called_once()
            assert str(mock_err.call_args[0][2]) == "network"

    async def test_agent_service_import_error_caught(self):
        """ImportError from `import AgentService` → caught, error logged."""
        svc = _svc()
        with patch.dict(sys.modules, {"application.agents.agent_service": None}), \
             patch.object(svc._logger, "error") as mock_err:
            await svc._summarize(CHAT_ID)
            
            mock_err.assert_called_once()
            assert mock_err.call_args[0][0] == "Auto-summarization error for chat %s: %s"
