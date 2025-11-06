"""
Health Checks - Monitoring Layer

Provides comprehensive health checks and diagnostics for:
- Runtime engine
- Integrations (integrations, libraries, services)
- Database connections
- MCP servers
- System resources

@.architecture
Incoming: app.py, api/v1/endpoints/health.py, Component instances --- {RuntimeEngine, IntegrationLoader, Database, MCPManager, str component_name}
Processing: check_all(), check_component(), _check_system(), register_checker(), _aggregate_status() --- {5 jobs: aggregation, health_checking, monitoring, registration, resource_monitoring}
Outgoing: api/v1/endpoints/health.py --- {Dict[str, Any] health status, HealthCheckResult, HealthStatus enum}
"""

import time
import asyncio
import psutil
import platform
from typing import Dict, List, Optional, Any
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum


class HealthStatus(str, Enum):
    """Health check status levels."""
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    UNHEALTHY = "unhealthy"
    UNKNOWN = "unknown"


@dataclass
class HealthCheckResult:
    """
    Result of a health check.
    
    Attributes:
        component: Component name
        status: Health status
        message: Status message
        details: Additional details
        checked_at: Timestamp of check
        response_time_ms: Check execution time
    """
    component: str
    status: HealthStatus
    message: str
    details: Dict[str, Any] = field(default_factory=dict)
    checked_at: str = field(default_factory=lambda: datetime.utcnow().isoformat() + 'Z')
    response_time_ms: Optional[float] = None


class HealthChecker:
    """
    Comprehensive health check system.
    
    Performs health checks on all system components and aggregates results.
    """
    
    def __init__(self):
        """Initialize health checker."""
        self._start_time = time.time()
        self._checkers: Dict[str, Any] = {}
    
    def register_checker(self, name: str, checker: Any) -> None:
        """
        Register a component health checker.
        
        Args:
            name: Component name
            checker: Object with async check_health() method
        """
        self._checkers[name] = checker
    
    async def check_all(self) -> Dict[str, Any]:
        """
        Run all health checks.
        
        Returns:
            Aggregated health check results
        """
        start = time.time()
        results = []
        
        # Check system resources
        results.append(await self._check_system())
        
        # Check runtime components
        for name, checker in self._checkers.items():
            try:
                check_start = time.time()
                result = await checker.check_health()
                check_time = (time.time() - check_start) * 1000
                
                results.append(HealthCheckResult(
                    component=name,
                    status=HealthStatus.HEALTHY if result.get('healthy', False) else HealthStatus.UNHEALTHY,
                    message=result.get('message', 'Component check completed'),
                    details=result,
                    response_time_ms=check_time
                ))
            except Exception as e:
                results.append(HealthCheckResult(
                    component=name,
                    status=HealthStatus.UNHEALTHY,
                    message=f"Health check failed: {str(e)}",
                    details={'error': str(e)}
                ))
        
        # Aggregate status
        overall_status = self._aggregate_status(results)
        total_time = (time.time() - start) * 1000
        
        return {
            'status': overall_status.value,
            'timestamp': datetime.utcnow().isoformat() + 'Z',
            'uptime_seconds': time.time() - self._start_time,
            'check_duration_ms': total_time,
            'components': [
                {
                    'component': r.component,
                    'status': r.status.value,
                    'message': r.message,
                    'details': r.details,
                    'response_time_ms': r.response_time_ms
                }
                for r in results
            ]
        }
    
    async def check_component(self, component: str) -> Optional[HealthCheckResult]:
        """
        Check health of specific component.
        
        Args:
            component: Component name
            
        Returns:
            HealthCheckResult or None if not found
        """
        # Handle system check specially
        if component == "system":
            return await self._check_system()
        
        if component not in self._checkers:
            return None
        
        try:
            check_start = time.time()
            result = await self._checkers[component].check_health()
            check_time = (time.time() - check_start) * 1000
            
            return HealthCheckResult(
                component=component,
                status=HealthStatus.HEALTHY if result.get('healthy', False) else HealthStatus.UNHEALTHY,
                message=result.get('message', 'Component check completed'),
                details=result,
                response_time_ms=check_time
            )
        except Exception as e:
            return HealthCheckResult(
                component=component,
                status=HealthStatus.UNHEALTHY,
                message=f"Health check failed: {str(e)}",
                details={'error': str(e)}
            )
    
    async def _check_system(self) -> HealthCheckResult:
        """
        Check system resources.
        
        Returns:
            System health check result
        """
        try:
            memory = psutil.virtual_memory()
            disk = psutil.disk_usage('/')
            cpu_percent = psutil.cpu_percent(interval=0.1)
            
            # Determine status based on resource usage
            status = HealthStatus.HEALTHY
            issues = []
            
            if memory.percent > 90:
                status = HealthStatus.DEGRADED
                issues.append(f"High memory usage: {memory.percent}%")
            
            if disk.percent > 90:
                status = HealthStatus.DEGRADED
                issues.append(f"High disk usage: {disk.percent}%")
            
            if cpu_percent > 90:
                status = HealthStatus.DEGRADED
                issues.append(f"High CPU usage: {cpu_percent}%")
            
            message = "System resources healthy" if not issues else "; ".join(issues)
            
            return HealthCheckResult(
                component="system",
                status=status,
                message=message,
                details={
                    'platform': platform.system(),
                    'python_version': platform.python_version(),
                    'cpu': {
                        'percent': cpu_percent,
                        'count': psutil.cpu_count()
                    },
                    'memory': {
                        'total_gb': round(memory.total / (1024**3), 2),
                        'available_gb': round(memory.available / (1024**3), 2),
                        'percent_used': memory.percent
                    },
                    'disk': {
                        'total_gb': round(disk.total / (1024**3), 2),
                        'free_gb': round(disk.free / (1024**3), 2),
                        'percent_used': disk.percent
                    },
                    'uptime_seconds': time.time() - self._start_time
                }
            )
        except Exception as e:
            return HealthCheckResult(
                component="system",
                status=HealthStatus.UNKNOWN,
                message=f"Failed to check system: {str(e)}",
                details={'error': str(e)}
            )
    
    def _aggregate_status(self, results: List[HealthCheckResult]) -> HealthStatus:
        """
        Aggregate component statuses into overall status.
        
        Args:
            results: List of health check results
            
        Returns:
            Overall health status
        """
        if not results:
            return HealthStatus.UNKNOWN
        
        statuses = [r.status for r in results]
        
        # If any component is unhealthy, system is unhealthy
        if HealthStatus.UNHEALTHY in statuses:
            return HealthStatus.UNHEALTHY
        
        # If any component is degraded, system is degraded
        if HealthStatus.DEGRADED in statuses:
            return HealthStatus.DEGRADED
        
        # All components healthy
        return HealthStatus.HEALTHY
    
    def get_uptime(self) -> float:
        """Get system uptime in seconds."""
        return time.time() - self._start_time


