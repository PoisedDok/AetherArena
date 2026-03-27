"""
Unit tests for security/auth.py — AuthenticationManager, AuthConfig, convenience functions.

Adversarial: every method tested, every branch forced, every error path verified.
Real Hasher used for crypto operations; only get_secret_manager and
get_permission_manager are mocked (they access filesystem / global state).

CI: pytest tests/unit/security/test_auth.py -m unit --no-cov -q
"""

from datetime import datetime, timedelta, timezone
from unittest.mock import patch, MagicMock

import pytest

from security.auth import (
    AuthConfig,
    AuthenticationError,
    AuthenticationManager,
    ExpiredTokenError,
    InvalidTokenError,
)
from security.permissions import Role, User, AuthorizationContext


# ---------------------------------------------------------------------------
# Shared fixture: patch get_secret_manager + get_permission_manager
# to avoid filesystem access and global singleton side-effects.
# ---------------------------------------------------------------------------

@pytest.fixture
def auth_mgr():
    """Fresh AuthenticationManager with default config, patched singletons."""
    with (
        patch("security.auth.get_secret_manager", return_value=MagicMock()),
        patch("security.auth.get_permission_manager", return_value=MagicMock()),
    ):
        yield AuthenticationManager()


@pytest.fixture
def strict_mgr():
    """AuthenticationManager with require_api_key=True, allow_anonymous=False."""
    config = AuthConfig(require_api_key=True, allow_anonymous=False)
    with (
        patch("security.auth.get_secret_manager", return_value=MagicMock()),
        patch("security.auth.get_permission_manager", return_value=MagicMock()),
    ):
        yield AuthenticationManager(config)


@pytest.fixture
def no_bearer_mgr():
    """AuthenticationManager with allow_bearer_tokens=False."""
    config = AuthConfig(allow_bearer_tokens=False)
    with (
        patch("security.auth.get_secret_manager", return_value=MagicMock()),
        patch("security.auth.get_permission_manager", return_value=MagicMock()),
    ):
        yield AuthenticationManager(config)


# ===========================================================================
# AuthConfig defaults
# ===========================================================================

class TestAuthConfigDefaults:
    """Verify dataclass defaults match documented expectations."""

    def test_default_values(self):
        config = AuthConfig()
        assert config.require_api_key is False
        assert config.api_key_header == "X-API-Key"
        assert config.token_expiry_hours == 24
        assert config.allow_bearer_tokens is True
        assert config.session_enabled is False
        assert config.session_cookie_name == "aether_session"
        assert config.session_expiry_hours == 24
        assert config.allow_anonymous is True
        assert config.default_role == Role.USER

    def test_custom_config(self):
        config = AuthConfig(
            require_api_key=True,
            token_expiry_hours=1,
            allow_anonymous=False,
            default_role=Role.ADMIN,
        )
        assert config.require_api_key is True
        assert config.token_expiry_hours == 1
        assert config.allow_anonymous is False
        assert config.default_role == Role.ADMIN


# ===========================================================================
# AuthenticationManager Initialization
# ===========================================================================

class TestAuthManagerInit:
    """Verify init wires config and dependencies."""

    def test_default_config_when_none(self, auth_mgr):
        assert auth_mgr.config is not None
        assert isinstance(auth_mgr.config, AuthConfig)
        assert auth_mgr.config.require_api_key is False

    def test_custom_config_applied(self, strict_mgr):
        assert strict_mgr.config.require_api_key is True
        assert strict_mgr.config.allow_anonymous is False

    def test_internal_registries_empty_on_init(self, auth_mgr):
        assert auth_mgr._api_keys == {}
        assert auth_mgr._tokens == {}

    def test_dependencies_wired(self, auth_mgr):
        assert auth_mgr._hasher is not None
        assert auth_mgr._secret_manager is not None
        assert auth_mgr._perm_manager is not None


# ===========================================================================
# API Key Management — register_api_key
# ===========================================================================

