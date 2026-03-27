"""
Unit tests for security/permissions.py — PermissionManager, AuthorizationContext.

Adversarial: every branch forced, inheritance verified exhaustively,
circular inheritance bug documented, exact permission counts asserted.

CI: pytest tests/unit/security/test_permissions.py -m unit --no-cov -q
"""

import pytest
from security.permissions import (
    Permission,
    Role,
    RoleDefinition,
    PermissionManager,
    PermissionError,
    User,
    AuthorizationContext,
    get_permission_manager,
    has_permission,
    check_permission,
    get_role_permissions,
)


@pytest.fixture
def pm():
    return PermissionManager()


# ===========================================================================
# PermissionManager — Role Registry
# ===========================================================================

class TestPermissionManagerRoles:

    def test_all_default_roles_registered(self, pm):
        """Exactly 5 default roles exist."""
        roles = pm.list_roles()
        expected = {Role.ANONYMOUS, Role.USER, Role.POWER_USER, Role.ADMIN, Role.SERVICE}
        assert set(roles) == expected
        assert len(roles) == 5

    def test_anonymous_permissions_exact(self, pm):
        """Anonymous has exactly 1 permission: HEALTH_CHECK."""
        perms = pm.get_role_permissions(Role.ANONYMOUS)
        assert perms == {Permission.HEALTH_CHECK}

    def test_anonymous_cannot_create_chat(self, pm):
        """Anonymous lacks chat creation."""
        assert pm.has_permission(Role.ANONYMOUS, Permission.CHAT_CREATE) is False

    def test_user_permissions_count(self, pm):
        """User role has exactly 17 unique permissions (including inherited)."""
        perms = pm.get_role_permissions(Role.USER)
        assert len(perms) == 17
        # Verify key permissions present
        assert Permission.CHAT_CREATE in perms
        assert Permission.FILE_UPLOAD in perms
        assert Permission.HEALTH_CHECK in perms  # inherited from anonymous
        # Verify admin perms absent
        assert Permission.ADMIN_SYSTEM not in perms
        assert Permission.ADMIN_USERS not in perms

    def test_user_inherits_anonymous_permissions(self, pm):
        """User's permission set is superset of anonymous."""
        anon_perms = pm.get_role_permissions(Role.ANONYMOUS)
        user_perms = pm.get_role_permissions(Role.USER)
        assert anon_perms.issubset(user_perms)

    def test_power_user_permissions(self, pm):
        """Power user has model configuration and file deletion."""
        perms = pm.get_role_permissions(Role.POWER_USER)
        assert Permission.MODEL_CONFIGURE in perms
        assert Permission.FILE_DELETE in perms
        assert Permission.SETTINGS_WRITE in perms
        assert Permission.METRICS_READ in perms
        assert Permission.MCP_CONFIGURE in perms
        # Still no admin
        assert Permission.ADMIN_SYSTEM not in perms

    def test_power_user_inherits_all_user_permissions(self, pm):
        """Power user's set is superset of user."""
        user_perms = pm.get_role_permissions(Role.USER)
        pu_perms = pm.get_role_permissions(Role.POWER_USER)
        assert user_perms.issubset(pu_perms)

    def test_admin_has_every_permission(self, pm):
        """Admin has all defined Permission enum values."""
        admin_perms = pm.get_role_permissions(Role.ADMIN)
        all_permissions = set(Permission)
        assert all_permissions == admin_perms

    def test_admin_inherits_full_chain(self, pm):
        """Admin inherits power_user → user → anonymous."""
        admin_perms = pm.get_role_permissions(Role.ADMIN)
        for role in [Role.POWER_USER, Role.USER, Role.ANONYMOUS]:
            role_perms = pm.get_role_permissions(role)
            assert role_perms.issubset(admin_perms), f"{role} not subset of admin"

    def test_service_role_specific_permissions(self, pm):
        """Service role has specific inter-service permissions, not admin."""
        perms = pm.get_role_permissions(Role.SERVICE)
        assert Permission.CHAT_CREATE in perms
        assert Permission.MCP_EXECUTE in perms
        assert Permission.HEALTH_CHECK in perms
        assert Permission.METRICS_READ in perms
        # Service should NOT have admin or user-management perms
        assert Permission.ADMIN_SYSTEM not in perms
        assert Permission.ADMIN_USERS not in perms
        # Service should NOT have destructive perms
        assert Permission.STORAGE_DELETE not in perms
        assert Permission.CHAT_DELETE not in perms

    def test_service_role_no_inheritance(self, pm):
        """Service role has no inherits_from — isolated permission set."""
        role_def = pm._roles[Role.SERVICE]
        assert role_def.inherits_from is None


