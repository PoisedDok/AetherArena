#!/bin/bash

# @.architecture
# Incoming: CLI invocation --- {bash}
# Processing: build_backend(), build_frontend(), package_app() --- {3 jobs: JOB_BUILD_BACKEND, JOB_BUILD_FRONTEND, JOB_PACKAGE}
# Outgoing: Distribution artifacts --- {DMG/NSIS/AppImage}

# AetherArena - Unified Build Script
# Builds backend (PyInstaller) + frontend (esbuild + electron-builder) into distributable app
#
# Prerequisites:
#   - Python 3.11+ with pip (backend)
#   - Node.js 18+ with npm (frontend)
#   - PyInstaller installed: pip install pyinstaller
#   - Docker Desktop (for testing; not required for build)
#
# Usage:
#   ./build.sh              # Build for current platform
#   ./build.sh --mac        # macOS DMG
#   ./build.sh --win        # Windows NSIS installer
#   ./build.sh --linux      # Linux AppImage + deb
#   ./build.sh --backend    # Backend only (PyInstaller)
#   ./build.sh --frontend   # Frontend only (electron-builder)
#   ./build.sh --skip-backend  # Skip backend build (use existing dist/)
#   ./build.sh --clean      # Clean all build artifacts first

set -euo pipefail

# ============================================================================
# CONSTANTS
# ============================================================================

readonly SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
readonly BACKEND_DIR="$SCRIPT_DIR/aether-backend"
readonly FRONTEND_DIR="$SCRIPT_DIR/aether-frontend"
readonly BACKEND_DIST="$BACKEND_DIR/dist"

# Color codes
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly CYAN='\033[0;36m'
readonly NC='\033[0m'

# Parse arguments
BUILD_BACKEND=true
BUILD_FRONTEND=true
PLATFORM_FLAG=""
CLEAN_FIRST=false

for arg in "$@"; do
    case "$arg" in
        --backend)    BUILD_FRONTEND=false ;;
        --frontend)   BUILD_BACKEND=false ;;
        --skip-backend) BUILD_BACKEND=false ;;
        --mac)        PLATFORM_FLAG="--mac" ;;
        --win)        PLATFORM_FLAG="--win" ;;
        --linux)      PLATFORM_FLAG="--linux" ;;
        --clean)      CLEAN_FIRST=true ;;
        --help|-h)
            echo "Usage: $0 [--backend|--frontend|--skip-backend] [--mac|--win|--linux] [--clean]"
            exit 0
            ;;
    esac
done

# ============================================================================
# LOGGING
# ============================================================================

log_info()    { echo -e "${CYAN}[BUILD]${NC} $*"; }
log_success() { echo -e "${GREEN}[BUILD]${NC} $*"; }
log_warn()    { echo -e "${YELLOW}[BUILD]${NC} $*"; }
log_error()   { echo -e "${RED}[BUILD]${NC} $*" >&2; }
log_section() {
    echo ""
    echo -e "${BLUE}================================================================${NC}"
    echo -e "${BLUE} $*${NC}"
    echo -e "${BLUE}================================================================${NC}"
}

# ============================================================================
# PREREQUISITES CHECK
# ============================================================================

check_prerequisites() {
    log_section "STEP 0: Prerequisites Check"
    
    local errors=0
    
    if [ "$BUILD_BACKEND" = true ]; then
        # Python
        if ! command -v python3 &>/dev/null; then
            log_error "Python 3 not installed"
            errors=$((errors + 1))
        else
            log_success "Python: $(python3 --version)"
        fi
        
        # PyInstaller
        if ! python3 -m PyInstaller --version &>/dev/null; then
            log_error "PyInstaller not installed. Run: pip install pyinstaller"
            errors=$((errors + 1))
        else
            log_success "PyInstaller: $(python3 -m PyInstaller --version 2>/dev/null)"
        fi
    fi
    
    if [ "$BUILD_FRONTEND" = true ]; then
        # Node.js
        if ! command -v node &>/dev/null; then
            log_error "Node.js not installed"
            errors=$((errors + 1))
        else
            log_success "Node.js: $(node --version)"
        fi
        
        # npm
        if ! command -v npm &>/dev/null; then
            log_error "npm not installed"
            errors=$((errors + 1))
        else
            log_success "npm: $(npm --version)"
        fi
    fi
    
    if [ $errors -gt 0 ]; then
        log_error "$errors prerequisite(s) missing. Fix and retry."
        exit 1
    fi
    
    log_success "All prerequisites satisfied"
}

