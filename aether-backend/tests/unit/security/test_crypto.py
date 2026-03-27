"""
Unit tests for security/crypto.py — EncryptionManager, Hasher, SecretManager.

Adversarial: tests target every branch, boundary, and error path in the source.
Every assertion verifies exact values or structural contracts, not just "didn't crash."

CI: pytest tests/unit/security/test_crypto.py -m unit --no-cov -q
"""

import hashlib
import base64
from unittest.mock import patch

import pytest
from pathlib import Path
from security.crypto import EncryptionManager, Hasher, SecretManager, CryptoError


# ===========================================================================
# EncryptionManager
# ===========================================================================

class TestEncryptionManager:

    # --- Constructor branches (3 paths: key, key_file, neither) ---

    def test_explicit_key_constructor(self):
        """EncryptionManager(key=valid_key) uses that key directly."""
        from cryptography.fernet import Fernet
        key = Fernet.generate_key()
        mgr = EncryptionManager(key=key)
        assert mgr.decrypt(mgr.encrypt("test")) == "test"

    def test_explicit_invalid_key_raises(self):
        """EncryptionManager(key=garbage) raises during construction."""
        with pytest.raises(Exception):
            EncryptionManager(key=b"not-a-valid-fernet-key")

    def test_in_memory_key_when_no_args(self):
        """No key or key_file generates ephemeral in-memory key."""
        mgr = EncryptionManager()
        assert mgr.decrypt(mgr.encrypt("ephemeral")) == "ephemeral"

    def test_key_file_creates_new(self, tmp_path):
        """key_file branch creates file if not exists, sets permissions."""
        key_file = tmp_path / "test_key"
        mgr = EncryptionManager(key_file=key_file)
        assert key_file.exists()
        assert mgr.decrypt(mgr.encrypt("test")) == "test"

    def test_key_file_reuse(self, tmp_path):
        """Two managers with same key_file share the same key."""
        key_file = tmp_path / "test_key"
        mgr1 = EncryptionManager(key_file=key_file)
        encrypted = mgr1.encrypt("shared-secret")
        mgr2 = EncryptionManager(key_file=key_file)
        assert mgr2.decrypt(encrypted) == "shared-secret"

    def test_key_file_corrupt_raises_crypto_error(self, tmp_path):
        """Corrupt key file raises CryptoError, not generic exception."""
        key_file = tmp_path / "bad_key"
        key_file.write_bytes(b"this-is-not-a-fernet-key")
        with pytest.raises(CryptoError, match="Invalid encryption key"):
            EncryptionManager(key_file=key_file)

    # --- encrypt / decrypt ---

    def test_encrypt_decrypt_roundtrip(self):
        """Encrypt then decrypt returns original plaintext exactly."""
        mgr = EncryptionManager()
        plaintext = "secret api key 12345!@#$%"
        encrypted = mgr.encrypt(plaintext)
        assert encrypted != plaintext
        assert mgr.decrypt(encrypted) == plaintext

    def test_encrypt_empty_string(self):
        """Empty string encrypts and decrypts correctly."""
        mgr = EncryptionManager()
        encrypted = mgr.encrypt("")
        assert encrypted != ""
        assert mgr.decrypt(encrypted) == ""

    def test_encrypt_unicode(self):
        """Unicode characters survive encrypt/decrypt roundtrip."""
        mgr = EncryptionManager()
        text = "Héllo wörld 你好 🔐"
        assert mgr.decrypt(mgr.encrypt(text)) == text

    def test_encrypt_produces_different_ciphertexts(self):
        """Same plaintext → different ciphertexts (Fernet IV + timestamp)."""
        mgr = EncryptionManager()
        e1 = mgr.encrypt("same")
        e2 = mgr.encrypt("same")
        assert e1 != e2

    def test_encrypt_failure_raises_crypto_error(self):
        """Lines 112-114: Exception in Fernet.encrypt triggers CryptoError."""
        mgr = EncryptionManager()
        with patch.object(mgr._fernet, 'encrypt', side_effect=Exception("fernet error")):
            with pytest.raises(CryptoError, match="Failed to encrypt"):
                mgr.encrypt("test")

    def test_decrypt_garbage_raises_crypto_error(self):
        """Decrypting non-encrypted data raises CryptoError."""
        mgr = EncryptionManager()
        with pytest.raises(CryptoError, match="Failed to decrypt"):
            mgr.decrypt("not-valid-encrypted-data")

    def test_decrypt_wrong_key_raises(self, tmp_path):
        """Decrypting with different key raises CryptoError."""
        mgr1 = EncryptionManager(key_file=tmp_path / "key1")
        mgr2 = EncryptionManager(key_file=tmp_path / "key2")
        encrypted = mgr1.encrypt("secret")
        with pytest.raises(CryptoError):
            mgr2.decrypt(encrypted)

    # --- encrypt_dict / decrypt_dict ---

    def test_encrypt_dict_specified_keys_only(self):
        """encrypt_dict encrypts only listed keys, leaves others untouched."""
        mgr = EncryptionManager()
        data = {"api_key": "secret123", "name": "test", "url": "http://example.com"}
        result = mgr.encrypt_dict(data, ["api_key"])
        assert result["api_key"] != "secret123"
        assert result["name"] == "test"
        assert result["url"] == "http://example.com"

    def test_decrypt_dict_roundtrip(self):
        """encrypt_dict → decrypt_dict returns original values."""
        mgr = EncryptionManager()
        data = {"api_key": "secret123", "name": "test"}
        encrypted = mgr.encrypt_dict(data, ["api_key"])
        decrypted = mgr.decrypt_dict(encrypted, ["api_key"])
        assert decrypted["api_key"] == "secret123"
        assert decrypted["name"] == "test"

    def test_encrypt_dict_skips_none_values(self):
        """encrypt_dict skips None values (truthiness check)."""
        mgr = EncryptionManager()
        result = mgr.encrypt_dict({"api_key": None, "name": "test"}, ["api_key"])
        assert result["api_key"] is None

    def test_encrypt_dict_skips_empty_string(self):
        """encrypt_dict skips empty string due to `if result[key]` truthiness.
        This documents the behavior: empty strings are NOT encrypted."""
        mgr = EncryptionManager()
        result = mgr.encrypt_dict({"password": "", "name": "test"}, ["password"])
        # Empty string is falsy → skipped by `if key in result and result[key]`
        assert result["password"] == ""

    def test_encrypt_dict_skips_zero(self):
        """encrypt_dict skips 0 due to truthiness check."""
        mgr = EncryptionManager()
        result = mgr.encrypt_dict({"count": 0, "name": "test"}, ["count"])
        assert result["count"] == 0

    def test_encrypt_dict_converts_int_to_str(self):
        """encrypt_dict calls str() on non-string truthy values.
        decrypt returns string, not original type — asymmetric behavior."""
        mgr = EncryptionManager()
        data = {"port": 8080}
        encrypted = mgr.encrypt_dict(data, ["port"])
        assert encrypted["port"] != 8080
        decrypted = mgr.decrypt_dict(encrypted, ["port"])
        assert decrypted["port"] == "8080"  # String, not int

    def test_encrypt_dict_missing_key_ignored(self):
        """Key in keys_to_encrypt that doesn't exist in dict is silently skipped."""
        mgr = EncryptionManager()
        data = {"name": "test"}
        result = mgr.encrypt_dict(data, ["nonexistent_key"])
        assert result == {"name": "test"}

    def test_decrypt_dict_missing_key_ignored(self):
        """Key in keys_to_decrypt that doesn't exist in dict is silently skipped."""
        mgr = EncryptionManager()
        data = {"name": "test"}
        result = mgr.decrypt_dict(data, ["nonexistent_key"])
        assert result == {"name": "test"}

    def test_decrypt_dict_invalid_value_keeps_original(self):
        """decrypt_dict keeps original value if decryption fails (not encrypted)."""
        mgr = EncryptionManager()
        data = {"api_key": "plain-text-not-encrypted", "name": "test"}
        result = mgr.decrypt_dict(data, ["api_key"])
        assert result["api_key"] == "plain-text-not-encrypted"

    def test_encrypt_dict_empty_keys_list(self):
        """Empty keys_to_encrypt list returns dict unchanged."""
        mgr = EncryptionManager()
        data = {"api_key": "secret"}
        result = mgr.encrypt_dict(data, [])
        assert result == {"api_key": "secret"}

    # --- generate_key ---

    def test_generate_key_is_valid_fernet_key(self):
        """generate_key returns bytes usable as Fernet key."""
        from cryptography.fernet import Fernet
        key = EncryptionManager.generate_key()
        assert isinstance(key, bytes)
        assert len(key) == 44
        # Prove it's actually valid by constructing Fernet with it
        f = Fernet(key)
        assert f.decrypt(f.encrypt(b"test")) == b"test"

    # --- derive_key_from_password ---

    def test_derive_key_deterministic_with_same_salt(self):
        """Same password + salt → same key."""
        key1, salt = EncryptionManager.derive_key_from_password("mypassword")
        key2, _ = EncryptionManager.derive_key_from_password("mypassword", salt=salt)
        assert key1 == key2

    def test_derive_key_different_passwords_different_keys(self):
        """Different passwords with same salt → different keys."""
        key1, salt = EncryptionManager.derive_key_from_password("password1")
        key2, _ = EncryptionManager.derive_key_from_password("password2", salt=salt)
        assert key1 != key2

    def test_derive_key_produces_usable_fernet_key(self):
        """Derived key can actually encrypt/decrypt data."""
        key, _ = EncryptionManager.derive_key_from_password("strong-password")
        mgr = EncryptionManager(key=key)
        assert mgr.decrypt(mgr.encrypt("derived-key-test")) == "derived-key-test"

    def test_derive_key_empty_password(self):
        """Empty password still produces a key (no crash)."""
        key, salt = EncryptionManager.derive_key_from_password("")
        assert isinstance(key, bytes)
        assert len(key) == 44
        assert len(salt) == 16


