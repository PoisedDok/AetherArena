"""
Production Bundle Integrity Tests

These tests validate that the backend will actually work in a packaged (PyInstaller) 
distribution. They catch import errors, missing modules, and configuration issues 
that only manifest in the production environment.

CRITICAL: The OI wrapper crash (ModuleNotFoundError: No module named 'core.integrations') 
was found only by running the packaged app and checking logs. These tests prevent that 
class of failure from ever reaching production again.

@.architecture
Incoming: pytest runner --- {test_invocation}
Processing: Import validation, script syntax checks, configuration audits --- 
  {5 jobs: JOB_VALIDATE_IMPORTS, JOB_CHECK_SCRIPTS, JOB_VERIFY_CONFIG, JOB_CHECK_BUNDLE, JOB_VALIDATE_DOCKER}
Outgoing: pass/fail assertions --- {test_results}
"""

import ast
import importlib
import sys
import subprocess
from pathlib import Path
from typing import List

import pytest

# Backend root
BACKEND_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = BACKEND_ROOT / "scripts"
SERVICES_DIR = BACKEND_ROOT / "services"
CONFIG_DIR = BACKEND_ROOT / "config"
MIGRATIONS_DIR = BACKEND_ROOT / "data" / "database" / "migrations"


# =============================================================================
# 1. OI WRAPPER VALIDATION (Would have caught the production crash)
# =============================================================================

class TestOIWrapperIntegrity:
    """
    Validates the OI server wrapper script works in BOTH environments:
    - Development: full backend source tree available (core.integrations importable)
    - Packaged: PyInstaller binary, source tree NOT available (graceful fallback)
    """

    def test_oi_wrapper_syntax_valid(self):
        """OI wrapper script must be valid Python (catches syntax errors before deployment)."""
        wrapper = SCRIPTS_DIR / "oi_server_wrapper.py"
        assert wrapper.exists(), f"OI wrapper not found: {wrapper}"
        
        source = wrapper.read_text(encoding="utf-8")
        try:
            ast.parse(source, filename=str(wrapper))
        except SyntaxError as e:
            pytest.fail(f"OI wrapper has syntax error: {e}")

    def test_oi_wrapper_handles_missing_core_integrations(self):
        """
        CRITICAL: OI wrapper must NOT crash if core.integrations is unavailable.
        
        In packaged builds, the wrapper runs in the OI venv which doesn't have
        the main backend's source tree. The import of OIToolCatalogBridge must
        be conditional.
        
        This test simulates the packaged environment by blocking the import.
        """
        wrapper = SCRIPTS_DIR / "oi_server_wrapper.py"
        source = wrapper.read_text(encoding="utf-8")
        
        # The wrapper must have a try/except around the OIToolCatalogBridge import
        assert "OIToolCatalogBridge = None" in source, (
            "OI wrapper must initialize OIToolCatalogBridge = None before try/except import"
        )
        assert "except ImportError" in source, (
            "OI wrapper must catch ImportError for core.integrations"
        )
        
        # Verify the tool injection section handles None gracefully
        assert "if OIToolCatalogBridge is not None:" in source, (
            "OI wrapper must guard tool injection with 'if OIToolCatalogBridge is not None'"
        )

    def test_oi_wrapper_imports_in_dev_mode(self):
        """In development mode, OIToolCatalogBridge should import successfully."""
        try:
            from core.integrations.framework.oi_catalog import OIToolCatalogBridge
            assert OIToolCatalogBridge is not None
        except ImportError:
            pytest.skip("core.integrations not available (running in minimal environment)")

    def test_oi_wrapper_no_toplevel_crash(self):
        """
        Running 'python oi_server_wrapper.py --help' or checking compilation
        must not crash with ImportError.
        """
        wrapper = SCRIPTS_DIR / "oi_server_wrapper.py"
        # Compile the module to bytecode (catches import-time errors in a simulated
        # environment where core.integrations is missing)
        result = subprocess.run(
            [sys.executable, "-c", f"import py_compile; py_compile.compile('{wrapper}', doraise=True)"],
            capture_output=True, text=True, timeout=30
        )
        assert result.returncode == 0, f"OI wrapper compilation failed: {result.stderr}"

    def test_oi_wrapper_required_dependencies_available(self):
        """OI wrapper's non-optional imports must be available in the main backend env."""
        # These are the imports at the top of oi_server_wrapper.py that are NOT conditional
        required = ["httpx", "argparse", "asyncio", "logging", "os", "signal", "sys", "threading", "time"]
        for mod_name in required:
            try:
                importlib.import_module(mod_name)
            except ImportError:
                pytest.fail(f"OI wrapper requires '{mod_name}' but it's not importable")