# ============================================================================
# CLEAN
# ============================================================================

clean_artifacts() {
    log_section "Cleaning Build Artifacts"
    
    if [ -d "$BACKEND_DIST" ]; then
        log_info "Removing backend dist/..."
        rm -rf "$BACKEND_DIST"
    fi
    
    if [ -d "$BACKEND_DIR/build" ]; then
        log_info "Removing backend build/..."
        rm -rf "$BACKEND_DIR/build"
    fi
    
    if [ -d "$FRONTEND_DIR/dist" ]; then
        log_info "Removing frontend dist/..."
        rm -rf "$FRONTEND_DIR/dist"
    fi
    
    if [ -d "$FRONTEND_DIR/build" ]; then
        log_info "Removing frontend build/..."
        rm -rf "$FRONTEND_DIR/build"
    fi
    
    log_success "Clean complete"
}

# ============================================================================
# BACKEND BUILD (PyInstaller)
# ============================================================================

build_backend() {
    log_section "STEP 1: Building Backend (PyInstaller ONEDIR)"
    
    cd "$BACKEND_DIR"
    
    # Verify entry point exists
    if [ ! -f "main.py" ]; then
        log_error "Backend entry point main.py not found in $BACKEND_DIR"
        exit 1
    fi
    
    # Verify spec file exists
    if [ ! -f "build-config.spec" ]; then
        log_error "PyInstaller spec file not found: build-config.spec"
        exit 1
    fi
    
    # ── Pre-build: Ensure vendored RealtimeTTS fork + qwen-tts are installed ──
    # The vendored fork at services/realtime-tts/ contains custom engines
    # (Qwen3Engine, Qwen3MLXEngine) that do NOT exist in the upstream pip
    # package.  Non-editable install COPIES files into site-packages so
    # PyInstaller's collect_all('RealtimeTTS') picks up our custom engines
    # independently of the source tree layout at analysis time.
    # --no-deps: all transitive deps are already in requirements.txt.
    log_info "Installing vendored RealtimeTTS fork (Qwen3 engines)..."
    python3 -m pip install services/realtime-tts/ --no-deps --quiet 2>&1 || {
        log_error "Failed to install vendored RealtimeTTS fork"
        exit 1
    }
    
    # qwen-tts: PyTorch model loader used by Qwen3Engine.synthesize().
    # Declared in requirements.txt but must be present for PyInstaller to
    # trace the import and bundle the package into the binary.
    # --no-deps: all transitive deps (torch, transformers, soundfile, etc.)
    # are already satisfied by requirements.txt.  Without --no-deps,
    # qwen-tts pulls in gradio → gradio-client which caps websockets<13,
    # downgrading the websockets>=15 required by supabase's realtime SDK.
    log_info "Ensuring qwen-tts is installed..."
    python3 -m pip install "qwen-tts>=0.1.0" --no-deps --quiet 2>&1 || {
        log_error "Failed to install qwen-tts"
        exit 1
    }
    
    # aether-rag-core: vendored at services/aether-rag/packages/aether-rag-core/.
    # Non-editable install copies into site-packages so PyInstaller's
    # collect_all('aether_rag') resolves all submodules (chunking_utils, etc.).
    # --no-deps: all transitive deps (llama-index-core, numpy, etc.)
    # are already satisfied by requirements.txt.
    log_info "Installing vendored aether-rag-core (chunking + index API)..."
    python3 -m pip install services/aether-rag/packages/aether-rag-core/ --no-deps --quiet 2>&1 || {
        log_error "Failed to install vendored aether-rag-core"
        exit 1
    }
    
    # llama-index-core + readers: transitive deps of aether-rag-core's chunking_utils
    # (SentenceSplitter) and file_indexing processor (SimpleDirectoryReader).
    # aether-rag-core is installed with --no-deps above, so these MUST be installed
    # explicitly.  Without them, collect_all('llama_index') returns empty and
    # the file indexing daemon fails at runtime with ModuleNotFoundError.
    log_info "Ensuring llama-index-core + readers for file indexing..."
    python3 -m pip install "llama-index-core>=0.12.0" "llama-index-readers-file>=0.4.0" --quiet 2>&1 || {
        log_error "Failed to install llama-index-core / llama-index-readers-file"
        exit 1
    }
    
    # ── Pre-build: Verify critical dependency constraints ──
    # Catches silent downgrades from transitive dependency resolution
    # BEFORE PyInstaller bundles the wrong versions into the binary.
    log_info "Verifying critical dependency versions..."
    local dep_errors=0
    
    # websockets>=13.0 required for supabase realtime SDK (websockets.asyncio module)
    if ! python3 -c "from websockets.asyncio.client import ClientConnection" 2>/dev/null; then
        log_error "DEPENDENCY CONFLICT: websockets.asyncio missing (need websockets>=13.0)"
        log_error "  Current: $(python3 -c 'import websockets; print(websockets.__version__)' 2>/dev/null || echo 'not installed')"
        log_error "  Fix: pip install 'websockets>=15.0' (as specified in requirements.txt)"
        dep_errors=$((dep_errors + 1))
    fi
    
    # supabase SDK must import cleanly (depends on websockets.asyncio via realtime)
    if ! python3 -c "from supabase import Client, create_client" 2>/dev/null; then
        log_error "DEPENDENCY CONFLICT: supabase SDK import failed"
        log_error "  This usually means a transitive dep downgraded websockets"
        dep_errors=$((dep_errors + 1))
    fi
    
    # llama-index-core required for file indexing daemon (SimpleDirectoryReader + SentenceSplitter)
    if ! python3 -c "from llama_index.core import SimpleDirectoryReader; from llama_index.core.node_parser import SentenceSplitter" 2>/dev/null; then
        log_error "DEPENDENCY MISSING: llama-index-core not importable"
        log_error "  File indexing daemon will fail at runtime without this package"
        log_error "  Fix: pip install 'llama-index-core>=0.12.0' 'llama-index-readers-file>=0.4.0'"
        dep_errors=$((dep_errors + 1))
    fi
    
    if [ $dep_errors -gt 0 ]; then
        log_error "$dep_errors critical dependency conflict(s) detected. Aborting build."
        log_error "Run: pip install -r requirements.txt --force-reinstall --no-deps"
        exit 1
    fi
    log_success "All critical dependency constraints verified"
    
    # ── Pre-build: Ensure NLTK punkt tokenizer data is available for bundling ──
    # DocumentUtility uses NLTK sentence tokenization (via sumy LexRank).
    # build-config.spec bundles ~/nltk_data/tokenizers/punkt_tab/ into the binary.
    # Download now so the spec can find it.
    log_info "Ensuring NLTK punkt tokenizer data is available..."
    python3 -c "
import nltk
for res in ('punkt_tab', 'punkt'):
    try:
        nltk.data.find(f'tokenizers/{res}')
        print(f'  punkt data found: {res}')
        break
    except LookupError:
        pass
else:
    try:
        nltk.download('punkt_tab', quiet=True)
        nltk.data.find('tokenizers/punkt_tab')
        print('  Downloaded punkt_tab')
    except Exception:
        nltk.download('punkt', quiet=True)
        nltk.data.find('tokenizers/punkt')
        print('  Downloaded punkt (legacy)')
" 2>&1 || log_warn "NLTK punkt download failed (build-config.spec will fail fast if data is missing)"
    
    log_info "Running PyInstaller..."
    log_info "Spec: build-config.spec"
    log_info "Output: dist/aether-hub/"
    
    # Build with PyInstaller
    python3 -m PyInstaller build-config.spec --noconfirm 2>&1 | tail -20
    
    # Verify output
    if [ ! -d "$BACKEND_DIST/aether-hub" ]; then
        log_error "PyInstaller output not found at $BACKEND_DIST/aether-hub"
        exit 1
    fi
    
    local binary="$BACKEND_DIST/aether-hub/aether-hub"
    if [ ! -f "$binary" ]; then
        log_error "Backend binary not found: $binary"
        exit 1
    fi
    
    # Make binary executable
    chmod +x "$binary"
    
    log_success "Backend binary built: $binary"
    log_info "Binary size: $(du -sh "$binary" | cut -f1)"
    log_info "Total dist size: $(du -sh "$BACKEND_DIST/aether-hub" | cut -f1)"
    
    # Run post-build script to copy external services alongside binary
    if [ -f "scripts/post_build.sh" ]; then
        log_info "Running post-build script..."
        bash scripts/post_build.sh
    fi
    
    # Post-build: verify OpenMP library has FAISS-required symbols.
    #
    # macOS (primary): _swigfaiss.so is compiled against Homebrew libomp (CMakeLists.txt
    #   line 21). torch bundles an older libomp.dylib missing ___kmpc_dispatch_deinit.
    #   dyld resolves @rpath/libomp.dylib to torch's copy → ImportError. Fix: replace.
    #
    # Linux (safety net): default GCC build links to libgomp.so.1 (no conflict).
    #   Clang/LLVM builds link to libomp.so and CAN conflict with torch's bundled copy.
    #   Detect and patch only when actual conflict is found.
    #
    # Windows: MSVC vcomp140.dll is a different library entirely. No conflict possible.
    local _faiss_symbol="___kmpc_dispatch_deinit"

    if [[ "$(uname)" == "Darwin" ]]; then
        local libomp_bundle
        libomp_bundle=$(find "$BACKEND_DIST/aether-hub/_internal" -name "libomp.dylib" -path "*/torch/lib/*" 2>/dev/null | head -1)
        if [ -n "$libomp_bundle" ]; then
            if nm -gU "$libomp_bundle" 2>/dev/null | grep -q "$_faiss_symbol"; then
                log_success "libomp.dylib has $_faiss_symbol (FAISS/HNSW compatible)"
            else
                log_warn "Bundled libomp.dylib missing $_faiss_symbol — patching with Homebrew version"
                local brew_libomp=""
                for candidate in /opt/homebrew/opt/libomp/lib/libomp.dylib /usr/local/opt/libomp/lib/libomp.dylib; do
                    if [ -f "$candidate" ] && nm -gU "$candidate" 2>/dev/null | grep -q "$_faiss_symbol"; then
                        brew_libomp="$candidate"
                        break
                    fi
                done
                if [ -n "$brew_libomp" ]; then
                    cp "$brew_libomp" "$libomp_bundle"
                    log_success "Patched libomp.dylib with $brew_libomp (FAISS compat fix)"
                else
                    log_error "No compatible libomp.dylib found. Install: brew install libomp"
                    log_error "FAISS/HNSW index building will fail in production."
                fi
            fi
        fi
    elif [[ "$(uname)" == "Linux" ]]; then
        local libomp_bundle
        libomp_bundle=$(find "$BACKEND_DIST/aether-hub/_internal" -name "libomp.so*" -path "*/torch/lib/*" 2>/dev/null | head -1)
        if [ -n "$libomp_bundle" ]; then
            if nm -D "$libomp_bundle" 2>/dev/null | grep -q "$_faiss_symbol"; then
                log_success "Linux: libomp.so has $_faiss_symbol (FAISS/HNSW compatible)"
            else
                log_warn "Linux: bundled libomp.so missing $_faiss_symbol — searching for system replacement"
                local sys_libomp=""
                for candidate in \
                    /usr/lib/x86_64-linux-gnu/libomp.so \
                    /usr/lib/aarch64-linux-gnu/libomp.so \
                    /usr/lib/libomp.so \
                    /usr/lib/llvm-17/lib/libomp.so \
                    /usr/lib/llvm-16/lib/libomp.so \
                    /usr/lib/llvm-15/lib/libomp.so; do
                    if [ -f "$candidate" ] && nm -D "$candidate" 2>/dev/null | grep -q "$_faiss_symbol"; then
                        sys_libomp="$candidate"
                        break
                    fi
                done
                if [ -n "$sys_libomp" ]; then
                    cp "$sys_libomp" "$libomp_bundle"
                    log_success "Linux: patched libomp.so with $sys_libomp (FAISS compat fix)"
                else
                    log_error "Linux: no compatible libomp.so found. Install: apt install libomp-dev"
                    log_error "FAISS/HNSW index building may fail in production."
                fi
            fi
        else
            log_info "Linux: no torch libomp.so bundled (likely using system libgomp — safe for FAISS)"
        fi
    fi
    
    # Quick smoke test: check binary runs
    log_info "Smoke test: checking binary executes..."
    if timeout 5 "$binary" --help >/dev/null 2>&1 || [ $? -eq 2 ]; then
        # Exit code 2 is argparse error (expected with --help if not recognized)
        log_success "Backend binary executes successfully"
    else
        log_warn "Binary smoke test returned non-zero (may be expected for help flag)"
    fi
    
    cd "$SCRIPT_DIR"
}

