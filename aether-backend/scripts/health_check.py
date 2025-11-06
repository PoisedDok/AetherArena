#!/usr/bin/env python3
"""
Aether Backend - Health Check Script

Production-ready health monitoring:
- Component health verification
- Database connectivity
- Service availability
- Resource utilization
- Dependency status
- JSON output for monitoring systems

@.architecture
Incoming: Command line, monitoring systems --- {CLI args, health check requests}
Processing: check_all_components(), check_database(), check_services(), check_dependencies() --- {4 jobs: dependency_checking, health_checking, resource_monitoring, service_checking}
Outgoing: stdout, monitoring systems --- {JSON health report, exit code}
"""

import sys
import os
import json
import time
from pathlib import Path
from typing import Dict, Any, List, Optional
from datetime import datetime
from urllib.parse import urlparse
import socket

# Add project root to path
PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))


# =============================================================================
# Terminal Colors
# =============================================================================

class Colors:
    """ANSI color codes."""
    RED = '\033[0;31m'
    GREEN = '\033[0;32m'
    YELLOW = '\033[1;33m'
    BLUE = '\033[0;34m'
    MAGENTA = '\033[0;35m'
    CYAN = '\033[0;36m'
    WHITE = '\033[1;37m'
    RESET = '\033[0m'


def log_info(message: str) -> None:
    """Log info message."""
    print(f"{Colors.BLUE}[INFO]{Colors.RESET} {message}")


def log_success(message: str) -> None:
    """Log success message."""
    print(f"{Colors.GREEN}[✓]{Colors.RESET} {message}")


def log_warn(message: str) -> None:
    """Log warning message."""
    print(f"{Colors.YELLOW}[⚠]{Colors.RESET} {message}")


def log_error(message: str) -> None:
    """Log error message."""
    print(f"{Colors.RED}[✗]{Colors.RESET} {message}")


# =============================================================================
# Health Check Results
# =============================================================================

class HealthStatus:
    """Health check status."""
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    UNHEALTHY = "unhealthy"


class HealthCheck:
    """Health check result."""
    
    def __init__(self, name: str, component: str):
        self.name = name
        self.component = component
        self.status = HealthStatus.HEALTHY
        self.message: Optional[str] = None
        self.details: Dict[str, Any] = {}
        self.duration_ms: Optional[float] = None
        self.timestamp = datetime.utcnow().isoformat()
    
    def set_healthy(self, message: str = "OK", **details) -> None:
        """Mark as healthy."""
        self.status = HealthStatus.HEALTHY
        self.message = message
        self.details.update(details)
    
    def set_degraded(self, message: str, **details) -> None:
        """Mark as degraded."""
        self.status = HealthStatus.DEGRADED
        self.message = message
        self.details.update(details)
    
    def set_unhealthy(self, message: str, **details) -> None:
        """Mark as unhealthy."""
        self.status = HealthStatus.UNHEALTHY
        self.message = message
        self.details.update(details)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "name": self.name,
            "component": self.component,
            "status": self.status,
            "message": self.message,
            "details": self.details,
            "duration_ms": self.duration_ms,
            "timestamp": self.timestamp
        }


class HealthCheckRunner:
    """Health check runner."""
    
    def __init__(self):
        self.checks: List[HealthCheck] = []
    
    def add_check(self, check: HealthCheck) -> None:
        """Add health check result."""
        self.checks.append(check)
    
    def get_overall_status(self) -> str:
        """Get overall health status."""
        if any(c.status == HealthStatus.UNHEALTHY for c in self.checks):
            return HealthStatus.UNHEALTHY
        elif any(c.status == HealthStatus.DEGRADED for c in self.checks):
            return HealthStatus.DEGRADED
        else:
            return HealthStatus.HEALTHY
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        overall_status = self.get_overall_status()
        
        return {
            "status": overall_status,
            "timestamp": datetime.utcnow().isoformat(),
            "checks": [c.to_dict() for c in self.checks],
            "summary": {
                "total": len(self.checks),
                "healthy": sum(1 for c in self.checks if c.status == HealthStatus.HEALTHY),
                "degraded": sum(1 for c in self.checks if c.status == HealthStatus.DEGRADED),
                "unhealthy": sum(1 for c in self.checks if c.status == HealthStatus.UNHEALTHY)
            }
        }


