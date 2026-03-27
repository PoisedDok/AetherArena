# -*- mode: python ; coding: utf-8 -*-

"""
PyInstaller Build Configuration for AetherArena Backend
Produces a single-file executable: aether-hub (macOS/Linux) or aether-hub.exe (Windows)

Usage:
  macOS/Linux: pyinstaller build-config.spec
  Windows:     pyinstaller build-config.spec

Output:
  dist/aether-hub (or aether-hub.exe)
"""

import sys
from pathlib import Path
from PyInstaller.utils.hooks import collect_all, collect_submodules

block_cipher = None

# Determine platform
IS_WINDOWS = sys.platform.startswith('win')
IS_MACOS = sys.platform == 'darwin'

# Backend root directory
backend_root = Path('.').resolve()

# --- PACKAGE COLLECTION (God-level strategy for complex ML packages) ---
# We use collect_all and manual path inclusion to ensure all submodules, 
# data files, and binaries are correctly identified.
packages_to_collect = [
    # Supabase SDK and all sub-dependencies (complex import chain)
    'supabase',
    'postgrest',
    'gotrue',
    'storage3',
    'supafunc',
    'realtime',
    # Transformers ecosystem — MUST use collect_all because transformers uses
    # heavy __getattr__ lazy-loading (import_utils.py) that PyInstaller can't trace.
    # Without this, AutoProcessor/AutoModel etc. fail at runtime (needed by Docling).
    'transformers',          # Core: AutoProcessor, AutoModel, pipelines (for Docling)
    # NOTE: sentence_transformers is NOT bundled. Embedding service runs inside
    # Perplexica Docker container (ONNX via @huggingface/transformers in Node.js).
    # Document processing — docling + ALL transitive deps
    'docling',
    'docling_core',
    'docling_parse',
    'docling_ibm_models',
    'filetype',          # docling: file type detection
    'tabulate',          # docling: table formatting
    'marko',             # docling: markdown parsing
    'openpyxl',          # docling: Excel parsing
    'pylatexenc',        # docling: LaTeX encoding
    'typer',             # docling: CLI framework
    'accelerate',        # docling: HF accelerate for model loading
    'pydantic_settings', # docling: settings management
    'huggingface_hub',   # docling: model downloads
    'aether_rag',
    'llama_index',           # AETHER_RAG chunking dependency (SentenceSplitter, Document model)
    'llama_index.core',      # Core module (node_parser, schema)
    'llama_index.readers',   # File readers (SimpleDirectoryReader)
    'pyterrier',  # BM25 keyword search (pure Python)
    'lightning',
    'lightning_fabric',
    'pytorch_lightning',
    'matplotlib',
    'speechbrain',
    'RealtimeTTS',
    'stream2sentence',
    'pydub',
    'pyaudio',
    'resampy',
    'kokoro',
    'qwen_tts',
    'misaki',
    'phonemizer',
    'segments',
    'csvw',
    'language_tags',
    'nltk',
    # sumy: LexRank extractive summarization used by DocumentUtility.
    # All imports are function-level (lazy), so PyInstaller cannot trace them.
    'sumy',
    'rfc3987',
    'rfc3987_syntax',
    'jsonschema',
    'jsonschema_specifications',
    'espeakng_loader',
    'spacy',
    'spacy_curated_transformers',
    'curated_transformers',
    'curated_tokenizers',
    'en_core_web_sm',
    # Audio processing — pyannote MUST be in collect_all to capture data files
    # (e.g. pyannote/audio/telemetry/config.yaml) not just hiddenimports
    'pyannote',
    'pyannote.audio',
    'pyannote.core',
    'pyannote.pipeline',
    'pyannote.database',
    # torchcodec: audio decoder for pyannote, has native .dylib files that need
    # explicit collection (not auto-traced as a transitive dep of pyannote)
    'torchcodec',
    # tiktoken: encoding data files (BPE merge tables) are discovered via entry
    # points (tiktoken_ext). PyInstaller doesn't collect entry points by default,
    # so litellm fails with "Unknown encoding cl100k_base. Plugins found: []".
    # collect_all ensures both the native .so AND the tiktoken_ext plugin data
    # are included in the bundle.
    'tiktoken',
    'tiktoken_ext',
    # openwakeword: ONNX wake word detection models + preprocessing data.
    # Without collect_all, production handsfree mode silently falls back to
    # no-wake-word because ImportError is caught in ws/factory.py:418-453.
    'openwakeword',
    # uv: Required for running PyPI-based MCP servers via the 'uvx' command
    # from the frontend MCP Marketplace integration.
    'uv',
    
    # Native MCPs
    'slack_sdk',
    'telethon',
]