# ===========================================================================
# PermissionManager — Permission Checks
# ===========================================================================

class TestPermissionManagerChecks:

    def test_has_permission_true(self, pm):
        """has_permission returns True for granted permission."""
        assert pm.has_permission(Role.USER, Permission.CHAT_CREATE) is True

    def test_has_permission_false(self, pm):
        """has_permission returns False for denied permission."""
        assert pm.has_permission(Role.USER, Permission.ADMIN_SYSTEM) is False

    def test_unknown_role_has_permission_returns_false(self, pm):
        """Unknown role silently returns False (no exception)."""
        assert pm.has_permission("nonexistent_role", Permission.HEALTH_CHECK) is False

    def test_unknown_role_get_permissions_raises(self, pm):
        """Getting permissions for unknown role raises ValueError."""
        with pytest.raises(ValueError, match="Unknown role"):
            pm.get_role_permissions("nonexistent_role")

    def test_check_permission_passes(self, pm):
        """check_permission does not raise when permission granted."""
        pm.check_permission(Role.USER, Permission.CHAT_CREATE)  # should not raise

    def test_check_permission_raises(self, pm):
        """check_permission raises PermissionError with descriptive message."""
        with pytest.raises(PermissionError, match="does not have permission"):
            pm.check_permission(Role.ANONYMOUS, Permission.CHAT_CREATE)

    def test_check_any_permission_one_matches(self, pm):
        """check_any_permission passes when at least one permission matches."""
        pm.check_any_permission(
            Role.USER,
            [Permission.ADMIN_SYSTEM, Permission.CHAT_CREATE]
        )

    def test_check_any_permission_none_match(self, pm):
        """check_any_permission raises when no permission matches."""
        with pytest.raises(PermissionError, match="does not have any"):
            pm.check_any_permission(
                Role.ANONYMOUS,
                [Permission.CHAT_CREATE, Permission.FILE_UPLOAD]
            )

    def test_check_all_permissions_all_match(self, pm):
        """check_all_permissions passes when all permissions match."""
        pm.check_all_permissions(
            Role.USER,
            [Permission.CHAT_CREATE, Permission.CHAT_READ, Permission.CHAT_DELETE]
        )

    def test_check_all_permissions_one_missing(self, pm):
        """check_all_permissions raises when any permission missing."""
        with pytest.raises(PermissionError):
            pm.check_all_permissions(
                Role.USER,
                [Permission.CHAT_CREATE, Permission.ADMIN_SYSTEM]
            )

    def test_check_any_empty_list_raises(self, pm):
        """check_any_permission with empty list raises (no matches possible)."""
        with pytest.raises(PermissionError):
            pm.check_any_permission(Role.ADMIN, [])

    def test_check_all_empty_list_passes(self, pm):
        """check_all_permissions with empty list passes (vacuously true)."""
        pm.check_all_permissions(Role.ANONYMOUS, [])


# ===========================================================================
# PermissionManager — Role Registration
# ===========================================================================