class TestRegisterApiKey:
    """API key registration: generation, import, duplicate detection."""

    def test_register_generates_key(self, auth_mgr):
        key = auth_mgr.register_api_key(user_id="user_1", role=Role.USER)
        assert key is not None
        assert isinstance(key, str)
        assert len(key) > 10  # Generated key should be substantial

    def test_register_stores_hashed_key(self, auth_mgr):
        key = auth_mgr.register_api_key(user_id="user_1")
        # Internal registry should have exactly one entry
        assert len(auth_mgr._api_keys) == 1
        # Key in registry is the HASH, not the plaintext
        assert key not in auth_mgr._api_keys

    def test_register_stores_correct_metadata(self, auth_mgr):
        auth_mgr.register_api_key(
            user_id="user_1",
            role=Role.ADMIN,
            description="Test key",
            metadata={"team": "core"},
        )
        entry = list(auth_mgr._api_keys.values())[0]
        assert entry["user_id"] == "user_1"
        assert entry["role"] == Role.ADMIN
        assert entry["description"] == "Test key"
        assert entry["metadata"] == {"team": "core"}
        assert entry["enabled"] is True
        assert entry["last_used"] is None
        assert "created_at" in entry

    def test_register_with_existing_key_import(self, auth_mgr):
        """Import a pre-existing API key (plaintext provided by caller)."""
        imported_key = "my_custom_key_12345"
        returned = auth_mgr.register_api_key(
            user_id="user_import", api_key=imported_key,
        )
        assert returned == imported_key
        assert len(auth_mgr._api_keys) == 1

    def test_duplicate_key_import_skipped(self, auth_mgr):
        """Importing same key twice should NOT overwrite."""
        key = "same_key_twice"
        auth_mgr.register_api_key(user_id="user_a", api_key=key)
        auth_mgr.register_api_key(user_id="user_b", api_key=key)
        # Still exactly one entry
        assert len(auth_mgr._api_keys) == 1
        entry = list(auth_mgr._api_keys.values())[0]
        assert entry["user_id"] == "user_a"  # First registration wins

    def test_default_role_is_user(self, auth_mgr):
        auth_mgr.register_api_key(user_id="u1")
        entry = list(auth_mgr._api_keys.values())[0]
        assert entry["role"] == Role.USER

    def test_none_metadata_becomes_empty_dict(self, auth_mgr):
        auth_mgr.register_api_key(user_id="u1", metadata=None)
        entry = list(auth_mgr._api_keys.values())[0]
        assert entry["metadata"] == {}

    def test_multiple_keys_for_same_user(self, auth_mgr):
        """Different generated keys for same user are allowed."""
        key1 = auth_mgr.register_api_key(user_id="user_multi")
        key2 = auth_mgr.register_api_key(user_id="user_multi")
        assert key1 != key2
        assert len(auth_mgr._api_keys) == 2


# ===========================================================================
# API Key Management — revoke_api_key
# ===========================================================================

class TestRevokeApiKey:
    """API key revocation: disable existing, handle unknown."""

    def test_revoke_existing_key(self, auth_mgr):
        key = auth_mgr.register_api_key(user_id="user_1")
        auth_mgr.revoke_api_key(key)
        entry = list(auth_mgr._api_keys.values())[0]
        assert entry["enabled"] is False

    def test_revoke_unknown_key_no_error(self, auth_mgr):
        """Revoking unknown key should not raise (logs warning)."""
        auth_mgr.revoke_api_key("nonexistent_key")
        # No exception raised
        assert len(auth_mgr._api_keys) == 0

    def test_revoke_idempotent(self, auth_mgr):
        """Revoking same key twice should be safe."""
        key = auth_mgr.register_api_key(user_id="user_1")
        auth_mgr.revoke_api_key(key)
        auth_mgr.revoke_api_key(key)  # Second revoke
        entry = list(auth_mgr._api_keys.values())[0]
        assert entry["enabled"] is False


# ===========================================================================
# API Key Management — validate_api_key
# ===========================================================================