# =============================================================================
# Health Check Functions
# =============================================================================

def check_database(runner: HealthCheckRunner) -> None:
    """Check database connectivity and health."""
    check = HealthCheck("database", "data")
    start_time = time.time()
    
    try:
        import psycopg
        from config.settings import get_settings
        settings = get_settings()
        
        # Connect to database
        conn = psycopg.connect(settings.database.url, connect_timeout=5)
        
        # Execute simple query
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
            cur.fetchone()
        
        # Get database statistics
        with conn.cursor() as cur:
            cur.execute("""
                SELECT 
                    COUNT(*) FILTER (WHERE schemaname = 'public') as table_count,
                    pg_database_size(current_database()) as size_bytes
                FROM pg_tables
            """)
            stats = cur.fetchone()
        
        conn.close()
        
        check.set_healthy(
            "Database connection successful",
            table_count=stats[0] if stats else 0,
            size_mb=round((stats[1] / 1024 / 1024), 2) if stats and stats[1] else 0
        )
    
    except Exception as e:
        check.set_unhealthy(f"Database connection failed: {e}")
    
    check.duration_ms = round((time.time() - start_time) * 1000, 2)
    runner.add_check(check)


def check_url_reachable(url: str, timeout: int = 3) -> tuple[bool, Optional[str]]:
    """
    Check if a URL is reachable.
    
    Returns:
        tuple[bool, Optional[str]]: (reachable, error_message)
    """
    try:
        parsed = urlparse(url)
        host = parsed.hostname or 'localhost'
        port = parsed.port or (443 if parsed.scheme == 'https' else 80)
        
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        result = sock.connect_ex((host, port))
        sock.close()
        
        if result == 0:
            return True, None
        else:
            return False, f"Connection failed (error code: {result})"
    
    except Exception as e:
        return False, str(e)


def check_services(runner: HealthCheckRunner) -> None:
    """Check external service availability."""
    try:
        from config.settings import get_settings
        settings = get_settings()
        
        services = [
            ("LM Studio", settings.integrations.lm_studio_url, settings.integrations.lm_studio_enabled),
            ("Perplexica", settings.integrations.perplexica_url, settings.integrations.perplexica_enabled),
            ("Docling", settings.integrations.docling_url, settings.integrations.docling_enabled),
            ("SearxNG", settings.integrations.searxng_url, settings.integrations.searxng_enabled),
            ("XLWings", settings.integrations.xlwings_url, settings.integrations.xlwings_enabled),
        ]
        
        for name, url, enabled in services:
            check = HealthCheck(f"service_{name.lower().replace(' ', '_')}", "integrations")
            start_time = time.time()
            
            if not enabled:
                check.set_degraded(f"{name} is disabled", url=url, enabled=False)
            else:
                reachable, error = check_url_reachable(url, timeout=2)
                
                if reachable:
                    check.set_healthy(f"{name} is reachable", url=url)
                else:
                    check.set_degraded(f"{name} not reachable: {error}", url=url)
            
            check.duration_ms = round((time.time() - start_time) * 1000, 2)
            runner.add_check(check)
    
    except Exception as e:
        check = HealthCheck("services", "integrations")
        check.set_unhealthy(f"Failed to check services: {e}")
        runner.add_check(check)