class TestRoleRegistration:

    def test_register_custom_role(self, pm):
        """Custom role is registered and has_permission works."""
        pm.register_role(RoleDefinition(
            name="custom",
            description="Custom role",
            permissions={Permission.CHAT_READ, Permission.HEALTH_CHECK},
        ))
        assert pm.has_permission("custom", Permission.CHAT_READ) is True
        assert pm.has_permission("custom", Permission.HEALTH_CHECK) is True
        assert pm.has_permission("custom", Permission.CHAT_CREATE) is False

    def test_register_role_with_inheritance(self, pm):
        """Custom role inheriting from USER gets all USER permissions."""
        pm.register_role(RoleDefinition(
            name="custom_user",
            description="Custom inheriting from user",
            permissions={Permission.ADMIN_LOGS},
            inherits_from=Role.USER,
        ))
        perms = pm.get_role_permissions("custom_user")
        assert Permission.ADMIN_LOGS in perms
        assert Permission.CHAT_CREATE in perms  # inherited from USER
        assert Permission.HEALTH_CHECK in perms  # inherited USER → ANONYMOUS

    def test_overwrite_existing_role(self, pm):
        """Registering role with existing name overwrites it."""
        original_perms = pm.get_role_permissions(Role.ANONYMOUS)
        assert Permission.CHAT_CREATE not in original_perms

        pm.register_role(RoleDefinition(
            name=Role.ANONYMOUS,
            description="Modified anonymous",
            permissions={Permission.CHAT_CREATE, Permission.HEALTH_CHECK},
        ))
        new_perms = pm.get_role_permissions(Role.ANONYMOUS)
        assert Permission.CHAT_CREATE in new_perms

    def test_circular_inheritance_causes_recursion(self, pm):
        """BUG: Circular inheritance causes infinite recursion.
        get_role_permissions has no cycle detection.
        This test documents the bug."""
        pm.register_role(RoleDefinition(
            name="role_a",
            description="A inherits B",
            permissions={Permission.CHAT_READ},
            inherits_from="role_b",
        ))
        pm.register_role(RoleDefinition(
            name="role_b",
            description="B inherits A",
            permissions={Permission.CHAT_CREATE},
            inherits_from="role_a",
        ))
        with pytest.raises(RecursionError):
            pm.get_role_permissions("role_a")

    def test_get_role_info_structure(self, pm):
        """get_role_info returns complete structured data."""
        info = pm.get_role_info(Role.USER)
        assert info["name"] == Role.USER
        assert info["description"] == "Standard authenticated user"
        assert info["inherits_from"] == Role.ANONYMOUS
        assert isinstance(info["direct_permissions"], list)
        assert isinstance(info["all_permissions"], list)
        assert info["permission_count"] == 17

    def test_get_role_info_unknown_raises(self, pm):
        """get_role_info for unknown role raises ValueError."""
        with pytest.raises(ValueError, match="Unknown role"):
            pm.get_role_info("nonexistent")


# ===========================================================================
# User dataclass
# ===========================================================================

class TestUser:

    def test_user_default_role(self):
        """Default role is USER."""
        user = User(user_id="u1")
        assert user.role == Role.USER

    def test_user_custom_permissions_default_empty(self):
        """custom_permissions defaults to empty set."""
        user = User(user_id="u1")
        assert user.custom_permissions == set()

    def test_user_metadata_default_empty(self):
        """metadata defaults to empty dict."""
        user = User(user_id="u1")
        assert user.metadata == {}

    def test_user_unknown_role_logs_warning(self, caplog):
        """User with unknown role logs warning but doesn't crash."""
        import logging
        with caplog.at_level(logging.WARNING, logger="security.permissions"):
            user = User(user_id="u1", role="nonexistent")
        assert user.role == "nonexistent"
        assert "Unknown role" in caplog.text


# ===========================================================================
# AuthorizationContext
# ===========================================================================