class TestValidateApiKey:
    """API key validation: success, invalid, revoked, last_used tracking."""

    def test_validate_success_returns_user(self, auth_mgr):
        key = auth_mgr.register_api_key(user_id="user_1", role=Role.ADMIN)
        user = auth_mgr.validate_api_key(key)
        assert isinstance(user, User)
        assert user.user_id == "user_1"
        assert user.role == Role.ADMIN

    def test_validate_updates_last_used(self, auth_mgr):
        key = auth_mgr.register_api_key(user_id="user_1")
        entry_before = list(auth_mgr._api_keys.values())[0]
        assert entry_before["last_used"] is None
        auth_mgr.validate_api_key(key)
        entry_after = list(auth_mgr._api_keys.values())[0]
        assert entry_after["last_used"] is not None

    def test_validate_invalid_key_raises(self, auth_mgr):
        with pytest.raises(AuthenticationError, match="Invalid API key"):
            auth_mgr.validate_api_key("totally_bogus_key")

    def test_validate_revoked_key_raises(self, auth_mgr):
        key = auth_mgr.register_api_key(user_id="user_1")
        auth_mgr.revoke_api_key(key)
        with pytest.raises(AuthenticationError, match="API key revoked"):
            auth_mgr.validate_api_key(key)

    def test_validate_preserves_metadata(self, auth_mgr):
        key = auth_mgr.register_api_key(
            user_id="user_1", metadata={"level": "premium"},
        )
        user = auth_mgr.validate_api_key(key)
        assert user.metadata == {"level": "premium"}


# ===========================================================================
# Token Management — generate_token
# ===========================================================================

class TestGenerateToken:
    """Token generation: creation, storage, expiry calculation."""

    def test_generate_returns_string(self, auth_mgr):
        token = auth_mgr.generate_token(user_id="user_1")
        assert isinstance(token, str)
        assert len(token) > 10

    def test_generate_stores_token(self, auth_mgr):
        token = auth_mgr.generate_token(user_id="user_1")
        assert token in auth_mgr._tokens

    def test_generate_stores_correct_info(self, auth_mgr):
        token = auth_mgr.generate_token(
            user_id="user_1", role=Role.ADMIN, metadata={"scope": "all"},
        )
        info = auth_mgr._tokens[token]
        assert info["user_id"] == "user_1"
        assert info["role"] == Role.ADMIN
        assert info["metadata"] == {"scope": "all"}
        assert info["last_used"] is None
        assert "created_at" in info
        assert "expires_at" in info

    def test_generate_default_expiry_24h(self, auth_mgr):
        before = datetime.now(timezone.utc)
        token = auth_mgr.generate_token(user_id="user_1")
        after = datetime.now(timezone.utc)
        expiry = datetime.fromisoformat(auth_mgr._tokens[token]["expires_at"])
        # Expiry should be ~24h from now
        assert expiry > before + timedelta(hours=23, minutes=59)
        assert expiry < after + timedelta(hours=24, minutes=1)

    def test_generate_custom_expiry(self):
        """Token expiry respects config.token_expiry_hours."""
        config = AuthConfig(token_expiry_hours=1)
        with (
            patch("security.auth.get_secret_manager", return_value=MagicMock()),
            patch("security.auth.get_permission_manager", return_value=MagicMock()),
        ):
            mgr = AuthenticationManager(config)
        before = datetime.now(timezone.utc)
        token = mgr.generate_token(user_id="user_1")
        expiry = datetime.fromisoformat(mgr._tokens[token]["expires_at"])
        assert expiry < before + timedelta(hours=1, minutes=1)
        assert expiry > before + timedelta(minutes=59)

    def test_generate_none_metadata_becomes_empty_dict(self, auth_mgr):
        token = auth_mgr.generate_token(user_id="u1", metadata=None)
        assert auth_mgr._tokens[token]["metadata"] == {}

    def test_multiple_tokens_unique(self, auth_mgr):
        t1 = auth_mgr.generate_token(user_id="u1")
        t2 = auth_mgr.generate_token(user_id="u1")
        assert t1 != t2
        assert len(auth_mgr._tokens) == 2


# ===========================================================================
# Token Management — validate_token
# ===========================================================================