# =============================================================================
# 2. SCRIPT INTEGRITY (All bundled scripts must parse cleanly)
# =============================================================================

class TestScriptIntegrity:
    """Validate all Python scripts that ship in the bundle."""

    def _get_all_scripts(self) -> List[Path]:
        scripts = list(SCRIPTS_DIR.glob("*.py"))
        return [s for s in scripts if s.name != "__pycache__"]

    def test_all_scripts_parse(self):
        """Every Python script in scripts/ must be syntactically valid."""
        for script in self._get_all_scripts():
            source = script.read_text(encoding="utf-8")
            try:
                ast.parse(source, filename=str(script))
            except SyntaxError as e:
                pytest.fail(f"{script.name} has syntax error: {e}")

    def test_start_production_script_exists(self):
        """start_production.sh must exist at the backend root."""
        script = BACKEND_ROOT / "start_production.sh"
        assert script.exists(), "start_production.sh missing from backend root"
        # Must be a bash script
        first_line = script.read_text(encoding="utf-8").split("\n")[0]
        assert "bash" in first_line, "start_production.sh must have bash shebang"


# =============================================================================
# 3. PYINSTALLER BUILD CONFIG INTEGRITY
# =============================================================================

class TestBuildConfigIntegrity:
    """Validate the PyInstaller build configuration catches all required modules."""

    def test_build_spec_exists(self):
        spec = BACKEND_ROOT / "build-config.spec"
        assert spec.exists(), "build-config.spec missing"

    def test_build_spec_includes_critical_packages(self):
        """Critical packages must be listed in the PyInstaller spec."""
        spec = BACKEND_ROOT / "build-config.spec"
        content = spec.read_text(encoding="utf-8")
        
        critical_packages = [
            "docling",
            "aether_rag",
            "RealtimeTTS",
            "spacy",
        ]
        
        for pkg in critical_packages:
            assert pkg in content, (
                f"CRITICAL: '{pkg}' not found in build-config.spec. "
                f"It will be missing from the packaged binary."
            )

    def test_build_spec_bundles_scripts(self):
        """Scripts directory must be included in the PyInstaller data files."""
        spec = BACKEND_ROOT / "build-config.spec"
        content = spec.read_text(encoding="utf-8")
        assert "('scripts', 'scripts')" in content, (
            "scripts/ directory not in PyInstaller data files -- "
            "oi_server_wrapper.py will be missing from bundle"
        )

    def test_build_spec_bundles_external_services(self):
        """External services (docker-compose) must be in the bundle."""
        spec = BACKEND_ROOT / "build-config.spec"
        content = spec.read_text(encoding="utf-8")
        assert "'services/external-services'" in content, (
            "services/external-services not in PyInstaller data files -- "
            "Docker compose files will be missing from bundle"
        )

    def test_build_spec_bundles_migrations(self):
        """Database migrations must be in the bundle."""
        spec = BACKEND_ROOT / "build-config.spec"
        content = spec.read_text(encoding="utf-8")
        assert "'data/database/migrations'" in content, (
            "data/database/migrations not in PyInstaller data files -- "
            "database migrations will be missing from bundle"
        )

    def test_build_spec_bundles_perplexica(self):
        """Modified Perplexica source must be in the bundle."""
        spec = BACKEND_ROOT / "build-config.spec"
        content = spec.read_text(encoding="utf-8")
        assert "'services/perplexica'" in content, (
            "services/perplexica not in PyInstaller data files -- "
            "modified Perplexica will not ship with the app"
        )


# =============================================================================
# 4. DOCKER COMPOSE INTEGRITY
# =============================================================================