# ===========================================================================
# Hasher
# ===========================================================================

class TestHasher:

    # --- hash_password / verify_password ---

    def test_hash_verify_roundtrip(self):
        """hash_password → verify_password returns True."""
        hashed = Hasher.hash_password("mysecretpassword")
        assert Hasher.verify_password("mysecretpassword", hashed) is True

    def test_verify_wrong_password(self):
        """Wrong password → False."""
        hashed = Hasher.hash_password("correct")
        assert Hasher.verify_password("wrong", hashed) is False

    def test_hash_with_explicit_rounds(self):
        """Custom rounds parameter is accepted and produces verifiable hash."""
        hashed = Hasher.hash_password("test", rounds=4)  # minimum rounds
        assert Hasher.verify_password("test", hashed) is True

    def test_pbkdf2_fallback_hash_and_verify(self):
        """When bcrypt unavailable, PBKDF2 fallback produces verifiable hash."""
        with patch("security.crypto.HAS_BCRYPT", False):
            hashed = Hasher.hash_password("fallback-password")
            assert hashed.startswith("$2b$")
            assert Hasher.verify_password("fallback-password", hashed) is True
            assert Hasher.verify_password("wrong", hashed) is False

    def test_pbkdf2_fallback_rounds_normalization(self):
        """PBKDF2 fallback normalizes rounds to 4-31 range."""
        with patch("security.crypto.HAS_BCRYPT", False):
            # rounds=1 should be normalized to 4
            hashed = Hasher.hash_password("test", rounds=1)
            assert "$04$" in hashed
            assert Hasher.verify_password("test", hashed) is True

    def test_verify_malformed_hash_returns_false(self):
        """Malformed hash string returns False, not exception."""
        with patch("security.crypto.HAS_BCRYPT", False):
            assert Hasher.verify_password("test", "$2b$12$") is False
            assert Hasher.verify_password("test", "$2b$") is False

    def test_verify_invalid_payload_returns_false(self):
        """Invalid base64 payload in $2b$ hash returns False."""
        with patch("security.crypto.HAS_BCRYPT", False):
            assert Hasher.verify_password("test", "$2b$12$!!!not-base64!!!") is False

    def test_verify_short_payload_returns_false(self):
        """$2b$ hash with payload too short returns False."""
        with patch("security.crypto.HAS_BCRYPT", False):
            short = base64.urlsafe_b64encode(b"short").decode()
            assert Hasher.verify_password("test", f"$2b$12${short}") is False

    def test_verify_unsupported_format_returns_false(self):
        """Completely unsupported hash format returns False."""
        with patch("security.crypto.HAS_BCRYPT", False):
            assert Hasher.verify_password("test", "argon2id$some$hash") is False
            assert Hasher.verify_password("test", "random-string") is False

    # --- hash_token ---

    def test_hash_token_deterministic(self):
        """hash_token returns consistent SHA256 for same input."""
        h1 = Hasher.hash_token("mytoken")
        h2 = Hasher.hash_token("mytoken")
        assert h1 == h2

    def test_hash_token_exact_value(self):
        """hash_token returns correct SHA256 hex digest."""
        expected = hashlib.sha256("mytoken".encode("utf-8")).hexdigest()
        assert Hasher.hash_token("mytoken") == expected
        assert len(expected) == 64

    def test_hash_token_different_inputs(self):
        """Different inputs produce different hashes."""
        assert Hasher.hash_token("a") != Hasher.hash_token("b")

    # --- generate_token ---

    def test_generate_token_uniqueness(self):
        """generate_token returns unique tokens."""
        tokens = {Hasher.generate_token() for _ in range(10)}
        assert len(tokens) == 10

    def test_generate_token_default_length(self):
        """Default 32-byte token produces 44-char base64 string."""
        token = Hasher.generate_token()
        # 32 bytes → ceil(32/3)*4 = 44 base64 chars (with padding stripped by urlsafe)
        assert len(token) == 44

    def test_generate_token_custom_length(self):
        """Custom byte length produces correspondingly longer/shorter token."""
        short = Hasher.generate_token(length=8)
        long = Hasher.generate_token(length=64)
        assert len(short) < len(long)

    # --- generate_api_key ---

    def test_generate_api_key_with_prefix(self):
        """API key starts with given prefix followed by underscore."""
        key = Hasher.generate_api_key(prefix="test")
        assert key.startswith("test_")
        assert len(key) > len("test_")

    def test_generate_api_key_default_prefix(self):
        """Default prefix is 'aether'."""
        key = Hasher.generate_api_key()
        assert key.startswith("aether_")

    # --- checksum_bytes ---

    def test_checksum_bytes_exact_sha256(self):
        """checksum_bytes returns exact known SHA256 for known input."""
        expected = hashlib.sha256(b"hello world").hexdigest()
        actual = Hasher.checksum_bytes(b"hello world")
        assert actual == expected
        assert actual == "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"

    def test_checksum_bytes_empty(self):
        """Checksum of empty bytes matches known SHA256 of empty input."""
        expected = hashlib.sha256(b"").hexdigest()
        assert Hasher.checksum_bytes(b"") == expected

    def test_checksum_bytes_md5_algorithm(self):
        """checksum_bytes with md5 algorithm produces 32-char hex."""
        h = Hasher.checksum_bytes(b"test", algorithm="md5")
        assert len(h) == 32
        assert h == hashlib.md5(b"test").hexdigest()

    # --- checksum_file ---

    def test_checksum_file_matches_content(self, tmp_path):
        """checksum_file matches manual hash of same content."""
        f = tmp_path / "test.txt"
        content = b"file content for hashing"
        f.write_bytes(content)
        expected = hashlib.sha256(content).hexdigest()
        assert Hasher.checksum_file(f) == expected

    def test_checksum_file_sha512(self, tmp_path):
        """checksum_file with sha512 algorithm."""
        f = tmp_path / "test.txt"
        content = b"sha512 content"
        f.write_bytes(content)
        expected = hashlib.sha512(content).hexdigest()
        assert Hasher.checksum_file(f, algorithm="sha512") == expected
        assert len(expected) == 128

    def test_checksum_file_nonexistent_raises(self):
        """checksum_file on non-existent file raises FileNotFoundError."""
        with pytest.raises(FileNotFoundError):
            Hasher.checksum_file(Path("/tmp/definitely_does_not_exist_12345.txt"))

    # --- constant_time_compare ---

    def test_constant_time_compare_equal(self):
        """Equal strings return True."""
        assert Hasher.constant_time_compare("abc", "abc") is True

    def test_constant_time_compare_not_equal(self):
        """Different strings return False."""
        assert Hasher.constant_time_compare("abc", "def") is False

    def test_constant_time_compare_empty_strings(self):
        """Two empty strings return True."""
        assert Hasher.constant_time_compare("", "") is True

    def test_constant_time_compare_different_lengths(self):
        """Strings of different lengths return False."""
        assert Hasher.constant_time_compare("short", "much longer string") is False

    def test_constant_time_compare_unicode(self):
        """Unicode strings compare correctly."""
        assert Hasher.constant_time_compare("héllo", "héllo") is True
        assert Hasher.constant_time_compare("héllo", "hello") is False


