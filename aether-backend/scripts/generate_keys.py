#!/usr/bin/env python3
"""
Secure Key Generation Utility for AetherArena
Generates all necessary cryptographic keys and tokens for first-run setup

@.architecture
Incoming: CLI args, system entropy --- {argv, random.SystemRandom}
Processing: generate_keys(), validate_strength(), write_env_file(), store_in_db() --- {4 jobs: JOB_GENERATE, JOB_VALIDATE, JOB_PERSIST, JOB_STORE}
Outgoing: config/local.env, .env files, api_keys table, stdout --- {env_file, Dict[str, str]}
"""

import secrets
import string
import sys
from pathlib import Path
from typing import Dict, Optional
from datetime import datetime, timedelta
import jwt


def generate_secure_password(length: int = 64, include_special: bool = True) -> str:
    """Generate a cryptographically secure password.
    
    For Docker/shell safety, only use alphanumeric characters.
    Special chars like []|^&$ cause shell expansion issues in docker-compose.
    64-char alphanumeric provides ~380 bits of entropy (more than sufficient).
    """
    # SHELL-SAFE: Only alphanumeric (no special chars that break shell/docker)
    chars = string.ascii_letters + string.digits
    return ''.join(secrets.choice(chars) for _ in range(length))


def generate_jwt_secret(length: int = 64) -> str:
    """Generate a secure JWT secret key."""
    return secrets.token_urlsafe(length)


def generate_supabase_jwt_token(secret: str, role: str, expiry_years: int = 10) -> str:
    """
    Generate Supabase-compatible JWT token.
    
    Args:
        secret: JWT secret key
        role: JWT role (anon, service_role, authenticated)
        expiry_years: Token validity period in years
    """
    iat = datetime.utcnow()
    exp = iat + timedelta(days=365 * expiry_years)
    
    payload = {
        "role": role,
        "iss": "supabase",
        "iat": int(iat.timestamp()),
        "exp": int(exp.timestamp())
    }
    
    return jwt.encode(payload, secret, algorithm="HS256")


def generate_encryption_key(length: int = 32) -> str:
    """Generate a simple alphanumeric encryption key of specific length.
    
    Using alphanumeric characters ensures the string itself is the correct byte length
    when used as an encryption key in services like Supavisor (Erlang).
    """
    chars = string.ascii_letters + string.digits
    return ''.join(secrets.choice(chars) for _ in range(length))