# ============================================================================
# FRONTEND BUILD (esbuild + electron-builder)
# ============================================================================

build_frontend() {
    log_section "STEP 2: Building Frontend (esbuild + electron-builder)"
    
    cd "$FRONTEND_DIR"
    
    # Verify package.json exists
    if [ ! -f "package.json" ]; then
        log_error "Frontend package.json not found in $FRONTEND_DIR"
        exit 1
    fi
    
    # Verify node_modules
    if [ ! -d "node_modules" ]; then
        log_info "Installing dependencies..."
        npm install
    fi
    
    # Verify backend dist exists (required by electron-builder extraResources)
    if [ ! -d "$BACKEND_DIST/aether-hub" ]; then
        log_error "Backend dist not found at $BACKEND_DIST/aether-hub"
        log_error "Build backend first: ./build.sh --backend"
        exit 1
    fi
    
    # Step 2a: Bundle preload and renderer scripts (esbuild)
    log_info "Bundling preload scripts (esbuild)..."
    NODE_ENV=production npm run build:preload
    
    log_info "Bundling renderer scripts (esbuild)..."
    NODE_ENV=production npm run build:renderer
    
    # Verify build output
    if [ ! -d "build/preload" ] || [ ! -d "build/renderer" ]; then
        log_error "esbuild output missing in build/"
        exit 1
    fi
    log_success "Preload + renderer scripts bundled"
    
    # Step 2b: Package with electron-builder
    log_info "Packaging with electron-builder..."
    
    if [ -n "$PLATFORM_FLAG" ]; then
        log_info "Platform: $PLATFORM_FLAG"
        npx electron-builder $PLATFORM_FLAG --publish=never
    else
        log_info "Platform: current (auto-detect)"
        npx electron-builder --publish=never
    fi
    
    # Verify output
    if [ ! -d "dist" ]; then
        log_error "electron-builder output not found in dist/"
        exit 1
    fi
    
    log_success "Frontend packaged successfully"
    
    # Step 2c: macOS post-processing (ad-hoc sign + strip quarantine)
    # Without signing, macOS Gatekeeper blocks the app with a "verifying" spinner.
    # Ad-hoc signing (-) doesn't require a Developer ID but prevents the block.
    # For production distribution, replace "-" with a Developer ID certificate.
    if [[ "$OSTYPE" == "darwin"* ]]; then
        log_info "macOS: Stripping quarantine attributes and ad-hoc signing..."
        
        local app_path=""
        # Find .app bundle in dist/ (could be in mac-arm64/ or mac-x64/ subdirectory)
        app_path=$(find "$FRONTEND_DIR/dist" -maxdepth 2 -name "*.app" -type d | head -1)
        
        if [ -n "$app_path" ] && [ -d "$app_path" ]; then
            log_info "  App bundle: $app_path"
            
            # Strip quarantine attributes
            xattr -cr "$app_path" 2>/dev/null || log_warn "  Failed to strip quarantine (non-fatal)"
            
            # Ad-hoc code sign (deep signs all frameworks and helpers)
            if codesign --force --deep --sign - "$app_path" 2>&1; then
                log_success "  macOS app signed (ad-hoc)"
            else
                log_warn "  Ad-hoc signing failed (non-fatal, app may trigger Gatekeeper)"
            fi
        else
            log_warn "  No .app bundle found in dist/ for signing"
        fi
    fi
    
    # Show output
    log_info "Distribution artifacts:"
    ls -la dist/ 2>/dev/null | grep -v "^total" | head -20
    
    cd "$SCRIPT_DIR"
}

