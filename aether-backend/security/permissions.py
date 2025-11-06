"""
Authorization and Permissions - Security Layer

Provides role-based access control (RBAC) and permission checking framework
for securing API endpoints and operations.

@.architecture
Incoming: api/dependencies.py (future), User authentication data --- {str role_name, Permission enum, User object}
Processing: has_permission(), check_permission(), get_role_permissions(), register_role() --- {4 jobs: authorization, permission_checking, role_management, validation}
Outgoing: api/dependencies.py (future), api/v1/endpoints/*.py --- {bool permission result, Set[Permission], raises PermissionError, Dict[str, Any] role info}
"""

import logging
from enum import Enum
from typing import List, Optional, Set, Dict, Any
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


class Permission(str, Enum):
    """
    System permissions for fine-grained access control.
    
    Format: RESOURCE_ACTION
    """
    # Chat permissions
    CHAT_CREATE = "chat:create"
    CHAT_READ = "chat:read"
    CHAT_DELETE = "chat:delete"
    CHAT_STREAM = "chat:stream"
    
    # File permissions
    FILE_UPLOAD = "file:upload"
    FILE_READ = "file:read"
    FILE_DELETE = "file:delete"
    FILE_PROCESS = "file:process"
    
    # Model permissions
    MODEL_LIST = "model:list"
    MODEL_CONFIGURE = "model:configure"
    MODEL_SWITCH = "model:switch"
    
    # Profile permissions
    PROFILE_READ = "profile:read"
    PROFILE_WRITE = "profile:write"
    PROFILE_APPLY = "profile:apply"
    
    # Settings permissions
    SETTINGS_READ = "settings:read"
    SETTINGS_WRITE = "settings:write"
    
    # MCP permissions
    MCP_LIST = "mcp:list"
    MCP_CREATE = "mcp:create"
    MCP_EXECUTE = "mcp:execute"
    MCP_DELETE = "mcp:delete"
    MCP_CONFIGURE = "mcp:configure"
    
    # Storage permissions
    STORAGE_READ = "storage:read"
    STORAGE_WRITE = "storage:write"
    STORAGE_DELETE = "storage:delete"
    
    # Admin permissions
    ADMIN_USERS = "admin:users"
    ADMIN_SYSTEM = "admin:system"
    ADMIN_LOGS = "admin:logs"
    
    # Health/monitoring
    HEALTH_CHECK = "health:check"
    METRICS_READ = "metrics:read"


class Role(str, Enum):
    """User roles with predefined permission sets."""
    
    # System roles
    ANONYMOUS = "anonymous"      # Unauthenticated users
    USER = "user"               # Standard authenticated user
    POWER_USER = "power_user"   # Advanced features access
    ADMIN = "admin"             # Full system access
    SERVICE = "service"         # Service-to-service communication


@dataclass
class RoleDefinition:
    """Definition of a role with its permissions."""
    
    name: str
    description: str
    permissions: Set[Permission] = field(default_factory=set)
    inherits_from: Optional[str] = None


class PermissionError(Exception):
    """Raised when permission check fails."""
    pass