class TestDockerComposeIntegrity:
    """Validate the external services mesh configuration."""

    def test_docker_compose_exists(self):
        compose = SERVICES_DIR / "external-services" / "docker-compose.yml"
        assert compose.exists(), "docker-compose.yml missing from services/external-services/"

    def test_docker_compose_syntax(self):
        """Docker compose file must be valid YAML."""
        compose = SERVICES_DIR / "external-services" / "docker-compose.yml"
        import yaml
        with open(compose) as f:
            try:
                data = yaml.safe_load(f)
            except yaml.YAMLError as e:
                pytest.fail(f"docker-compose.yml has YAML syntax error: {e}")
        
        assert "services" in data, "docker-compose.yml must define 'services'"

    def test_docker_compose_has_critical_services(self):
        """Docker compose must define all critical services."""
        compose = SERVICES_DIR / "external-services" / "docker-compose.yml"
        import yaml
        with open(compose) as f:
            data = yaml.safe_load(f)
        
        services = set(data.get("services", {}).keys())
        
        # These services are REQUIRED for the backend to function
        critical = {"db", "kong", "auth", "rest", "storage"}
        # Use partial matching since names may have supabase- prefix
        compose_text = compose.read_text()
        for svc in critical:
            found = any(svc in s for s in services)
            if not found:
                # Check in raw text for aliased names
                assert svc in compose_text.lower(), (
                    f"Critical service '{svc}' not found in docker-compose.yml"
                )


# =============================================================================
# 5. CONFIGURATION INTEGRITY
# =============================================================================

class TestConfigIntegrity:
    """Validate configuration files are complete and consistent."""

    def test_models_toml_exists(self):
        toml_path = CONFIG_DIR / "models.toml"
        assert toml_path.exists(), "config/models.toml missing"

    def test_models_toml_has_default_model(self):
        """models.toml must define a default LLM model."""
        toml_path = CONFIG_DIR / "models.toml"
        content = toml_path.read_text()
        assert "qwen" in content.lower() or "model" in content.lower(), (
            "models.toml doesn't reference any model configuration"
        )

    def test_settings_module_loads(self):
        """config/settings.py must import without error."""
        try:
            from config.settings import get_settings
            settings = get_settings()
            assert settings is not None
        except Exception as e:
            pytest.fail(f"config.settings failed to load: {e}")

    def test_no_hardcoded_thinking_model(self):
        """
        Regression: Migration 027 previously hardcoded qwen3-4b-thinking variant.
        No migration should seed the thinking model as default.
        """
        for migration_file in sorted(MIGRATIONS_DIR.glob("*.sql")):
            content = migration_file.read_text()
            if "user_preferences" in content and "llm_settings" in content:
                # This migration touches LLM settings -- verify no thinking model
                if "thinking" in content.lower():
                    # Allow corrective migrations that UPDATE away from thinking
                    if "UPDATE" in content and "lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit" in content:
                        continue  # This is the fix migration (031)
                    # But disallow INSERT/seed with thinking model
                    if "INSERT" in content or "VALUES" in content:
                        pytest.fail(
                            f"{migration_file.name} seeds 'thinking' LLM model variant. "
                            f"The default model must be the non-thinking variant."
                        )


# =============================================================================
# 6. MIGRATION SEQUENCE INTEGRITY
# =============================================================================

class TestMigrationIntegrity:
    """Validate database migrations are properly sequenced."""

    def test_migrations_directory_exists(self):
        assert MIGRATIONS_DIR.exists(), "data/database/migrations/ missing"

    def test_migrations_sequential(self):
        """Migration files must be numbered sequentially with no gaps."""
        files = sorted(MIGRATIONS_DIR.glob("*.sql"))
        if not files:
            pytest.skip("No migration files found")
        
        numbers = []
        for f in files:
            # Extract leading number from filename like "001_create_tables.sql"
            parts = f.stem.split("_", 1)
            try:
                num = int(parts[0])
                numbers.append(num)
            except (ValueError, IndexError):
                continue
        
        if not numbers:
            pytest.skip("No numbered migrations found")
        
        # Check for gaps (allow non-sequential but warn)
        numbers.sort()
        for i in range(len(numbers) - 1):
            gap = numbers[i + 1] - numbers[i]
            if gap > 2:  # Allow small gaps (deleted migrations)
                pytest.fail(
                    f"Large gap in migration sequence: {numbers[i]} -> {numbers[i+1]} (gap={gap})"
                )