class TestAuthorizationContext:

    def test_get_permissions_matches_role(self, pm):
        """Context permissions match role's resolved permissions."""
        user = User(user_id="u1", role=Role.USER)
        ctx = AuthorizationContext(user, pm)
        perms = ctx.get_permissions()
        assert perms == pm.get_role_permissions(Role.USER)

    def test_custom_permissions_merged(self, pm):
        """Custom user permissions are merged with role permissions."""
        user = User(
            user_id="u1",
            role=Role.USER,
            custom_permissions={Permission.ADMIN_LOGS},
        )
        ctx = AuthorizationContext(user, pm)
        perms = ctx.get_permissions()
        assert Permission.ADMIN_LOGS in perms  # custom
        assert Permission.CHAT_CREATE in perms  # from role

    def test_has_permission_true(self, pm):
        """has_permission returns True for granted permission."""
        user = User(user_id="u1", role=Role.ADMIN)
        ctx = AuthorizationContext(user, pm)
        assert ctx.has_permission(Permission.ADMIN_SYSTEM) is True

    def test_has_permission_false(self, pm):
        """has_permission returns False for denied permission."""
        user = User(user_id="u1", role=Role.USER)
        ctx = AuthorizationContext(user, pm)
        assert ctx.has_permission(Permission.ADMIN_SYSTEM) is False

    def test_check_permission_passes(self, pm):
        """check_permission does not raise when authorized."""
        user = User(user_id="u1", role=Role.USER)
        ctx = AuthorizationContext(user, pm)
        ctx.check_permission(Permission.CHAT_CREATE)

    def test_check_permission_raises(self, pm):
        """check_permission raises PermissionError with user ID in message."""
        user = User(user_id="user-42", role=Role.USER)
        ctx = AuthorizationContext(user, pm)
        with pytest.raises(PermissionError, match="user-42"):
            ctx.check_permission(Permission.ADMIN_SYSTEM)

    def test_check_any_success(self, pm):
        """check_any passes when at least one permission matches."""
        user = User(user_id="u1", role=Role.USER)
        ctx = AuthorizationContext(user, pm)
        ctx.check_any([Permission.ADMIN_SYSTEM, Permission.CHAT_CREATE])

    def test_check_any_failure(self, pm):
        """check_any raises when no permissions match."""
        user = User(user_id="u1", role=Role.ANONYMOUS)
        ctx = AuthorizationContext(user, pm)
        with pytest.raises(PermissionError, match="does not have any"):
            ctx.check_any([Permission.CHAT_CREATE, Permission.FILE_UPLOAD])

    def test_check_all_success(self, pm):
        """check_all passes when all permissions match."""
        user = User(user_id="u1", role=Role.USER)
        ctx = AuthorizationContext(user, pm)
        ctx.check_all([Permission.CHAT_CREATE, Permission.CHAT_READ])

    def test_check_all_failure(self, pm):
        """check_all raises when any permission missing."""
        user = User(user_id="u1", role=Role.USER)
        ctx = AuthorizationContext(user, pm)
        with pytest.raises(PermissionError):
            ctx.check_all([Permission.CHAT_CREATE, Permission.ADMIN_SYSTEM])

    def test_is_admin_true(self, pm):
        """Admin user returns True for is_admin()."""
        user = User(user_id="a1", role=Role.ADMIN)
        ctx = AuthorizationContext(user, pm)
        assert ctx.is_admin() is True

    def test_is_admin_false_for_power_user(self, pm):
        """Power user is NOT admin (is_admin checks role == ADMIN, not permissions)."""
        user = User(user_id="p1", role=Role.POWER_USER)
        ctx = AuthorizationContext(user, pm)
        assert ctx.is_admin() is False

    def test_is_admin_false_for_user(self, pm):
        """Regular user is not admin."""
        user = User(user_id="u1", role=Role.USER)
        ctx = AuthorizationContext(user, pm)
        assert ctx.is_admin() is False

    def test_get_info_complete_structure(self, pm):
        """get_info returns all expected fields with correct values."""
        user = User(
            user_id="user-1",
            role=Role.USER,
            metadata={"email": "test@test.com"},
        )
        ctx = AuthorizationContext(user, pm)
        info = ctx.get_info()
        assert info["user_id"] == "user-1"
        assert info["role"] == Role.USER
        assert info["is_admin"] is False
        assert info["metadata"] == {"email": "test@test.com"}
        assert isinstance(info["permissions"], list)
        assert len(info["permissions"]) == 17
        # Verify permissions are string values, not enum objects
        assert "chat:create" in info["permissions"]

    def test_get_info_with_custom_permissions(self, pm):
        """get_info includes custom permissions in the permissions list."""
        user = User(
            user_id="u1",
            role=Role.ANONYMOUS,
            custom_permissions={Permission.ADMIN_LOGS},
        )
        ctx = AuthorizationContext(user, pm)
        info = ctx.get_info()
        assert "admin:logs" in info["permissions"]
        assert "health:check" in info["permissions"]
        assert len(info["permissions"]) == 2  # 1 from role + 1 custom


