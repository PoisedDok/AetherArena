"""
Cryptography Utilities - Security Layer

Provides encryption/decryption and hashing utilities for protecting sensitive data
such as API keys, tokens, passwords, and configuration secrets.

@.architecture
Incoming: config/settings.py, data/database/repositories/*.py, User input --- {str plaintext secrets, str passwords, Path key_file, bytes encryption keys}
Processing: encrypt(), decrypt(), hash_password(), verify_password(), generate_token(), generate_api_key(), get_secret_manager(), derive_key_from_password() --- {7 jobs: decryption, encryption, hashing, initialization, key_derivation, token_generation, verification}
Outgoing: config/settings.py, data/database/repositories/*.py, api/v1/endpoints/*.py --- {str encrypted secrets, str password hashes, str API tokens, Tuple[str, str] key pairs}
"""

import os
import base64
import hashlib
import logging
import secrets
from typing import Optional, Tuple
from pathlib import Path

logger = logging.getLogger(__name__)


class CryptoError(Exception):
    """Raised when cryptographic operations fail."""
    pass


class EncryptionManager:
    """
    Manages encryption/decryption of sensitive data using Fernet (symmetric encryption).
    
    Features:
    - AES-128-CBC with HMAC authentication
    - Key derivation from password or random generation
    - Secure key storage
    - Token-based encryption (includes timestamp)
    """
    
    def __init__(self, key: Optional[bytes] = None, key_file: Optional[Path] = None):
        """
        Initialize encryption manager.
        
        Args:
            key: Encryption key (32 bytes, URL-safe base64 encoded)
            key_file: Path to key file (loads or creates if None provided)
            
        Note: If neither key nor key_file provided, generates new key in memory only.
        """
        from cryptography.fernet import Fernet
        
        self._fernet: Optional[Fernet] = None
        
        if key:
            self._fernet = Fernet(key)
        elif key_file:
            self._key_file = Path(key_file)
            self._fernet = Fernet(self._load_or_create_key())
        else:
            # In-memory only key
            self._fernet = Fernet(Fernet.generate_key())
            logger.warning("Using in-memory encryption key - encrypted data will not persist across restarts")
    
    def _load_or_create_key(self) -> bytes:
        """Load encryption key from file or create new one."""
        from cryptography.fernet import Fernet
        
        if self._key_file.exists():
            try:
                key = self._key_file.read_bytes()
                # Validate key format
                Fernet(key)
                logger.info(f"Loaded encryption key from {self._key_file}")
                return key
            except Exception as e:
                logger.error(f"Failed to load encryption key: {e}")
                raise CryptoError(f"Invalid encryption key in {self._key_file}")
        else:
            # Generate new key
            key = Fernet.generate_key()
            
            # Save securely
            self._key_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            self._key_file.write_bytes(key)
            self._key_file.chmod(0o600)
            
            logger.info(f"Generated new encryption key at {self._key_file}")
            return key
    
    def encrypt(self, plaintext: str) -> str:
        """
        Encrypt plaintext string.
        
        Args:
            plaintext: String to encrypt
            
        Returns:
            Base64-encoded encrypted string
            
        Raises:
            CryptoError: If encryption fails
        """
        try:
            encrypted_bytes = self._fernet.encrypt(plaintext.encode('utf-8'))
            return base64.urlsafe_b64encode(encrypted_bytes).decode('utf-8')
        except Exception as e:
            logger.error(f"Encryption failed: {e}")
            raise CryptoError(f"Failed to encrypt data: {e}")
    
    def decrypt(self, encrypted: str) -> str:
        """
        Decrypt encrypted string.
        
        Args:
            encrypted: Base64-encoded encrypted string
            
        Returns:
            Decrypted plaintext string
            
        Raises:
            CryptoError: If decryption fails
        """
        try:
            encrypted_bytes = base64.urlsafe_b64decode(encrypted.encode('utf-8'))
            decrypted_bytes = self._fernet.decrypt(encrypted_bytes)
            return decrypted_bytes.decode('utf-8')
        except Exception as e:
            logger.error(f"Decryption failed: {e}")
            raise CryptoError(f"Failed to decrypt data: {e}")
    
    def encrypt_dict(self, data: dict, keys_to_encrypt: list[str]) -> dict:
        """
        Encrypt specific keys in a dictionary.
        
        Args:
            data: Dictionary containing data
            keys_to_encrypt: List of keys whose values should be encrypted
            
        Returns:
            Dictionary with encrypted values
        """
        result = data.copy()
        for key in keys_to_encrypt:
            if key in result and result[key]:
                result[key] = self.encrypt(str(result[key]))
        return result
    
    def decrypt_dict(self, data: dict, keys_to_decrypt: list[str]) -> dict:
        """
        Decrypt specific keys in a dictionary.
        
        Args:
            data: Dictionary containing encrypted data
            keys_to_decrypt: List of keys whose values should be decrypted
            
        Returns:
            Dictionary with decrypted values
        """
        result = data.copy()
        for key in keys_to_decrypt:
            if key in result and result[key]:
                try:
                    result[key] = self.decrypt(result[key])
                except CryptoError:
                    # Keep original value if decryption fails (might not be encrypted)
                    logger.warning(f"Failed to decrypt key '{key}' - keeping original value")
        return result
    
    @staticmethod
    def generate_key() -> bytes:
        """Generate a new Fernet encryption key."""
        from cryptography.fernet import Fernet
        return Fernet.generate_key()
    
    @staticmethod
    def derive_key_from_password(password: str, salt: Optional[bytes] = None) -> Tuple[bytes, bytes]:
        """
        Derive encryption key from password using PBKDF2.
        
        Args:
            password: Password string
            salt: Salt bytes (generates random if None)
            
        Returns:
            Tuple of (derived_key, salt)
        """
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
        
        if salt is None:
            salt = os.urandom(16)
        
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=32,
            salt=salt,
            iterations=480000,  # OWASP recommendation for 2024
        )
        
        key = base64.urlsafe_b64encode(kdf.derive(password.encode('utf-8')))
        return key, salt