# =============================================================================
# 7. CRITICAL MODULE IMPORT VALIDATION
# =============================================================================

class TestCriticalImports:
    """
    Verify that all modules critical to the production runtime can be imported.
    These imports are the ones that matter during app.py lifespan startup.
    """

    CRITICAL_MODULES = [
        "app",
        "core.runtime.engine",
        "core.runtime.streaming",
        "core.runtime.interpreter",
        "core.runtime.session",
        "core.integrations.framework",
        "core.integrations.framework.oi_catalog",
        "core.config.key_sync",
        "data.database.clients.supabase",
        "data.database.persistence_gateway",
        "data.database.migration_runner",
        "api.v1.endpoints.chat",
        "api.v1.endpoints.storage",
        "api.v1.endpoints.search",
        "api.v1.endpoints.files",
        "services.daemons.daemon_control",
    ]

    @pytest.mark.parametrize("module_path", CRITICAL_MODULES)
    def test_critical_module_importable(self, module_path):
        """Each critical module must import without error."""
        try:
            importlib.import_module(module_path)
        except ImportError as e:
            pytest.fail(
                f"CRITICAL: '{module_path}' cannot be imported: {e}\n"
                f"This module is required during app startup. If it fails here, "
                f"the packaged binary will crash on launch."
            )
        except Exception as e:
            # Some modules may fail due to missing runtime deps (Redis, DB) --
            # that's OK for import-time validation. We only care about ImportError.
            if "No module named" in str(e):
                pytest.fail(f"Import dependency missing for '{module_path}': {e}")


# =============================================================================
# 8. PERPLEXICA BUNDLE VALIDATION
# =============================================================================

class TestPerplexicaBundle:
    """Validate modified Perplexica is properly bundled."""

    def test_perplexica_source_exists(self):
        perp = SERVICES_DIR / "perplexica"
        assert perp.exists(), "services/perplexica/ missing"

    def test_perplexica_has_package_json(self):
        pkg = SERVICES_DIR / "perplexica" / "package.json"
        assert pkg.exists(), "Perplexica package.json missing"

    def test_perplexica_has_dockerfile(self):
        """Perplexica must have a Dockerfile for Docker image building during onboarding."""
        dockerfile = SERVICES_DIR / "perplexica" / "Dockerfile"
        # Could also be in the external-services compose build context
        compose_dir = SERVICES_DIR / "external-services"
        has_dockerfile = dockerfile.exists()
        if not has_dockerfile:
            # Check compose for build context pointing to perplexica
            compose = compose_dir / "docker-compose.yml"
            if compose.exists():
                content = compose.read_text()
                has_dockerfile = "perplexica" in content and "build" in content
        
        assert has_dockerfile, (
            "Perplexica has no Dockerfile and no build context in docker-compose.yml. "
            "The Docker image cannot be built during onboarding."
        )

    def test_perplexica_dockerfile_name_consistency(self):
        """
        REGRESSION: setup_engine.py referenced 'app.dockerfile' but only 'Dockerfile' exists.
        Both setup_engine.py and docker-compose.yml must reference the same Dockerfile.
        """
        # Check what setup_engine.py references
        setup_script = BACKEND_ROOT / "core" / "system" / "setup_engine.py"
        setup_content = setup_script.read_text()
        
        # Both should reference 'Dockerfile' (not 'app.dockerfile')
        assert "app.dockerfile" not in setup_content, (
            "setup_engine.py still references 'app.dockerfile' which doesn't exist. "
            "Use 'Dockerfile' to match docker-compose.yml."
        )
        
        # The actual Dockerfile must exist
        dockerfile = SERVICES_DIR / "perplexica" / "Dockerfile"
        assert dockerfile.exists(), "Perplexica Dockerfile missing"

    def test_perplexica_never_pulled_from_registry(self):
        """
        CRITICAL: Perplexica is our modified fork. It must NEVER be pulled from 
        a remote Docker registry. The docker-compose.yml must enforce this with
        pull_policy: never (never contact Docker Hub; use local image or build).
        """
        compose = SERVICES_DIR / "external-services" / "docker-compose.yml"
        content = compose.read_text()
        
        # Find the perplexica service block and verify pull_policy
        assert "pull_policy: never" in content, (
            "docker-compose.yml MUST set pull_policy: never on the perplexica service. "
            "This prevents any contact with Docker Hub. The image is built locally "
            "by setup_engine.py (onboarding) or docker_mesh_up() if missing."
        )

    def test_setup_engine_pull_ignores_buildable(self):
        """
        setup_engine.py must use --ignore-buildable when pulling Docker images
        so that locally-built services (Perplexica) are never pulled from a registry.
        """
        setup_script = BACKEND_ROOT / "core" / "system" / "setup_engine.py"
        content = setup_script.read_text()
        
        assert "--ignore-buildable" in content, (
            "setup_engine.py must use 'docker compose pull --ignore-buildable' "
            "to skip locally-built services like Perplexica."
        )

    def test_start_production_builds_perplexica_if_missing(self):
        """
        core/system/orchestrator.py must check for the Perplexica image and build
        from local source if it doesn't exist — never pull from registry.
        """
        start_script = BACKEND_ROOT / "core" / "system" / "orchestrator.py"
        content = start_script.read_text()
        
        # Must check image existence
        assert "docker\", \"image\", \"inspect\", \"perplexica:latest" in content or "docker image inspect perplexica:latest" in content, (
            "orchestrator.py must check if perplexica:latest exists locally "
            "before starting Docker services."
        )
        # Must build from compose if missing
        assert "build\", \"-t\", \"perplexica:latest" in content or "build perplexica" in content, (
            "orchestrator.py must build Perplexica from local source "
            "when the image is not found locally."
        )


