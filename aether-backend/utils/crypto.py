"""
Cryptography Utilities - Convenience wrappers for security layer.

Provides simple functions for common cryptographic operations by wrapping
the comprehensive security.crypto module. Used across the backend for
quick access to encryption, hashing, and token generation.

@.architecture
Incoming: All backend modules, security/crypto.py --- {str plaintext, str passwords, Path file_path, dict config}
Processing: encrypt(), decrypt(), hash_password(), generate_token(), encrypt_config() --- {5 jobs: delegation, encryption, hashing, token_generation, verification}
Outgoing: All backend modules --- {str encrypted, str hashes, Tuple[str, str] API key pairs, dict encrypted config}
"""

from pathlib import Path
from typing import Optional, Tuple

# Import security layer components
from security.crypto import (
    CryptoError,
    EncryptionManager,
    Hasher,
    SecretManager,
    get_secret_manager,
)

__all__ = [
    # Exceptions
    'CryptoError',
    
    # Classes
    'EncryptionManager',
    'Hasher',
    'SecretManager',
    
    # Convenience functions
    'encrypt',
    'decrypt',
    'hash_password',
    'verify_password',
    'generate_token',
    'generate_api_key',
    'hash_token',
    'checksum_file',
    'get_secret_manager',
]


# =============================================================================
# Convenience Functions
# =============================================================================

def encrypt(plaintext: str, key_file: Optional[Path] = None) -> str:
    """
    Encrypt plaintext string.
    
    Args:
        plaintext: String to encrypt
        key_file: Optional path to encryption key file
        
    Returns:
        Base64-encoded encrypted string
        
    Raises:
        CryptoError: If encryption fails
        
    Example:
        >>> encrypted = encrypt("my secret data")
        >>> decrypted = decrypt(encrypted)
    """
    manager = get_secret_manager(key_file=key_file)
    return manager.encrypt_secret(plaintext)


def decrypt(encrypted: str, key_file: Optional[Path] = None) -> str:
    """
    Decrypt encrypted string.
    
    Args:
        encrypted: Base64-encoded encrypted string
        key_file: Optional path to encryption key file
        
    Returns:
        Decrypted plaintext string
        
    Raises:
        CryptoError: If decryption fails
    """
    manager = get_secret_manager(key_file=key_file)
    return manager.decrypt_secret(encrypted)


def hash_password(password: str, rounds: int = 12) -> str:
    """
    Hash password using bcrypt.
    
    Args:
        password: Password to hash
        rounds: Cost factor (default 12, range 4-31)
        
    Returns:
        Hashed password string
        
    Example:
        >>> hashed = hash_password("user_password")
        >>> is_valid = verify_password("user_password", hashed)
    """
    return Hasher.hash_password(password, rounds=rounds)


def verify_password(password: str, hashed: str) -> bool:
    """
    Verify password against hash (timing-attack resistant).
    
    Args:
        password: Password to verify
        hashed: Hashed password
        
    Returns:
        True if password matches, False otherwise
    """
    return Hasher.verify_password(password, hashed)


def generate_token(length: int = 32) -> str:
    """
    Generate secure random token.
    
    Args:
        length: Token length in bytes (default 32)
        
    Returns:
        URL-safe base64-encoded token
        
    Example:
        >>> token = generate_token(32)  # 32-byte token
        >>> session_token = generate_token(64)  # Longer token
    """
    return Hasher.generate_token(length)


def generate_api_key(prefix: str = "aether", length: int = 32) -> Tuple[str, str]:
    """
    Generate API key and its hash.
    
    Args:
        prefix: Key prefix for identification (default "aether")
        length: Random portion length in bytes
        
    Returns:
        Tuple of (api_key, hashed_key)
        
    Example:
        >>> api_key, hashed = generate_api_key("aether")
        >>> # Store hashed in database, give api_key to user
    """
    manager = get_secret_manager()
    return manager.generate_api_key(prefix)


def hash_token(token: str) -> str:
    """
    Hash API token for secure storage (one-way hash).
    
    Args:
        token: API token to hash
        
    Returns:
        Hex-encoded SHA-256 hash
        
    Example:
        >>> hashed = hash_token("aether_abc123...")
        >>> # Store hashed in database
    """
    return Hasher.hash_token(token)


def checksum_file(file_path: Path, algorithm: str = 'sha256') -> str:
    """
    Calculate file checksum.
    
    Args:
        file_path: Path to file
        algorithm: Hash algorithm (sha256, sha512, md5)
        
    Returns:
        Hex-encoded checksum
        
    Example:
        >>> checksum = checksum_file(Path("document.pdf"))
        >>> # Verify file integrity later
    """
    return Hasher.checksum_file(file_path, algorithm=algorithm)


def constant_time_compare(a: str, b: str) -> bool:
    """
    Timing-attack resistant string comparison.
    
    Args:
        a: First string
        b: Second string
        
    Returns:
        True if strings match, False otherwise
        
    Example:
        >>> if constant_time_compare(provided_token, stored_token):
        ...     # Token is valid
    """
    return Hasher.constant_time_compare(a, b)


# =============================================================================
# Config Encryption Helpers
# =============================================================================

def encrypt_config(config: dict, secret_keys: list[str]) -> dict:
    """
    Encrypt secret keys in configuration dictionary.
    
    Args:
        config: Configuration dictionary
        secret_keys: List of keys to encrypt (e.g., ['api_key', 'password'])
        
    Returns:
        Configuration with encrypted secrets
        
    Example:
        >>> config = {"host": "localhost", "password": "secret123"}
        >>> encrypted = encrypt_config(config, ["password"])
        >>> # {"host": "localhost", "password": "encrypted_value"}
    """
    manager = get_secret_manager()
    return manager.encrypt_config(config, secret_keys)


def decrypt_config(config: dict, secret_keys: list[str]) -> dict:
    """
    Decrypt secret keys in configuration dictionary.
    
    Args:
        config: Configuration dictionary with encrypted values
        secret_keys: List of keys to decrypt
        
    Returns:
        Configuration with decrypted secrets
    """
    manager = get_secret_manager()
    return manager.decrypt_config(config, secret_keys)