# ===========================================================================
# Module-level convenience functions (lines 475-487)
# ===========================================================================

class TestModuleLevelConvenienceFunctions:
    """Tests for module-level has_permission, check_permission, get_role_permissions.

    These are thin wrappers around the global singleton returned by
    get_permission_manager(). Each test resets the global singleton to
    ensure isolation.
    """

    @pytest.fixture(autouse=True)
    def reset_singleton(self):
        """Reset global permission manager before/after each test."""
        import security.permissions as pmod
        original = pmod._permission_manager
        pmod._permission_manager = None
        yield
        pmod._permission_manager = original

    # --- get_permission_manager singleton ---

    def test_get_permission_manager_returns_instance(self):
        """get_permission_manager returns a PermissionManager instance."""
        mgr = get_permission_manager()
        assert isinstance(mgr, PermissionManager)

    def test_get_permission_manager_is_singleton(self):
        """Repeated calls return the same instance."""
        mgr1 = get_permission_manager()
        mgr2 = get_permission_manager()
        assert mgr1 is mgr2

    # --- has_permission ---

    def test_has_permission_granted(self):
        """Module-level has_permission returns True for granted permission."""
        result = has_permission(Role.USER, Permission.CHAT_CREATE)
        assert result is True

    def test_has_permission_denied(self):
        """Module-level has_permission returns False for denied permission."""
        result = has_permission(Role.ANONYMOUS, Permission.CHAT_CREATE)
        assert result is False

    def test_has_permission_unknown_role(self):
        """Module-level has_permission returns False for unknown role."""
        result = has_permission("nonexistent_role", Permission.HEALTH_CHECK)
        assert result is False

    # --- check_permission ---

    def test_check_permission_passes_when_granted(self):
        """Module-level check_permission does not raise when granted."""
        check_permission(Role.USER, Permission.CHAT_CREATE)

    def test_check_permission_raises_when_denied(self):
        """Module-level check_permission raises PermissionError when denied."""
        with pytest.raises(PermissionError, match="does not have permission"):
            check_permission(Role.ANONYMOUS, Permission.CHAT_CREATE)

    # --- get_role_permissions ---

    def test_get_role_permissions_admin_has_all(self):
        """Module-level get_role_permissions returns all permissions for admin."""
        perms = get_role_permissions(Role.ADMIN)
        assert perms == set(Permission)

    def test_get_role_permissions_anonymous_exact(self):
        """Module-level get_role_permissions returns exact set for anonymous."""
        perms = get_role_permissions(Role.ANONYMOUS)
        assert perms == {Permission.HEALTH_CHECK}

    def test_get_role_permissions_unknown_role_raises(self):
        """Module-level get_role_permissions raises ValueError for unknown role."""
        with pytest.raises(ValueError, match="Unknown role"):
            get_role_permissions("nonexistent_role")