def generate_all_keys() -> Dict[str, str]:
    """
    Generate all required keys and tokens for AetherArena.
    
    Returns:
        Dictionary of key names to values
    """
    print("🔐 Generating secure keys and tokens...")
    
    # Generate base secrets
    postgres_password = generate_secure_password(64)
    jwt_secret = generate_jwt_secret(64)
    dashboard_password = generate_secure_password(32)
    secret_key_base = generate_secure_password(64)
    
    # Generate encryption keys (ensure proper length)
    vault_enc_key = generate_encryption_key(32)
    pg_meta_crypto_key = generate_encryption_key(32)
    
    # Generate Supabase JWT tokens
    anon_key = generate_supabase_jwt_token(jwt_secret, "anon", expiry_years=10)
    service_role_key = generate_supabase_jwt_token(jwt_secret, "service_role", expiry_years=10)
    
    # Generate Logflare tokens
    logflare_public_token = secrets.token_urlsafe(32)
    logflare_private_token = secrets.token_urlsafe(32)
    
    # Generate SearXNG secret
    searxng_secret = secrets.token_urlsafe(32)
    
    # Generate tenant ID
    tenant_id = secrets.token_hex(16)
    
    # Generate backend API keys
    backend_admin_key = secrets.token_urlsafe(32)
    interpreter_api_key = secrets.token_urlsafe(32)
    
    keys = {
        # Supabase Database
        "POSTGRES_PASSWORD": postgres_password,
        "JWT_SECRET": jwt_secret,
        "ANON_KEY": anon_key,
        "SERVICE_ROLE_KEY": service_role_key,
        "DASHBOARD_USERNAME": "admin",
        "DASHBOARD_PASSWORD": dashboard_password,
        "SECRET_KEY_BASE": secret_key_base,
        "VAULT_ENC_KEY": vault_enc_key,
        "PG_META_CRYPTO_KEY": pg_meta_crypto_key,
        
        # Pooler
        "POOLER_TENANT_ID": tenant_id,
        
        # Logflare
        "LOGFLARE_PUBLIC_ACCESS_TOKEN": logflare_public_token,
        "LOGFLARE_PRIVATE_ACCESS_TOKEN": logflare_private_token,
        
        # SearXNG
        "SEARXNG_SECRET": searxng_secret,
        
        # Backend API Keys
        "BACKEND_ADMIN_API_KEY": backend_admin_key,
        "INTERPRETER_API_KEY": interpreter_api_key,
        
        # Supabase connection for backend
        "SUPABASE_URL": "http://localhost:54321",
        "SUPABASE_ANON_KEY": anon_key,
        "SUPABASE_SERVICE_ROLE_KEY": service_role_key,
        "SUPABASE_DB_USER": "supabase_admin",
        "SUPABASE_DB_PASSWORD": postgres_password,
        "SUPABASE_DB_NAME": "aether",
        "SUPABASE_DB_PORT": "5432",
        
        # Database connection strings
        # CRITICAL: Use actual Docker-mapped port (dynamically discovered at runtime)
        # External services mesh uses internal Docker network (port 5432 internal)
        # Backend connects via host-mapped port (queried from `docker port supabase-db`)
        "DATABASE_URL": f"postgresql://supabase_admin:{postgres_password}@localhost:55432/aether",
        "POSTGRES_HOST": "localhost",
        "POSTGRES_DB": "aether",
        "POSTGRES_PORT": "55432",  # Actual Docker-mapped port from docker-compose.yml
        
        # Docker defaults
        "DOCKER_SOCKET_LOCATION": "/var/run/docker.sock",
        
        # Supabase Service Ports
        "KONG_HTTP_PORT": "54321",
        "KONG_HTTPS_PORT": "54322",
        "JWT_EXPIRY": "315360000", # 10 years
        "PGRST_DB_SCHEMAS": "public,storage,graphql_public",
        "SITE_URL": "http://localhost:3000",
        "SUPABASE_PUBLIC_URL": "http://localhost:54321",
        "POOLER_PROXY_PORT_TRANSACTION": "6543",
        "POOLER_DB_POOL_SIZE": "25",
        "POOLER_DEFAULT_POOL_SIZE": "20",
        "POOLER_MAX_CLIENT_CONN": "200",
        "STUDIO_DEFAULT_ORGANIZATION": "AetherArena",
        "STUDIO_DEFAULT_PROJECT": "Local",
        "IMGPROXY_ENABLE_WEBP_DETECTION": "true",
        "FUNCTIONS_VERIFY_JWT": "false",
        "ENABLE_EMAIL_SIGNUP": "true",
        "ENABLE_EMAIL_AUTOCONFIRM": "true",
        "ENABLE_PHONE_SIGNUP": "false",
        "ENABLE_PHONE_AUTOCONFIRM": "false",
        "ENABLE_ANONYMOUS_USERS": "true",
        "DISABLE_SIGNUP": "false",
        
        # SMTP defaults (optional, for email features)
        "SMTP_PORT": "587",
        "SMTP_HOST": "",
        "SMTP_USER": "",
        "SMTP_PASS": "",
        "SMTP_ADMIN_EMAIL": "",
        "SMTP_SENDER_NAME": "",
        "MAILER_URLPATHS_CONFIRMATION": "",
        "MAILER_URLPATHS_INVITE": "",
        "MAILER_URLPATHS_RECOVERY": "",
        "MAILER_URLPATHS_EMAIL_CHANGE": "",
        "API_EXTERNAL_URL": "http://localhost:54321",
        "ADDITIONAL_REDIRECT_URLS": "",
        
        # Interpreter External Mode (Per-Chat Isolation using venv-oi)
        "INTERPRETER_EXTERNAL_SERVER_ENABLED": "true",
        "INTERPRETER_EXTERNAL_SERVER_URL": "http://127.0.0.1",  # Base URL (scheme + host, no port - port is from range)
        "INTERPRETER_EXTERNAL_SERVER_PER_CHAT": "true",  # REQUIRED: Backend enforces per-chat isolation
        "INTERPRETER_EXTERNAL_SERVER_AUTH": interpreter_api_key,  # Auth token for OI servers
        "INTERPRETER_EXTERNAL_SERVER_PORT_MIN": "8010",  # Per-chat spawn port range start
        "INTERPRETER_EXTERNAL_SERVER_PORT_MAX": "8099",  # Per-chat spawn port range end
        "INTERPRETER_EXTERNAL_SERVER_MAX_SERVERS": "10",  # Max concurrent per-chat instances
        "INTERPRETER_EXTERNAL_SERVER_TTL_SECONDS": "1800",  # 30min idle timeout
        "INTERPRETER_ALLOW_VENDORED_RUNTIME": "false",
        
        # Aether Inference (native vllm-mlx / vLLM / Ollama server)
        "INFERENCE_ENABLED": "true",
        "INFERENCE_PORT": "7090",  # Avoids 8010-8099 (OI), 8765 (backend), Docker mesh
        "INFERENCE_AUTO_START": "true",
    }
    
    print(f"✅ Generated {len(keys)} secure keys and tokens")
    return keys