collected_datas = []
collected_binaries = []
collected_hiddenimports = []

for pkg in packages_to_collect:
    # Use collect_all which is a wrapper around submodules, datas, and binaries
    d, b, h = collect_all(pkg)
    collected_datas.extend(d)
    collected_binaries.extend(b)
    collected_hiddenimports.extend(h)
    
    # Extra safety for editable installs or complex packages: 
    # explicitly collect all submodules found by scanning the package path
    sub_h = collect_submodules(pkg)
    collected_hiddenimports.extend(sub_h)

# --- DEEP RECURSIVE SUBMODULE COLLECTION (Final Boss Strategy) ---
# Some submodules are missed even by collect_submodules if they are loaded 
# via complex plugin architectures or __path__ manipulation.
additional_hidden_imports = [
    'docling.models.plugins',
    'docling.models.plugins.defaults',
    'docling.backend.docling_parse_v2_backend',
    'docling.backend.docling_parse_v4_backend',
    'docling.models.factories.picture_description_factory',
    'docling.models.picture_description_api_model',
    'RealtimeTTS.engines.system_engine',
    'RealtimeTTS.engines.edge_engine',
    'RealtimeTTS.engines.gtts_engine',
    'RealtimeTTS.engines.openai_engine',
    'RealtimeTTS.engines.elevenlabs_engine',
    'RealtimeTTS.engines.kokoro_engine',
    'RealtimeTTS.engines.qwen3_engine',
    'kokoro.pipeline',
    'kokoro.model',
    'kokoro.modules',
    'kokoro.istftnet',
    'kokoro.custom_stft',
    'qwen_tts',
    'qwen_tts.models',
    'qwen_tts.tokenizer',
    # sumy: LexRank extractive summarization (all imports in DocumentUtility are function-level)
    'sumy.summarizers.lex_rank',
    'sumy.summarizers.luhn',
    'sumy.nlp.tokenizers',
    'sumy.nlp.stemmers',
    'sumy.parsers.plaintext',
    'sumy.utils',
    # Transformers auto-class modules (lazy-loaded via __getattr__, invisible to PyInstaller)
    # Required by Docling for AutoProcessor, AutoModelForImageTextToText, AutoModelForVision2Seq
    'transformers.models.auto.processing_auto',
    'transformers.models.auto.modeling_auto',
    'transformers.models.auto.image_processing_auto',
    'transformers.models.auto.tokenization_auto',
    'transformers.models.auto.configuration_auto',
    'transformers.models.auto.auto_factory',
    # Aether Inference: manager/control/platform compiled INTO binary (backend imports these).
    # server.py is NOT imported — it runs standalone in venv-inference.
    'services.aether_inference',
    'services.aether_inference.manager',
    'services.aether_inference.inference_control',
    'services.aether_inference.platform_detector',
]
collected_hiddenimports.extend(additional_hidden_imports)

# Apple Silicon only: MLX TTS engine (mlx/mlx-audio are macOS arm64 only)
import platform as _platform
if IS_MACOS and _platform.machine() == 'arm64':
    collected_hiddenimports.extend([
        'RealtimeTTS.engines.qwen3_mlx_engine',
        'mlx_audio',
        'mlx_audio.tts',
        'mlx_audio.tts.utils',
        'mlx_audio.tts.generate',
        'mlx_audio.tts.models',
    ])