# ===========================================================================
# SecretManager
# ===========================================================================

class TestSecretManager:

    def test_encrypt_decrypt_secret(self, tmp_path):
        """SecretManager encrypt/decrypt roundtrip."""
        mgr = SecretManager(key_file=tmp_path / "key")
        encrypted = mgr.encrypt_secret("my-api-key")
        assert encrypted != "my-api-key"
        assert mgr.decrypt_secret(encrypted) == "my-api-key"

    def test_generate_and_verify_api_key(self, tmp_path):
        """Generate API key → verify returns True, wrong key → False."""
        mgr = SecretManager(key_file=tmp_path / "key")
        api_key, stored_hash = mgr.generate_api_key("test")
        assert api_key.startswith("test_")
        assert isinstance(stored_hash, str)
        assert len(stored_hash) == 64  # SHA256 hex
        assert mgr.verify_api_key(api_key, stored_hash) is True
        assert mgr.verify_api_key("wrong_key", stored_hash) is False

    def test_hash_api_key(self, tmp_path):
        """hash_api_key returns SHA256 of the key."""
        mgr = SecretManager(key_file=tmp_path / "key")
        key = "aether_test123"
        hashed = mgr.hash_api_key(key)
        expected = hashlib.sha256(key.encode("utf-8")).hexdigest()
        assert hashed == expected

    def test_encrypt_decrypt_config(self, tmp_path):
        """Encrypt/decrypt config dictionary — full field verification."""
        mgr = SecretManager(key_file=tmp_path / "key")
        config = {"api_key": "sk-123", "endpoint": "https://api.example.com"}
        encrypted = mgr.encrypt_config(config, ["api_key"])
        assert encrypted["api_key"] != "sk-123"
        assert encrypted["endpoint"] == "https://api.example.com"
        decrypted = mgr.decrypt_config(encrypted, ["api_key"])
        assert decrypted["api_key"] == "sk-123"
        assert decrypted["endpoint"] == "https://api.example.com"

    def test_verify_api_key_uses_constant_time_compare(self, tmp_path):
        """verify_api_key internally uses constant_time_compare (timing-safe)."""
        mgr = SecretManager(key_file=tmp_path / "key")
        api_key, stored_hash = mgr.generate_api_key("test")
        # If it used == instead of constant_time_compare, it would still
        # return True — but we can verify the method is called.
        with patch.object(mgr._hasher, "constant_time_compare", wraps=mgr._hasher.constant_time_compare) as spy:
            mgr.verify_api_key(api_key, stored_hash)
            spy.assert_called_once()

    def test_default_key_file_path(self, tmp_path):
        """Line 424: SecretManager without key_file uses default home path."""
        with patch.object(Path, "home", return_value=tmp_path):
            mgr = SecretManager()  # key_file=None triggers default
        expected_key = tmp_path / ".aether" / ".encryption_key"
        assert expected_key.exists()
        # Verify round-trip works
        encrypted = mgr.encrypt_secret("test-default")
        assert mgr.decrypt_secret(encrypted) == "test-default"


