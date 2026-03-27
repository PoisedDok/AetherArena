// Incoming: main/index.js, core/config/index.js --- {function, none}
// Processing: Detect backend directory/script and manage child processes --- {3 jobs: JOB_INITIALIZE, JOB_ORCHESTRATE, JOB_START_SERVICE}
// Outgoing: Child process handles --- {object, none}

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { logger } = require('../../core/utils/logger');
const config = require('../../core/config');

// ============================================================================
// Constants
// ============================================================================

/**
 * Service binary names (without extension)
 */
const SERVICE_BINARIES = Object.freeze({
  integrated: 'aether-hub',
});

/**
 * Default backend script path (from centralized config)
 */
const DEFAULT_BACKEND_SCRIPT = config.backend.entryScript;

/**
 * Auto-detect backend directory relative to frontend
 * Try multiple possible locations
 */
function autoDetectBackendDir() {
  // Try relative paths from current directory
  const possiblePaths = [
    // From frontend root to backend
    path.join(process.cwd(), '..', 'aether-backend'),
    path.join(process.cwd(), 'backend'),
    path.join(process.cwd(), '..', 'backend'),
    // From AetherArena root
    path.join(process.cwd(), '..', '..', 'AetherArena', 'aether-backend'),
    // From Aether root (for old structure compatibility)
    path.join(process.cwd(), '..', '..'),
    path.join(process.cwd(), '..', '..', 'Aether'),
  ];
  
  for (const dir of possiblePaths) {
    try {
      const normalizedPath = path.resolve(dir);
      if (fs.existsSync(normalizedPath)) {
        // Check if it looks like a backend directory
        const hasMainPy = fs.existsSync(path.join(normalizedPath, 'main.py'));
        const hasAppPy = fs.existsSync(path.join(normalizedPath, 'app.py'));
        const hasScript = fs.existsSync(path.join(normalizedPath, DEFAULT_BACKEND_SCRIPT));
        
        if (hasMainPy || hasAppPy || hasScript) {
          return normalizedPath;
        }
      }
    } catch (err) {
      // Ignore and try next path
    }
  }
  
  return null;
}

/**
 * Default backend directory - resolved dynamically or from environment
 */
const DEFAULT_BACKEND_DIR = config.backend.backendDir || autoDetectBackendDir();

// ============================================================================
// ServiceLauncher Class
// ============================================================================

class ServiceLauncher {
  constructor(options = {}) {
    this.options = {
      backendDir: options.backendDir || DEFAULT_BACKEND_DIR,
      backendScript: options.backendScript || DEFAULT_BACKEND_SCRIPT,
      spawnInTerminal: options.spawnInTerminal !== false, // Default true
      ...options,
    };
    
    this.isPackaged = this._detectPackagedMode();
    this.platform = this._detectPlatform();
    this.projectRoot = this._getProjectRoot();
    this.binDirectory = this._getBinDirectory();
    
    this.logger = logger.child({ module: 'ServiceLauncher' });
    
    this.logger.info('ServiceLauncher initialized', {
      isPackaged: this.isPackaged,
      platform: this.platform,
      projectRoot: this.projectRoot,
      binDirectory: this.binDirectory,
    });
  }

  /**
   * Detect if running in packaged mode
   */
  _detectPackagedMode() {
    return (
      process.env.NODE_ENV === 'production' ||
      process.env.AETHER_PACKAGED === 'true' ||
      (app && app.isPackaged) ||
      (process.mainModule && process.mainModule.filename.includes('app.asar'))
    );
  }

  /**
   * Detect platform
   */
  _detectPlatform() {
    switch (process.platform) {
      case 'darwin': return 'darwin';
      case 'win32': return 'win32';
      case 'linux': return 'linux';
      default: return 'linux';
    }
  }

  /**
   * Get project root directory
   */
  _getProjectRoot() {
    if (this.isPackaged) {
      // In packaged mode, use app path
      if (app && app.getAppPath) {
        return path.dirname(app.getAppPath());
      }
      return path.dirname(process.execPath);
    }
    
    // In development, find directory containing package.json
    let current = __dirname;
    while (current !== path.dirname(current)) {
      if (fs.existsSync(path.join(current, 'package.json'))) {
        return current;
      }
      current = path.dirname(current);
    }
    return process.cwd();
  }

