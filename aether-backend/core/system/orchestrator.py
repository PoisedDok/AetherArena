import os
import sys
import time
import json
import signal
import shutil
import subprocess
import urllib.request
import urllib.error
import logging
import shlex
from pathlib import Path

def augment_path():
    current_path = os.environ.get("PATH", "")
    existing_paths = current_path.split(os.pathsep) if current_path else []
    paths_to_add = [
        "/usr/local/bin",
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        str(Path.home() / ".docker" / "bin"),
        str(Path.home() / ".pyenv" / "shims"),
        str(Path.home() / ".local" / "bin"),
    ]
    for p in paths_to_add:
        if os.path.isdir(p) and p not in existing_paths:
            existing_paths.insert(0, p)
    os.environ["PATH"] = os.pathsep.join(existing_paths)

class AetherContext:
    def __init__(self):
        self.script_dir = Path(os.environ.get("AETHER_INSTALL_DIR", Path(__file__).resolve().parent.parent.parent)).resolve()
        
        if os.environ.get("AETHER_DATA_DIR"):
            self.data_dir = Path(os.environ["AETHER_DATA_DIR"])
        elif sys.platform == "darwin":
            self.data_dir = Path.home() / "Library/Application Support/Aether"
        elif sys.platform == "win32":
            self.data_dir = Path(os.environ.get("APPDATA", Path.home() / "AppData/Roaming")) / "Aether"
        else:
            self.data_dir = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "Aether"
            
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.log_dir = self.data_dir / "logs"
        self.log_dir.mkdir(parents=True, exist_ok=True)

        is_frozen = getattr(sys, 'frozen', False)
        is_dev = "development" in sys.argv or os.environ.get("ENVIRONMENT") == "development"

        if is_frozen:
            self.backend_cmd = [sys.executable]
            self.docker_services_dir = self.script_dir / "services"
            self.config_file = self.data_dir / "config/local.env"
            os.environ["AETHER_BACKEND_ROOT"] = str(self.data_dir)
            os.environ["AETHER_INSTALL_DIR"] = str(self.script_dir)
            os.environ["AETHER_DOCKER_DATA"] = str(self.data_dir / "docker-data")
            os.environ["AETHER_PERPLEXICA_DATA"] = str(self.data_dir / "docker-data/perplexica")
            Path(os.environ["AETHER_DOCKER_DATA"]).mkdir(parents=True, exist_ok=True)
            Path(os.environ["AETHER_PERPLEXICA_DATA"]).mkdir(parents=True, exist_ok=True)
            
            if not (self.data_dir / "config").is_dir():
                (self.data_dir / "config").mkdir(parents=True, exist_ok=True)
                if (self.script_dir / "config").is_dir():
                    shutil.copytree(self.script_dir / "config", self.data_dir / "config", dirs_exist_ok=True)
        elif (self.script_dir / "aether-hub").is_dir() and (self.script_dir / "services").is_dir() and not is_dev:
            self.backend_cmd = [str(self.script_dir / "aether-hub/aether-hub")]
            self.docker_services_dir = self.script_dir / "services"
            self.config_file = self.data_dir / "config/local.env"
            os.environ["AETHER_BACKEND_ROOT"] = str(self.data_dir)
            os.environ["AETHER_INSTALL_DIR"] = str(self.script_dir)
            os.environ["AETHER_DOCKER_DATA"] = str(self.data_dir / "docker-data")
            os.environ["AETHER_PERPLEXICA_DATA"] = str(self.data_dir / "docker-data/perplexica")
            Path(os.environ["AETHER_DOCKER_DATA"]).mkdir(parents=True, exist_ok=True)
            Path(os.environ["AETHER_PERPLEXICA_DATA"]).mkdir(parents=True, exist_ok=True)
            
            if not (self.data_dir / "config").is_dir():
                (self.data_dir / "config").mkdir(parents=True, exist_ok=True)
                if (self.script_dir / "config").is_dir():
                    shutil.copytree(self.script_dir / "config", self.data_dir / "config", dirs_exist_ok=True)
        elif (self.script_dir / "dist/aether-hub").is_dir() and not is_dev:
            self.backend_cmd = [str(self.script_dir / "dist/aether-hub/aether-hub")]
            self.docker_services_dir = self.script_dir / "services"
            self.config_file = self.script_dir / "config/local.env"
            os.environ["AETHER_BACKEND_ROOT"] = str(self.script_dir)
        else:
            self.backend_cmd = [sys.executable, str(self.script_dir / "main.py")]
            self.docker_services_dir = self.script_dir / "services"
            
            # ARCHITECTURAL FIX: Align local.env path with settings.py logic.
            # In non-frozen (source) mode, settings.py always reads from source tree (script_dir).
            # Therefore, orchestrator MUST use the source tree config to prevent split-brain DB passwords.
            self.config_file = self.script_dir / "config/local.env"
            os.environ["AETHER_BACKEND_ROOT"] = str(self.script_dir)
            os.environ["AETHER_INSTALL_DIR"] = str(self.script_dir)
            os.environ["AETHER_DOCKER_DATA"] = str(self.docker_services_dir / "external-services/volumes")
            os.environ["AETHER_PERPLEXICA_DATA"] = str(self.docker_services_dir / "perplexica/volumes")
            Path(os.environ["AETHER_DOCKER_DATA"]).mkdir(parents=True, exist_ok=True)
            Path(os.environ["AETHER_PERPLEXICA_DATA"]).mkdir(parents=True, exist_ok=True)

        self.docker_compose_dir = self.docker_services_dir / "external-services"
        os.environ["COMPOSE_PROJECT_NAME"] = "aether-dev" if is_dev else "aether-prod"