class TestValidateToken:
    """Token validation: success, invalid, expired, last_used tracking."""

    def test_validate_success_returns_user(self, auth_mgr):
        token = auth_mgr.generate_token(user_id="user_1", role=Role.ADMIN)
        user = auth_mgr.validate_token(token)
        assert isinstance(user, User)
        assert user.user_id == "user_1"
        assert user.role == Role.ADMIN

    def test_validate_updates_last_used(self, auth_mgr):
        token = auth_mgr.generate_token(user_id="user_1")
        assert auth_mgr._tokens[token]["last_used"] is None
        auth_mgr.validate_token(token)
        assert auth_mgr._tokens[token]["last_used"] is not None

    def test_validate_invalid_token_raises(self, auth_mgr):
        with pytest.raises(InvalidTokenError, match="Invalid token"):
            auth_mgr.validate_token("completely_fake_token")

    def test_validate_expired_token_raises(self, auth_mgr):
        """Force expiry by manipulating stored expires_at."""
        token = auth_mgr.generate_token(user_id="user_1")
        # Set expiry to the past (must be timezone-aware to match production code)
        past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        auth_mgr._tokens[token]["expires_at"] = past
        with pytest.raises(ExpiredTokenError, match="Token expired"):
            auth_mgr.validate_token(token)

    def test_expired_token_removed_from_registry(self, auth_mgr):
        """Expired token is cleaned up on validation attempt."""
        token = auth_mgr.generate_token(user_id="user_1")
        past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        auth_mgr._tokens[token]["expires_at"] = past
        with pytest.raises(ExpiredTokenError):
            auth_mgr.validate_token(token)
        # Token should be gone from registry
        assert token not in auth_mgr._tokens

    def test_validate_preserves_metadata(self, auth_mgr):
        token = auth_mgr.generate_token(
            user_id="u1", metadata={"device": "desktop"},
        )
        user = auth_mgr.validate_token(token)
        assert user.metadata == {"device": "desktop"}


# ===========================================================================
# Token Management — revoke_token
# ===========================================================================

class TestRevokeToken:
    """Token revocation: remove existing, handle unknown."""

    def test_revoke_existing_token(self, auth_mgr):
        token = auth_mgr.generate_token(user_id="user_1")
        assert token in auth_mgr._tokens
        auth_mgr.revoke_token(token)
        assert token not in auth_mgr._tokens

    def test_revoke_unknown_token_no_error(self, auth_mgr):
        """Revoking unknown token should not raise."""
        auth_mgr.revoke_token("nonexistent_token")
        assert len(auth_mgr._tokens) == 0

    def test_revoke_then_validate_raises(self, auth_mgr):
        """Revoked token cannot be validated."""
        token = auth_mgr.generate_token(user_id="user_1")
        auth_mgr.revoke_token(token)
        with pytest.raises(InvalidTokenError, match="Invalid token"):
            auth_mgr.validate_token(token)


# ===========================================================================
# authenticate_request — the core authentication flow
# ===========================================================================