def write_env_file(keys: Dict[str, str], output_path: Path, template_path: Optional[Path] = None) -> None:
    """
    Write keys to environment file, optionally using a template.
    
    Args:
        keys: Dictionary of key-value pairs
        output_path: Path to output .env file
        template_path: Optional template file to merge with
    """
    content = []
    content.append("# AetherArena - Auto-generated Configuration")
    content.append(f"# Generated: {datetime.utcnow().isoformat()}Z")
    content.append("# DO NOT COMMIT THIS FILE TO VERSION CONTROL")
    content.append("# Backup this file securely - contains all secrets")
    content.append("")
    
    if template_path and template_path.exists():
        # Read template and replace values
        template = template_path.read_text()
        for key, value in keys.items():
            # Replace lines that start with KEY=
            lines = template.split('\n')
            new_lines = []
            replaced = False
            for line in lines:
                stripped = line.strip()
                if stripped.startswith(f"{key}="):
                    new_lines.append(f'{key}="{value}"')
                    replaced = True
                else:
                    new_lines.append(line)
            template = '\n'.join(new_lines)
        
        content.append(template)
    else:
        # Write keys directly
        content.append("# Generated Keys")
        content.append("")
        for key, value in sorted(keys.items()):
            content.append(f'{key}="{value}"')
    
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text('\n'.join(content))
    
    # Set restrictive permissions (owner read/write only)
    output_path.chmod(0o600)
    
    print(f"✅ Wrote configuration to: {output_path}")
    print(f"   Permissions: {oct(output_path.stat().st_mode)[-3:]}")


def create_user_keys_template() -> Dict[str, Dict[str, str]]:
    """
    Define keys that users must provide (external API keys).
    
    Returns:
        Dictionary of key categories with descriptions
    """
    return {
        "llm_providers": {
            "LM_STUDIO_API_KEY": "API key for LM Studio (optional, default: 'not-needed')",
            "OPENROUTER_API_KEY": "API key for OpenRouter (optional for fallback embeddings)",
            "OPENAI_API_KEY": "OpenAI API key (optional for SQL Editor Assistant)",
        },
        "optional_services": {
            "SEARXNG_URL": "SearXNG instance URL (optional, default: http://127.0.0.1:4040)",
            "PERPLEXICA_URL": "Perplexica service URL (optional, default: http://localhost:3000)",
        }
    }


def load_existing_secrets(env_path: Path) -> Dict[str, str]:
    """
    Load existing secrets from env file if it exists.
    Returns empty dict if file doesn't exist or can't be parsed.
    """
    secrets = {}
    if not env_path.exists():
        return secrets
    
    try:
        content = env_path.read_text()
        for line in content.split('\n'):
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, _, value = line.partition('=')
            key = key.strip()
            value = value.strip()
            # Only preserve critical secrets that must stay in sync with database
            if key in ['POSTGRES_PASSWORD', 'JWT_SECRET',
                       'SECRET_KEY_BASE', 'VAULT_ENC_KEY', 'PG_META_CRYPTO_KEY',
                       'DASHBOARD_PASSWORD', 'LOGFLARE_PUBLIC_ACCESS_TOKEN',
                       'LOGFLARE_PRIVATE_ACCESS_TOKEN', 'POOLER_TENANT_ID']:
                secrets[key] = value
    except Exception as e:
        print(f"⚠️  Warning: Could not read existing secrets: {e}")
    
    return secrets