class PermissionManager:
    """
    Manages roles and permissions with inheritance support.
    
    Features:
    - Role-based access control (RBAC)
    - Permission inheritance
    - Dynamic permission checking
    - Permission validation
    """
    
    def __init__(self):
        """Initialize permission manager with default roles."""
        self._roles: Dict[str, RoleDefinition] = {}
        self._setup_default_roles()
    
    def _setup_default_roles(self):
        """Set up default system roles."""
        
        # Anonymous role - minimal permissions
        self.register_role(RoleDefinition(
            name=Role.ANONYMOUS,
            description="Unauthenticated user with minimal permissions",
            permissions={
                Permission.HEALTH_CHECK,
            }
        ))
        
        # User role - standard permissions
        self.register_role(RoleDefinition(
            name=Role.USER,
            description="Standard authenticated user",
            permissions={
                # Chat
                Permission.CHAT_CREATE,
                Permission.CHAT_READ,
                Permission.CHAT_DELETE,
                Permission.CHAT_STREAM,
                # Files
                Permission.FILE_UPLOAD,
                Permission.FILE_READ,
                Permission.FILE_PROCESS,
                # Models
                Permission.MODEL_LIST,
                Permission.MODEL_SWITCH,
                # Profiles
                Permission.PROFILE_READ,
                Permission.PROFILE_APPLY,
                # Settings (read only)
                Permission.SETTINGS_READ,
                # MCP (basic)
                Permission.MCP_LIST,
                Permission.MCP_EXECUTE,
                # Storage (own data)
                Permission.STORAGE_READ,
                Permission.STORAGE_WRITE,
                # Health
                Permission.HEALTH_CHECK,
            },
            inherits_from=Role.ANONYMOUS
        ))
        
        # Power user role - advanced features
        self.register_role(RoleDefinition(
            name=Role.POWER_USER,
            description="Power user with advanced features access",
            permissions={
                # Additional file permissions
                Permission.FILE_DELETE,
                # Additional model permissions
                Permission.MODEL_CONFIGURE,
                # Profile management
                Permission.PROFILE_WRITE,
                # Settings write
                Permission.SETTINGS_WRITE,
                # MCP management
                Permission.MCP_CREATE,
                Permission.MCP_CONFIGURE,
                # Storage management
                Permission.STORAGE_DELETE,
                # Metrics
                Permission.METRICS_READ,
            },
            inherits_from=Role.USER
        ))
        
        # Admin role - full access
        self.register_role(RoleDefinition(
            name=Role.ADMIN,
            description="Administrator with full system access",
            permissions={
                # Admin permissions
                Permission.ADMIN_USERS,
                Permission.ADMIN_SYSTEM,
                Permission.ADMIN_LOGS,
                # MCP admin
                Permission.MCP_DELETE,
                # All other permissions inherited
            },
            inherits_from=Role.POWER_USER
        ))
        
        # Service role - for service-to-service communication
        self.register_role(RoleDefinition(
            name=Role.SERVICE,
            description="Service account for internal communication",
            permissions={
                Permission.CHAT_CREATE,
                Permission.CHAT_READ,
                Permission.FILE_UPLOAD,
                Permission.FILE_READ,
                Permission.FILE_PROCESS,
                Permission.MCP_EXECUTE,
                Permission.HEALTH_CHECK,
                Permission.METRICS_READ,
            }
        ))
    
    def register_role(self, role_def: RoleDefinition) -> None:
        """
        Register a new role or update existing role.
        
        Args:
            role_def: Role definition
        """
        self._roles[role_def.name] = role_def
        logger.info(f"Registered role '{role_def.name}' with {len(role_def.permissions)} permissions")
    
    def get_role_permissions(self, role_name: str) -> Set[Permission]:
        """
        Get all permissions for a role (including inherited).
        
        Args:
            role_name: Role name
            
        Returns:
            Set of permissions
            
        Raises:
            ValueError: If role doesn't exist
        """
        if role_name not in self._roles:
            raise ValueError(f"Unknown role: {role_name}")
        
        role = self._roles[role_name]
        permissions = set(role.permissions)
        
        # Add inherited permissions
        if role.inherits_from:
            inherited = self.get_role_permissions(role.inherits_from)
            permissions.update(inherited)
        
        return permissions
    
    def has_permission(
        self,
        role_name: str,
        permission: Permission
    ) -> bool:
        """
        Check if role has specific permission.
        
        Args:
            role_name: Role name
            permission: Permission to check
            
        Returns:
            True if role has permission, False otherwise
        """
        try:
            permissions = self.get_role_permissions(role_name)
            return permission in permissions
        except ValueError:
            return False
    
    def check_permission(
        self,
        role_name: str,
        permission: Permission
    ) -> None:
        """
        Check permission and raise error if not authorized.
        
        Args:
            role_name: Role name
            permission: Required permission
            
        Raises:
            PermissionError: If permission not granted
        """
        if not self.has_permission(role_name, permission):
            raise PermissionError(
                f"Role '{role_name}' does not have permission '{permission.value}'"
            )
    
    def check_any_permission(
        self,
        role_name: str,
        permissions: List[Permission]
    ) -> None:
        """
        Check if role has ANY of the specified permissions.
        
        Args:
            role_name: Role name
            permissions: List of permissions (needs at least one)
            
        Raises:
            PermissionError: If none of the permissions granted
        """
        for permission in permissions:
            if self.has_permission(role_name, permission):
                return
        
        perm_str = ", ".join(p.value for p in permissions)
        raise PermissionError(
            f"Role '{role_name}' does not have any of: {perm_str}"
        )
    
    def check_all_permissions(
        self,
        role_name: str,
        permissions: List[Permission]
    ) -> None:
        """
        Check if role has ALL of the specified permissions.
        
        Args:
            role_name: Role name
            permissions: List of permissions (needs all)
            
        Raises:
            PermissionError: If any permission not granted
        """
        for permission in permissions:
            self.check_permission(role_name, permission)
    
    def list_roles(self) -> List[str]:
        """List all registered roles."""
        return list(self._roles.keys())
    
    def get_role_info(self, role_name: str) -> Dict[str, Any]:
        """
        Get detailed information about a role.
        
        Args:
            role_name: Role name
            
        Returns:
            Dict with role information
            
        Raises:
            ValueError: If role doesn't exist
        """
        if role_name not in self._roles:
            raise ValueError(f"Unknown role: {role_name}")
        
        role = self._roles[role_name]
        all_permissions = self.get_role_permissions(role_name)
        
        return {
            'name': role.name,
            'description': role.description,
            'inherits_from': role.inherits_from,
            'direct_permissions': [p.value for p in role.permissions],
            'all_permissions': [p.value for p in all_permissions],
            'permission_count': len(all_permissions)
        }