  /**
   * Get binary directory path
   */
  _getBinDirectory() {
    if (this.isPackaged) {
      // In packaged mode, binaries are in resources/launcher/platform/
      if (process.resourcesPath) {
        return path.join(process.resourcesPath, 'launcher', this.platform);
      }
      return path.join(this.projectRoot, 'resources', 'launcher', this.platform);
    }
    
    // In development mode, check for pre-built binaries
    const devBinPath = path.join(this.projectRoot, 'resources', 'launcher', this.platform);
    if (fs.existsSync(devBinPath)) {
      return devBinPath;
    }
    
    return null; // Will use Python scripts directly
  }

  /**
   * Get binary name with platform-specific extension
   */
  _getBinaryName(serviceName) {
    const binaryName = SERVICE_BINARIES[serviceName] || serviceName;
    return this.platform === 'win32' ? `${binaryName}.exe` : binaryName;
  }

  /**
   * Check if service binary is available
   */
  isServiceAvailable(serviceName) {
    if (!this.binDirectory) return false;
    
    const binaryName = this._getBinaryName(serviceName);
    const binaryPath = path.join(this.binDirectory, binaryName);
    
    return fs.existsSync(binaryPath);
  }

  /**
   * Get list of available services
   */
  getAvailableServices() {
    if (!this.binDirectory) return [];
    
    return Object.keys(SERVICE_BINARIES).filter(service => 
      this.isServiceAvailable(service)
    );
  }

  /**
   * Open a terminal window and run command
   */
  _openTerminal(command, args, options = {}) {
    const { cwd, env } = options;
    
    this.logger.debug('Opening terminal', { command, args, cwd });
    
    switch (this.platform) {
      case 'darwin': {
        // macOS: use AppleScript to open Terminal
        const quotedCommand = command.replace(/'/g, "\\'");
        const quotedArgs = args.map(arg => `'${arg.replace(/'/g, "\\'")}'`).join(' ');
        const cdCommand = cwd ? `cd '${cwd}' && ` : '';
        
        const script = `tell application "Terminal"
          do script "${cdCommand}exec '${quotedCommand}' ${quotedArgs}"
        end tell`;
        
        return spawn('osascript', ['-e', script], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, ...env },
        });
      }
      
      case 'win32': {
        // Windows: use cmd.exe
        const cmdArgs = cwd 
          ? ['/c', 'cd', '/d', cwd, '&&', 'start', 'cmd', '/k', command, ...args]
          : ['/c', 'start', 'cmd', '/k', command, ...args];
        
        return spawn('cmd.exe', cmdArgs, {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, ...env },
          shell: true,
        });
      }
      