class LoggerMixin:
    def __init__(self, name: str, log_dir: Path):
        self.logger = logging.getLogger(name)
        self.logger.setLevel(logging.INFO)
        if not self.logger.handlers:
            fh = logging.FileHandler(log_dir / "startup.log")
            fh.setFormatter(logging.Formatter("[%(asctime)s] %(message)s", "%Y-%m-%d %H:%M:%S"))
            ch = logging.StreamHandler()
            ch.setFormatter(logging.Formatter("[%(asctime)s] %(message)s", "%Y-%m-%d %H:%M:%S"))
            self.logger.addHandler(fh)
            self.logger.addHandler(ch)

    def log(self, msg: str): self.logger.info(f"[INFO] {msg}")
    def log_success(self, msg: str): self.logger.info(f"[SUCCESS] {msg}")
    def log_warn(self, msg: str): self.logger.warning(f"[WARN] {msg}")
    def log_error(self, msg: str): self.logger.error(f"[ERROR] {msg}")
    def log_debug(self, msg: str, exc_info=False): self.logger.debug(f"[DEBUG] {msg}", exc_info=exc_info)

class ProcessSupervisor(LoggerMixin):
    def __init__(self, ctx: AetherContext):
        super().__init__("ProcessSupervisor", ctx.log_dir)
        self.ctx = ctx
        self.backend_pid = None
        self.watchdog_pid = None
        self.docker_bg_pid = None

    def run_cmd(self, cmd, **kwargs):
        if isinstance(cmd, str):
            cmd_list = shlex.split(cmd)
        else:
            cmd_list = cmd
        return subprocess.run(cmd_list, shell=False, **kwargs)

    def stop_process_tree(self, pid, grace_seconds=5):
        if not pid: return
        try:
            pgid = os.getpgid(pid)
            os.killpg(pgid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        except Exception as e:
            self.log_debug(f"Failed to SIGTERM process group {pid}: {e}")
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            except Exception as e2:
                self.log_debug(f"Failed to SIGTERM pid {pid}: {e2}")
        
        elapsed = 0
        while elapsed < grace_seconds:
            try:
                os.kill(pid, 0)
                time.sleep(1)
                elapsed += 1
            except ProcessLookupError:
                break
            except Exception:
                break
        
        try:
            os.killpg(os.getpgid(pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
        except Exception as e:
            self.log_debug(f"Failed to SIGKILL process group {pid}: {e}")
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except Exception as e2:
                self.log_debug(f"Failed to SIGKILL pid {pid}: {e2}")

    def kill_port(self, port):
        try:
            res = self.run_cmd(f"lsof -ti tcp:{port}", capture_output=True, text=True)
            pids = res.stdout.strip().split()
            for p in pids:
                if p.isdigit():
                    self.stop_process_tree(int(p))
        except Exception as e:
            self.log_debug(f"Error checking or killing port {port}: {e}")

    def cleanup_old_services(self):
        self.log("Cleaning up previous instances...")
        try:
            from config.settings import get_settings
            s = get_settings()
            self.kill_port(s.security.bind_port)
            self.kill_port(s.inference.port)
        except Exception as e:
            self.log_debug(f"Could not load settings for port cleanup: {e}")
            self.kill_port(8765)
            self.kill_port(7090)
            
        for pfile in [self.ctx.log_dir / "worker_watchdog.pid", self.ctx.log_dir / "worker.pid"]:
            if pfile.exists():
                try:
                    pid = int(pfile.read_text().strip())
                    self.stop_process_tree(pid)
                    pfile.unlink()
                except ValueError:
                    pfile.unlink()
                except Exception as e:
                    self.log_debug(f"Error cleaning up old service pid {pfile}: {e}")
        self.log_success("Cleanup complete")

    def _stop_conflicting_processes(self):
        try:
            from config.settings import get_settings
            s = get_settings()
            ports = [s.security.bind_port, s.inference.port]
            self.log(f"Cleaning up conflicting processes on ports {', '.join(map(str, ports))}...")
            for port in ports:
                self.kill_port(port)
        except Exception as e:
            self.log_debug(f"Failed to load settings for conflicting processes cleanup: {e}")

    def sweep_orphaned_processes(self):
        patterns = [
            "worker_watchdog",
            "daemon_manager",
            "daemon-manager",
            "vllm-mlx",
            "vllm_mlx.server",
            "ollama serve",
            "aether_inference.server",
            "searxng_server_wrapper.py"
        ]
        
        for pattern in patterns:
            try:
                res = self.run_cmd(["pgrep", "-f", pattern], capture_output=True, text=True)
                pids = [p.strip() for p in res.stdout.splitlines() if p.strip()]
                for pid in pids:
                    if pid.isdigit() and int(pid) != os.getpid() and int(pid) != os.getppid():
                        self.log(f"Gracefully killing orphaned '{pattern}' (PID {pid})")
                        self.stop_process_tree(int(pid))
            except Exception as e:
                self.log_debug(f"Error sweeping orphaned processes for pattern {pattern}: {e}")

class DockerMeshManager(LoggerMixin):
    def __init__(self, ctx: AetherContext, supervisor: ProcessSupervisor):
        super().__init__("DockerMeshManager", ctx.log_dir)
        self.ctx = ctx
        self.supervisor = supervisor

    def patch_perplexica_config(self):
        perplexica_data_dir = os.environ.get("AETHER_PERPLEXICA_DATA", str(self.ctx.docker_services_dir / "perplexica/volumes"))
        config_path = Path(perplexica_data_dir) / "data/config.json"
        
        Path(perplexica_data_dir).joinpath("data").mkdir(parents=True, exist_ok=True)
        
        if not config_path.is_file():
            return
            
        try:
            with open(config_path, "r") as f:
                content = f.read()
                
            if '"provider": "lmstudio-default"' in content:
                self.log("Patching Perplexica config: switching default chat provider to aether-inference...")
                from config.settings import get_settings
                system_model = get_settings().llm.model
                
                c = json.loads(content)
                providers = c.get("modelProviders", [])
                
                if not any(p.get("id") == "aether-inference-default" for p in providers):
                    providers.insert(0, {
                        "id": "aether-inference-default",
                        "name": "Aether Inference (Built-in)",
                        "type": "lmstudio",
                        "chatModels": [], "embeddingModels": [],
                        "config": {"baseURL": "http://host.docker.internal:7090"},
                        "hash": "fe60b3a42987d7a87513a7bbabce25835d47b0bae0ddea69a5447fd074f1a491"
                    })
                    
                if not any(p.get("id") == "transformers-default" for p in providers):
                    providers.append({
                        "id": "transformers-default",
                        "name": "Transformers (ONNX)",
                        "type": "transformers",
                        "chatModels": [], "embeddingModels": [],
                        "config": {},
                        "hash": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
                    })
                    
                c["modelProviders"] = providers
                prefs = c.get("preferences", {})
                prefs["chatModel"] = {"provider": "aether-inference-default", "model": prefs.get("chatModel", {}).get("model", system_model)}
                prefs["embeddingModel"] = {"provider": "transformers-default", "model": "Xenova/bge-small-en-v1.5"}
                c["preferences"] = prefs
                
                with open(config_path, "w") as f:
                    json.dump(c, f, indent=2)
                self.log_success("Perplexica config patched")
        except Exception as e:
            self.log_warn(f"Failed to patch Perplexica config (non-critical): {e}")

    def docker_mesh_down(self):
        self.log("Stopping external services mesh (docker compose down)...")
        if not self.ctx.docker_compose_dir.is_dir() or not shutil.which("docker"): return
        os.chdir(self.ctx.docker_compose_dir)
        self.supervisor.run_cmd(["docker", "compose", "--env-file", str(self.ctx.config_file), "down", "--timeout", "5", "--remove-orphans"], capture_output=True)
        self.log_success("Docker mesh cleanup command completed")

    def docker_mesh_up(self):
        self.log("STEP 3: Starting External Services Mesh")
        os.chdir(self.ctx.docker_compose_dir)
        
        docker_data = Path(os.environ.get("AETHER_DOCKER_DATA", self.ctx.docker_compose_dir / "volumes"))
        
        # Ensure ALL Supabase and external service boilerplate is present
        db_roles_sql = docker_data / "db/roles.sql"
        if not db_roles_sql.is_file():
            self.log("Seeding Supabase/External config templates to writable data dir...")
            template_dir = self.ctx.docker_compose_dir / "volumes-template"
            if template_dir.is_dir():
                shutil.copytree(template_dir, docker_data, dirs_exist_ok=True)
                self.log_success(f"Boilerplate seeded to {docker_data}")
            else:
                self.log_warn(f"volumes-template not found at {template_dir}")

        if self.supervisor.run_cmd(["docker", "image", "inspect", "perplexica:latest"], capture_output=True).returncode != 0:
            self.log("Perplexica image not found locally — building from bundled source...")
            perplexica_dir = self.ctx.docker_services_dir / "perplexica"
            if perplexica_dir.is_dir():
                os.chdir(perplexica_dir)
                if self.supervisor.run_cmd(["docker", "build", "-t", "perplexica:latest", "-f", "Dockerfile", "."]).returncode != 0:
                    self.log_error("Failed to build Perplexica from local source")
                    sys.exit(1)
                self.log_success("Perplexica image built from local repo")
                os.chdir(self.ctx.docker_compose_dir)
        
        self.patch_perplexica_config()
        self.log("Bringing up database first to ensure passwords sync...")
        self.supervisor.run_cmd(["docker", "compose", "--env-file", str(self.ctx.config_file), "up", "-d", "db"])
        
        elapsed = 0
        db_ready = False
        while elapsed < 40:
            res = self.supervisor.run_cmd(["docker", "compose", "--env-file", str(self.ctx.config_file), "ps", "db", "--format", "json"], capture_output=True, text=True)
            if "healthy" in res.stdout:
                db_ready = True
                break
            time.sleep(2)
            elapsed += 2
            
        if db_ready:
            self._sync_postgres_passwords()
        else:
            self.log_warn("Database did not become healthy in time; password sync may fail.")
            
        self.log("Bringing up remaining services...")
        self.supervisor.run_cmd(["docker", "compose", "--env-file", str(self.ctx.config_file), "up", "-d"])
        self.log_success("Docker services started")

    def _sync_postgres_passwords(self):
        self.log("Syncing Postgres passwords from local.env to running database...")
        try:
            env = {}
            with open(self.ctx.config_file) as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith('#') and '=' in line:
                        k, v = line.split('=', 1)
                        env[k] = v.strip('\"\'')
                        
            postgres_password = env.get("POSTGRES_PASSWORD")
            if not postgres_password:
                self.log_warn("POSTGRES_PASSWORD not found in config_file, skipping password sync.")
                return False
                
            # 1. Temporarily allow trust authentication for supabase_admin
            self.supervisor.run_cmd([
                "docker", "exec", "supabase-db", "su", "-", "postgres", "-c",
                "sed -i 's/local all  supabase_admin     scram-sha-256/local all  supabase_admin     trust/' /etc/postgresql/pg_hba.conf && pg_ctl reload -D /var/lib/postgresql/data"
            ], capture_output=True)
            
            # Wait a moment for reload to apply
            time.sleep(1)
            
            # 2. Update passwords for all essential roles
            cmd = [
                "docker", "exec", "supabase-db", "su", "-", "postgres", "-c",
                f"psql -U supabase_admin -d postgres -c \"ALTER USER supabase_admin WITH PASSWORD '{postgres_password}'; ALTER USER postgres WITH PASSWORD '{postgres_password}'; ALTER USER authenticator WITH PASSWORD '{postgres_password}'; ALTER USER pgbouncer WITH PASSWORD '{postgres_password}'; ALTER USER supabase_auth_admin WITH PASSWORD '{postgres_password}'; ALTER USER supabase_functions_admin WITH PASSWORD '{postgres_password}'; ALTER USER supabase_storage_admin WITH PASSWORD '{postgres_password}';\""
            ]
            
            res = self.supervisor.run_cmd(cmd, capture_output=True, text=True)
            
            # 3. Restore pg_hba.conf security
            self.supervisor.run_cmd([
                "docker", "exec", "supabase-db", "su", "-", "postgres", "-c",
                "sed -i 's/local all  supabase_admin     trust/local all  supabase_admin     scram-sha-256/' /etc/postgresql/pg_hba.conf && pg_ctl reload -D /var/lib/postgresql/data"
            ], capture_output=True)
            
            if res.returncode == 0:
                self.log_success("Postgres passwords successfully synced")
                return True
            else:
                self.log_warn(f"Failed to sync Postgres passwords: {res.stderr}")
                return False
        except Exception as e:
            self.log_error(f"Error during password sync: {e}")
            return False

    def wait_for_docker_health(self):
        self.log("STEP 4: Health Checks")
        max_wait = 90
        elapsed = 0
        os.chdir(self.ctx.docker_compose_dir)
        while elapsed < max_wait:
            res_total = self.supervisor.run_cmd(["docker", "compose", "--env-file", str(self.ctx.config_file), "ps", "--format", "json"], capture_output=True, text=True)
            if not res_total.stdout.strip():
                time.sleep(3)
                elapsed += 3
                continue
            
            try:
                data = res_total.stdout.strip()
                if data.startswith("["):
                    containers = json.loads(data)
                else:
                    containers = [json.loads(line) for line in data.splitlines() if line.strip()]
                    
                total_with_health = 0
                unhealthy = 0
                db_healthy = False
                
                for c in containers:
                    if c.get("Name") == "supabase-kong" or not c.get("Health"): continue
                    total_with_health += 1
                    if c.get("Health") != "healthy":
                        unhealthy += 1
                        
                if total_with_health > 0 and unhealthy == 0:
                    self.log_success(f"All services healthy ({total_with_health}/{total_with_health} ready)")
                    return True
                self.log(f"Health status: {total_with_health - unhealthy}/{total_with_health} ready (waiting for {unhealthy} service(s))...")
            except Exception as e:
                self.log_debug(f"Error parsing docker health: {e}")
                
            time.sleep(3)
            elapsed += 3
            
        self.log_error(f"CRITICAL: Services did not become healthy within {max_wait}s")
        return False

    def verify_critical_services(self):
        try:
            from config.settings import get_settings
            s = get_settings()
        except ImportError as e:
            self.log_error(f"Failed to load settings for verification: {e}")
            return False
            
        self.log("Verifying critical service endpoints with retry...")
        all_healthy = True
        
        if self.supervisor.run_cmd(["docker", "exec", "supabase-redis", "redis-cli", "ping"], capture_output=True).returncode == 0:
            self.log_success("✓ Redis responding")
        else:
            self.log_error("✗ CRITICAL: Redis not responding")
            all_healthy = False
            
        if self.supervisor.run_cmd(["docker", "exec", "supabase-db", "pg_isready", "-U", "postgres", "-h", "localhost"], capture_output=True).returncode == 0:
            self.log_success("✓ Postgres responding")
        else:
            self.log_error("✗ CRITICAL: Postgres not responding")
            all_healthy = False
            
        try:
            urllib.request.urlopen(s.integration.perplexica_url, timeout=3)
            self.log_success("✓ Perplexica responding")
        except Exception:
            self.log_warn("⚠ Perplexica not responding")
            
        try:
            import socket
            with socket.create_connection(("localhost", 9050), timeout=3):
                self.log_success("✓ Tor Proxy responding on port 9050")
        except Exception:
            self.log_warn("⚠ Tor Proxy not responding on port 9050")
            
        try:
            urllib.request.urlopen(f"{s.integration.perplexica_url.rstrip('/')}/api/embeddings", timeout=5)
            self.log_success("✓ Embedding service healthy (Perplexica ONNX)")
        except Exception:
            self.log_warn("⚠ Embedding service not responding on /api/embeddings")
            
        oi_enabled = s.interpreter.external_server_enabled
        if oi_enabled:
            oi_per_chat = s.interpreter.external_server_per_chat
            if oi_per_chat:
                oi_python = s.interpreter.external_server_venv_python
                if not oi_python and (Path(os.environ.get("AETHER_BACKEND_ROOT", "")) / "venv-oi/bin/python").is_file():
                    oi_python = str(Path(os.environ["AETHER_BACKEND_ROOT"]) / "venv-oi/bin/python")
                if not oi_python and (self.ctx.data_dir / "venv-oi/bin/python").is_file():
                    oi_python = str(self.ctx.data_dir / "venv-oi/bin/python")
                    
                if not oi_python:
                    self.log_error("✗ CRITICAL: OI venv-oi python not found")
                    all_healthy = False
                else:
                    self.log_success(f"✓ OI venv python: {oi_python}")
                    if self.supervisor.run_cmd([oi_python, "-c", "import importlib.util; exit(0 if importlib.util.find_spec('interpreter') else 1)"]).returncode == 0:
                        self.log_success("✓ OI package available in venv-oi")
                    else:
                        self.log_error("✗ CRITICAL: open-interpreter package not found in venv-oi")
                        all_healthy = False
            else:
                oi_url = s.interpreter.external_server_url or "http://127.0.0.1:8000"
                if not ":" in oi_url.replace("http://", "").replace("https://", ""):
                    oi_url += ":8000"
                try:
                    urllib.request.urlopen(f"{oi_url}/heartbeat", timeout=3)
                    self.log_success(f"✓ OI standalone server responding at {oi_url}")
                except Exception:
                    self.log_warn(f"⚠ OI standalone server not responding at {oi_url}")

        if not all_healthy:
            return False

        os.environ["ENVIRONMENT"] = "production"
        os.environ["AETHER_ENVIRONMENT"] = "production"
        self.supervisor.run_cmd(self.ctx.backend_cmd + ["run-migrations"])
        self.log_success("All critical services verified and responding")
        return True

class EnvironmentBootstrapper(LoggerMixin):
    def __init__(self, ctx: AetherContext, supervisor: ProcessSupervisor):
        super().__init__("EnvironmentBootstrapper", ctx.log_dir)
        self.ctx = ctx
        self.supervisor = supervisor

    def validate_environment(self):
        self.log("STEP 1: Environment Validation")
        if not Path(self.ctx.backend_cmd[0]).exists() and not self.ctx.backend_cmd[0] == sys.executable:
            self.log_error(f"Backend binary not found: {self.ctx.backend_cmd[0]}")
            sys.exit(1)
        
        if os.environ.get("AETHER_SKIP_SHELL_SETUP", "false").lower() != "true":
            if not shutil.which("docker"):
                self.log_error("Docker is not installed but is required to run the external services mesh.")
                sys.exit(1)
            if self.supervisor.run_cmd(["docker", "info"], capture_output=True).returncode != 0:
                self.log_error("Docker daemon is not running.")
                sys.exit(1)
            if not self.ctx.docker_compose_dir.is_dir():
                self.log_error(f"Docker compose directory not found: {self.ctx.docker_compose_dir}")
                sys.exit(1)

        config_valid = False
        if self.ctx.config_file.is_file():
            try:
                env = {}
                with open(self.ctx.config_file) as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith('#') and '=' in line:
                            k, v = line.split('=', 1)
                            env[k] = v.strip('\"\'')
                
                jwt_secret = env.get('JWT_SECRET')
                service_role_key = env.get('SERVICE_ROLE_KEY')
                
                if jwt_secret and service_role_key:
                    import jwt
                    jwt.decode(service_role_key, jwt_secret, algorithms=['HS256'])
                    config_valid = True
                else:
                    self.log_warn("Configuration file missing JWT_SECRET or SERVICE_ROLE_KEY")
            except Exception as e:
                self.log_warn(f"Existing configuration is invalid (JWT mismatch): {e}")

        if not config_valid:
            self.log("Generating secure keys for first-time setup (or fixing invalid config)...")
            self.ctx.config_file.parent.mkdir(parents=True, exist_ok=True)
            os.environ["SETUP_CONFIG_FILE"] = str(self.ctx.config_file)
            
            # Use the actual script instead of inline code to ensure full functionality
            script_path = self.ctx.script_dir / "scripts/generate_keys.py"
            internal_script = self.ctx.script_dir / "aether-hub/_internal/scripts/generate_keys.py"
            
            cmd = None
            if script_path.exists():
                cmd = [sys.executable, str(script_path), "--force"]
            elif internal_script.exists():
                # Using globals() as the dictionary for exec to avoid scope resolution issues with nested function calls inside the executed script
                # Also inject __file__ so the script can resolve paths relative to itself
                cmd = self.ctx.backend_cmd + ["python-eval", "--code", f"import sys; sys.argv=['generate_keys.py', '--force']; g=globals().copy(); g['__file__']='{internal_script}'; exec(open('{internal_script}').read(), g)"]
            else:
                # Fallback to inline code if script not found
                code = """
import os, sys
try:
    sys.path.insert(0, os.path.join(os.path.dirname(sys.executable), '_internal'))
    from scripts.generate_keys import generate_all_keys, write_env_file, database_exists_with_data, load_existing_secrets, generate_supabase_jwt_token
    from pathlib import Path
    
    env_path = Path(os.environ.get('SETUP_CONFIG_FILE'))
    db_exists = database_exists_with_data(env_path)
    existing_secrets = load_existing_secrets(env_path) if env_path.exists() else {}
    
    keys = generate_all_keys()
    
    if db_exists and existing_secrets:
        critical_keys = ['POSTGRES_PASSWORD', 'JWT_SECRET', 'SECRET_KEY_BASE', 'VAULT_ENC_KEY', 'PG_META_CRYPTO_KEY']
        for key in critical_keys:
            if key in existing_secrets:
                keys[key] = existing_secrets[key]
                
        jwt_secret = keys.get('JWT_SECRET')
        if jwt_secret:
            anon_key = generate_supabase_jwt_token(jwt_secret, "anon", expiry_years=10)
            service_role_key = generate_supabase_jwt_token(jwt_secret, "service_role", expiry_years=10)
            keys['ANON_KEY'] = anon_key
            keys['SUPABASE_ANON_KEY'] = anon_key
            keys['SERVICE_ROLE_KEY'] = service_role_key
            keys['SUPABASE_SERVICE_ROLE_KEY'] = service_role_key
            
    write_env_file(keys, env_path)
except Exception as e:
    import traceback
    traceback.print_exc()
    sys.exit(1)
"""
                cmd = self.ctx.backend_cmd + ["python-eval", "--code", code]
                
            self.log(f"Running key generation command: {cmd}")
            res = self.supervisor.run_cmd(cmd)
            if res.returncode != 0:
                self.log_error(f"Key generation failed with exit code {res.returncode}")
                sys.exit(1)
                
            if not self.ctx.config_file.is_file():
                self.log_error("Failed to generate configuration file")
                sys.exit(1)
            self.log_success("Configuration file auto-generated or repaired")
        else:
            self.log_success("Configuration file loaded and validated")

    def check_and_run_setup_if_needed(self):
        self.log("STEP 2: First-Run Initialization Check")
        if os.environ.get("AETHER_SKIP_SHELL_SETUP", "false").lower() == "true":
            self.log("Shell setup skipped (frontend handles setup via API)")
            return

        needs_setup = False
        if not (Path(os.environ.get("AETHER_BACKEND_ROOT", "")) / "venv-oi/bin/python").is_file():
            needs_setup = True
        
        res = self.supervisor.run_cmd(["docker", "images", "--format", "{{.Repository}}"], capture_output=True, text=True)
        if "supabase/postgres" not in res.stdout or "gnzsnz/torproxy" not in res.stdout or "perplexica" not in res.stdout.lower():
            needs_setup = True

        if not needs_setup:
            self.log_success("All critical components detected, proceeding with startup")
            return

        self.log_warn("First run detected! Running setup-core natively...")
        os.environ["ENVIRONMENT"] = "production"
        os.environ["AETHER_ENVIRONMENT"] = "production"
        
        res = self.supervisor.run_cmd(self.ctx.backend_cmd + ["setup-core", str(self.ctx.data_dir)])
        if res.returncode != 0:
            self.log_error("Setup failed")
            sys.exit(1)
        self.log_success("First-run setup complete, proceeding with normal startup")

    def inject_ffmpeg_lib_path(self):
        ffmpeg_dir = None
        candidates = [
            "/opt/homebrew/opt/ffmpeg@7/lib",
            "/usr/local/opt/ffmpeg@7/lib",
            "/usr/lib/x86_64-linux-gnu",
            "/usr/lib/aarch64-linux-gnu",
            "/usr/local/lib"
        ]
        for candidate in candidates:
            cand_path = Path(candidate)
            if cand_path.is_dir() and any(cand_path.glob("libavutil*")):
                ffmpeg_dir = str(cand_path)
                break

        if not ffmpeg_dir:
            self.log_warn("No FFmpeg lib directory found — torchcodec audio decoding may fail")
            return

        if sys.platform == "darwin":
            curr = os.environ.get("DYLD_LIBRARY_PATH", "")
            os.environ["DYLD_LIBRARY_PATH"] = f"{ffmpeg_dir}:{curr}" if curr else ffmpeg_dir
        else:
            curr = os.environ.get("LD_LIBRARY_PATH", "")
            os.environ["LD_LIBRARY_PATH"] = f"{ffmpeg_dir}:{curr}" if curr else ffmpeg_dir
            
        self.log(f"Injected FFmpeg lib path for torchcodec: {ffmpeg_dir}")

class Orchestrator(LoggerMixin):
    def __init__(self):
        self.ctx = AetherContext()
        super().__init__("Orchestrator", self.ctx.log_dir)
        self._rotate_logs()
        self.log(f"Script Dir: {self.ctx.script_dir}")
        self.log(f"Data Dir: {self.ctx.data_dir}")

        self.supervisor = ProcessSupervisor(self.ctx)
        self.bootstrapper = EnvironmentBootstrapper(self.ctx, self.supervisor)
        self.docker_manager = DockerMeshManager(self.ctx, self.supervisor)

        self.shutdown_in_progress = False

        signal.signal(signal.SIGINT, self.graceful_shutdown)
        signal.signal(signal.SIGTERM, self.graceful_shutdown)

    def _rotate_logs(self):
        prev_dir = self.ctx.log_dir / "previous"
        if prev_dir.exists():
            shutil.rmtree(prev_dir, ignore_errors=True)
        prev_dir.mkdir(parents=True, exist_ok=True)
        moved = 0
        for f in self.ctx.log_dir.glob("*.log"):
            if f.is_file():
                shutil.move(str(f), str(prev_dir / f.name))
                moved += 1
        for d in self.ctx.log_dir.iterdir():
            if d.is_dir() and d.name != "previous":
                shutil.rmtree(d, ignore_errors=True)
        if moved > 0:
            print(f"[LOG-ROTATE] Archived {moved} file(s) from previous session")

    def _source_env(self):
        if self.ctx.config_file.exists():
            for line in self.ctx.config_file.read_text().splitlines():
                if line.strip() and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ[k.strip()] = v.strip().strip('"').strip("'")

    def start_background_services(self):
        self.log("STEP 5: Starting Background Services")
        out = open(self.ctx.log_dir / "worker-watchdog.log", "a")
        try:
            proc = subprocess.Popen(self.ctx.backend_cmd + ["worker-watchdog"], stdout=out, stderr=out, start_new_session=True, cwd=str(self.ctx.script_dir))
        finally:
            out.close()
        self.supervisor.watchdog_pid = proc.pid
        (self.ctx.log_dir / "worker_watchdog.pid").write_text(str(proc.pid))
        self.log_success(f"Worker watchdog started (PID: {proc.pid})")

    def start_backend_binary(self):
        self.log("STEP 6: Starting Backend Binary")
        self.supervisor._stop_conflicting_processes()
        self.bootstrapper.inject_ffmpeg_lib_path()
        os.environ["ENVIRONMENT"] = "production"
        os.environ["AETHER_ENVIRONMENT"] = "production"
        os.environ["PYTHONUNBUFFERED"] = "1"
        os.environ["DISABLE_DOCKER_MANAGEMENT"] = "true"
        
        self._source_env()
        
        out = open(self.ctx.log_dir / "backend.log", "a")
        try:
            self.backend_proc = subprocess.Popen(self.ctx.backend_cmd + ["api"], stdout=out, stderr=out, cwd=str(self.ctx.script_dir))
        finally:
            out.close()
        self.supervisor.backend_pid = self.backend_proc.pid
        self.log_success(f"Backend started (PID: {self.supervisor.backend_pid})")
        
        max_wait = 300
        elapsed = 0
        from config.settings import get_settings
        port = get_settings().security.bind_port
        while elapsed < max_wait:
            try:
                res = self.supervisor.run_cmd(["lsof", f"-ti:{port}"], capture_output=True, text=True)
                if res.stdout.strip():
                    self.log_success(f"Backend listening on port {port}")
                    return True
            except Exception as e:
                self.log_debug(f"Waiting for backend port {port}: {e}")
            
            if self.backend_proc.poll() is not None:
                self.log_error("Backend process died during startup")
                return False
                
            time.sleep(1)
            elapsed += 1
            
        self.log_error(f"Backend failed to start within {max_wait}s")
        return False

    def start_backend_uvicorn(self):
        self.log("Starting Backend via Uvicorn (Development Mode)")
        self.supervisor._stop_conflicting_processes()
        self.bootstrapper.inject_ffmpeg_lib_path()
        os.environ["ENVIRONMENT"] = "development"
        os.environ["AETHER_ENVIRONMENT"] = "development"
        os.environ["PYTHONUNBUFFERED"] = "1"
        os.environ["DISABLE_DOCKER_MANAGEMENT"] = "true"
        
        self._source_env()
        
        uvicorn_args = [
            sys.executable, "-m", "uvicorn",
            "app:create_app", "--factory",
            "--host", "127.0.0.1",
            "--port", "8765",
            "--log-level", "info",
            "--access-log",
            "--use-colors",
            "--reload",
            "--reload-dir", str(self.ctx.script_dir),
            "--reload-exclude", "tests/*",
            "--reload-exclude", "test_*.py"
        ]
        
        self.backend_proc = subprocess.Popen(uvicorn_args, cwd=str(self.ctx.script_dir))
        self.supervisor.backend_pid = self.backend_proc.pid
        self.log_success(f"Backend started via uvicorn (PID: {self.supervisor.backend_pid})")
        
        max_wait = 60
        elapsed = 0
        from config.settings import get_settings
        port = get_settings().security.bind_port
        while elapsed < max_wait:
            try:
                res = self.supervisor.run_cmd(["lsof", f"-ti:{port}"], capture_output=True, text=True)
                if res.stdout.strip():
                    self.log_success(f"Backend API listening on port {port}")
                    return True
            except Exception as e:
                self.log_debug(f"Waiting for uvicorn port {port}: {e}")
            if self.backend_proc.poll() is not None:
                self.log_error("Backend process died during startup")
                return False
            time.sleep(1)
            elapsed += 1
        return False

    def start_backend_api_only(self):
        self.log("Starting Backend API (Frontend-Managed Mode)")
        self.supervisor._stop_conflicting_processes()
        self.bootstrapper.inject_ffmpeg_lib_path()
        os.environ["ENVIRONMENT"] = "production"
        os.environ["AETHER_ENVIRONMENT"] = "production"
        os.environ["PYTHONUNBUFFERED"] = "1"
        os.environ["SKIP_SERVICE_HEALTH_CHECK"] = "true"
        os.environ["DISABLE_DOCKER_MANAGEMENT"] = "true"
        
        self._source_env()
        
        out = open(self.ctx.log_dir / "backend.log", "a")
        try:
            self.backend_proc = subprocess.Popen(self.ctx.backend_cmd + ["api"], stdout=out, stderr=out, cwd=str(self.ctx.script_dir))
        finally:
            out.close()
        self.supervisor.backend_pid = self.backend_proc.pid
        self.log_success(f"Backend API started (PID: {self.supervisor.backend_pid})")
        
        max_wait = 300
        elapsed = 0
        from config.settings import get_settings
        port = get_settings().security.bind_port
        while elapsed < max_wait:
            try:
                res = self.supervisor.run_cmd(["lsof", f"-ti:{port}"], capture_output=True, text=True)
                if res.stdout.strip():
                    self.log_success(f"Backend API listening on port {port}")
                    return True
            except Exception as e:
                self.log_debug(f"Waiting for API only port {port}: {e}")
            if self.backend_proc.poll() is not None:
                self.log_error("Backend process died during startup")
                return False
            time.sleep(1)
            elapsed += 1
        return False

    def graceful_shutdown(self, signum=None, frame=None):
        if self.shutdown_in_progress: return
        self.shutdown_in_progress = True
        self.log("GRACEFUL SHUTDOWN INITIATED")
        
        self.log("Cleaning up any orphaned Open Interpreter processes...")
        try:
            from config.settings import get_settings
            s = get_settings()
            min_port = s.interpreter.external_server_port_min
            max_port = s.interpreter.external_server_port_max
            res = self.supervisor.run_cmd(["lsof", f"-tiTCP:{min_port}-{max_port}", "-sTCP:LISTEN"], capture_output=True, text=True)
            pids = [p.strip() for p in res.stdout.splitlines() if p.strip()]
            for pid in pids:
                if pid.isdigit():
                    self.supervisor.stop_process_tree(int(pid))
        except Exception as e:
            self.log_warn(f"Failed to cleanup OI processes: {e}")
        
        cmd = ["docker", "compose", "--env-file", str(self.ctx.config_file), "down", "--timeout", "5", "--remove-orphans"]
        self.log("Initiating detached Docker mesh teardown session...")
        cwd_bkp = os.getcwd()
        os.chdir(self.ctx.docker_compose_dir)
        docker_proc = subprocess.Popen(cmd, start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        os.chdir(cwd_bkp)
        self.supervisor.docker_bg_pid = docker_proc.pid
        
        if self.supervisor.backend_pid:
            self.log(f"Stopping backend binary (PID: {self.supervisor.backend_pid})...")
            self.supervisor.stop_process_tree(self.supervisor.backend_pid)
            self.log_success("Backend stopped")
            
        if self.supervisor.watchdog_pid:
            self.log(f"Stopping worker watchdog (PID: {self.supervisor.watchdog_pid})...")
            self.supervisor.stop_process_tree(self.supervisor.watchdog_pid)
            self.log_success("Worker watchdog stopped")
            
        try:
            from config.settings import get_settings
            port = get_settings().security.bind_port
            self.supervisor.kill_port(port)
        except Exception as e:
            self.log_debug(f"Error forcefully clearing backend port: {e}")
            
        if self.supervisor.docker_bg_pid:
            self.log(f"Monitoring detached Docker mesh teardown (PID: {self.supervisor.docker_bg_pid})...")
            try: docker_proc.wait(timeout=45)
            except subprocess.TimeoutExpired:
                self.log_warn("Docker mesh teardown still running in background")
                
        self.log_success("All services stopped cleanly")
        sys.exit(0)

    def stop_all(self, stop_supabase=False):
        self.log("Stopping Aether Backend (KILL SWITCH)...")
        
        try:
            from config.settings import get_settings
            s = get_settings()
            port = s.security.bind_port
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/system/shutdown",
                method="POST"
            )
            urllib.request.urlopen(req, timeout=3)
            self.log_success("Sent graceful shutdown signal to backend API.")
            time.sleep(2)
        except Exception as e:
            self.log_warn(f"Graceful API shutdown skipped or failed: {e}")
        
        self.log("Stopping proactive daemons...")
        try:
            from services.daemons.daemon_control import stop_daemon_manager
            stop_daemon_manager()
            self.log_success("Daemon manager gracefully stopped.")
        except Exception as e:
            self.log_warn(f"Daemon manager graceful stop failed: {e}")
            
        self.log("Stopping inference server...")
        try:
            import asyncio
            from services.aether_inference.inference_control import inference_shutdown
            asyncio.run(inference_shutdown(stop_server=True))
            self.log_success("Inference server gracefully stopped.")
        except Exception as e:
            self.log_warn(f"Inference server graceful stop failed: {e}")

        self.log("Sweeping for orphaned processes...")
        self.supervisor.sweep_orphaned_processes()
                
        try:
            from config.settings import get_settings
            s = get_settings()
            if s.embedding_service and getattr(s.embedding_service, "enabled", False):
                port = s.embedding_service.port
                self.log(f"Stopping embedding service on port {port}")
                self.supervisor.kill_port(port)
        except Exception as e:
            self.log_debug(f"Error stopping embedding service port: {e}")

        try:
            from config.settings import get_settings
            s = get_settings()
            if getattr(s.interpreter, "external_server_enabled", False) and getattr(s.interpreter, "external_server_per_chat", False):
                min_p = s.interpreter.external_server_port_min
                max_p = s.interpreter.external_server_port_max
                self.log(f"Stopping per-chat OI servers on ports {min_p}-{max_p}")
                res = self.supervisor.run_cmd(["lsof", f"-tiTCP:{min_p}-{max_p}", "-sTCP:LISTEN"], capture_output=True, text=True)
                pids = [p.strip() for p in res.stdout.splitlines() if p.strip()]
                for pid in pids:
                    if pid.isdigit():
                        self.supervisor.stop_process_tree(int(pid))
        except Exception as e:
            self.log_debug(f"Error stopping OI server ports: {e}")
            
        try:
            from config.settings import get_settings
            s = get_settings()
            port = s.security.bind_port
            self.supervisor.kill_port(port)
            self.log_success(f"Backend API port {port} cleared")
        except Exception as e:
            self.supervisor.kill_port(8765)
            self.log_success("Backend API port 8765 cleared")
            
        if stop_supabase:
            res = self.supervisor.run_cmd(["pgrep", "-f", "docker compose.*down"], capture_output=True, text=True)
            if res.stdout.strip():
                self.log("Docker mesh teardown already in progress, waiting...")
                while self.supervisor.run_cmd(["pgrep", "-f", "docker compose.*down"], capture_output=True).returncode == 0:
                    time.sleep(1)
            else:
                self.docker_manager.docker_mesh_down()
        else:
            self.log("Docker mesh left running (use --stop-supabase to stop)")
            
        self.log_success("KILL SWITCH Shutdown complete")

    def run(self, mode="production"):
        self.bootstrapper.validate_environment()
        
        if mode == "development":
            self.log("Mode: Development")
            self.supervisor.cleanup_old_services()
            self.docker_manager.docker_mesh_down()
            self.docker_manager.docker_mesh_up()
            if not self.docker_manager.wait_for_docker_health():
                self.docker_manager.docker_mesh_down()
                sys.exit(1)
            if not self.docker_manager.verify_critical_services():
                self.docker_manager.docker_mesh_down()
                sys.exit(1)
            self.start_background_services()
            if not self.start_backend_uvicorn():
                self.docker_manager.docker_mesh_down()
                sys.exit(1)
        elif os.environ.get("AETHER_SKIP_SHELL_SETUP", "false").lower() == "true":
            self.log("Mode: Frontend-managed")
            self.supervisor.cleanup_old_services()
            if not self.start_backend_api_only(): sys.exit(1)
        else:
            self.log("Mode: Shell-managed")
            self.bootstrapper.check_and_run_setup_if_needed()
            self.supervisor.cleanup_old_services()
            self.docker_manager.docker_mesh_down()
            self.docker_manager.docker_mesh_up()
            if not self.docker_manager.wait_for_docker_health():
                self.docker_manager.docker_mesh_down()
                sys.exit(1)
            if not self.docker_manager.verify_critical_services():
                self.docker_manager.docker_mesh_down()
                sys.exit(1)
            self.start_background_services()
            if not self.start_backend_binary():
                self.docker_manager.docker_mesh_down()
                sys.exit(1)
                
        self.log("STEP 7: System Ready")
        self.log_success(f"Aether Backend is running ({mode.upper()} MODE)")
        self.log("Press Ctrl+C to stop gracefully")
        
        try:
            self.backend_proc.wait()
        except KeyboardInterrupt:
            self.graceful_shutdown()
        except Exception as e:
            self.log_warn(f"Backend process exited: {e}")
            self.graceful_shutdown()

def main(args=None):
    import argparse
    parser = argparse.ArgumentParser(description="Aether Backend Orchestrator")
    parser.add_argument("--mode", choices=["production", "development", "stop"], default="production")
    parser.add_argument("--stop-supabase", action="store_true", help="Stop docker mesh when stopping")
    parsed_args = parser.parse_args(args)

    augment_path()
    orchestrator = Orchestrator()
    if parsed_args.mode == "stop":
        orchestrator.stop_all(stop_supabase=parsed_args.stop_supabase)
    else:
        orchestrator.run(mode=parsed_args.mode)

if __name__ == "__main__":
    main()
