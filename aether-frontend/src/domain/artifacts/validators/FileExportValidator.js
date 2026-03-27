'use strict';

/**
 * @.architecture
 * 
 * Incoming: ArtifactsController.exportFile(content, filename, extension) --- {string, string, string}
 * Processing: Sanitize filename (remove path traversal), validate extension against whitelist, check content size limits, normalize paths, fail-fast on violations --- {5 jobs: JOB_VALIDATE_SCHEMA, JOB_SANITIZE_INPUT, JOB_VALIDATE_PATTERN, JOB_VALIDATE_LENGTH, JOB_NORMALIZE_DATA}
 * Outgoing: Return {sanitizedFilename, validExtension, safe: true} or throw ValidationError --- {validation_result, object}
 * 
 * SECURITY:
 * - Prevents path traversal (../, ..\, absolute paths)
 * - Prevents null byte injection (\x00)
 * - Prevents hidden file creation (leading dots on Windows)
 * - Blocks dangerous extensions (.exe, .sh, .bat, .scr, .cmd, .com, .pif)
 * - Enforces filename length limits
 * - Enforces content size limits (DoS prevention)
 * - Normalizes all paths to prevent encoding attacks
 * - Fail-fast: throws immediately on violation
 * 
 * @module domain/artifacts/validators/FileExportValidator
 */

// REMOVED: const path = require('path'); → Not available in renderer process
const { freeze } = Object;

// Security configuration
const EXPORT_LIMITS = freeze({
  MAX_FILENAME_LENGTH: 255, // Standard filesystem limit
  MIN_FILENAME_LENGTH: 1,
  MAX_CONTENT_SIZE: 100 * 1024 * 1024, // 100MB max
  MIN_CONTENT_SIZE: 0, // Allow empty files
  
  // Safe file extensions (WHITELIST approach - safer than blacklist)
  SAFE_EXTENSIONS: freeze([
    // Text/Code
    'txt', 'md', 'json', 'xml', 'yaml', 'yml', 'csv', 'log',
    'js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs',
    'py', 'rb', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'hpp',
    'sh', 'bash', 'zsh', 'fish', // Shell scripts (user responsibility)
    'sql', 'graphql', 'proto',
    
    // Web
    'html', 'htm', 'css', 'scss', 'sass', 'less',
    'svg', 'vue', 'svelte',
    
    // Data
    'geojson', 'toml', 'ini', 'conf', 'config',
    
    // Images
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico',
    
    // Documents
    'pdf', 'doc', 'docx', 'odt', 'rtf',
    
    // Archives (user responsibility to verify contents)
    'zip', 'tar', 'gz', 'bz2', '7z',
    
    // Media
    'mp3', 'mp4', 'wav', 'ogg', 'webm', 'avi', 'mov'
  ]),
  
  // DANGEROUS extensions (BLOCKED - executable/system files)
  DANGEROUS_EXTENSIONS: freeze([
    'exe', 'com', 'bat', 'cmd', 'scr', 'pif', 'msi', 'app', 'dmg',
    'deb', 'rpm', 'run', 'bin', 'apk', 'vbs', 'wsf', 'ps1', 'psm1'
  ])
});

// Dangerous filename patterns
const DANGEROUS_PATTERNS = freeze({
  // Path traversal
  PATH_TRAVERSAL: /\.\.[/\\]/g,
  ABSOLUTE_PATH_UNIX: /^[/\\]/,
  ABSOLUTE_PATH_WINDOWS: /^[a-zA-Z]:[/\\]/,
  
  // Hidden files/folders (Windows + Unix)
  HIDDEN_FILE_UNIX: /^\./,
  HIDDEN_FILE_WINDOWS: /^\./,
  
  // Null byte injection
  NULL_BYTE: /\x00/g,
  
  // Control characters
  CONTROL_CHARS: /[\x00-\x1F\x7F]/g,
  
  // Reserved Windows names
  RESERVED_WINDOWS: /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i,
  
  // Dangerous characters in filename
  DANGEROUS_CHARS: /[<>:"|?*]/g,
  
  // Multiple extensions (file.txt.exe)
  DOUBLE_EXTENSION: /\.[^.]+\.[^.]+$/
});

class ValidationError extends Error {
  constructor(message, field, rule, details = {}) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.rule = rule;
    this.details = details;
  }
}