class Hasher:
    """
    Secure hashing utilities for passwords, tokens, and checksums.
    
    Features:
    - Password hashing with bcrypt
    - Token generation
    - Checksum calculation
    - Timing-attack resistant comparison
    """
    
    @staticmethod
    def hash_password(password: str, rounds: int = 12) -> str:
        """
        Hash password using bcrypt.
        
        Args:
            password: Password to hash
            rounds: Cost factor (default 12, range 4-31)
            
        Returns:
            Hashed password string
        """
        import bcrypt
        
        password_bytes = password.encode('utf-8')
        salt = bcrypt.gensalt(rounds=rounds)
        hashed = bcrypt.hashpw(password_bytes, salt)
        
        return hashed.decode('utf-8')
    
    @staticmethod
    def verify_password(password: str, hashed: str) -> bool:
        """
        Verify password against hash (timing-attack resistant).
        
        Args:
            password: Password to verify
            hashed: Hashed password
            
        Returns:
            True if password matches, False otherwise
        """
        import bcrypt
        
        password_bytes = password.encode('utf-8')
        hashed_bytes = hashed.encode('utf-8')
        
        try:
            return bcrypt.checkpw(password_bytes, hashed_bytes)
        except Exception as e:
            logger.error(f"Password verification failed: {e}")
            return False
    
    @staticmethod
    def hash_token(token: str) -> str:
        """
        Hash API token for storage (one-way hash).
        
        Args:
            token: API token to hash
            
        Returns:
            Hex-encoded SHA-256 hash
        """
        return hashlib.sha256(token.encode('utf-8')).hexdigest()
    
    @staticmethod
    def generate_token(length: int = 32) -> str:
        """
        Generate secure random token.
        
        Args:
            length: Token length in bytes
            
        Returns:
            URL-safe base64-encoded token
        """
        token_bytes = secrets.token_bytes(length)
        return base64.urlsafe_b64encode(token_bytes).decode('utf-8')
    
    @staticmethod
    def generate_api_key(prefix: str = "aether", length: int = 32) -> str:
        """
        Generate API key with prefix for easy identification.
        
        Args:
            prefix: Key prefix (e.g., "aether", "sk")
            length: Random portion length in bytes
            
        Returns:
            API key string (format: prefix_base64token)
        """
        token = Hasher.generate_token(length)
        return f"{prefix}_{token}"
    
    @staticmethod
    def checksum_file(file_path: Path, algorithm: str = 'sha256') -> str:
        """
        Calculate file checksum.
        
        Args:
            file_path: Path to file
            algorithm: Hash algorithm (sha256, sha512, md5)
            
        Returns:
            Hex-encoded checksum
        """
        hasher = hashlib.new(algorithm)
        
        with open(file_path, 'rb') as f:
            for chunk in iter(lambda: f.read(8192), b''):
                hasher.update(chunk)
        
        return hasher.hexdigest()
    
    @staticmethod
    def checksum_bytes(data: bytes, algorithm: str = 'sha256') -> str:
        """
        Calculate checksum for bytes.
        
        Args:
            data: Bytes to hash
            algorithm: Hash algorithm
            
        Returns:
            Hex-encoded checksum
        """
        hasher = hashlib.new(algorithm)
        hasher.update(data)
        return hasher.hexdigest()
    
    @staticmethod
    def constant_time_compare(a: str, b: str) -> bool:
        """
        Timing-attack resistant string comparison.
        
        Args:
            a: First string
            b: Second string
            
        Returns:
            True if strings match, False otherwise
        """
        return secrets.compare_digest(a.encode('utf-8'), b.encode('utf-8'))


