'use strict';

/**
 * @.architecture
 * 
 * Incoming: main/index.js (launchIntegratedBackend, killProcess), config (backendDir, backendScript) --- {method_call, void}
 * Processing: Auto-detect packaged mode (NODE_ENV, AETHER_PACKAGED, app.isPackaged, app.asar), auto-detect backend directory (try AETHER_BACKEND_DIR, ../aether-backend, ../backend, ../../AetherArena/aether-backend, check for main.py/app.py/start_integrated_backend.py), detect platform (darwin/win32/linux), spawn backend in terminal (osascript for macOS, cmd.exe for Windows, gnome-terminal for Linux) or headless, launch via Python (python3/python), graceful shutdown via SIGTERM then SIGKILL after timeout, provide killProcess with timeout (default 10s) --- {9 jobs: JOB_GET_STATE, JOB_GET_STATE, JOB_GET_STATE, JOB_EMIT_EVENT, JOB_INITIALIZE, JOB_DISPOSE, JOB_INITIALIZE, JOB_VALIDATE_SCHEMA, JOB_VALIDATE_SCHEMA}
 * Outgoing: Child process (backend Python process), kill functions --- {child_process, ChildProcess}
 * 
 * 
 * @module main/services/ServiceLauncher
 * 
 * Service Launcher
 * ============================================================================
 * Manages lifecycle of backend services (Python processes).
 * Handles spawning, monitoring, and graceful shutdown.
 * 
 * Features:
 * - Auto-detect packaged vs development mode
 * - Platform-specific binary paths
 * - Graceful process termination
 * - Process health monitoring
 * - Terminal window spawning for visibility
 * 
 * @module main/services/ServiceLauncher
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { logger } = require('../../core/utils/logger');

// ============================================================================
// Constants
// ============================================================================

/**
 * Service binary names (without extension)
 */
const SERVICE_BINARIES = Object.freeze({
  integrated: 'aether-hub',
  docling: 'docling-api',
  searxng: 'searxng-api',
  xlwings: 'xlwings-api',
  perplexica: 'perplexica-api',
});

/**
 * Default backend script path (relative to project root)
 */
const DEFAULT_BACKEND_SCRIPT = 'start_integrated_backend.py';

/**
 * Auto-detect backend directory relative to frontend
 * Try multiple possible locations
 */
function autoDetectBackendDir() {
  // Try environment variables first
  const envDir = process.env.AETHER_BACKEND_DIR || process.env.GURU_BACKEND_DIR;
  if (envDir && fs.existsSync(envDir)) {
    return envDir;
  }
  
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
const DEFAULT_BACKEND_DIR = autoDetectBackendDir();

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
      // In packaged mode, binaries are in resources/bin/platform/
      if (process.resourcesPath) {
        return path.join(process.resourcesPath, 'bin', this.platform);
      }
      return path.join(this.projectRoot, 'resources', 'bin', this.platform);
    }
    
    // In development mode, check for pre-built binaries
    const devBinPath = path.join(this.projectRoot, 'resources', 'bin', this.platform);
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
    const backendDir = this.options.backendDir;
    const scriptName = this.options.backendScript;
    
    // Validate backend directory
    if (!backendDir) {
      const error = 'Backend directory not configured. Set AETHER_BACKEND_DIR environment variable or ensure backend is in expected location relative to frontend.';
      this.logger.error(error, {
        cwd: process.cwd(),
        tried: ['AETHER_BACKEND_DIR', 'GURU_BACKEND_DIR', '../aether-backend', '../backend', '../../AetherArena/aether-backend'],
      });
      throw new Error(error);
    }
    
    if (!fs.existsSync(backendDir)) {
      const error = `Backend directory does not exist: ${backendDir}`;
      this.logger.error(error);
      throw new Error(error);
    }
    
    const scriptPath = path.join(backendDir, scriptName);
    
    this.logger.info('Launching integrated backend', {
      backendDir,
      scriptName,
      scriptPath,
    });
    
    // Check if script exists
    if (!fs.existsSync(scriptPath)) {
      this.logger.error('Backend script not found', { scriptPath });
      throw new Error(`Backend script not found: ${scriptPath}`);
    }
    
    // Determine Python executable
    const pythonExe = this.platform === 'win32' ? 'python' : 'python3';
    
    // Launch in terminal for visibility
    if (this.options.spawnInTerminal) {
      const process = this._openTerminal(pythonExe, [scriptName], {
        cwd: backendDir,
      });
      
      this.logger.info('Integrated backend launched in terminal', {
        pid: process.pid,
      });
      
      return process;
    }
    
    // Launch without terminal (headless)
    const process = spawn(pythonExe, [scriptName], {
      cwd: backendDir,
      detached: false,
      stdio: 'pipe',
    });
    
    // Capture output
    process.stdout?.on('data', (data) => {
      this.logger.debug('Backend stdout', { data: data.toString().trim() });
    });
    
    process.stderr?.on('data', (data) => {
      this.logger.warn('Backend stderr', { data: data.toString().trim() });
    });
    
    process.on('error', (err) => {
      this.logger.error('Backend process error', { error: err.message });
    });
    
    process.on('exit', (code, signal) => {
      this.logger.info('Backend process exited', { code, signal });
    });
    
    this.logger.info('Integrated backend launched', {
      pid: process.pid,
    });
    
    return process;
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
      
      // Make executable (Unix)
      if (this.platform !== 'win32') {
        try {
          fs.chmodSync(binaryPath, 0o755);
        } catch (err) {
          this.logger.warn('Failed to chmod binary', {
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