def database_exists_with_data(env_path: Path) -> bool:
    """
    Check if database exists and has data by looking for Docker volume indicators.
    This is a lightweight check that doesn't require database connection.
    """
    import subprocess
    
    # STRATEGY 1: Check for running/stopped supabase-db container
    container_name = None
    try:
        result = subprocess.run(
            ['docker', 'ps', '-a', '--format', '{{.Names}}'],
            capture_output=True, text=True, timeout=10
        )
        # Look for container with supabase-db in name (handles supabase-db, aether-mesh-db-1, etc.)
        for line in result.stdout.split('\n'):
            line = line.strip()
            if 'supabase' in line.lower() and 'db' in line.lower():
                container_name = line
                break
            if line == 'supabase-db':
                container_name = line
                break
        
        if container_name:
            # Container exists - check if it has data
            try:
                result = subprocess.run(
                    ['docker', 'exec', container_name, 'psql', '-U', 'postgres', '-d', 'aether', 
                     '-c', "SELECT 1 FROM pg_roles WHERE rolname='supabase_admin' LIMIT 1;"],
                    capture_output=True, text=True, timeout=10
                )
                if result.returncode == 0 and '1' in result.stdout:
                    return True
            except Exception:
                pass
    except Exception:
        pass
    
    # STRATEGY 2: Check for persistent Docker volume with postgres data
    try:
        result = subprocess.run(
            ['docker', 'volume', 'ls', '--format', '{{.Name}}'],
            capture_output=True, text=True, timeout=10
        )
        for line in result.stdout.split('\n'):
            if 'postgres' in line.lower() or 'db' in line.lower() or 'data' in line.lower():
                # Check if volume contains PostgreSQL data
                try:
                    # Mount volume to a temporary container and check for PG_VERSION
                    check_result = subprocess.run(
                        ['docker', 'run', '--rm', '-v', f'{line.strip()}:/data', 
                         'alpine:latest', 'ls', '/data/PG_VERSION'],
                        capture_output=True, text=True, timeout=5
                    )
                    if check_result.returncode == 0:
                        return True  # Volume has PostgreSQL data
                except Exception:
                    continue
    except Exception:
        pass
    
    # STRATEGY 3: Check for local data directory (AETHER_DOCKER_DATA path)
    docker_data = env_path.parent.parent / 'docker-data'
    if docker_data.exists():
        pg_data = docker_data / 'db'  # Common pattern
        if pg_data.exists() and any(pg_data.iterdir()):
            return True
    
    return False