class TestAuthenticateRequest:
    """Full authentication flow: API key, bearer token, anonymous, strict mode."""

    # --- API Key authentication ---

    def test_api_key_success(self, auth_mgr):
        key = auth_mgr.register_api_key(user_id="user_1", role=Role.ADMIN)
        ctx = auth_mgr.authenticate_request(api_key=key)
        assert isinstance(ctx, AuthorizationContext)
        assert ctx.user.user_id == "user_1"
        assert ctx.user.role == Role.ADMIN

    def test_api_key_invalid_falls_to_anonymous(self, auth_mgr):
        """Invalid API key + allow_anonymous=True → anonymous access."""
        ctx = auth_mgr.authenticate_request(api_key="bogus_key")
        assert ctx.user.user_id == "anonymous"
        assert ctx.user.role == Role.ANONYMOUS

    def test_api_key_invalid_strict_raises(self, strict_mgr):
        """Invalid API key + require_api_key=True → AuthenticationError."""
        with pytest.raises(AuthenticationError, match="Invalid API key"):
            strict_mgr.authenticate_request(api_key="bogus_key")

    def test_revoked_api_key_strict_raises(self, strict_mgr):
        """Revoked API key + require_api_key=True → AuthenticationError."""
        key = strict_mgr.register_api_key(user_id="user_1")
        strict_mgr.revoke_api_key(key)
        with pytest.raises(AuthenticationError, match="API key revoked"):
            strict_mgr.authenticate_request(api_key=key)

    # --- Bearer Token authentication ---

    def test_bearer_token_success(self, auth_mgr):
        token = auth_mgr.generate_token(user_id="user_1", role=Role.USER)
        ctx = auth_mgr.authenticate_request(bearer_token=token)
        assert ctx.user.user_id == "user_1"
        assert ctx.user.role == Role.USER

    def test_bearer_token_invalid_falls_to_anonymous(self, auth_mgr):
        """Invalid bearer + allow_anonymous=True → anonymous."""
        ctx = auth_mgr.authenticate_request(bearer_token="fake_token")
        assert ctx.user.user_id == "anonymous"
        assert ctx.user.role == Role.ANONYMOUS

    def test_bearer_token_invalid_strict_raises(self, strict_mgr):
        """Invalid bearer + require_api_key=True → AuthenticationError."""
        with pytest.raises(InvalidTokenError, match="Invalid token"):
            strict_mgr.authenticate_request(bearer_token="fake_token")

    def test_bearer_disabled_ignores_token(self, no_bearer_mgr):
        """When allow_bearer_tokens=False, bearer token is ignored → anonymous."""
        token = no_bearer_mgr.generate_token(user_id="user_1")
        ctx = no_bearer_mgr.authenticate_request(bearer_token=token)
        assert ctx.user.user_id == "anonymous"

    # --- Anonymous access ---

    def test_no_credentials_anonymous(self, auth_mgr):
        """No API key, no bearer → anonymous (allow_anonymous=True)."""
        ctx = auth_mgr.authenticate_request()
        assert ctx.user.user_id == "anonymous"
        assert ctx.user.role == Role.ANONYMOUS
        assert ctx.user.metadata == {"authenticated": False}

    def test_no_credentials_strict_raises(self, strict_mgr):
        """No credentials + require_api_key=True + allow_anonymous=False → error."""
        with pytest.raises(AuthenticationError, match="Authentication required"):
            strict_mgr.authenticate_request()

    # --- Priority: API key checked before bearer ---

    def test_api_key_takes_priority_over_bearer(self, auth_mgr):
        """When both provided, API key is checked first."""
        api_key = auth_mgr.register_api_key(user_id="api_user", role=Role.ADMIN)
        token = auth_mgr.generate_token(user_id="token_user", role=Role.USER)
        ctx = auth_mgr.authenticate_request(api_key=api_key, bearer_token=token)
        assert ctx.user.user_id == "api_user"  # API key wins

    def test_api_key_fails_bearer_succeeds(self, auth_mgr):
        """Invalid API key + valid bearer + allow_anonymous → bearer used."""
        token = auth_mgr.generate_token(user_id="token_user")
        ctx = auth_mgr.authenticate_request(
            api_key="bad_key", bearer_token=token,
        )
        assert ctx.user.user_id == "token_user"

    # --- Expired token path ---

    def test_expired_bearer_falls_to_anonymous(self, auth_mgr):
        """Expired bearer + allow_anonymous=True → anonymous."""
        token = auth_mgr.generate_token(user_id="user_1")
        past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        auth_mgr._tokens[token]["expires_at"] = past
        ctx = auth_mgr.authenticate_request(bearer_token=token)
        assert ctx.user.user_id == "anonymous"

    def test_expired_bearer_strict_raises(self, strict_mgr):
        """Expired bearer + require_api_key=True → ExpiredTokenError."""
        token = strict_mgr.generate_token(user_id="user_1")
        past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        strict_mgr._tokens[token]["expires_at"] = past
        with pytest.raises(ExpiredTokenError, match="Token expired"):
            strict_mgr.authenticate_request(bearer_token=token)


# ===========================================================================
# Session Management — create_user_session
# ===========================================================================

class TestCreateUserSession:
    """Session creation (delegates to generate_token)."""

    def test_create_session_returns_token(self, auth_mgr):
        session = auth_mgr.create_user_session(user_id="user_1")
        assert isinstance(session, str)
        assert len(session) > 10

    def test_session_token_is_valid(self, auth_mgr):
        """Session token should be validateable as a regular token."""
        session = auth_mgr.create_user_session(
            user_id="user_1", role=Role.ADMIN, metadata={"session": True},
        )
        user = auth_mgr.validate_token(session)
        assert user.user_id == "user_1"
        assert user.role == Role.ADMIN
        assert user.metadata == {"session": True}


# ===========================================================================
# Utilities — cleanup_expired_tokens
# ===========================================================================