      default: {
        // Linux: try gnome-terminal or fallback
        const term = process.env.TERM_EMULATOR || 'gnome-terminal';
        const cmdString = `${cwd ? `cd "${cwd}" && ` : ''}${command} ${args.join(' ')}`;
        
        return spawn(term, ['--', 'bash', '-c', cmdString], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, ...env },
        });
      }
    }
  }

  /**
   * Launch integrated backend (unified backend hub)
   */
  launchIntegratedBackend() {
    /**
     * @.architecture
     * Unified Production Launch Sequence via start_production.sh
     * Script handles: Docker mesh startup → Health checks → Backend binary launch
     */
    if (this.isPackaged) {
      // In packaged mode, backend binary + services are in Resources/bin/
      // But we use start_production.sh which orchestrates everything
      const backendBinDir = path.join(process.resourcesPath, 'bin');
      const productionScript = path.join(backendBinDir, 'start_production.sh');

      this.logger.info('Launching via production orchestration script', { 
        script: productionScript,
        cwd: backendBinDir
      });

      if (!fs.existsSync(productionScript)) {
        throw new Error(`Production script not found: ${productionScript}`);
      }

      // Check if production script exists and is executable
      try {
        const stat = fs.statSync(productionScript);
        const isExecutable = (stat.mode & 0o111) !== 0;
        if (!isExecutable) {
          this.logger.warn('Production script is not executable. This indicates a packaging error.', { script: productionScript });
        }
      } catch (err) {
        this.logger.error('Failed to stat production script', { error: err.message });
      }

      // Compute writable data directory (must match start_production.sh DATA_DIR logic)
      // macOS: ~/Library/Application Support/Aether
      // Windows: %APPDATA%/Aether
      // Linux: ~/.local/share/Aether
      let dataDir;
      const homeDir = app.getPath('home');
      if (process.platform === 'darwin') {
        dataDir = path.join(homeDir, 'Library', 'Application Support', 'Aether');
      } else if (process.platform === 'win32') {
        dataDir = path.join(process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'Aether');
      } else {
        dataDir = path.join(process.env.XDG_DATA_HOME || path.join(homeDir, '.local', 'share'), 'Aether');
      }

      // Ensure writable data directory exists
      try {
        fs.mkdirSync(dataDir, { recursive: true });
      } catch (err) {
        this.logger.warn('Failed to create data directory', { dataDir, error: err.message });
      }

      // Determine if setup was already completed on a previous run.
      // If yes: full shell-managed orchestration (Docker + background services).
      // If no: API-only mode so OnboardingModal can guide the user.
      const setupComplete = this._isSetupComplete(dataDir);
      this.logger.info('Setup completion check', { setupComplete, dataDir });

      // Launch production script (handles Docker + binary orchestration)
      // Write spawn logs into the unified log directory (not /tmp)
      const spawnLogDir = path.join(dataDir, 'logs');
      fs.mkdirSync(spawnLogDir, { recursive: true });
      const logPath = path.join(spawnLogDir, 'backend-spawn.log');
      const logFile = fs.openSync(logPath, 'w');  // 'w' = fresh each launch (rotation done by shell)

      // Read app version from package.json for environment injection.
      // setup_engine.py uses this to stamp setup_progress.json,
      // enabling future migration logic when installed vs current version diverge.
      const pkg = require('../../../package.json');
      const appVersion = pkg.version || '2.0.0';

      const spawnEnv = {
        ...process.env,
        // AETHER_BACKEND_ROOT = writable data dir (for logs, data, indexes, venv-oi)
        AETHER_BACKEND_ROOT: dataDir,
        // AETHER_INSTALL_DIR = read-only bundle dir (for binaries, services, scripts)
        AETHER_INSTALL_DIR: backendBinDir,
        // AETHER_DATA_DIR = explicit writable dir (redundant but explicit for shell script)
        AETHER_DATA_DIR: dataDir,
        // AETHER_APP_VERSION = current version from package.json
        // Used by setup_engine.py to stamp setup_progress.json
        AETHER_APP_VERSION: appVersion,
        ENVIRONMENT: 'production',
        AETHER_ENVIRONMENT: 'production'
      };

      // Only set AETHER_SKIP_SHELL_SETUP on first run (setup not yet complete).
      // On subsequent runs, the shell script handles full orchestration:
      // Docker mesh, health checks, background services, backend binary.
      if (!setupComplete) {
        spawnEnv.AETHER_SKIP_SHELL_SETUP = 'true';
        this.logger.info('First run detected: backend will start in API-only mode for onboarding');
      } else {
        this.logger.info('Setup already complete: backend will start in full orchestration mode');
      }

      const backendProcess = spawn('bash', [productionScript], {
        cwd: backendBinDir,
        // CRITICAL: detached = true gives the backend its own process group.
        // If the Electron main process crashes (native segfault, uncaught exception),
        // the OS won't kill the backend's process group with it.
        // On NORMAL quit, shutdown() explicitly sends SIGTERM to backendProcess.pid.
        // On CRASH, the orphan backend stays alive so the NEXT launch finds it
        // already running on port 8765, avoiding the 60s cold-start delay.
        detached: true,
        stdio: ['ignore', logFile, logFile],
        env: spawnEnv
      });

      // Allow Electron to exit without waiting for this child.
      // We still track the PID for explicit cleanup in shutdown().
      backendProcess.unref();

      this.logger.info('Production backend orchestration started', { 
        pid: backendProcess.pid,
        log: logPath
      });
      return backendProcess;
    }

    // Dev mode fallback
    const backendDir = this.options.backendDir;
    const scriptName = this.options.backendScript;
    
    if (!backendDir) throw new Error('Backend directory not found');
    
    this.logger.info('Launching dev backend', { backendDir, scriptName });
    
    // CRITICAL: start_production.sh is a BASH script, not Python
    // Check if script is shell script (.sh) or Python (.py)
    const isShellScript = scriptName.endsWith('.sh');
    
    if (isShellScript) {
      // Launch bash script directly
      const logPath = '/tmp/aether-backend-dev-spawn.log';
      const logFile = fs.openSync(logPath, 'a');
      
      return spawn('bash', [scriptName], {
        cwd: backendDir,
        detached: false,
        stdio: ['ignore', logFile, logFile],
      });
    } else {
      // Launch Python script
      const pythonExe = this.options.pythonPath || 'python3';
      return spawn(pythonExe, [scriptName], {
        cwd: backendDir,
        detached: false,
        stdio: 'pipe',
      });
    }
  }

  /**
   * Check if the initial onboarding/setup has been completed on a previous run.
   * Reads $dataDir/logs/setup_progress.json and checks current_phase.
   * @param {string} dataDir - Writable data directory
   * @returns {boolean} true only when setup was previously completed
   */
  _isSetupComplete(dataDir) {
    try {
      const progressFile = path.join(dataDir, 'logs', 'setup_progress.json');
      if (!fs.existsSync(progressFile)) {
        return false;
      }
      const raw = fs.readFileSync(progressFile, 'utf-8');
      const data = JSON.parse(raw);
      const phase = data.current_phase;

      // Version tracking: log installed vs current for future migration decisions.
      // In v1 this is informational only. Future releases can add migration logic
      // when installedVersion !== currentVersion (e.g. pull new Docker images).
      const pkg = require('../../../package.json');
      const currentVersion = pkg.version || 'unknown';
      const installedVersion = data.app_version || 'unknown';
      this.logger.info('Setup version check', { installedVersion, currentVersion });

      // Hard-block onboarding policy: only fully completed setup unlocks full startup.
      // Legacy "skipped" states must re-enter onboarding.
      return phase === 'completed';
    } catch (err) {
      this.logger.warn('Failed to read setup progress file', { error: err.message });
      return false;
    }
  }

  /**
   * Launch individual service
   */
  launchService(serviceName, args = []) {
    const binaryName = this._getBinaryName(serviceName);
    
    this.logger.info('Launching service', { serviceName, args });
    
    // Try binary first (packaged or pre-built)
    if (this.isServiceAvailable(serviceName)) {
      const binaryPath = path.join(this.binDirectory, binaryName);
      
      // Check if executable (Unix)
      if (this.platform !== 'win32') {
        try {
          const stat = fs.statSync(binaryPath);
          const isExecutable = (stat.mode & 0o111) !== 0;
          if (!isExecutable) {
            this.logger.warn('Binary is not executable. This indicates a packaging error.', { serviceName, binaryPath });
          }
        } catch (err) {
          this.logger.error('Failed to stat binary', {
            serviceName,
            error: err.message,
          });
        }
      }
      
      // Launch in terminal
      if (this.options.spawnInTerminal) {
        const process = this._openTerminal(binaryPath, args);
        this.logger.info('Service launched in terminal (binary)', {
          serviceName,
          pid: process.pid,
        });
        return process;
      }
      
      // Launch headless
      const process = spawn(binaryPath, args, {
        detached: false,
        stdio: 'pipe',
      });
      
      this.logger.info('Service launched (binary)', {
        serviceName,
        pid: process.pid,
      });
      
      return process;
    }
    
    // Fallback: try Python script (development mode)
    this.logger.warn('Binary not found, attempting Python script fallback', {
      serviceName,
    });
    
    throw new Error(`Service binary not found: ${serviceName}`);
  }

  /**
   * Kill process gracefully
   */
  async killProcess(process, timeout = 10000) {
    if (!process || process.killed) {
      this.logger.debug('Process already killed or invalid');
      return;
    }
    
    const pid = process.pid;
    
    this.logger.info('Killing process gracefully', { pid, timeout });
    
    return new Promise((resolve) => {
      // Try SIGTERM first
      try {
        process.kill('SIGTERM');
      } catch (err) {
        this.logger.warn('SIGTERM failed', { pid, error: err.message });
      }
      
      // Set timeout for force kill
      const killTimer = setTimeout(() => {
        if (!process.killed) {
          this.logger.warn('Process did not exit gracefully, force killing', { pid });
          try {
            process.kill('SIGKILL');
          } catch (err) {
            this.logger.error('SIGKILL failed', { pid, error: err.message });
          }
        }
      }, timeout);
      
      // Wait for exit
      process.once('exit', (code, signal) => {
        clearTimeout(killTimer);
        this.logger.info('Process exited', { pid, code, signal });
        resolve();
      });
    });
  }

  /**
   * Kill all tracked processes
   */
  async killAll(timeout = 10000) {
    // This would need to track spawned processes
    // For now, just a placeholder
    this.logger.info('Killing all processes');
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalLauncher = null;

/**
 * Get or create global launcher instance
 */
function getLauncher(options = {}) {
  if (!globalLauncher) {
    globalLauncher = new ServiceLauncher(options);
  }
  return globalLauncher;
}

/**
 * Create a new launcher instance
 */
function createLauncher(options = {}) {
  return new ServiceLauncher(options);
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  ServiceLauncher,
  getLauncher,
  createLauncher,
  
  // Constants
  SERVICE_BINARIES,
  DEFAULT_BACKEND_SCRIPT,
  DEFAULT_BACKEND_DIR,
};
