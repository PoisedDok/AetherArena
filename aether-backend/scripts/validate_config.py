#!/usr/bin/env python3
"""
Aether Backend - Configuration Validator

Production-ready configuration validation:
- Schema validation for all config files
- Dependency verification (services, integrations)
- Environment variable checks
- File path verification
- Network connectivity tests
- Security configuration audits

@.architecture
Incoming: Command line, config files --- {CLI args, YAML/TOML config files}
Processing: validate_yaml_schema(), validate_dependencies(), check_paths(), test_connectivity() --- {4 jobs: config_validation, dependency_checking, schema_validation, validation}
Outgoing: stdout --- {Validation report, exit code}
"""

import sys
import os
import json
import yaml
import toml
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple
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


def print_section(title: str) -> None:
    """Print section header."""
    print()
    print(f"{Colors.WHITE}{'='*70}{Colors.RESET}")
    print(f"{Colors.WHITE}{title.upper()}{Colors.RESET}")
    print(f"{Colors.WHITE}{'='*70}{Colors.RESET}")
    print()


# =============================================================================
# Validation Results Tracker
# =============================================================================

class ValidationResults:
    """Track validation results."""
    
    def __init__(self):
        self.passed: List[str] = []
        self.warnings: List[str] = []
        self.errors: List[str] = []
    
    def add_pass(self, message: str) -> None:
        """Add passing validation."""
        self.passed.append(message)
        log_success(message)
    
    def add_warning(self, message: str) -> None:
        """Add warning."""
        self.warnings.append(message)
        log_warn(message)
    
    def add_error(self, message: str) -> None:
        """Add error."""
        self.errors.append(message)
        log_error(message)
    
    def print_summary(self) -> None:
        """Print validation summary."""
        print_section("Validation Summary")
        
        print(f"{Colors.GREEN}Passed:{Colors.RESET}    {len(self.passed)}")
        print(f"{Colors.YELLOW}Warnings:{Colors.RESET}  {len(self.warnings)}")
        print(f"{Colors.RED}Errors:{Colors.RESET}    {len(self.errors)}")
        print()
        
        if self.errors:
            print(f"{Colors.RED}VALIDATION FAILED{Colors.RESET}")
            print()
            print("Errors:")
            for error in self.errors:
                print(f"  • {error}")
            print()
        
        elif self.warnings:
            print(f"{Colors.YELLOW}VALIDATION PASSED WITH WARNINGS{Colors.RESET}")
            print()
            print("Warnings:")
            for warning in self.warnings:
                print(f"  • {warning}")
            print()
        
        else:
            print(f"{Colors.GREEN}✓ ALL VALIDATIONS PASSED{Colors.RESET}")
            print()
    
    def has_errors(self) -> bool:
        """Check if there are any errors."""
        return len(self.errors) > 0


# =============================================================================
# Configuration File Validators
# =============================================================================

def validate_file_exists(file_path: Path, required: bool = True) -> Tuple[bool, Optional[str]]:
    """
    Validate that a file exists.
    
    Returns:
        Tuple[bool, Optional[str]]: (success, error_message)
    """
    if file_path.exists():
        return True, None
    else:
        if required:
            return False, f"Required file not found: {file_path}"
        else:
            return False, f"Optional file not found: {file_path}"


def validate_settings_py(results: ValidationResults) -> None:
    """Validate config/settings.py."""
    log_info("Validating settings.py...")
    
    settings_file = PROJECT_ROOT / "config" / "settings.py"
    success, error = validate_file_exists(settings_file)
    
    if not success:
        results.add_error(error)
        return
    
    # Try importing settings
    try:
        from config.settings import get_settings
        settings = get_settings()
        results.add_pass("settings.py - Structure valid")
        
        # Validate critical settings
        if settings.database.url:
            results.add_pass("settings.py - Database URL configured")
        else:
            results.add_error("settings.py - Database URL missing")
        
        if settings.llm.api_base:
            results.add_pass("settings.py - LLM API base configured")
        else:
            results.add_warning("settings.py - LLM API base not configured")
        
    except Exception as e:
        results.add_error(f"settings.py - Import failed: {e}")