class TestCleanupExpiredTokens:
    """Expired token cleanup: count, removal, no false positives."""

    def test_cleanup_no_tokens(self, auth_mgr):
        count = auth_mgr.cleanup_expired_tokens()
        assert count == 0

    def test_cleanup_no_expired(self, auth_mgr):
        auth_mgr.generate_token(user_id="u1")
        auth_mgr.generate_token(user_id="u2")
        count = auth_mgr.cleanup_expired_tokens()
        assert count == 0
        assert len(auth_mgr._tokens) == 2

    def test_cleanup_removes_expired(self, auth_mgr):
        t1 = auth_mgr.generate_token(user_id="u1")
        t2 = auth_mgr.generate_token(user_id="u2")
        # Expire t1 only
        past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        auth_mgr._tokens[t1]["expires_at"] = past
        count = auth_mgr.cleanup_expired_tokens()
        assert count == 1
        assert t1 not in auth_mgr._tokens
        assert t2 in auth_mgr._tokens

    def test_cleanup_all_expired(self, auth_mgr):
        t1 = auth_mgr.generate_token(user_id="u1")
        t2 = auth_mgr.generate_token(user_id="u2")
        past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        auth_mgr._tokens[t1]["expires_at"] = past
        auth_mgr._tokens[t2]["expires_at"] = past
        count = auth_mgr.cleanup_expired_tokens()
        assert count == 2
        assert len(auth_mgr._tokens) == 0

    def test_cleanup_idempotent(self, auth_mgr):
        t = auth_mgr.generate_token(user_id="u1")
        past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        auth_mgr._tokens[t]["expires_at"] = past
        assert auth_mgr.cleanup_expired_tokens() == 1
        assert auth_mgr.cleanup_expired_tokens() == 0  # Nothing left


# ===========================================================================
# Utilities — get_statistics
# ===========================================================================

class TestGetStatistics:
    """Statistics: correct counts, config inclusion."""

    def test_empty_statistics(self, auth_mgr):
        stats = auth_mgr.get_statistics()
        assert stats["active_api_keys"] == 0
        assert stats["total_api_keys"] == 0
        assert stats["active_tokens"] == 0
        assert "config" in stats
        assert stats["config"]["require_api_key"] is False
        assert stats["config"]["allow_anonymous"] is True
        assert stats["config"]["token_expiry_hours"] == 24

    def test_statistics_with_active_keys_and_tokens(self, auth_mgr):
        auth_mgr.register_api_key(user_id="u1")
        auth_mgr.register_api_key(user_id="u2")
        k3 = auth_mgr.register_api_key(user_id="u3")
        auth_mgr.revoke_api_key(k3)  # 1 revoked
        auth_mgr.generate_token(user_id="u1")
        auth_mgr.generate_token(user_id="u2")
        stats = auth_mgr.get_statistics()
        assert stats["active_api_keys"] == 2  # 3 total, 1 revoked
        assert stats["total_api_keys"] == 3
        assert stats["active_tokens"] == 2


# ===========================================================================
# Utilities — list_api_keys
# ===========================================================================

class TestListApiKeys:
    """API key listing: all keys, filtered by user, sanitized output."""

    def test_list_empty(self, auth_mgr):
        assert auth_mgr.list_api_keys() == []

    def test_list_all_keys(self, auth_mgr):
        auth_mgr.register_api_key(user_id="u1", description="Key 1")
        auth_mgr.register_api_key(user_id="u2", description="Key 2")
        keys = auth_mgr.list_api_keys()
        assert len(keys) == 2
        user_ids = {k["user_id"] for k in keys}
        assert user_ids == {"u1", "u2"}

    def test_list_filtered_by_user(self, auth_mgr):
        auth_mgr.register_api_key(user_id="u1")
        auth_mgr.register_api_key(user_id="u2")
        auth_mgr.register_api_key(user_id="u1")  # Second key for u1
        keys = auth_mgr.list_api_keys(user_id="u1")
        assert len(keys) == 2
        assert all(k["user_id"] == "u1" for k in keys)

    def test_list_sanitized_no_hash(self, auth_mgr):
        """Returned info should NOT contain key hash."""
        auth_mgr.register_api_key(user_id="u1", description="My key")
        keys = auth_mgr.list_api_keys()
        assert len(keys) == 1
        key_info = keys[0]
        expected_fields = {
            "user_id", "role", "description", "created_at",
            "last_used", "enabled",
        }
        assert set(key_info.keys()) == expected_fields

    def test_list_includes_revoked(self, auth_mgr):
        """Revoked keys should still appear in list."""
        k = auth_mgr.register_api_key(user_id="u1")
        auth_mgr.revoke_api_key(k)
        keys = auth_mgr.list_api_keys()
        assert len(keys) == 1
        assert keys[0]["enabled"] is False

    def test_list_nonexistent_user(self, auth_mgr):
        auth_mgr.register_api_key(user_id="u1")
        keys = auth_mgr.list_api_keys(user_id="nobody")
        assert keys == []