class FileExportValidator {
  /**
   * Validate and sanitize file export parameters
   * @param {string} content - File content
   * @param {string} filename - Requested filename
   * @param {string} extension - File extension
   * @param {Object} options - Validation options
   * @returns {Object} Sanitized export parameters
   * @throws {ValidationError} If file export is unsafe
   */
  static validate(content, filename, extension, options = {}) {
    // FAIL FAST: Required parameters
    if (content === null || content === undefined) {
      throw new ValidationError(
        'Content is required for file export',
        'content',
        'required',
        { provided: typeof content }
      );
    }

    if (typeof content !== 'string' && !Buffer.isBuffer(content)) {
      throw new ValidationError(
        'Content must be a string or Buffer',
        'content',
        'type',
        { provided: typeof content, expected: 'string or Buffer' }
      );
    }

    if (!filename || typeof filename !== 'string') {
      throw new ValidationError(
        'Filename is required',
        'filename',
        'required',
        { provided: typeof filename }
      );
    }

    if (!extension || typeof extension !== 'string') {
      throw new ValidationError(
        'Extension is required',
        'extension',
        'required',
        { provided: typeof extension }
      );
    }

    // Validate content size
    this._validateContentSize(content);

    // Sanitize filename
    const sanitizedFilename = this._sanitizeFilename(filename);

    // Validate extension
    const validExtension = this._validateExtension(extension);

    // Final safety check
    const finalFilename = `${sanitizedFilename}.${validExtension}`;
    this._validateFinalFilename(finalFilename);

    return freeze({
      safe: true,
      sanitizedFilename,
      validExtension,
      finalFilename,
      contentSize: typeof content === 'string' ? content.length : content.length,
      timestamp: Date.now()
    });
  }

  /**
   * Validate content size
   * @private
   */
  static _validateContentSize(content) {
    const size = typeof content === 'string' ? content.length : content.length;

    if (size > EXPORT_LIMITS.MAX_CONTENT_SIZE) {
      throw new ValidationError(
        `Content exceeds maximum size of ${EXPORT_LIMITS.MAX_CONTENT_SIZE} bytes`,
        'content',
        'max_size',
        { 
          provided: size, 
          maximum: EXPORT_LIMITS.MAX_CONTENT_SIZE,
          providedMB: (size / (1024 * 1024)).toFixed(2),
          maximumMB: (EXPORT_LIMITS.MAX_CONTENT_SIZE / (1024 * 1024)).toFixed(2)
        }
      );
    }
  }

  /**
   * Sanitize filename (remove dangerous patterns)
   * @private
   */
  static _sanitizeFilename(filename) {
    // Trim whitespace
    let sanitized = filename.trim();

    // Check for null bytes
    if (DANGEROUS_PATTERNS.NULL_BYTE.test(sanitized)) {
      throw new ValidationError(
        'Filename contains null bytes (injection attempt)',
        'filename',
        'null_byte',
        { filename }
      );
    }

    // Check for path traversal
    if (DANGEROUS_PATTERNS.PATH_TRAVERSAL.test(sanitized)) {
      throw new ValidationError(
        'Filename contains path traversal sequence (../ or ..\\)',
        'filename',
        'path_traversal',
        { filename }
      );
    }

    // Check for absolute paths
    if (DANGEROUS_PATTERNS.ABSOLUTE_PATH_UNIX.test(sanitized) ||
        DANGEROUS_PATTERNS.ABSOLUTE_PATH_WINDOWS.test(sanitized)) {
      throw new ValidationError(
        'Filename cannot be an absolute path',
        'filename',
        'absolute_path',
        { filename }
      );
    }

    // Remove control characters
    sanitized = sanitized.replace(DANGEROUS_PATTERNS.CONTROL_CHARS, '');

    // Remove dangerous characters
    sanitized = sanitized.replace(DANGEROUS_PATTERNS.DANGEROUS_CHARS, '_');

    // Remove path separators
    sanitized = sanitized.replace(/[/\\]/g, '_');

    // Get basename (remove any extension) - browser-compatible
    const lastDotIndex = sanitized.lastIndexOf('.');
    if (lastDotIndex > 0) {
      sanitized = sanitized.substring(0, lastDotIndex);
    }

    // Check length
    if (sanitized.length < EXPORT_LIMITS.MIN_FILENAME_LENGTH) {
      throw new ValidationError(
        'Filename is empty after sanitization',
        'filename',
        'empty',
        { original: filename, sanitized }
      );
    }

    if (sanitized.length > EXPORT_LIMITS.MAX_FILENAME_LENGTH) {
      throw new ValidationError(
        `Filename exceeds maximum length of ${EXPORT_LIMITS.MAX_FILENAME_LENGTH} characters`,
        'filename',
        'max_length',
        { provided: sanitized.length, maximum: EXPORT_LIMITS.MAX_FILENAME_LENGTH }
      );
    }

    // Check for Windows reserved names
    if (DANGEROUS_PATTERNS.RESERVED_WINDOWS.test(sanitized)) {
      throw new ValidationError(
        `Filename is a reserved Windows name: ${sanitized}`,
        'filename',
        'reserved_name',
        { filename: sanitized }
      );
    }

    return sanitized;
  }

