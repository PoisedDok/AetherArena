import os
import sys
import json
import time
import shutil
import platform
import subprocess
import logging
import shlex
from pathlib import Path

# Aether Backend - Core Setup Engine
# Robust, idempotent Python script for initial environment setup.

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

class SetupEngine:
    def __init__(self, backend_root: str):
        self.backend_root = Path(backend_root).resolve()
        self.install_dir = Path(os.environ.get("AETHER_INSTALL_DIR", str(self.backend_root))).resolve()
        
        self.logs_dir = self.backend_root / "logs"
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        
        self.progress_file = self.logs_dir / "setup_progress.json"
        self.log_file = self.logs_dir / "setup_script.log"
        self.pid_file = self.logs_dir / "setup_engine.pid"
        
        self.pid_file.write_text(str(os.getpid()))
        self._setup_logging()
        
    def _setup_logging(self):
        self.logger = logging.getLogger("SetupEngine")
        self.logger.setLevel(logging.INFO)
        fh = logging.FileHandler(self.log_file)
        fh.setFormatter(logging.Formatter("[%(asctime)s] %(message)s", "%Y-%m-%d %H:%M:%S"))
        ch = logging.StreamHandler()
        ch.setFormatter(logging.Formatter("[%(asctime)s] %(message)s", "%Y-%m-%d %H:%M:%S"))
        self.logger.handlers = []
        self.logger.addHandler(fh)
        self.logger.addHandler(ch)

    def log(self, msg: str):
        self.logger.info(msg)

    def _read_progress(self):
        try:
            with open(self.progress_file, "r") as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return {
                "repositories": {"status": "pending", "progress": 0, "message": "Waiting", "items": []},
                "python_packages": {"status": "pending", "progress": 0, "message": "Waiting", "items": []},
                "oi_environment": {"status": "pending", "progress": 0, "message": "Waiting", "items": []},
                "inference_environment": {"status": "pending", "progress": 0, "message": "Waiting", "items": []},
                "ml_models": {"status": "pending", "progress": 0, "message": "Waiting", "items": []},
                "docker_services": {"status": "pending", "progress": 0, "message": "Waiting", "items": []},
                "total_progress": 0,
                "current_phase": "idle"
            }

    def _write_progress(self, data):
        tmp_file = self.progress_file.with_suffix(".tmp")
        with open(tmp_file, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp_file, self.progress_file)

    def error_exit(self, msg: str):
        self.logger.error(f"ERROR: {msg}")
        phase = "docker_services"
        try:
            data = self._read_progress()
            phase = data.get("current_phase", "docker_services")
            if phase not in {"repositories", "python_packages", "oi_environment", "inference_environment", "ml_models", "docker_services"}:
                phase = "docker_services"
        except Exception as e:
            self.logger.debug(f"Failed to read progress before exit: {e}", exc_info=True)
        self.update_progress(phase, 0, f"Error: {msg}", "error")
        sys.exit(1)

    def update_progress(self, phase: str, progress: int, message: str, status: str = "in_progress"):
        data = self._read_progress()

        if phase in data:
            data[phase]["status"] = status
            data[phase]["progress"] = progress
            data[phase]["message"] = message

        if status == "in_progress":
            data["current_phase"] = phase
        elif status == "error":
            data["current_phase"] = "error"
            data["error"] = message
        elif status == "completed" and all(
            data[k]["status"] in ("completed", "completed_with_errors", "skipped")
            for k in ("repositories", "python_packages", "oi_environment", "inference_environment", "ml_models", "docker_services")
        ):
            data["current_phase"] = "completed"

        if status != "error":
            data.pop("error", None)

        weights = {
            "repositories": 0.02,
            "python_packages": 0.03,
            "oi_environment": 0.15,
            "inference_environment": 0.25,
            "ml_models": 0.10,
            "docker_services": 0.45
        }
        
        total = sum(data.get(k, {}).get("progress", 0) * weights[k] for k in weights)
        data["total_progress"] = min(int(total), 100)

        self._write_progress(data)

    def run_cmd(self, cmd, log_file=None, **kwargs):
        if isinstance(cmd, str):
            cmd_list = shlex.split(cmd)
        else:
            cmd_list = cmd

        if log_file:
            with open(log_file, "a") as f:
                f.write(f"\n--- Running: {cmd_list} ---\n")
                process = subprocess.Popen(cmd_list, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, shell=False, **kwargs)
                stdout_text = []
                for line in process.stdout:
                    sys.stdout.write(line)
                    sys.stdout.flush()
                    f.write(line)
                    f.flush()
                    stdout_text.append(line)
                process.wait()
                return subprocess.CompletedProcess(process.args, process.returncode, "".join(stdout_text), "")
        return subprocess.run(cmd_list, shell=False, **kwargs)

    def fetch_supabase_boilerplate(self, target_dir: Path):
        self.log(f"Copying official Supabase configuration boilerplate to {target_dir}...")
        template_dir = None
        candidates = [
            self.install_dir / "services/external-services/volumes-template",
            self.install_dir / "aether-hub/_internal/services/external-services/volumes-template",
            self.backend_root / "services/external-services/volumes-template"
        ]
        for c in candidates:
            if c.is_dir():
                template_dir = c
                break
                
        if template_dir:
            shutil.copytree(template_dir, target_dir, dirs_exist_ok=True)
            self.log("✓ Boilerplate copied from local template")
            return True
        else:
            self.log("⚠ Warning: Could not find local Supabase boilerplate template at volumes-template.")
            return False

    def verify_bundled_services(self):
        self.log("Verifying bundled services...")
        self.update_progress("repositories", 10, "Verifying bundle integrity...")
        
        services_dir = None
        candidates = [
            self.install_dir / "services",
            self.install_dir / "aether-hub/_internal/services",
            self.backend_root / "services"
        ]
        for c in candidates:
            if c.is_dir():
                services_dir = c
                break
                
        if not services_dir:
            self.error_exit(f"Services directory not found. Checked: {candidates}")

        self.resolved_services_dir = services_dir
        self.resolved_external_services_dir = services_dir / "external-services"

        if not (services_dir / "perplexica/package.json").is_file():
            self.error_exit(f"Perplexica source missing from bundle (expected at {services_dir}/perplexica)")
        self.log(f"✓ Perplexica source: {services_dir}/perplexica")

        if not (self.resolved_external_services_dir / "docker-compose.yml").is_file():
            self.error_exit(f"Docker compose file missing from bundle (expected at {self.resolved_external_services_dir})")
        self.log(f"✓ Docker compose: {self.resolved_external_services_dir}/docker-compose.yml")

        self.log(f"✓ INSTALL_DIR: {self.install_dir}")
        self.log(f"✓ BACKEND_ROOT: {self.backend_root}")
        self.log(f"✓ RESOLVED_SERVICES_DIR: {self.resolved_services_dir}")
        
        self.update_progress("repositories", 100, "Bundle verified (no downloads needed)", "completed")

    def setup_python_packages(self):
        self.log("Starting Python Package Setup...")
        self.update_progress("python_packages", 10, "Installing optional extras...")
        
        python_exec = sys.executable
        if not python_exec:
            python_exec = "python3"

        res = self.run_cmd([python_exec, "-m", "pip", "install", "stream2sentence", "--upgrade"], capture_output=True, text=True)
        if res.returncode != 0:
            self.log("Warning: Optional package install failed (non-critical)")

        try:
            import llama_index.core
        except ImportError:
            self.log("Installing llama-index-core + readers for file indexing...")
            res = self.run_cmd([python_exec, "-m", "pip", "install", "llama-index-core>=0.12.0", "llama-index-readers-file>=0.4.0", "--quiet"], capture_output=True, text=True)
            if res.returncode != 0:
                self.log("Warning: llama-index install failed (file indexing will not work)")
                
        self.update_progress("python_packages", 100, "Packages ready", "completed")

    def setup_oi_env(self):
        self.log("Starting OI Environment Setup...")
        self.update_progress("oi_environment", 10, "Creating venv-oi...")
        
        if platform.system() == "Darwin":
            venv_path = Path.home() / "Library/Application Support/Aether/venv-oi"
        else:
            venv_path = self.backend_root / "venv-oi"
            
        venv_path.parent.mkdir(parents=True, exist_ok=True)
        
        if not venv_path.is_dir():
            res = self.run_cmd([sys.executable or "python3", "-m", "venv", str(venv_path)])
            if res.returncode != 0:
                self.error_exit("Failed to create OI venv")
                
        self.update_progress("oi_environment", 40, "Installing requirements...")
        
        req_file = None
        candidates = [
            self.install_dir / "scripts/requirements_oi_server.txt",
            self.install_dir / "aether-hub/_internal/scripts/requirements_oi_server.txt",
            self.backend_root / "scripts/requirements_oi_server.txt"
        ]
        for c in candidates:
            if c.is_file():
                req_file = c
                break
                
        venv_python = venv_path / "bin/python" if platform.system() != "Windows" else venv_path / "Scripts/python.exe"
        if req_file:
            res = self.run_cmd([str(venv_python), "-m", "pip", "install", "-r", str(req_file)], capture_output=True, text=True)
            if res.returncode != 0:
                self.error_exit(f"Failed to install OI requirements: {res.stderr}")
        else:
            self.log("Warning: requirements_oi_server.txt not found, skipping pip install")
            
        self.update_progress("oi_environment", 100, "OI Environment ready", "completed")

    def setup_inference_env(self):
        self.log("Starting Inference Environment Setup...")
        self.update_progress("inference_environment", 10, "Creating venv-inference...")
        
        if platform.system() == "Darwin":
            venv_path = Path.home() / "Library/Application Support/Aether/venv-inference"
        else:
            venv_path = self.backend_root / "venv-inference"
            
        venv_path.parent.mkdir(parents=True, exist_ok=True)
        if not venv_path.is_dir():
            if self.run_cmd([sys.executable or "python3", "-m", "venv", str(venv_path)]).returncode != 0:
                self.error_exit("Failed to create inference venv")
                
        self.update_progress("inference_environment", 30, "Detecting platform...")
        
        is_apple_silicon = platform.system() == "Darwin" and platform.machine() == "arm64"
        has_nvidia = shutil.which("nvidia-smi") is not None
        
        self.update_progress("inference_environment", 50, "Installing inference engine...")
        
        req_dir = self.install_dir / "services/aether_inference"
        venv_python = str(venv_path / "bin/python" if platform.system() != "Windows" else venv_path / "Scripts/python.exe")
        
        self.run_cmd([venv_python, "-m", "pip", "install", "--upgrade", "pip"])
        
        if is_apple_silicon:
            self.log("Platform: Apple Silicon -- installing vllm-mlx (Metal GPU inference)")
            req_file = req_dir / "requirements-apple-silicon.txt"
            if req_file.is_file():
                self.log(f"Using requirements file: {req_file}")
                self.run_cmd([venv_python, "-m", "pip", "install", "-r", str(req_file)])
            else:
                self.log("Requirements file not found, using inline install...")
                self.run_cmd([venv_python, "-m", "pip", "install", "vllm-mlx[vision] @ git+https://github.com/waybarrios/vllm-mlx.git@1fd1c9ae47847822dac7dbc5db8433009186aa5c"])
            
            self.run_cmd([venv_python, "-m", "pip", "install", "--upgrade", "mlx-vlm>=0.3.12", "mlx-lm>=0.30.7", "transformers>=5.1.0"])
            self.run_cmd([venv_python, "-m", "pip", "install", "huggingface_hub>=0.20.0"])
            
            self.log("Verifying Apple Silicon inference dependencies...")
            self.run_cmd([venv_python, "-c", "from vllm_mlx.reasoning import get_parser"])
            self.run_cmd([venv_python, "-c", "from mlx_vlm.models.glm_ocr import Model"])
            
        elif has_nvidia:
            self.log("Platform: NVIDIA CUDA -- installing vLLM")
            req_file = req_dir / "requirements-cuda.txt"
            if req_file.is_file():
                self.run_cmd([venv_python, "-m", "pip", "install", "-r", str(req_file)])
            else:
                self.run_cmd([venv_python, "-m", "pip", "install", "vllm", "huggingface_hub>=0.20.0"])
        else:
            self.log("Platform: No GPU detected -- installing llama-cpp (CPU GGUF) + Ollama fallback")
            self.run_cmd([venv_python, "-m", "pip", "install", "fastapi>=0.109.0", "uvicorn>=0.27.0", "httpx>=0.26.0", "llama-cpp-python>=0.3.0", "huggingface_hub>=0.20.0"])
            if shutil.which("ollama"):
                self.log("Ollama detected -- will also be available as fallback engine")
            else:
                self.log("Install Ollama from https://ollama.com/download for additional model support")
                
        self.log("Ensuring llama-cpp-python for GGUF model support...")
        self.run_cmd([venv_python, "-m", "pip", "install", "llama-cpp-python>=0.3.0"])
        
        self.update_progress("inference_environment", 70, "Downloading inference models...")
        
        models_dir = Path(os.environ.get("INFERENCE_MODELS_DIR", self.backend_root / "models"))
        models_dir.mkdir(parents=True, exist_ok=True)
        self.log(f"Inference models directory: {models_dir}")
        
        hf_cache_dir = self.backend_root / "cache/huggingface"
        hf_cache_dir.mkdir(parents=True, exist_ok=True)
        os.environ["HF_HOME"] = str(hf_cache_dir)
        os.environ["HF_HUB_CACHE"] = str(hf_cache_dir / "hub")
        os.environ["HF_HUB_DISABLE_SYMLINKS_WINDOWS"] = "1"
        
        try:
            import urllib.request
            url = "https://huggingface.co"
            req = urllib.request.Request(url, method="HEAD")
            urllib.request.urlopen(req, timeout=3)
            self.log("✓ huggingface.co is reachable")
        except Exception:
            try:
                url = "https://hf-mirror.com"
                req = urllib.request.Request(url, method="HEAD")
                urllib.request.urlopen(req, timeout=3)
                os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
                self.log("⚠ huggingface.co unreachable, falling back to hf-mirror.com")
            except Exception:
                self.log("⚠ Warning: Both huggingface.co and hf-mirror.com are unreachable. Model downloads may fail.")

        if is_apple_silicon:
            models = [
                ('lmstudio-community/LFM2.5-1.2B-Instruct-MLX-8bit', 'Text model (summaries, query-gen)', True),
                ('mlx-community/GLM-OCR-8bit', 'OCR model (document understanding)', True),
                ('lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit', 'Main agent (primary chat, reasoning)', True),
                ('lmstudio-community/LFM2.5-VL-1.6B-MLX-6bit', 'Vision model (image understanding)', False),
            ]
        elif has_nvidia:
            models = [
                ('LiquidAI/LFM2.5-1.2B-Instruct', 'Text model (summaries, query-gen)', True),
                ('zai-org/GLM-OCR', 'OCR model (full precision)', True),
                ('Qwen/Qwen3-4B-Instruct', 'Main agent (primary chat)', True),
                ('LiquidAI/LFM2.5-VL-1.6B', 'Vision model (image understanding)', False),
            ]
        else:
            models = []
            if shutil.which("ollama"):
                for m in ["glm-ocr", "qwen3:4b", "lfm2.5:1.2b"]:
                    self.run_cmd(["ollama", "pull", m])

        if models:
            script = f"""
import os, sys
from huggingface_hub import snapshot_download
models_dir = '{models_dir}'
models = {models}
failed = []
for i, (model_id, label, req) in enumerate(models):
    local_dir = os.path.join(models_dir, *model_id.split('/'))
    os.makedirs(local_dir, exist_ok=True)
    print(f'[{{i+1}}/{{len(models)}}] Downloading {{label}}: {{model_id}}')
    try:
        path = snapshot_download(model_id, local_dir=local_dir)
    except Exception as e:
        if req:
            failed.append(model_id)
if failed:
    sys.exit(1)
"""
            res = self.run_cmd([venv_python, "-c", script], capture_output=True, text=True)
            if res.returncode != 0:
                self.log(f"Warning: Model download failed: {res.stderr}")
                
        self.update_progress("inference_environment", 100, "Inference environment ready", "completed")

    def setup_models(self):
        self.log("Starting Model Downloads...")
        self.update_progress("ml_models", 10, "Downloading critical models...")
        
        is_apple_silicon = platform.system() == 'Darwin' and platform.machine() == 'arm64'
        models = [('mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit', 'Qwen3 TTS MLX')] if is_apple_silicon else [
            ('Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice', 'Qwen3 TTS PyTorch'),
            ('Qwen/Qwen3-TTS-Tokenizer-12Hz', 'Qwen3 TTS Tokenizer'),
        ]

        python_exec = sys.executable or "python3"
        script = f"""
import sys, os, shutil
from pathlib import Path
try:
    from huggingface_hub import snapshot_download
    models = {models}
    is_apple_silicon = {is_apple_silicon}
    downloaded_paths = {{}}
    for model_id, label in models:
        local_path = snapshot_download(model_id)
        downloaded_paths[model_id] = local_path
    
    if not is_apple_silicon:
        backend_root = Path('{self.backend_root}')
        tts_local = backend_root / 'data/models/tts/Qwen3-TTS-12Hz-0.6B-CustomVoice'
        qwen_cache = downloaded_paths.get('Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice')
        if qwen_cache and not tts_local.exists():
            tts_local.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(qwen_cache, str(tts_local), dirs_exist_ok=True)
except ImportError:
    pass
"""
        self.run_cmd([python_exec, "-c", script])
        self.update_progress("ml_models", 100, "Models ready (TTS + embedding in Docker)", "completed")

    def setup_docker(self):
        self.log("Starting Docker Setup...")
        self.update_progress("docker_services", 5, "Analyzing existing Docker environment...")
        
        compose_dir = getattr(self, "resolved_external_services_dir", None)
        if not compose_dir or not compose_dir.is_dir():
            candidates = [
                self.install_dir / "services/external-services",
                self.install_dir / "aether-hub/_internal/services/external-services",
                self.backend_root / "services/external-services"
            ]
            for c in candidates:
                if c.is_dir():
                    compose_dir = c
                    break
                    
        if not compose_dir or not compose_dir.is_dir():
            self.error_exit("Docker compose directory not found")
            
        self.log(f"Using compose directory: {compose_dir}")
        os.chdir(compose_dir)
        
        env_args = []
        env_file = self.backend_root / "config/local.env"
        if env_file.is_file():
            env_args = ["--env-file", str(env_file)]
            
        self.update_progress("docker_services", 10, "Checking existing services...")
        
        res = self.run_cmd(["docker", "compose"] + env_args + ["ps", "--status", "running", "-q"], capture_output=True, text=True)
        running_services = len([line for line in res.stdout.splitlines() if line.strip()])
        res2 = self.run_cmd(["docker", "compose"] + env_args + ["ps"], capture_output=True, text=True)
        still_starting = res2.stdout.count("(starting)")
        
        if running_services >= 12 and still_starting == 0:
            self.log(f"✓ Docker mesh already running and healthy ({running_services} services)")
            self.update_progress("docker_services", 100, f"Docker mesh already running ({running_services} services)", "completed")
            os.chdir(self.backend_root)
            return

        self.update_progress("docker_services", 15, "Checking local image cache...")
        res = self.run_cmd(["docker", "images", "--format", "{{.Repository}}"], capture_output=True, text=True)
        cached_repos = res.stdout
        
        required_images = [
            "searxng/searxng", "supabase/studio", "kong", "supabase/gotrue",
            "postgrest/postgrest", "supabase/realtime", "supabase/storage-api",
            "darthsim/imgproxy", "supabase/postgres-meta", "supabase/edge-runtime",
            "supabase/logflare", "supabase/postgres", "timberio/vector",
            "supabase/supavisor", "redis", "gnzsnz/torproxy"
        ]
        
        all_cached = all(img in cached_repos for img in required_images)
        
        if all_cached:
            self.log("✓ All pre-built images cached locally — skipping pull")
            self.update_progress("docker_services", 30, "Images verified (all cached)")
        else:
            self.update_progress("docker_services", 20, "Pulling pre-built images...")
            pull_success = False
            for count in range(3):
                self.log(f"Pulling images (Attempt {count+1}/3)...")
                if self.run_cmd(["docker", "compose"] + env_args + ["pull", "--ignore-buildable"], log_file=self.log_file).returncode == 0:
                    pull_success = True
                    break
                time.sleep(10)
            if not pull_success:
                self.error_exit("Failed to pull Docker images")
            self.update_progress("docker_services", 30, "Images ready")

        if self.run_cmd(["docker", "image", "inspect", "perplexica:latest"], capture_output=True).returncode == 0:
            self.log("✓ Perplexica image already built — reusing cached image")
            self.update_progress("docker_services", 55, "Perplexica image cached")
        else:
            self.update_progress("docker_services", 35, "Building Perplexica + embedding models from source...")
            perplexica_dir = None
            if getattr(self, "resolved_services_dir", None):
                p = self.resolved_services_dir / "perplexica"
                if p.is_dir():
                    perplexica_dir = p
            if not perplexica_dir:
                for c in [
                    self.install_dir / "services/perplexica",
                    self.install_dir / "aether-hub/_internal/services/perplexica",
                    self.backend_root / "services/perplexica"
                ]:
                    if c.is_dir():
                        perplexica_dir = c
                        break
            if perplexica_dir:
                os.chdir(perplexica_dir)
                self.run_cmd(["docker", "build", "-t", "perplexica:latest", "-f", "Dockerfile", "."], log_file=self.log_file)
                os.chdir(compose_dir)
            self.update_progress("docker_services", 55, "Perplexica ready")

        self.update_progress("docker_services", 60, "Preparing mesh configuration...")
        docker_data = Path(os.environ.get("AETHER_DOCKER_DATA", compose_dir / "volumes"))
        for d in ["api", "db/data", "storage", "logs", "pooler", "searxng"]:
            (docker_data / d).mkdir(parents=True, exist_ok=True)
            
        if not (docker_data / "api/kong.yml").is_file():
            self.fetch_supabase_boilerplate(docker_data)
            
        if not (docker_data / "searxng/settings.yml").is_file():
            self.log("Seeding SearXNG config from template...")
            template_file = None
            for c in [
                self.install_dir / "services/external-services/volumes-template/searxng/settings.yml",
                self.install_dir / "aether-hub/_internal/services/external-services/volumes-template/searxng/settings.yml",
                self.backend_root / "services/external-services/volumes-template/searxng/settings.yml"
            ]:
                if c.is_file():
                    template_file = c
                    break
            if template_file:
                shutil.copy(template_file, docker_data / "searxng/settings.yml")
            else:
                (docker_data / "searxng/settings.yml").write_text("use_default_settings: true\ngeneral:\n  instance_name: 'aether-searxng'\nsearch:\n  autocomplete: 'google'\n  formats: [html, json]\n")

        perplexica_data = os.environ.get("AETHER_PERPLEXICA_DATA")
        if perplexica_data:
            Path(perplexica_data).joinpath("data").mkdir(parents=True, exist_ok=True)
            Path(perplexica_data).joinpath("uploads").mkdir(parents=True, exist_ok=True)

        self.update_progress("docker_services", 70, "Starting Docker services...")
        if self.run_cmd(["docker", "compose"] + env_args + ["up", "-d"], log_file=self.log_file).returncode != 0:
            self.error_exit("Failed to start Docker services")

        self.update_progress("docker_services", 80, "Verifying service health...")
        max_wait = 120
        elapsed = 0
        while elapsed < max_wait:
            res_q = self.run_cmd(["docker", "compose"] + env_args + ["ps", "-q"], capture_output=True, text=True)
            total = len([line for line in res_q.stdout.splitlines() if line.strip()])
            res_ps = self.run_cmd(["docker", "compose"] + env_args + ["ps"], capture_output=True, text=True)
            healthy = res_ps.stdout.count("(healthy)")
            starting = res_ps.stdout.count("(starting)")
            
            if total > 0 and starting == 0:
                self.log(f"✓ All services settled: {healthy} healthy out of {total} total")
                break
                
            progress = 80
            if total > 0 and healthy > 0:
                progress = 80 + int(healthy * 19 / total)
            self.update_progress("docker_services", progress, f"Services starting ({healthy}/{total} healthy, {starting} warming up)...")
            
            time.sleep(5)
            elapsed += 5
            
        if elapsed >= max_wait:
            self.log(f"⚠ Some services did not become healthy within {max_wait}s")
            self.update_progress("docker_services", 100, "Docker mesh started (some services still warming up)", "completed_with_errors")
        else:
            self.update_progress("docker_services", 100, "Docker mesh ready — all services healthy", "completed")
            
        os.chdir(self.backend_root)

    def run(self):
        self.log("=== Aether Setup Core Started ===")
        try:
            self.verify_bundled_services()
            self.setup_python_packages()
            self.setup_oi_env()
            self.setup_inference_env()
            self.setup_models()
            self.setup_docker()
        except Exception as e:
            self.error_exit(str(e))
        
        self.log("=== Aether Setup Core Completed Successfully ===")
        
        try:
            data = self._read_progress()
            data["current_phase"] = "completed"
            data["app_version"] = os.environ.get("AETHER_APP_VERSION", "2.0.0")
            self._write_progress(data)
        except Exception as e:
            self.logger.error(f"Failed to write completion status: {e}", exc_info=True)

def main():
    augment_path()
    print("SYS.ARGV IN SETUP_ENGINE:", sys.argv)
    if len(sys.argv) > 1:
        if sys.argv[1] == "setup-core" and len(sys.argv) > 2:
            backend_root = sys.argv[2]
        else:
            backend_root = sys.argv[1]
    else:
        backend_root = os.getcwd()
    print("BACKEND_ROOT:", backend_root)
    engine = SetupEngine(backend_root)
    engine.run()

if __name__ == "__main__":
    main()