# ===========================================================================
# Convenience Functions (module-level)
# ===========================================================================

class TestConvenienceFunctions:
    """
    Module-level convenience functions delegate to the global singleton.
    We must reset the global _auth_manager to prevent singleton leak.
    """

    def test_get_auth_manager_creates_singleton(self):
        import security.auth as auth_mod
        original = auth_mod._auth_manager
        try:
            auth_mod._auth_manager = None
            with (
                patch("security.auth.get_secret_manager", return_value=MagicMock()),
                patch("security.auth.get_permission_manager", return_value=MagicMock()),
            ):
                mgr = auth_mod.get_auth_manager()
            assert isinstance(mgr, AuthenticationManager)
            # Calling again returns SAME instance
            mgr2 = auth_mod.get_auth_manager()
            assert mgr is mgr2
        finally:
            auth_mod._auth_manager = original

    def test_get_auth_manager_ignores_config_after_first_call(self):
        """BUG DOCUMENTED: second call with different config is silently ignored."""
        import security.auth as auth_mod
        original = auth_mod._auth_manager
        try:
            auth_mod._auth_manager = None
            with (
                patch("security.auth.get_secret_manager", return_value=MagicMock()),
                patch("security.auth.get_permission_manager", return_value=MagicMock()),
            ):
                mgr1 = auth_mod.get_auth_manager(AuthConfig(token_expiry_hours=1))
                mgr2 = auth_mod.get_auth_manager(AuthConfig(token_expiry_hours=99))
            assert mgr1 is mgr2
            assert mgr2.config.token_expiry_hours == 1  # First config wins
        finally:
            auth_mod._auth_manager = original

    def test_authenticate_request_convenience(self):
        import security.auth as auth_mod
        original = auth_mod._auth_manager
        try:
            auth_mod._auth_manager = None
            with (
                patch("security.auth.get_secret_manager", return_value=MagicMock()),
                patch("security.auth.get_permission_manager", return_value=MagicMock()),
            ):
                ctx = auth_mod.authenticate_request()
            # Default config: allow_anonymous=True, no creds → anonymous
            assert ctx.user.user_id == "anonymous"
        finally:
            auth_mod._auth_manager = original

    def test_validate_api_key_convenience(self):
        import security.auth as auth_mod
        original = auth_mod._auth_manager
        try:
            auth_mod._auth_manager = None
            with (
                patch("security.auth.get_secret_manager", return_value=MagicMock()),
                patch("security.auth.get_permission_manager", return_value=MagicMock()),
            ):
                key = auth_mod.generate_api_key(
                    user_id="user_conv", role=Role.USER, description="conv key",
                )
            assert isinstance(key, str)
            assert len(key) > 10
            with (
                patch("security.auth.get_secret_manager", return_value=MagicMock()),
                patch("security.auth.get_permission_manager", return_value=MagicMock()),
            ):
                user = auth_mod.validate_api_key(key)
            assert user.user_id == "user_conv"
        finally:
            auth_mod._auth_manager = original

    def test_revoke_api_key_convenience(self):
        import security.auth as auth_mod
        original = auth_mod._auth_manager
        try:
            auth_mod._auth_manager = None
            with (
                patch("security.auth.get_secret_manager", return_value=MagicMock()),
                patch("security.auth.get_permission_manager", return_value=MagicMock()),
            ):
                key = auth_mod.generate_api_key(user_id="user_rev")
                auth_mod.revoke_api_key(key)
                with pytest.raises(AuthenticationError, match="API key revoked"):
                    auth_mod.validate_api_key(key)
        finally:
            auth_mod._auth_manager = original


# ===========================================================================
# Exception Hierarchy
# ===========================================================================