def validate_models_toml(results: ValidationResults) -> None:
    """Validate config/models.toml."""
    log_info("Validating models.toml...")
    
    models_file = PROJECT_ROOT / "config" / "models.toml"
    success, error = validate_file_exists(models_file)
    
    if not success:
        results.add_error(error)
        return
    
    # Parse TOML
    try:
        with open(models_file, 'r') as f:
            config = toml.load(f)
        
        results.add_pass("models.toml - Syntax valid")
        
        # Check required sections
        required_sections = ["MODELS", "PROVIDERS"]
        for section in required_sections:
            if section in config:
                results.add_pass(f"models.toml - Section '{section}' present")
            else:
                results.add_error(f"models.toml - Missing required section '{section}'")
        
        # Validate PROVIDERS
        if "PROVIDERS" in config:
            providers = config["PROVIDERS"]
            
            # Check for required provider URLs
            provider_keys = [
                "lm_studio_url",
                "perplexica_url",
                "docling_url",
                "searxng_url",
                "xlwings_url"
            ]
            
            for key in provider_keys:
                if key in providers and providers[key]:
                    results.add_pass(f"models.toml - Provider '{key}' configured")
                else:
                    results.add_warning(f"models.toml - Provider '{key}' not configured")
    
    except Exception as e:
        results.add_error(f"models.toml - Parse failed: {e}")


def validate_integrations_registry(results: ValidationResults) -> None:
    """Validate config/integrations_registry.yaml."""
    log_info("Validating integrations_registry.yaml...")
    
    registry_file = PROJECT_ROOT / "config" / "integrations_registry.yaml"
    success, error = validate_file_exists(registry_file)
    
    if not success:
        results.add_error(error)
        return
    
    # Parse YAML
    try:
        with open(registry_file, 'r') as f:
            config = yaml.safe_load(f)
        
        results.add_pass("integrations_registry.yaml - Syntax valid")
        
        # Check structure
        if "integrations" in config:
            integrations = config["integrations"]
            results.add_pass(f"integrations_registry.yaml - Found {len(integrations)} integrations")
            
            # Validate each integration
            for name, integration in integrations.items():
                required_fields = ["type", "enabled"]
                missing = [f for f in required_fields if f not in integration]
                
                if missing:
                    results.add_warning(f"Integration '{name}' missing fields: {missing}")
                else:
                    results.add_pass(f"Integration '{name}' - Structure valid")
        else:
            results.add_error("integrations_registry.yaml - Missing 'integrations' key")
    
    except Exception as e:
        results.add_error(f"integrations_registry.yaml - Parse failed: {e}")


def validate_environment_configs(results: ValidationResults) -> None:
    """Validate environment-specific configs."""
    log_info("Validating environment configs...")
    
    env_dir = PROJECT_ROOT / "config" / "environments"
    
    for env_file in ["development.yaml", "production.yaml", "test.yaml"]:
        file_path = env_dir / env_file
        success, error = validate_file_exists(file_path, required=False)
        
        if success:
            try:
                with open(file_path, 'r') as f:
                    yaml.safe_load(f)
                results.add_pass(f"{env_file} - Syntax valid")
            except Exception as e:
                results.add_error(f"{env_file} - Parse failed: {e}")
        else:
            results.add_warning(error)


# =============================================================================
# Schema File Validators
# =============================================================================

def validate_database_schemas(results: ValidationResults) -> None:
    """Validate database schema files."""
    log_info("Validating database schemas...")
    
    migrations_dir = PROJECT_ROOT / "data" / "database" / "migrations"
    
    # Check schema files
    schema_files = ["schema.sql", "mcp_schema.sql"]
    
    for schema_file in schema_files:
        file_path = migrations_dir / schema_file
        success, error = validate_file_exists(file_path)
        
        if not success:
            results.add_error(error)
        else:
            # Check file is not empty
            if file_path.stat().st_size > 0:
                results.add_pass(f"{schema_file} - File exists and not empty")
            else:
                results.add_error(f"{schema_file} - File is empty")