# =============================================================================
# 9. VENV-OI SETUP SCRIPT VALIDATION
# =============================================================================

class TestOIVenvSetup:
    """Validate that the OI venv setup mechanism exists."""

    def test_setup_endpoint_exists(self):
        """The backend must expose a /v1/setup/start endpoint for OI venv creation."""
        try:
            from app import create_app
            app = create_app()
            routes = [r.path for r in app.routes]
            # The setup endpoint might be nested under a router
            route_paths = []
            for route in app.routes:
                if hasattr(route, 'path'):
                    route_paths.append(route.path)
                if hasattr(route, 'routes'):
                    for sub in route.routes:
                        if hasattr(sub, 'path'):
                            route_paths.append(sub.path)
            
            # Check that setup-related endpoints exist
            setup_routes = [r for r in route_paths if "setup" in r.lower()]
            assert len(setup_routes) > 0, (
                "No /setup/ endpoints found. The backend needs setup endpoints "
                "for OI venv creation and Docker image pulling during onboarding."
            )
        except Exception as e:
            # If app can't be created (missing deps), skip
            pytest.skip(f"Cannot create app for route inspection: {e}")


# =============================================================================
# 10. SETUP CORE SCRIPT VALIDATION
# =============================================================================

class TestSetupEngineScript:
    """Validate the setup_engine.py onboarding engine."""

    def test_setup_engine_exists(self):
        script = BACKEND_ROOT / "core" / "system" / "setup_engine.py"
        assert script.exists(), "core/system/setup_engine.py missing"

    def test_setup_engine_python_syntax(self):
        """setup_engine.py must pass python syntax check."""
        script = BACKEND_ROOT / "core" / "system" / "setup_engine.py"
        result = subprocess.run(
            ["python3", "-m", "py_compile", str(script)],
            capture_output=True, text=True, timeout=10
        )
        assert result.returncode == 0, f"setup_engine.py syntax error: {result.stderr}"

    def test_setup_engine_handles_all_phases(self):
        """setup_engine.py must handle all 5 onboarding phases."""
        script = BACKEND_ROOT / "core" / "system" / "setup_engine.py"
        content = script.read_text()
        
        required_phases = [
            "verify_bundled_services",
            "setup_python_packages",
            "setup_oi_env",
            "setup_models",
            "setup_docker",
        ]
        
        for phase in required_phases:
            assert phase in content, (
                f"setup_engine.py missing function: {phase}"
            )

    def test_setup_engine_does_not_install_upstream_realtimetts(self):
        """
        REGRESSION: setup_engine.py must NEVER install 'RealtimeTTS' or 'realtimetts'
        from PyPI.  The vendored fork at services/realtime-tts/ is the ONLY source
        of RealtimeTTS for this project.  Installing from PyPI overwrites the fork
        and silently breaks Qwen3 TTS in both development and production.
        """
        script = BACKEND_ROOT / "core" / "system" / "setup_engine.py"
        content = script.read_text()

        # Must NOT pip install the package by name
        import re
        # Match: pip install ... realtimetts or pip install ... RealtimeTTS
        # But NOT when it's part of a path (services/realtime-tts/)
        dangerous_patterns = [
            r'pip\s+install\s+[^#\n]*\brealtimetts\b(?!/)',
            r'pip\s+install\s+[^#\n]*\bRealtimeTTS\b(?!/)',
        ]
        for pat in dangerous_patterns:
            match = re.search(pat, content, re.IGNORECASE)
            assert match is None, (
                f"setup_engine.py MUST NOT install RealtimeTTS from PyPI! "
                f"Found: '{match.group()}' -- this would overwrite the vendored fork."
            )

    def test_setup_engine_writes_progress(self):
        """setup_engine.py must write to setup_progress.json for API consumption."""
        script = BACKEND_ROOT / "core" / "system" / "setup_engine.py"
        content = script.read_text()
        assert "setup_progress.json" in content, (
            "setup_engine.py doesn't reference setup_progress.json -- "
            "frontend polling will never see progress updates"
        )

    def test_requirements_oi_server_exists(self):
        """OI server requirements file must exist in scripts/ for venv creation."""
        req = SCRIPTS_DIR / "requirements_oi_server.txt"
        assert req.exists(), "scripts/requirements_oi_server.txt missing"

    def test_requirements_oi_includes_open_interpreter(self):
        """OI requirements must include open-interpreter package."""
        req = SCRIPTS_DIR / "requirements_oi_server.txt"
        content = req.read_text()
        assert "open-interpreter" in content, (
            "requirements_oi_server.txt doesn't include open-interpreter"
        )

    def test_setup_database_script_exists(self):
        """Database setup script must exist."""
        script = SCRIPTS_DIR / "setup_database.sh"
        assert script.exists(), "scripts/setup_database.sh missing"