# De-duplicate hidden imports
collected_hiddenimports = list(set(collected_hiddenimports))

# --- ROBUST UV INCLUSION FOR MCP MARKETPLACE ---
# We must manually extract the uv binary path because collect_all('uv')
# only grabs the python package, not the compiled rust binary in bin/.
try:
    import uv as _uv
    from pathlib import Path as _Path
    _uv_bin_path = _uv.find_uv_bin()
    if _uv_bin_path and _Path(_uv_bin_path).exists():
        print(f"✅ Found uv binary for bundling: {_uv_bin_path}")
        # Place the binary in the root directory ('.') or 'bin' to avoid conflict 
        # with the 'uv' directory created by the python package
        collected_binaries.append((str(_uv_bin_path), 'bin'))
        
        # Also try to grab the adjacent `uvx` binary
        _uvx_bin_path = _Path(_uv_bin_path).parent / 'uvx'
        if not _uvx_bin_path.exists():
            _uvx_bin_path = _Path(_uv_bin_path).parent / 'uvx.exe'
            
        if _uvx_bin_path.exists():
            print(f"✅ Found uvx binary for bundling: {_uvx_bin_path}")
            collected_binaries.append((str(_uvx_bin_path), 'bin'))
except Exception as e:
    print(f"⚠️  Could not find uv binary to bundle: {e}")


# Data files to include
# BUNDLING STRATEGY:
# - Core Aether services (agents, file_indexing, embeddings, daemons, proactive)
# - ML/Document processing (docling, aether_rag - via collect_all)
# - Excel automation (xlwings)
# - AI research (perplexica - our modified fork, built in Docker during onboarding)
# - External services mesh (docker-compose.yml + volume configs)
# DOWNLOADED DURING ONBOARDING (AGPL/external, NOT bundled):
#   - Supabase Docker images (pre-built, pulled on first run)
#   - SearXNG Docker image (pre-built, pulled on first run)
#   - Open Interpreter venv (venv-oi, created during setup_engine.py)
datas = [
    ('core/profiles', 'core/profiles'),
    ('core/profiles/templates', 'core/profiles/templates'),
    ('skills', 'skills'),
    ('scripts', 'scripts'),
    ('data/database/migrations', 'data/database/migrations'),
    ('workers', 'workers'),
    ('application', 'application'),
    # Core Aether services
    ('services/agents/prompts', 'services/agents/prompts'),
    ('services/agents', 'services/agents'),
    # NOTE: services/embeddings REMOVED — embedding runs inside Perplexica Docker (ONNX)
    # Proactive daemons (browser, email, filesystem, query_generation, file_indexing)
    # These are critical for production - started by app.py lifespan via daemon_control
    ('services/daemons', 'services/daemons'),
    # Proactive service logic (includes default_prompt.json data file)
    ('services/proactive', 'services/proactive'),
    # External mesh definitions and volumes (docker-compose.yml, SearXNG config, Kong config, etc.)
    ('services/external-services', 'services/external-services'),
    # Modified Perplexica fork (source bundled; Docker image built during onboarding)
    ('services/perplexica', 'services/perplexica'),
    # Aether Inference: server.py runs as standalone process in venv-inference (like Perplexica).
    # NOT bundled here — manager/platform/inference_control are hidden imports (compiled in binary).
    # server.py + requirements live in the repo alongside the binary, found via AETHER_BACKEND_ROOT.
    # This avoids PYTHONPATH pollution from _internal/ conflicting with venv-inference deps.
] + collected_datas