# =============================================================================
# Environment Variable Validators
# =============================================================================

def validate_environment_variables(results: ValidationResults) -> None:
    """Validate required environment variables."""
    log_info("Validating environment variables...")
    
    # Optional but recommended environment variables
    recommended_vars = {
        "DATABASE_URL": "Database connection string",
        "AETHER_ENVIRONMENT": "Environment (development/production/test)",
        "LLM_API_BASE": "LLM API endpoint",
        "MONITORING_LOG_LEVEL": "Log level",
    }
    
    for var, description in recommended_vars.items():
        if os.getenv(var):
            results.add_pass(f"Environment variable '{var}' set")
        else:
            results.add_warning(f"Environment variable '{var}' not set ({description})")


# =============================================================================
# Network Connectivity Validators
# =============================================================================

def check_url_reachable(url: str, timeout: int = 3) -> bool:
    """
    Check if a URL is reachable.
    
    Args:
        url: URL to check
        timeout: Connection timeout in seconds
    
    Returns:
        bool: True if reachable, False otherwise
    """
    try:
        parsed = urlparse(url)
        host = parsed.hostname or 'localhost'
        port = parsed.port or (443 if parsed.scheme == 'https' else 80)
        
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        result = sock.connect_ex((host, port))
        sock.close()
        
        return result == 0
    except Exception:
        return False


def validate_service_connectivity(results: ValidationResults, check_services: bool = False) -> None:
    """Validate connectivity to external services."""
    if not check_services:
        log_info("Skipping service connectivity checks (use --check-services to enable)")
        return
    
    log_info("Validating service connectivity...")
    
    # Load settings to get service URLs
    try:
        from config.settings import get_settings
        settings = get_settings()
        
        services = {
            "LM Studio": settings.integrations.lm_studio_url,
            "Perplexica": settings.integrations.perplexica_url,
            "Docling": settings.integrations.docling_url,
            "SearxNG": settings.integrations.searxng_url,
            "XLWings": settings.integrations.xlwings_url,
        }
        
        for name, url in services.items():
            if check_url_reachable(url):
                results.add_pass(f"Service '{name}' reachable at {url}")
            else:
                results.add_warning(f"Service '{name}' not reachable at {url}")
    
    except Exception as e:
        results.add_warning(f"Could not check service connectivity: {e}")


def validate_database_connectivity(results: ValidationResults, check_db: bool = False) -> None:
    """Validate database connectivity."""
    if not check_db:
        log_info("Skipping database connectivity check (use --check-db to enable)")
        return
    
    log_info("Validating database connectivity...")
    
    try:
        import psycopg
        from config.settings import get_settings
        settings = get_settings()
        
        conn = psycopg.connect(settings.database.url, connect_timeout=3)
        conn.close()
        
        results.add_pass(f"Database connection successful")
    
    except Exception as e:
        results.add_error(f"Database connection failed: {e}")


# =============================================================================
# Directory Structure Validators
# =============================================================================

def validate_directory_structure(results: ValidationResults) -> None:
    """Validate expected directory structure."""
    log_info("Validating directory structure...")
    
    required_dirs = [
        "api",
        "api/v1",
        "api/v1/endpoints",
        "api/v1/schemas",
        "api/middleware",
        "config",
        "config/environments",
        "core",
        "core/runtime",
        "core/integrations",
        "core/mcp",
        "core/profiles",
        "data",
        "data/database",
        "data/database/migrations",
        "data/storage",
        "monitoring",
        "security",
        "utils",
        "ws",
        "tests",
        "scripts",
    ]
    
    for dir_path in required_dirs:
        full_path = PROJECT_ROOT / dir_path
        if full_path.exists() and full_path.is_dir():
            results.add_pass(f"Directory '{dir_path}' exists")
        else:
            results.add_error(f"Required directory missing: {dir_path}")