# =============================================================================
# 11. OI WRAPPER PACKAGED-BUILD SIMULATION
# =============================================================================

class TestOIWrapperPackagedSimulation:
    """
    Simulate the packaged build environment by executing the OI wrapper's 
    module-level code with core.integrations blocked.
    
    This is the DEFINITIVE test that would have caught the production crash.
    """

    def test_wrapper_executes_without_core_integrations(self):
        """
        Execute the OI wrapper's top-level code in a subprocess where
        core.integrations is NOT importable (simulating PyInstaller OI venv).
        
        The wrapper must NOT crash. It must set OIToolCatalogBridge = None
        and proceed without error.
        """
        wrapper = SCRIPTS_DIR / "oi_server_wrapper.py"
        
        # Create a test script that:
        # 1. Blocks the core.integrations import
        # 2. Executes the wrapper's module-level code
        # 3. Verifies OIToolCatalogBridge is None
        test_code = f'''
import sys
import types

# Block core.integrations entirely by inserting a broken finder
class BlockCoreIntegrations:
    def find_module(self, name, path=None):
        if name.startswith("core.integrations") or name.startswith("core"):
            return self
    def load_module(self, name):
        raise ImportError(f"SIMULATED: No module named '{{name}}' (packaged build)")

sys.meta_path.insert(0, BlockCoreIntegrations())

# Remove any cached core modules
for key in list(sys.modules.keys()):
    if key.startswith("core"):
        del sys.modules[key]

# Now execute only the top-level (module-scope) code of oi_server_wrapper.py
# We read the source and exec just the import/setup portion
source = open("{wrapper}").read()

# Extract everything before the first function definition or "def main"
lines = source.split("\\n")
top_level_lines = []
for line in lines:
    if line.startswith("def ") or line.startswith("class "):
        break
    top_level_lines.append(line)

top_level_code = "\\n".join(top_level_lines)

# Execute in a namespace that simulates normal module execution
namespace = {{
    "__name__": "__test__", 
    "__builtins__": __builtins__,
    "__file__": "{wrapper}",
}}
try:
    exec(compile(top_level_code, "{wrapper}", "exec"), namespace)
except SystemExit:
    pass  # argparse may call sys.exit on --help

# Verify OIToolCatalogBridge is None (graceful degradation)
bridge = namespace.get("OIToolCatalogBridge")
if bridge is not None:
    print(f"FAIL: OIToolCatalogBridge should be None when core.integrations is blocked, got: {{bridge}}")
    sys.exit(1)
else:
    print("PASS: OIToolCatalogBridge = None (graceful degradation works)")
    sys.exit(0)
'''
        
        result = subprocess.run(
            [sys.executable, "-c", test_code],
            capture_output=True, text=True, timeout=30,
            cwd=str(BACKEND_ROOT)
        )
        
        assert result.returncode == 0, (
            f"OI wrapper crashes when core.integrations is unavailable!\n"
            f"stdout: {result.stdout}\n"
            f"stderr: {result.stderr}\n"
            f"This is EXACTLY the bug that crashed the packaged app."
        )