class SecretManager:
    """
    High-level secret management with encryption and secure storage.
    
    Handles encryption of sensitive configuration data like API keys,
    database passwords, and service credentials.
    """
    
    def __init__(self, key_file: Optional[Path] = None):
        """
        Initialize secret manager.
        
        Args:
            key_file: Path to encryption key file
        """
        # Default key file location
        if key_file is None:
            key_file = Path.home() / '.aether' / '.encryption_key'
        
        self._encryption = EncryptionManager(key_file=key_file)
        self._hasher = Hasher()
    
    def encrypt_secret(self, secret: str) -> str:
        """Encrypt a secret string."""
        return self._encryption.encrypt(secret)
    
    def decrypt_secret(self, encrypted: str) -> str:
        """Decrypt an encrypted secret."""
        return self._encryption.decrypt(encrypted)
    
    def encrypt_config(self, config: dict, secret_keys: list[str]) -> dict:
        """
        Encrypt secret keys in configuration dictionary.
        
        Args:
            config: Configuration dictionary
            secret_keys: List of keys to encrypt (e.g., ['api_key', 'password'])
            
        Returns:
            Configuration with encrypted secrets
        """
        return self._encryption.encrypt_dict(config, secret_keys)
    
    def decrypt_config(self, config: dict, secret_keys: list[str]) -> dict:
        """
        Decrypt secret keys in configuration dictionary.
        
        Args:
            config: Configuration dictionary with encrypted values
            secret_keys: List of keys to decrypt
            
        Returns:
            Configuration with decrypted secrets
        """
        return self._encryption.decrypt_dict(config, secret_keys)
    
    def hash_api_key(self, api_key: str) -> str:
        """
        Hash API key for secure storage.
        
        Args:
            api_key: API key to hash
            
        Returns:
            Hashed API key
        """
        return self._hasher.hash_token(api_key)
    
    def generate_api_key(self, prefix: str = "aether") -> Tuple[str, str]:
        """
        Generate new API key and its hash.
        
        Args:
            prefix: Key prefix for identification
            
        Returns:
            Tuple of (api_key, hashed_key)
        """
        api_key = self._hasher.generate_api_key(prefix)
        hashed = self._hasher.hash_token(api_key)
        return api_key, hashed
    
    def verify_api_key(self, provided_key: str, stored_hash: str) -> bool:
        """
        Verify API key against stored hash.
        
        Args:
            provided_key: API key provided by user
            stored_hash: Stored hash to compare against
            
        Returns:
            True if key matches, False otherwise
        """
        provided_hash = self._hasher.hash_token(provided_key)
        return self._hasher.constant_time_compare(provided_hash, stored_hash)


# Global secret manager instance
_secret_manager: Optional[SecretManager] = None


def get_secret_manager(key_file: Optional[Path] = None) -> SecretManager:
    """Get global secret manager instance."""
    global _secret_manager
    if _secret_manager is None:
        _secret_manager = SecretManager(key_file=key_file)
    return _secret_manager


# Convenience functions
def encrypt_secret(secret: str) -> str:
    """Encrypt secret using global manager."""
    return get_secret_manager().encrypt_secret(secret)


def decrypt_secret(encrypted: str) -> str:
    """Decrypt secret using global manager."""
    return get_secret_manager().decrypt_secret(encrypted)


def hash_password(password: str) -> str:
    """Hash password using bcrypt."""
    return Hasher.hash_password(password)


def verify_password(password: str, hashed: str) -> bool:
    """Verify password against hash."""
    return Hasher.verify_password(password, hashed)


def generate_token(length: int = 32) -> str:
    """Generate secure random token."""
    return Hasher.generate_token(length)


def generate_api_key(prefix: str = "aether") -> Tuple[str, str]:
    """Generate API key and its hash."""
    return get_secret_manager().generate_api_key(prefix)


def verify_api_key(provided_key: str, stored_hash: str) -> bool:
    """Verify API key against hash."""
    return get_secret_manager().verify_api_key(provided_key, stored_hash)