def check_mcp_system(runner: HealthCheckRunner) -> None:
    """Check MCP system health."""
    check = HealthCheck("mcp_system", "core")
    start_time = time.time()
    
    try:
        # Check if MCP tables exist
        import psycopg
        from config.settings import get_settings
        settings = get_settings()
        
        conn = psycopg.connect(settings.database.url, connect_timeout=5)
        
        with conn.cursor() as cur:
            cur.execute("""
                SELECT COUNT(*) 
                FROM information_schema.tables 
                WHERE table_schema = 'public' 
                AND table_name IN ('mcp_servers', 'mcp_tools', 'mcp_executions')
            """)
            table_count = cur.fetchone()[0]
        
        if table_count == 3:
            # Get MCP statistics
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT 
                        COUNT(*) as server_count,
                        COUNT(*) FILTER (WHERE status = 'active') as active_count
                    FROM mcp_servers
                """)
                stats = cur.fetchone()
            
            conn.close()
            
            check.set_healthy(
                "MCP system operational",
                servers_total=stats[0] if stats else 0,
                servers_active=stats[1] if stats else 0
            )
        else:
            check.set_unhealthy(f"MCP tables missing (found {table_count}/3)")
    
    except Exception as e:
        check.set_unhealthy(f"MCP system check failed: {e}")
    
    check.duration_ms = round((time.time() - start_time) * 1000, 2)
    runner.add_check(check)


def check_storage(runner: HealthCheckRunner) -> None:
    """Check storage system health."""
    check = HealthCheck("storage", "data")
    start_time = time.time()
    
    try:
        from config.settings import get_settings
        settings = get_settings()
        
        storage_path = settings.storage.base_path
        
        # Ensure storage directory exists
        storage_path.mkdir(parents=True, exist_ok=True)
        
        # Check if writable
        test_file = storage_path / ".health_check"
        test_file.write_text("health_check")
        test_file.unlink()
        
        # Get storage statistics
        import shutil
        stat = shutil.disk_usage(storage_path)
        
        free_percent = (stat.free / stat.total) * 100
        
        if free_percent < 10:
            check.set_degraded(
                f"Storage space low ({free_percent:.1f}% free)",
                path=str(storage_path),
                free_gb=round(stat.free / (1024**3), 2),
                total_gb=round(stat.total / (1024**3), 2)
            )
        else:
            check.set_healthy(
                "Storage system operational",
                path=str(storage_path),
                free_gb=round(stat.free / (1024**3), 2),
                total_gb=round(stat.total / (1024**3), 2),
                free_percent=round(free_percent, 1)
            )
    
    except Exception as e:
        check.set_unhealthy(f"Storage check failed: {e}")
    
    check.duration_ms = round((time.time() - start_time) * 1000, 2)
    runner.add_check(check)


def check_configuration(runner: HealthCheckRunner) -> None:
    """Check configuration files."""
    check = HealthCheck("configuration", "config")
    start_time = time.time()
    
    try:
        from config.settings import get_settings
        settings = get_settings()
        
        # Basic configuration checks
        issues = []
        
        if not settings.database.url:
            issues.append("Database URL not configured")
        
        if not settings.llm.api_base:
            issues.append("LLM API base not configured")
        
        if settings.security.bind_host == "0.0.0.0":
            issues.append("Server exposed on all interfaces (security risk)")
        
        if issues:
            check.set_degraded(
                f"Configuration has {len(issues)} issues",
                issues=issues
            )
        else:
            check.set_healthy(
                "Configuration valid",
                environment=settings.environment
            )
    
    except Exception as e:
        check.set_unhealthy(f"Configuration check failed: {e}")
    
    check.duration_ms = round((time.time() - start_time) * 1000, 2)
    runner.add_check(check)


def check_runtime_dependencies(runner: HealthCheckRunner) -> None:
    """Check runtime dependencies."""
    check = HealthCheck("dependencies", "runtime")
    start_time = time.time()
    
    required_packages = [
        "fastapi",
        "uvicorn",
        "psycopg",
        "pydantic",
        "yaml",
        "toml",
    ]
    
    missing = []
    for package in required_packages:
        try:
            __import__(package)
        except ImportError:
            missing.append(package)
    
    if missing:
        check.set_unhealthy(
            f"Missing required packages: {', '.join(missing)}",
            missing_packages=missing
        )
    else:
        check.set_healthy(
            "All required dependencies installed",
            checked_packages=len(required_packages)
        )
    
    check.duration_ms = round((time.time() - start_time) * 1000, 2)
    runner.add_check(check)


# =============================================================================
# Output Formatters
# =============================================================================

def print_human_readable(runner: HealthCheckRunner) -> None:
    """Print human-readable health check results."""
    print()
    print(f"{Colors.CYAN}{'='*70}{Colors.RESET}")
    print(f"{Colors.CYAN}AETHER BACKEND HEALTH CHECK{Colors.RESET}")
    print(f"{Colors.CYAN}{'='*70}{Colors.RESET}")
    print()
    
    overall_status = runner.get_overall_status()
    
    # Print overall status
    if overall_status == HealthStatus.HEALTHY:
        print(f"Overall Status: {Colors.GREEN}✓ HEALTHY{Colors.RESET}")
    elif overall_status == HealthStatus.DEGRADED:
        print(f"Overall Status: {Colors.YELLOW}⚠ DEGRADED{Colors.RESET}")
    else:
        print(f"Overall Status: {Colors.RED}✗ UNHEALTHY{Colors.RESET}")
    
    print()
    print(f"{Colors.WHITE}Component Health:{Colors.RESET}")
    print()
    
    # Group by component
    by_component: Dict[str, List[HealthCheck]] = {}
    for check in runner.checks:
        if check.component not in by_component:
            by_component[check.component] = []
        by_component[check.component].append(check)
    
    # Print each component
    for component, checks in sorted(by_component.items()):
        print(f"  {Colors.WHITE}{component.upper()}{Colors.RESET}")
        
        for check in checks:
            status_icon = {
                HealthStatus.HEALTHY: f"{Colors.GREEN}✓{Colors.RESET}",
                HealthStatus.DEGRADED: f"{Colors.YELLOW}⚠{Colors.RESET}",
                HealthStatus.UNHEALTHY: f"{Colors.RED}✗{Colors.RESET}"
            }[check.status]
            
            duration = f"({check.duration_ms}ms)" if check.duration_ms else ""
            print(f"    {status_icon} {check.name}: {check.message} {duration}")
            
            # Print details if degraded or unhealthy
            if check.status != HealthStatus.HEALTHY and check.details:
                for key, value in check.details.items():
                    print(f"        {key}: {value}")
        
        print()
    
    # Print summary
    summary = runner.to_dict()["summary"]
    print(f"{Colors.WHITE}Summary:{Colors.RESET}")
    print(f"  Total Checks:   {summary['total']}")
    print(f"  {Colors.GREEN}Healthy:{Colors.RESET}        {summary['healthy']}")
    print(f"  {Colors.YELLOW}Degraded:{Colors.RESET}       {summary['degraded']}")
    print(f"  {Colors.RED}Unhealthy:{Colors.RESET}      {summary['unhealthy']}")
    print()


def print_json_output(runner: HealthCheckRunner) -> None:
    """Print JSON health check results."""
    result = runner.to_dict()
    print(json.dumps(result, indent=2))


# =============================================================================
# Main Health Check Runner
# =============================================================================

def run_health_check(json_output: bool = False, quick: bool = False) -> bool:
    """
    Run health check.
    
    Args:
        json_output: Output as JSON instead of human-readable
        quick: Run only critical checks (skip services)
    
    Returns:
        bool: True if healthy, False otherwise
    """
    runner = HealthCheckRunner()
    
    # Core checks (always run)
    check_configuration(runner)
    check_runtime_dependencies(runner)
    check_database(runner)
    check_storage(runner)
    check_mcp_system(runner)
    
    # Extended checks (skip in quick mode)
    if not quick:
        check_services(runner)
    
    # Output results
    if json_output:
        print_json_output(runner)
    else:
        print_human_readable(runner)
    
    # Return exit code
    overall_status = runner.get_overall_status()
    return overall_status == HealthStatus.HEALTHY


# =============================================================================
# CLI Interface
# =============================================================================

def main():
    """Main CLI entry point."""
    import argparse
    
    parser = argparse.ArgumentParser(
        description="Aether Backend Health Check",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Run full health check
  python health_check.py

  # Quick check (skip services)
  python health_check.py --quick

  # JSON output for monitoring systems
  python health_check.py --json

  # Quick check with JSON output
  python health_check.py --quick --json
        """
    )
    
    parser.add_argument(
        '--json',
        action='store_true',
        help='Output as JSON'
    )
    
    parser.add_argument(
        '--quick',
        action='store_true',
        help='Run only critical checks (skip services)'
    )
    
    args = parser.parse_args()
    
    # Run health check
    healthy = run_health_check(json_output=args.json, quick=args.quick)
    
    # Exit with appropriate code
    sys.exit(0 if healthy else 1)


if __name__ == "__main__":
    main()