# ===========================================================================
# Module-level code & Convenience functions
# ===========================================================================


class TestModuleLevelCode:
    """Cover module-level import flag and global singleton."""

    def test_bcrypt_import_flag_when_available(self):
        """Line 21: When bcrypt is importable, HAS_BCRYPT is set to True."""
        import importlib
        import sys
        import types
        import security.crypto as mod
        original_manager = mod._secret_manager

        fake_bcrypt = types.ModuleType("bcrypt")
        try:
            with patch.dict(sys.modules, {"bcrypt": fake_bcrypt}):
                importlib.reload(mod)
                assert mod.HAS_BCRYPT is True
        finally:
            # Restore original state (bcrypt unavailable)
            if "bcrypt" in sys.modules and sys.modules["bcrypt"] is fake_bcrypt:
                del sys.modules["bcrypt"]
            importlib.reload(mod)
            mod._secret_manager = original_manager

    def test_bcrypt_import_flag_when_unavailable(self):
        """Lines 22-24: When bcrypt is NOT importable, HAS_BCRYPT is False."""
        import builtins
        import importlib
        import sys
        import security.crypto as mod
        original_manager = mod._secret_manager
        original_import = builtins.__import__

        def mock_import(name, *args, **kwargs):
            if name == "bcrypt":
                raise ModuleNotFoundError("No module named 'bcrypt'")
            return original_import(name, *args, **kwargs)

        try:
            # Remove bcrypt from sys.modules so reload triggers a fresh import
            saved_bcrypt = sys.modules.pop("bcrypt", None)
            builtins.__import__ = mock_import
            importlib.reload(mod)
            assert mod.HAS_BCRYPT is False
            assert mod.bcrypt is None
        finally:
            builtins.__import__ = original_import
            if saved_bcrypt is not None:
                sys.modules["bcrypt"] = saved_bcrypt
            importlib.reload(mod)
            mod._secret_manager = original_manager