# --- CRITICAL DATA FILES MISSED BY collect_all ---
# litellm: model_prices_and_context_window_backup.json is needed for
# litellm.supports_vision() model capability detection.  litellm is imported
# but not in collect_all (too heavy), so we include just the JSON data files.
import litellm as _litellm
_litellm_dir = Path(_litellm.__file__).parent
for _json in ('model_prices_and_context_window_backup.json', 'cost.json'):
    _json_path = _litellm_dir / _json
    if _json_path.exists():
        datas.append((str(_json_path), 'litellm'))
        print(f"✅ Including litellm data: {_json}")

# litellm tokenizer data files (anthropic_tokenizer.json, BPE merge tables).
# Without these, litellm token counting falls back to rough estimates and logs
# "[Errno 2] No such file or directory: .../tokenizers/anthropic_tokenizer.json".
_tokenizers_dir = _litellm_dir / 'litellm_core_utils' / 'tokenizers'
if _tokenizers_dir.is_dir():
    for _tf in _tokenizers_dir.iterdir():
        if _tf.is_file() and _tf.name != '__init__.py':
            datas.append((str(_tf), 'litellm/litellm_core_utils/tokenizers'))
            print(f"✅ Including litellm tokenizer: {_tf.name}")

# NLTK punkt sentence tokenizer data: required by DocumentUtility (LexRank via sumy)
# and any NLTK-based sentence tokenization.  collect_all('nltk') bundles the Python
# package but NOT the corpus/tokenizer data (stored in ~/nltk_data/ by default).
# main.py line 71-81 sets NLTK_DATA -> _internal/nltk_data/ at startup.
# Without bundling, first DocumentUtility call triggers an SSL download that fails
# in sandboxed production environments.
import nltk as _nltk
_nltk_data_candidates = [
    Path.home() / 'nltk_data',
    Path('/usr/share/nltk_data'),
    Path('/usr/local/share/nltk_data'),
]
for _nd in _nltk_data_candidates:
    _punkt_tab = _nd / 'tokenizers' / 'punkt_tab'
    _punkt_legacy = _nd / 'tokenizers' / 'punkt'
    if _punkt_tab.is_dir():
        datas.append((str(_punkt_tab), 'nltk_data/tokenizers/punkt_tab'))
        print(f"✅ Including NLTK punkt_tab data: {_punkt_tab}")
        break
    elif _punkt_legacy.is_dir():
        datas.append((str(_punkt_legacy), 'nltk_data/tokenizers/punkt'))
        print(f"✅ Including NLTK punkt data (legacy): {_punkt_legacy}")
        break
else:
    raise RuntimeError(
        "NLTK punkt data not found. Run build.sh (which pre-downloads punkt_tab) "
        "or install NLTK data before invoking PyInstaller directly."
    )

# pyjnius: NativeInvocationHandler.class is a Java class file loaded by the JVM at
# runtime.  collect_all only collects the Python .so, NOT the src/ directory with
# .class files.  Without this, PyTerrier init fails with:
#   java.lang.NoClassDefFoundError: org/jnius/NativeInvocationHandler
import jnius as _jnius
_jnius_src = Path(_jnius.__file__).parent / 'src'
if _jnius_src.exists():
    datas.append((str(_jnius_src), 'jnius/src'))
    print(f"✅ Including jnius Java classes: {_jnius_src}")

# Add static config files recursively (no local.env or secrets)
# Uses rglob to capture config/environments/*.yaml and nested configs
config_dir = backend_root / 'config'
for pattern in ['*.toml', '*.yaml', '*.json', '*.example']:
    for file_path in config_dir.rglob(pattern):
        if file_path.name in ('local.env',) or '.env' in file_path.name:
            continue  # Explicitly exclude secrets
        # Preserve directory structure relative to backend root
        rel_dir = str(file_path.parent.relative_to(backend_root))
        datas.append((str(file_path), rel_dir))
        print(f"✅ Including config: {file_path.relative_to(backend_root)}")