@dataclass
class User:
    """User identity with role and permissions."""
    
    user_id: str
    role: str = Role.USER
    custom_permissions: Set[Permission] = field(default_factory=set)
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    def __post_init__(self):
        """Validate role."""
        if self.role not in [r.value for r in Role]:
            logger.warning(f"Unknown role '{self.role}' for user {self.user_id}")


class AuthorizationContext:
    """
    Context for authorization checks.
    
    Holds user identity and provides permission checking methods.
    """
    
    def __init__(
        self,
        user: User,
        permission_manager: Optional[PermissionManager] = None
    ):
        """
        Initialize authorization context.
        
        Args:
            user: User identity
            permission_manager: Permission manager (uses global if None)
        """
        self.user = user
        self._perm_manager = permission_manager or get_permission_manager()
    
    def get_permissions(self) -> Set[Permission]:
        """Get all permissions for current user."""
        # Get role permissions
        role_perms = self._perm_manager.get_role_permissions(self.user.role)
        
        # Add custom permissions
        all_perms = role_perms.union(self.user.custom_permissions)
        
        return all_perms
    
    def has_permission(self, permission: Permission) -> bool:
        """Check if user has permission."""
        return permission in self.get_permissions()
    
    def check_permission(self, permission: Permission) -> None:
        """
        Check permission and raise error if not authorized.
        
        Raises:
            PermissionError: If permission not granted
        """
        if not self.has_permission(permission):
            raise PermissionError(
                f"User '{self.user.user_id}' does not have permission '{permission.value}'"
            )
    
    def check_any(self, permissions: List[Permission]) -> None:
        """Check if user has any of the permissions."""
        for permission in permissions:
            if self.has_permission(permission):
                return
        
        perm_str = ", ".join(p.value for p in permissions)
        raise PermissionError(
            f"User '{self.user.user_id}' does not have any of: {perm_str}"
        )
    
    def check_all(self, permissions: List[Permission]) -> None:
        """Check if user has all of the permissions."""
        for permission in permissions:
            self.check_permission(permission)
    
    def is_admin(self) -> bool:
        """Check if user is admin."""
        return self.user.role == Role.ADMIN
    
    def get_info(self) -> Dict[str, Any]:
        """Get user authorization info."""
        return {
            'user_id': self.user.user_id,
            'role': self.user.role,
            'permissions': [p.value for p in self.get_permissions()],
            'is_admin': self.is_admin(),
            'metadata': self.user.metadata
        }


# Global permission manager instance
_permission_manager: Optional[PermissionManager] = None


def get_permission_manager() -> PermissionManager:
    """Get global permission manager."""
    global _permission_manager
    if _permission_manager is None:
        _permission_manager = PermissionManager()
    return _permission_manager


# Convenience functions
def has_permission(role: str, permission: Permission) -> bool:
    """Check if role has permission."""
    return get_permission_manager().has_permission(role, permission)


def check_permission(role: str, permission: Permission) -> None:
    """Check permission and raise error if not granted."""
    get_permission_manager().check_permission(role, permission)


def get_role_permissions(role: str) -> Set[Permission]:
    """Get all permissions for role."""
    return get_permission_manager().get_role_permissions(role)