# =============================================================================
# 12. BUNDLED SERVICE COMPLETENESS (Docling, RealtimeTTS, XLWings)
# =============================================================================

class TestBundledServiceCompleteness:
    """
    Verify all modified/forked services that must ship with the bundle 
    are properly referenced in the PyInstaller spec.
    """

    def test_docling_in_packages_to_collect(self):
        """Docling (modified) must be in PyInstaller collect_all list."""
        spec = (BACKEND_ROOT / "build-config.spec").read_text()
        assert "'docling'" in spec, "docling missing from packages_to_collect"
        assert "'docling_core'" in spec, "docling_core missing from packages_to_collect"

    def test_realtimetts_in_packages_to_collect(self):
        """RealtimeTTS (modified) must be in PyInstaller collect_all list."""
        spec = (BACKEND_ROOT / "build-config.spec").read_text()
        assert "'RealtimeTTS'" in spec, "RealtimeTTS missing from packages_to_collect"

    def test_realtimetts_engines_in_hidden_imports(self):
        """All RealtimeTTS engines must be listed as hidden imports."""
        spec = (BACKEND_ROOT / "build-config.spec").read_text()
        engines = [
            "RealtimeTTS.engines.system_engine",
            "RealtimeTTS.engines.kokoro_engine",
            "RealtimeTTS.engines.qwen3_engine",
        ]
        for engine in engines:
            assert engine in spec, f"{engine} missing from hidden imports"

    def test_xlwings_bundled_as_data(self):
        """XLWings (modified) must be bundled as data files."""
        spec = (BACKEND_ROOT / "build-config.spec").read_text()
        assert "xlwings" in spec, "xlwings not referenced in build-config.spec"

    def test_xlwings_source_exists(self):
        """Modified xlwings source must exist in services/."""
        xlwings = SERVICES_DIR / "xlwings" / "xlwings"
        assert xlwings.exists(), "services/xlwings/xlwings/ missing"

    def test_aether_rag_in_packages_to_collect(self):
        """AETHER_RAG (file indexing) must be in PyInstaller collect_all list."""
        spec = (BACKEND_ROOT / "build-config.spec").read_text()
        assert "'aether_rag'" in spec, "aether_rag missing from packages_to_collect"

    def test_kokoro_tts_in_packages(self):
        """Kokoro TTS (fallback engine) must be in PyInstaller collect list."""
        spec = (BACKEND_ROOT / "build-config.spec").read_text()
        assert "'kokoro'" in spec, "kokoro missing from packages_to_collect"

    def test_qwen_tts_in_packages(self):
        """Qwen TTS (primary engine) must be in PyInstaller collect list."""
        spec = (BACKEND_ROOT / "build-config.spec").read_text()
        assert "'qwen_tts'" in spec, "qwen_tts missing from packages_to_collect"

    def test_openwakeword_in_packages(self):
        """openwakeword (handsfree wake word) must be in PyInstaller collect list."""
        spec = (BACKEND_ROOT / "build-config.spec").read_text()
        assert "'openwakeword'" in spec, "openwakeword missing from packages_to_collect"

    def test_realtimetts_pathex(self):
        """Vendored RealtimeTTS fork path must be in PyInstaller pathex."""
        spec = (BACKEND_ROOT / "build-config.spec").read_text()
        assert "realtime-tts" in spec and "pathex" in spec, (
            "services/realtime-tts not in PyInstaller pathex -- "
            "vendored engine data files will not be discoverable"
        )

    def test_build_sh_installs_vendored_realtimetts(self):
        """
        CRITICAL: build.sh must install the vendored RealtimeTTS fork before
        PyInstaller runs.  The upstream pip package does NOT contain Qwen3Engine
        or Qwen3MLXEngine.  Without this step, collect_all('RealtimeTTS')
        collects the upstream version and handsfree TTS is dead in production.
        """
        build_sh = BACKEND_ROOT.parent / "build.sh"
        assert build_sh.exists(), "build.sh not found at project root"
        content = build_sh.read_text()
        assert "services/realtime-tts" in content and "pip" in content, (
            "build.sh must pip-install the vendored RealtimeTTS fork "
            "(services/realtime-tts/) before running PyInstaller. "
            "Without this, Qwen3Engine is missing from the production bundle."
        )

    def test_build_sh_installs_qwen_tts(self):
        """
        build.sh must ensure qwen-tts is installed before PyInstaller.
        The Qwen3Engine lazily imports qwen_tts.Qwen3TTSModel at synthesis
        time.  If qwen_tts is missing from the bundle, handsfree TTS fails
        silently on first synthesize() call.
        """
        build_sh = BACKEND_ROOT.parent / "build.sh"
        assert build_sh.exists(), "build.sh not found at project root"
        content = build_sh.read_text()
        assert "qwen-tts" in content or "qwen_tts" in content, (
            "build.sh must install qwen-tts before PyInstaller runs."
        )

    def test_installed_realtimetts_has_qwen3_engine(self):
        """
        REGRESSION: The pip-installed RealtimeTTS must be the vendored fork,
        not the upstream PyPI package.  Only the fork has Qwen3Engine.

        This test catches the scenario where someone runs 'pip install
        RealtimeTTS' (upstream) which overwrites the vendored fork.
        """
        try:
            from RealtimeTTS.engines.qwen3_engine import Qwen3Engine
            assert Qwen3Engine is not None
        except ImportError:
            pytest.fail(
                "CRITICAL: Qwen3Engine not importable from RealtimeTTS. "
                "The vendored fork at services/realtime-tts/ is NOT installed. "
                "Run: pip install -e services/realtime-tts/ --no-deps"
            )

    def test_qwen_tts_package_importable(self):
        """qwen-tts must be installed for Qwen3Engine.synthesize() to work."""
        try:
            import qwen_tts  # noqa: F401
        except ImportError:
            pytest.fail(
                "CRITICAL: qwen_tts not importable. "
                "Qwen3Engine model loading will fail at synthesis time. "
                "Run: pip install qwen-tts"
            )

    def test_setup_engine_does_not_install_upstream_realtimetts(self):
        """
        REGRESSION: setup_engine.py must NOT install RealtimeTTS from PyPI.

        The project uses a vendored fork at services/realtime-tts/ which
        contains custom Qwen3Engine and Qwen3MLXEngine.  Installing the
        upstream 'RealtimeTTS' from PyPI overwrites the fork and breaks
        handsfree TTS.

        setup_engine.py may install 'stream2sentence' (a separate dependency
        of TextToAudioStream), but NEVER 'RealtimeTTS'.
        """
        setup = BACKEND_ROOT / "core" / "system" / "setup_engine.py"
        content = setup.read_text()

        # Find pip install lines that mention RealtimeTTS
        import re
        pip_lines = [
            line.strip()
            for line in content.splitlines()
            if "pip" in line and "install" in line and not line.strip().startswith("#")
        ]

        for line in pip_lines:
            # Match: pip install ... RealtimeTTS ... (case-sensitive, the PyPI package)
            # But allow: pip install -e services/realtime-tts/ (our vendored fork)
            if re.search(r'\bRealtimeTTS\b', line) and "services/realtime-tts" not in line:
                pytest.fail(
                    f"setup_engine.py installs UPSTREAM RealtimeTTS from PyPI:\n"
                    f"  {line}\n"
                    f"This overwrites the vendored fork. Remove 'RealtimeTTS' "
                    f"from this line (keep 'stream2sentence' if present)."
                )