def main():
    """Main entry point for key generation."""
    import argparse
    parser = argparse.ArgumentParser(description="AetherArena Secure Key Generation")
    parser.add_argument("--force", action="store_true", help="Force regeneration without prompting")
    args = parser.parse_args()

    script_dir = Path(__file__).parent
    backend_root = script_dir.parent
    
    print("=" * 70)
    print("🔐 AetherArena Secure Key Generation")
    print("=" * 70)
    print()
    
    # Check if keys already exist
    import os
    env_override = os.environ.get("SETUP_CONFIG_FILE")
    if env_override:
        backend_env = Path(env_override)
    else:
        backend_env = backend_root / "config" / "local.env"
    
    # ARCHITECTURAL FIX: Check if database exists with data
    # If yes, we MUST preserve existing secrets to maintain sync with database
    db_exists = database_exists_with_data(backend_env)
    existing_secrets = load_existing_secrets(backend_env) if backend_env.exists() else {}
    
    if backend_env.exists():
        print("⚠️  WARNING: Configuration file already exists:")
        print(f"   • {backend_env}")
        if db_exists:
            print("   ⚠️  DATABASE DETECTED: Database exists with initialized data")
            print("   🔒 SECRET SYNC: Will preserve existing secrets to maintain database compatibility")
        print()
        if not args.force:
            response = input("Regenerate keys? This will OVERWRITE existing configuration [y/N]: ")
            if response.lower() not in ['y', 'yes']:
                print("❌ Key generation cancelled")
                return
        print()
        if db_exists:
            print("⚠️  DATABASE EXISTS - Preserving secrets that must match database state")
        print("⚠️  Regenerating keys - backup existing files if needed")
        print()
    
    # Generate all keys
    keys = generate_all_keys()
    
    # ARCHITECTURAL FIX: If database exists, preserve critical secrets
    # that must stay in sync with database state
    if db_exists and existing_secrets:
        critical_keys = ['POSTGRES_PASSWORD', 'JWT_SECRET', 'SECRET_KEY_BASE', 'VAULT_ENC_KEY', 'PG_META_CRYPTO_KEY']
        for key in critical_keys:
            if key in existing_secrets:
                old_val = keys[key][:8] + "..." if len(keys[key]) > 10 else "***"
                keys[key] = existing_secrets[key]
                print(f"   🔒 Preserved {key}: {old_val} -> using existing value")
        
        # Regenerate JWT tokens using the active JWT_SECRET to ensure cryptographic match
        jwt_secret = keys.get('JWT_SECRET')
        if jwt_secret:
            anon_key = generate_supabase_jwt_token(jwt_secret, "anon", expiry_years=10)
            service_role_key = generate_supabase_jwt_token(jwt_secret, "service_role", expiry_years=10)
            keys['ANON_KEY'] = anon_key
            keys['SUPABASE_ANON_KEY'] = anon_key
            keys['SERVICE_ROLE_KEY'] = service_role_key
            keys['SUPABASE_SERVICE_ROLE_KEY'] = service_role_key
            print("   🔄 Regenerated JWT tokens using the active JWT_SECRET to ensure cryptographic match")
        print()
    
    # ARCHITECTURAL FIX: Write ONLY to central config (single source of truth)
    # Docker Compose uses --env-file flag in supabase_docker.py to load central config
    # No duplicate .env in docker/ directory
    print()
    print("📝 Writing central configuration file...")
    backend_keys = keys.copy()
    # CRITICAL: Backend DATABASE_URL must use actual Docker-mapped port (discovered at runtime)
    # DO NOT hardcode port 5432 - use dynamic port discovery in supabase_docker.py
    # Format: postgresql://user:password@host:PORT/database where PORT is discovered
    write_env_file(backend_keys, backend_env)
    
    print()
    print("=" * 70)
    print("✅ Key Generation Complete")
    print("=" * 70)
    print()
    print("📁 Configuration file created:")
    print(f"   • {backend_env} (CENTRAL CONFIG - single source of truth)")
    print()
    print("🔒 Security Notes:")
    print("   • All keys are cryptographically secure (generated with secrets module)")
    print("   • Files set to owner-read-only permissions (600)")
    print("   • Supabase JWT tokens valid for 10 years")
    print("   • NEVER commit these files to version control (.gitignore them)")
    print("   • Backup these files securely (encrypted backup recommended)")
    print()
    print("🔑 Important Keys Generated:")
    print(f"   • Dashboard Username: {keys['DASHBOARD_USERNAME']}")
    print(f"   • Dashboard Password: {keys['DASHBOARD_PASSWORD']}")
    print(f"   • Supabase URL: {keys['SUPABASE_URL']}")
    print(f"   • Database Port: {keys['SUPABASE_DB_PORT']}")
    print()
    
    # Show user keys that need to be configured
    user_keys = create_user_keys_template()
    print("📋 Optional API Keys (Configure in Settings UI):")
    print()
    for category, keys_dict in user_keys.items():
        category_name = category.upper().replace('_', ' ')
        print(f"   {category_name}:")
        for key, description in keys_dict.items():
            print(f"      • {key}")
            print(f"        {description}")
        print()
    
    print("💡 Configuration Methods:")
    print("   1. Via Backend API:")
    print("      POST http://localhost:8765/v1/api-keys/")
    print("      Body: {\"key_name\": \"openai_api_key\", \"key_value\": \"sk-...\"}")
    print()
    print("   2. Via Frontend Settings:")
    print("      Settings → API Keys → Configure Optional Keys")
    print()
    print("🚀 Next Steps:")
    print("   1. Start external services mesh:")
    print("      cd aether-backend/services/external-services && docker compose up -d")
    print()
    print("   2. Run database migrations:")
    print("      cd aether-backend && python3 -m data.database.migration_runner")
    print()
    print("   3. Start backend:")
    print("      cd aether-backend && AETHER_ENVIRONMENT=production ./dist/aether-hub api")
    print()
    print("   4. Configure optional API keys in Settings UI")
    print()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\n❌ Key generation cancelled")
        sys.exit(1)
    except Exception as e:
        print(f"\n\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