# ============================================================================
# SUMMARY
# ============================================================================

print_summary() {
    log_section "BUILD COMPLETE"
    
    if [ "$BUILD_BACKEND" = true ]; then
        log_success "Backend: $BACKEND_DIST/aether-hub/"
        log_info "  Binary: aether-hub/aether-hub"
        log_info "  Size: $(du -sh "$BACKEND_DIST/aether-hub" 2>/dev/null | cut -f1 || echo 'N/A')"
    fi
    
    if [ "$BUILD_FRONTEND" = true ]; then
        log_success "Frontend: $FRONTEND_DIR/dist/"
        
        # Show distributable files
        if [ -d "$FRONTEND_DIR/dist" ]; then
            local found_dist=false
            while IFS= read -r -d '' f; do
                found_dist=true
                log_info "  $(basename "$f"): $(du -sh "$f" | cut -f1)"
            done < <(find "$FRONTEND_DIR/dist" -maxdepth 1 \( -name "*.dmg" -o -name "*.exe" -o -name "*.AppImage" -o -name "*.deb" -o -name "*.zip" \) -print0 2>/dev/null)
            
            if [ "$found_dist" = false ]; then
                log_warn "  No distributable files found in dist/"
            fi
        fi
    fi
    
    echo ""
    log_info "Next steps:"
    if [ "$BUILD_FRONTEND" = true ]; then
        log_info "  1. Test the app: open dist/*.dmg (macOS) or run dist/*.AppImage (Linux)"
        log_info "  2. First run will auto-generate keys and pull Docker images"
        log_info "  3. Requires: Docker Desktop running, internet connection for first setup"
    fi
}

# ============================================================================
# MAIN
# ============================================================================

main() {
    log_section "AETHER DESKTOP - UNIFIED BUILD"
    log_info "Backend: $BUILD_BACKEND"
    log_info "Frontend: $BUILD_FRONTEND"
    log_info "Platform: ${PLATFORM_FLAG:-auto}"
    log_info "Clean: $CLEAN_FIRST"
    
    check_prerequisites
    
    if [ "$CLEAN_FIRST" = true ]; then
        clean_artifacts
    fi
    
    if [ "$BUILD_BACKEND" = true ]; then
        build_backend
    fi
    
    if [ "$BUILD_FRONTEND" = true ]; then
        build_frontend
    fi
    
    print_summary
}

main