class RuntimeHealthChecker:
    """Health checker for runtime engine."""
    
    def __init__(self, runtime: Any):
        """
        Initialize runtime health checker.
        
        Args:
            runtime: Runtime engine instance
        """
        self.runtime = runtime
    
    async def check_health(self) -> Dict[str, Any]:
        """
        Check runtime health.
        
        Returns:
            Health status dict
        """
        try:
            # Check if runtime is initialized
            if not hasattr(self.runtime, '_initialized') or not self.runtime._initialized:
                return {
                    'healthy': False,
                    'message': 'Runtime not initialized'
                }
            
            # Check interpreter
            interpreter_healthy = hasattr(self.runtime, 'interpreter') and self.runtime.interpreter is not None
            
            # Check integrations loaded
            integrations_count = len(getattr(self.runtime, '_loaded_integrations', {}))
            
            return {
                'healthy': True,
                'message': 'Runtime healthy',
                'interpreter_loaded': interpreter_healthy,
                'integrations_count': integrations_count
            }
        except Exception as e:
            return {
                'healthy': False,
                'message': f'Runtime check failed: {str(e)}'
            }


class IntegrationHealthChecker:
    """Health checker for integrations."""
    
    def __init__(self, integration_loader: Any):
        """
        Initialize integration health checker.
        
        Args:
            integration_loader: Integration loader instance
        """
        self.loader = integration_loader
    
    async def check_health(self) -> Dict[str, Any]:
        """
        Check integration health.
        
        Returns:
            Health status dict
        """
        try:
            if not hasattr(self.loader, 'registry'):
                return {
                    'healthy': False,
                    'message': 'Integration loader not initialized'
                }
            
            # Count loaded integrations by type
            loaded = getattr(self.loader, '_loaded', {})
            
            integration_stats = {}
            for name, integration in loaded.items():
                integration_type = type(integration).__name__
                integration_stats[name] = {
                    'type': integration_type,
                    'loaded': True
                }
            
            return {
                'healthy': True,
                'message': f'{len(loaded)} integrations loaded',
                'count': len(loaded),
                'integrations': integration_stats
            }
        except Exception as e:
            return {
                'healthy': False,
                'message': f'Integration check failed: {str(e)}'
            }