class TestExceptionHierarchy:
    """Verify exception inheritance chain for proper catch blocks."""

    def test_invalid_token_is_authentication_error(self):
        assert issubclass(InvalidTokenError, AuthenticationError)

    def test_expired_token_is_authentication_error(self):
        assert issubclass(ExpiredTokenError, AuthenticationError)

    def test_authentication_error_is_exception(self):
        assert issubclass(AuthenticationError, Exception)

    def test_catch_authentication_error_catches_subtypes(self, auth_mgr):
        """Caller catching AuthenticationError should catch both subtypes."""
        token = auth_mgr.generate_token(user_id="u1")
        past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        auth_mgr._tokens[token]["expires_at"] = past
        with pytest.raises(AuthenticationError):
            auth_mgr.validate_token(token)


# ===========================================================================
# Edge Cases / Adversarial
# ===========================================================================

class TestEdgeCases:
    """Boundary conditions, empty inputs, rapid operations."""

    def test_empty_string_user_id_accepted(self, auth_mgr):
        """No validation on user_id — empty string is accepted (design note)."""
        key = auth_mgr.register_api_key(user_id="")
        user = auth_mgr.validate_api_key(key)
        assert user.user_id == ""

    def test_empty_string_api_key_treated_as_generate(self, auth_mgr):
        """Empty string api_key is falsy → triggers key generation (not import).
        This is Python truthiness: `api_key or generate()` treats '' as 'not provided'.
        """
        key = auth_mgr.register_api_key(user_id="u1", api_key="")
        assert key != ""  # Generated, not the empty string
        assert len(key) > 10
        user = auth_mgr.validate_api_key(key)
        assert user.user_id == "u1"

    def test_rapid_register_and_validate(self, auth_mgr):
        """Register and validate 100 keys rapidly — no collisions."""
        keys = []
        for i in range(100):
            k = auth_mgr.register_api_key(user_id=f"user_{i}")
            keys.append(k)
        assert len(set(keys)) == 100  # All unique
        assert len(auth_mgr._api_keys) == 100
        for i, k in enumerate(keys):
            user = auth_mgr.validate_api_key(k)
            assert user.user_id == f"user_{i}"

    def test_rapid_token_generate_and_validate(self, auth_mgr):
        """Generate and validate 100 tokens rapidly — no collisions."""
        tokens = []
        for i in range(100):
            t = auth_mgr.generate_token(user_id=f"user_{i}")
            tokens.append(t)
        assert len(set(tokens)) == 100
        for i, t in enumerate(tokens):
            user = auth_mgr.validate_token(t)
            assert user.user_id == f"user_{i}"

    def test_api_key_with_special_characters(self, auth_mgr):
        """API key with unicode/special chars should hash correctly."""
        special_key = "key_with_unicode_\u00e9\u00e0\u00fc_and_symbols_!@#$%"
        auth_mgr.register_api_key(user_id="u1", api_key=special_key)
        user = auth_mgr.validate_api_key(special_key)
        assert user.user_id == "u1"

    def test_full_lifecycle_api_key(self, auth_mgr):
        """Register → validate → revoke → validate fails."""
        key = auth_mgr.register_api_key(user_id="lifecycle_user")
        user = auth_mgr.validate_api_key(key)
        assert user.user_id == "lifecycle_user"
        auth_mgr.revoke_api_key(key)
        with pytest.raises(AuthenticationError, match="revoked"):
            auth_mgr.validate_api_key(key)

    def test_full_lifecycle_token(self, auth_mgr):
        """Generate → validate → revoke → validate fails."""
        token = auth_mgr.generate_token(user_id="lifecycle_user")
        user = auth_mgr.validate_token(token)
        assert user.user_id == "lifecycle_user"
        auth_mgr.revoke_token(token)
        with pytest.raises(InvalidTokenError):
            auth_mgr.validate_token(token)

    def test_auth_request_lifecycle(self, auth_mgr):
        """Register key → authenticate → revoke → authenticate falls to anon."""
        key = auth_mgr.register_api_key(user_id="lc_user", role=Role.ADMIN)
        ctx = auth_mgr.authenticate_request(api_key=key)
        assert ctx.user.user_id == "lc_user"
        auth_mgr.revoke_api_key(key)
        ctx2 = auth_mgr.authenticate_request(api_key=key)
        assert ctx2.user.user_id == "anonymous"  # Falls to anon