# Conditionally add service directories that should be bundled
# Only include permissive-licensed services (MIT/BSD/Apache)
# NOTE: Perplexica is shipped ALONGSIDE binary in dist/, NOT bundled inside it
service_includes = [
    ('services/xlwings/xlwings', 'xlwings'),
    # Note: main 'services' directory is now included in 'datas' for absolute imports
]

for src, dst in service_includes:
    src_path = backend_root / src
    if src_path.exists():
        # Check if already included by collect_all to avoid duplicates
        # We check the destination directory name in the datas list
        is_already_included = any(dst == d[1] or d[1].startswith(dst + "/") for d in datas)
        if not is_already_included:
            datas.append((src, dst))
            print(f"✅ Including: {src} -> {dst}")
        else:
            print(f"ℹ️ Skipping (already included): {src}")
    else:
        print(f"⚠️  Skipping (not found): {src}")

# Hidden imports required for FastAPI/Uvicorn
hiddenimports = [
    # Uvicorn core
    'uvicorn.logging',
    'uvicorn.loops',
    'uvicorn.loops.auto',
    'uvicorn.protocols',
    'uvicorn.protocols.http',
    'uvicorn.protocols.http.auto',
    'uvicorn.protocols.websockets',
    'uvicorn.protocols.websockets.auto',
    'uvicorn.lifespan',
    'uvicorn.lifespan.on',
    
    # FastAPI and dependencies
    'fastapi',
    'fastapi.routing',
    'starlette',
    'starlette.routing',
    'starlette.middleware',
    'starlette.middleware.cors',
    
    # Pydantic
    'pydantic',
    'pydantic.fields',
    'pydantic_settings',
    
    # Database
    'supabase',
    'postgrest',
    'realtime',
    'storage3',
    'gotrue',
    
    # WebSockets
    'websockets',
    'websockets.legacy',
    'websockets.legacy.server',
    
    # Python standard library modules sometimes missed
    'email.mime.text',
    'email.mime.multipart',
    'email.mime.base',
    
    # Audio processing (if enabled)
    'pyannote',
    'pyannote.audio',
    'torch',
    'torchaudio',
    'torch.multiprocessing',
    'torch.export',
    'torch.jit',
    
    # Transformers (needed by Docling — sentence_transformers removed, runs in Perplexica Docker)
    'transformers',
    
    # BM25 search (PyTerrier - pure Python)
    'pyterrier',
    'pyterrier.index',
    'pyterrier.io',
    'pyterrier.terrier',
    
    # HTTP clients
    'httpx',
    'httpcore',
    
    # YAML/TOML parsing
    'yaml',
    'toml',
    
    # WebSocket and Audio Layer
    'ws',
    'ws.presentation',
    'ws.application',
    'ws.domain',
    'ws.infrastructure',
    
    # --- DYNAMIC IMPORTS (not traced by PyInstaller bytecode analysis) ---
    # These are loaded via importlib.import_module() or string-based references
    'data.cache.redis',               # app.py: import_module("data.cache.redis")
    
    # --- LAZY IMPORTS IN app.py LIFESPAN (safety net) ---
    # PyInstaller usually traces function-level imports, but these are critical
    # enough to list explicitly as insurance against trace failures
    'core.config.key_sync',
    'core.runtime.engine',
    'core.integrations.providers.supabase_docker',
    'core.integrations.providers.aether_rag.mcp_client',
    'core.integrations.libraries.tts',
    'core.integrations.framework',
    'core.mcp.manager',
    'core.mcp.database',
    'data.database.clients.supabase',
    'data.database.migration_runner',
    'data.database.repositories.files',
    'data.database.repositories.mcp',
    'data.database.uow',
    'data.database.persistence_gateway',
    'application.chat',
    'application.chat.memory_service',
    'application.agents.agent_seeder',
    'application.settings.runtime_settings_service',
    'services.daemons.daemon_control',
    'services.daemons.daemon_manager',
    'services.daemons.file_indexing.daemon',
    'services.daemons.file_indexing.mcp_server',
    'services.daemons.file_indexing.async_reindex',
    'services.daemons.browser.daemon',
    'services.daemons.email.daemon',
    'services.daemons.filesystem.daemon',
    'services.daemons.query_generation.daemon',
    'workers.scheduler',
    'workers.handlers.proactive_agent_handler',
    
    # --- LAZY IMPORTS FROM NEW REFACTORING (application/data/core) ---
    'application.services.source_indexing_service',
    'application.indexing.index_service',
    'application.notebook.notebook_service',
    'application.tools.tool_service',
    'application.research.research_service',
    'data.database.repositories.chat',
    'data.database.repositories.daemon_logs',
    'application.search.orchestrator',
    'application.search.providers.web_search_provider',
    'application.search.providers.unified_search_provider',
    'application.search.providers.perplexica_providers',
    'application.search.providers.local_providers',
    'application.search.providers.legal_search_provider',
    'core.system.process_gateway',
    'application.setup.setup_service',
    'data.database.repositories.setup_state_repository',
    'application.files.file_service',
    'application.skills.skill_service',
    'data.infrastructure.file_storage_gateway',
    'application.daemons.daemon_service',
    'data.database.repositories.proactive_agent',
    'application.agents.proactive_service',
    'application.agents.proactive_config_service',
    'data.database.repositories.configuration_repository',
    'data.database.repositories.storage',
    'data.database.repositories.trail',
    'application.storage.storage_service',
    'data.database.repositories.preferences',
    'application.settings.preferences_service',
    'core.integrations.libraries.omni.tools',
    'data.infrastructure.registry_gateway',
    'data.database.repositories.profile_repository',
    'data.network.http_client',

    # --- LAZY IMPORTS IN main.py ENTRYPOINTS (function-level, not auto-traced) ---
    'core.runtime.workers.job_worker_watchdog',
    
    # --- RUNTIME-ONLY DEPENDENCIES (only lazy-imported, never top-level) ---
    # psutil: used in manager.py, daemon_control.py, workers.py, mcp/sandbox.py, main.py
    # for process management and memory monitoring.  All imports are function-level.
    'psutil',
    # watchfiles: used in job_worker_watchdog.py for hot-reload file watching.
    # Only imported inside the watchdog module which itself is lazy-imported from main.py.
    'watchfiles',
    
    # Additional critical dependencies
    'pkg_resources',
    'setuptools',
    'importlib_metadata',
    'lightning_fabric',
    'lightning',
    'pytorch_lightning',
    'onnxruntime',
    'sounddevice',
    'soundfile',
    'librosa',
    'pydub',
] + collected_hiddenimports