class TestConvenienceFunctions:
    """Lines 511-513, 519, 524, 539, 544, 549:
    Module-level convenience functions and get_secret_manager singleton."""

    @pytest.fixture(autouse=True)
    def _reset_global_manager(self, tmp_path):
        """Reset the global _secret_manager before each test and patch Path.home
        to avoid writing to the real home directory."""
        import security.crypto as mod
        original = mod._secret_manager
        mod._secret_manager = None
        with patch.object(Path, "home", return_value=tmp_path):
            yield
        mod._secret_manager = original

    def test_encrypt_secret(self):
        """Line 519: Module-level encrypt_secret delegates to global manager."""
        from security.crypto import encrypt_secret
        result = encrypt_secret("test-secret")
        assert isinstance(result, str)
        assert result != "test-secret"

    def test_decrypt_secret(self):
        """Line 524: Module-level decrypt_secret round-trips with encrypt_secret."""
        from security.crypto import encrypt_secret, decrypt_secret
        encrypted = encrypt_secret("roundtrip")
        assert decrypt_secret(encrypted) == "roundtrip"

    def test_generate_token(self):
        """Line 539: Module-level generate_token wraps Hasher.generate_token."""
        from security.crypto import generate_token
        token = generate_token(16)
        assert isinstance(token, str)
        assert len(token) > 0

    def test_generate_api_key(self):
        """Line 544: Module-level generate_api_key delegates to global manager."""
        from security.crypto import generate_api_key
        key, hash_val = generate_api_key("test")
        assert key.startswith("test_")
        assert len(hash_val) == 64

    def test_verify_api_key(self):
        """Line 549: Module-level verify_api_key delegates to global manager."""
        from security.crypto import generate_api_key, verify_api_key
        key, hash_val = generate_api_key("test")
        assert verify_api_key(key, hash_val) is True
        assert verify_api_key("wrong_key", hash_val) is False