class DatabaseHealthChecker:
    """Health checker for database connections."""
    
    def __init__(self, db: Any):
        """
        Initialize database health checker.
        
        Args:
            db: Database instance
        """
        self.db = db
    
    async def check_health(self) -> Dict[str, Any]:
        """
        Check database health.
        
        Returns:
            Health status dict
        """
        try:
            # Try to execute a simple query
            start = time.time()
            
            if hasattr(self.db, 'health_check'):
                result = self.db.health_check()
            else:
                # Fallback: try to get connection
                if hasattr(self.db, 'get_connection'):
                    conn = self.db.get_connection()
                    result = {'healthy': conn is not None}
                else:
                    result = {'healthy': True, 'message': 'Database check not implemented'}
            
            response_time = (time.time() - start) * 1000
            
            return {
                'healthy': result.get('healthy', True),
                'message': result.get('message', 'Database healthy'),
                'response_time_ms': response_time,
                **result
            }
        except Exception as e:
            return {
                'healthy': False,
                'message': f'Database check failed: {str(e)}'
            }


class MCPHealthChecker:
    """Health checker for MCP servers."""
    
    def __init__(self, mcp_manager: Any):
        """
        Initialize MCP health checker.
        
        Args:
            mcp_manager: MCP server manager instance
        """
        self.manager = mcp_manager
    
    async def check_health(self) -> Dict[str, Any]:
        """
        Check MCP server health.
        
        Returns:
            Health status dict
        """
        try:
            if not hasattr(self.manager, '_active_servers'):
                return {
                    'healthy': False,
                    'message': 'MCP manager not initialized'
                }
            
            active_servers = getattr(self.manager, '_active_servers', {})
            server_count = len(active_servers)
            
            # Check each server
            server_health = {}
            unhealthy_count = 0
            
            for server_id, server in active_servers.items():
                try:
                    # Try to list tools as basic health check
                    if hasattr(server, 'get_tools'):
                        tools = await server.get_tools()
                        server_health[str(server_id)] = {
                            'healthy': True,
                            'tool_count': len(tools)
                        }
                    else:
                        server_health[str(server_id)] = {
                            'healthy': True,
                            'message': 'Server active'
                        }
                except Exception as e:
                    server_health[str(server_id)] = {
                        'healthy': False,
                        'error': str(e)
                    }
                    unhealthy_count += 1
            
            overall_healthy = unhealthy_count == 0
            message = f'{server_count} MCP servers active' if overall_healthy else f'{unhealthy_count}/{server_count} servers unhealthy'
            
            return {
                'healthy': overall_healthy,
                'message': message,
                'total_servers': server_count,
                'unhealthy_servers': unhealthy_count,
                'servers': server_health
            }
        except Exception as e:
            return {
                'healthy': False,
                'message': f'MCP check failed: {str(e)}'
            }


# Global health checker instance
_global_health_checker: Optional[HealthChecker] = None


def get_health_checker() -> HealthChecker:
    """
    Get global health checker.
    
    Returns:
        HealthChecker instance
    """
    global _global_health_checker
    if _global_health_checker is None:
        _global_health_checker = HealthChecker()
    return _global_health_checker


def initialize_health_checks(
    runtime: Optional[Any] = None,
    integration_loader: Optional[Any] = None,
    database: Optional[Any] = None,
    mcp_manager: Optional[Any] = None
) -> HealthChecker:
    """
    Initialize health checks for components.
    
    Args:
        runtime: Runtime engine
        integration_loader: Integration loader
        database: Database instance
        mcp_manager: MCP server manager
        
    Returns:
        Configured HealthChecker
    """
    checker = get_health_checker()
    
    if runtime:
        checker.register_checker('runtime', RuntimeHealthChecker(runtime))
    
    if integration_loader:
        checker.register_checker('integrations', IntegrationHealthChecker(integration_loader))
    
    if database:
        checker.register_checker('database', DatabaseHealthChecker(database))
    
    if mcp_manager:
        checker.register_checker('mcp', MCPHealthChecker(mcp_manager))
    
    return checker