# Modules to explicitly exclude (large, not needed, or externally managed)
excludes = [
    # Development tools
    'pytest',
    'pytest_asyncio',
    'black',
    'ruff',
    'mypy',
    'sphinx',
    'jupyter',
    'ipython',
    'notebook',
    
    # Visualization (keep matplotlib for audio processing)
    'plotly',
    'bokeh',
    'seaborn',
    
    # Test directories
    'tests',
    'test',
    'aether_rag.tests',
    'aether_rag_core.tests',
]

a = Analysis(
    ['main.py'],
    pathex=[
        str(backend_root),
        str(backend_root / "services" / "docling"),
        str(backend_root / "services" / "aether-rag" / "packages" / "aether-rag-core" / "src"),
        # Vendored RealtimeTTS fork: build.sh installs it via pip -e before
        # PyInstaller runs, but pathex ensures engine *.json data files and
        # any non-Python assets are discoverable during analysis.
        str(backend_root / "services" / "realtime-tts"),
    ],
    binaries=collected_binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

# --- POST-ANALYSIS: Strip secret files and test directories from bundled data ---
# PyInstaller expands directory entries in `datas` into individual files during
# Analysis.  Filter out .env files that may contain generated secrets (e.g.
# services/external-services/.env).  The production runtime generates its own
# secrets at first launch via start_production.sh; these files are never needed.
# We also filter out any test datasets or test scripts to avoid bloating the build.

def _should_exclude_data(name, path):
    name_str = str(name).replace('\\', '/')
    path_str = str(path).replace('\\', '/')
    
    # 1. Exclude secrets
    if name_str.endswith('.env') or name_str.endswith('.env.local') or '/.env' in name_str or name_str == '.env':
        return True
        
    # 2. Exclude tests in aether-rag and datasets
    if '/aether-rag/' in path_str and '/tests/' in path_str:
        return True
    if '/aether_rag/' in path_str and '/tests/' in path_str:
        return True
    if 'trec_covid' in path_str.lower() or 'beir' in path_str.lower():
        return True
        
    # 3. Exclude pytest cache or regular pycache (PyInstaller normally handles this, but just in case)
    if '__pycache__' in path_str or '.pytest_cache' in path_str:
        return True
        
    return False

_before_datas = len(a.datas)
a.datas = [
    (name, path, typecode) for name, path, typecode in a.datas
    if not _should_exclude_data(name, path)
]
_after_datas = len(a.datas)
if _before_datas != _after_datas:
    print(f"🔒 Stripped {_before_datas - _after_datas} secret/test/cache file(s) from bundle")

# Also filter pure Python modules for test scripts in aether-rag to prevent bloating PYZ
_before_pure = len(a.pure)
def _should_exclude_pure(name, path):
    path_str = str(path).replace('\\', '/')
    if '/tests/' in path_str:
        if '/aether-rag/' in path_str or '/aether_rag/' in path_str:
            return True
    return False

a.pure = [
    (name, path, typecode) for name, path, typecode in a.pure
    if not _should_exclude_pure(name, path)
]
_after_pure = len(a.pure)
if _before_pure != _after_pure:
    print(f"🧹 Stripped {_before_pure - _after_pure} test module(s) from bundle")

# --- POST-ANALYSIS: Fix OpenMP library for FAISS/HNSW compatibility ---
#
# WHY macOS IS THE PRIMARY TARGET:
#   aether_rag_backend_hnsw/CMakeLists.txt (line 21) explicitly compiles _swigfaiss.so
#   against Homebrew's libomp.dylib because Apple clang ships without OpenMP.
#   torch also bundles its own libomp.dylib (older, missing ___kmpc_dispatch_deinit).
#   At runtime, dyld resolves @rpath/libomp.dylib to torch's copy → ImportError.
#
# WHY LINUX IS SAFE BY DEFAULT:
#   On Linux, the CMakeLists.txt if(APPLE) block is skipped. CMake's FindOpenMP
#   finds GCC's libgomp.so.1 — a completely different library than torch's libomp.so.
#   No name collision → no conflict. Exception: Clang/LLVM-built Linux binaries
#   would link to libomp.so and COULD collide. The diagnostic below catches that.
#
# WHY WINDOWS IS SAFE:
#   MSVC OpenMP uses vcomp140.dll. Different library name, different ABI, no conflict.

import subprocess

def _check_openmp_symbol(lib_path, symbol='___kmpc_dispatch_deinit'):
    """Check if an OpenMP library exports the required FAISS symbol."""
    try:
        if IS_MACOS:
            out = subprocess.check_output(['nm', '-gU', str(lib_path)], text=True)
        else:
            out = subprocess.check_output(['nm', '-D', str(lib_path)], text=True, stderr=subprocess.DEVNULL)
        return symbol in out
    except Exception:
        return False

if IS_MACOS:
    _system_libomp = None
    _brew_candidates = [
        Path('/opt/homebrew/opt/libomp/lib/libomp.dylib'),
        Path('/opt/homebrew/lib/libomp.dylib'),
        Path('/usr/local/opt/libomp/lib/libomp.dylib'),
        Path('/usr/local/lib/libomp.dylib'),
    ]
    for _candidate in _brew_candidates:
        if _candidate.exists():
            _system_libomp = _candidate
            break

    if _system_libomp and _check_openmp_symbol(_system_libomp):
        _replaced = 0
        _new_binaries = []
        for name, path, typecode in a.binaries:
            if name.endswith('libomp.dylib'):
                _new_binaries.append((name, str(_system_libomp), typecode))
                _replaced += 1
            else:
                _new_binaries.append((name, path, typecode))
        a.binaries = _new_binaries
        print(f"🔧 Replaced {_replaced} libomp.dylib instance(s) with Homebrew {_system_libomp} (FAISS compat)")
    elif _system_libomp:
        print(f"⚠️  Homebrew libomp at {_system_libomp} missing ___kmpc_dispatch_deinit — FAISS may fail")
    else:
        print("⚠️  Homebrew libomp not found. Install: brew install libomp")
        print("    FAISS/HNSW index building will fail in production.")

elif not IS_WINDOWS:
    # Linux: only an issue if _swigfaiss links to libomp.so (Clang build) instead of libgomp.so (GCC).
    # Detect and warn — do NOT auto-patch, as the GCC/libgomp case is the normal one.
    _has_libomp_conflict = False
    _bundled_libomps = [(n, p) for n, p, _ in a.binaries if 'libomp.so' in n]
    _has_swigfaiss = any('_swigfaiss' in n for n, _, _ in a.binaries)

    if _has_swigfaiss and _bundled_libomps:
        for _name, _path in _bundled_libomps:
            if not _check_openmp_symbol(_path):
                _has_libomp_conflict = True
                break

        if _has_libomp_conflict:
            _sys_candidates = [
                Path('/usr/lib/x86_64-linux-gnu/libomp.so'),
                Path('/usr/lib/aarch64-linux-gnu/libomp.so'),
                Path('/usr/lib/libomp.so'),
                Path('/usr/lib/llvm-17/lib/libomp.so'),
                Path('/usr/lib/llvm-16/lib/libomp.so'),
                Path('/usr/lib/llvm-15/lib/libomp.so'),
            ]
            _sys_libomp = None
            for _c in _sys_candidates:
                if _c.exists() and _check_openmp_symbol(_c):
                    _sys_libomp = _c
                    break

            if _sys_libomp:
                _replaced = 0
                _new_binaries = []
                for name, path, typecode in a.binaries:
                    if 'libomp.so' in name:
                        _new_binaries.append((name, str(_sys_libomp), typecode))
                        _replaced += 1
                    else:
                        _new_binaries.append((name, path, typecode))
                a.binaries = _new_binaries
                print(f"🔧 Linux: replaced {_replaced} libomp.so with system {_sys_libomp} (FAISS compat)")
            else:
                print("⚠️  Linux: bundled libomp.so missing FAISS symbols and no system replacement found.")
                print("    If FAISS index building fails, install: apt install libomp-dev")
        else:
            print("✅ Linux: bundled libomp.so has required FAISS symbols")
    elif _has_swigfaiss:
        print("✅ Linux: _swigfaiss found, no libomp.so bundled (likely using system libgomp — safe)")

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='aether-hub' if not IS_WINDOWS else 'aether-hub.exe',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,  # DISABLED: UPX corrupts native libraries (llvmlite, torch, etc.)
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,  # PRODUCTION: no console window behind GUI app
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='aether-hub'
)

print("\n" + "="*60)
print("PyInstaller Configuration Complete (ONEDIR Mode)")
print("="*60)
print(f"Platform: {'Windows' if IS_WINDOWS else 'macOS' if IS_MACOS else 'Linux'}")
print(f"Output: dist/aether-hub/")
print(f"Data files: {len(datas)} directories")
print(f"Hidden imports: {len(hiddenimports)} modules")
print(f"Excluded: {len(excludes)} modules")
print("="*60 + "\n")