# =============================================================================
# Security Configuration Validators
# =============================================================================

def validate_security_config(results: ValidationResults) -> None:
    """Validate security configuration."""
    log_info("Validating security configuration...")
    
    try:
        from config.settings import get_settings
        settings = get_settings()
        
        # Check CORS configuration
        if settings.security.allowed_origins:
            if "*" in settings.security.allowed_origins:
                results.add_warning("CORS allows all origins (*) - not recommended for production")
            else:
                results.add_pass("CORS origins properly restricted")
        
        # Check authentication
        if settings.security.auth_enabled:
            if settings.security.auth_secret_key:
                results.add_pass("Authentication enabled with secret key")
            else:
                results.add_error("Authentication enabled but no secret key configured")
        else:
            results.add_warning("Authentication not enabled")
        
        # Check rate limiting
        if settings.security.rate_limit_enabled:
            results.add_pass("Rate limiting enabled")
        else:
            results.add_warning("Rate limiting not enabled")
        
        # Check bind address
        if settings.security.bind_host == "0.0.0.0":
            results.add_warning("Server bound to 0.0.0.0 - accessible from network")
        elif settings.security.bind_host in ["127.0.0.1", "localhost"]:
            results.add_pass("Server bound to localhost only")
    
    except Exception as e:
        results.add_error(f"Could not validate security config: {e}")


# =============================================================================
# Main Validation Runner
# =============================================================================

def run_validation(check_services: bool = False, check_db: bool = False) -> bool:
    """
    Run all validation checks.
    
    Args:
        check_services: Whether to check service connectivity
        check_db: Whether to check database connectivity
    
    Returns:
        bool: True if validation passed, False otherwise
    """
    results = ValidationResults()
    
    print()
    print(f"{Colors.CYAN}{'='*70}{Colors.RESET}")
    print(f"{Colors.CYAN}AETHER BACKEND CONFIGURATION VALIDATOR{Colors.RESET}")
    print(f"{Colors.CYAN}{'='*70}{Colors.RESET}")
    
    # Configuration files
    print_section("Configuration Files")
    validate_settings_py(results)
    validate_models_toml(results)
    validate_integrations_registry(results)
    validate_environment_configs(results)
    
    # Database schemas
    print_section("Database Schemas")
    validate_database_schemas(results)
    
    # Environment variables
    print_section("Environment Variables")
    validate_environment_variables(results)
    
    # Directory structure
    print_section("Directory Structure")
    validate_directory_structure(results)
    
    # Security configuration
    print_section("Security Configuration")
    validate_security_config(results)
    
    # Network connectivity (optional)
    if check_services or check_db:
        print_section("Network Connectivity")
        validate_service_connectivity(results, check_services)
        validate_database_connectivity(results, check_db)
    
    # Print summary
    results.print_summary()
    
    return not results.has_errors()


# =============================================================================
# CLI Interface
# =============================================================================

def main():
    """Main CLI entry point."""
    import argparse
    
    parser = argparse.ArgumentParser(
        description="Aether Backend Configuration Validator",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Basic validation (config files and structure)
  python validate_config.py

  # Include service connectivity checks
  python validate_config.py --check-services

  # Include database connectivity check
  python validate_config.py --check-db

  # Full validation (all checks)
  python validate_config.py --check-services --check-db
        """
    )
    
    parser.add_argument(
        '--check-services',
        action='store_true',
        help='Check connectivity to external services'
    )
    
    parser.add_argument(
        '--check-db',
        action='store_true',
        help='Check database connectivity'
    )
    
    args = parser.parse_args()
    
    # Run validation
    success = run_validation(
        check_services=args.check_services,
        check_db=args.check_db
    )
    
    # Exit with appropriate code
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()