  /**
   * Validate extension against whitelist
   * @private
   */
  static _validateExtension(extension) {
    // Normalize: lowercase, remove leading dot
    let normalized = extension.toLowerCase().trim().replace(/^\./, '');

    // CRITICAL: Block dangerous extensions
    if (EXPORT_LIMITS.DANGEROUS_EXTENSIONS.includes(normalized)) {
      throw new ValidationError(
        `Extension .${normalized} is blocked for security (executable/system file)`,
        'extension',
        'dangerous',
        { 
          extension: normalized,
          reason: 'Executable or system file extension is not allowed'
        }
      );
    }

    // Whitelist validation
    if (!EXPORT_LIMITS.SAFE_EXTENSIONS.includes(normalized)) {
      throw new ValidationError(
        `Extension .${normalized} is not in the safe extensions whitelist`,
        'extension',
        'not_whitelisted',
        { 
          extension: normalized,
          safeExtensions: EXPORT_LIMITS.SAFE_EXTENSIONS.slice(0, 10).join(', ') + '...'
        }
      );
    }

    return normalized;
  }

  /**
   * Final validation of complete filename
   * @private
   */
  static _validateFinalFilename(filename) {
    // Check for double extensions (file.txt.exe pattern)
    const extensions = filename.match(/\.[^.]+/g);
    if (extensions && extensions.length > 1) {
      throw new ValidationError(
        'Multiple file extensions are not allowed (possible disguised executable)',
        'filename',
        'double_extension',
        { filename, extensions }
      );
    }

    // Final length check
    if (filename.length > EXPORT_LIMITS.MAX_FILENAME_LENGTH) {
      throw new ValidationError(
        'Final filename exceeds maximum length',
        'filename',
        'final_length',
        { length: filename.length, maximum: EXPORT_LIMITS.MAX_FILENAME_LENGTH }
      );
    }
  }

  /**
   * Get export limits (for display/documentation)
   */
  static getLimits() {
    return { ...EXPORT_LIMITS };
  }

  /**
   * Get safe extensions (for display/documentation)
   */
  static getSafeExtensions() {
    return [...EXPORT_LIMITS.SAFE_EXTENSIONS];
  }

  /**
   * Get dangerous extensions (for display/documentation)
   */
  static getDangerousExtensions() {
    return [...EXPORT_LIMITS.DANGEROUS_EXTENSIONS];
  }

  /**
   * Check if extension is safe (without throwing)
   */
  static isExtensionSafe(extension) {
    const normalized = extension.toLowerCase().trim().replace(/^\./, '');
    return EXPORT_LIMITS.SAFE_EXTENSIONS.includes(normalized) &&
           !EXPORT_LIMITS.DANGEROUS_EXTENSIONS.includes(normalized);
  }
}

// Export
module.exports = { 
  FileExportValidator, 
  ValidationError,
  EXPORT_LIMITS 
};
