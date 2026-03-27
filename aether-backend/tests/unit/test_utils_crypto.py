"""
Unit Tests: utils/crypto.py

Covers the encrypt_config and decrypt_config convenience wrappers.
The underlying SecretManager is tested in tests/unit/security/test_crypto.py;
here we verify the thin wrappers delegate correctly.

Mock boundary: security.crypto.get_secret_manager → MagicMock.
"""

from unittest.mock import MagicMock, patch

from utils.crypto import encrypt_config, decrypt_config


class TestEncryptConfig:
    def test_delegates_to_secret_manager(self):
        """Lines 229-230: encrypt_config calls manager.encrypt_config."""
        mock_manager = MagicMock()
        mock_manager.encrypt_config.return_value = {"host": "localhost", "pw": "ENC"}

        with patch("utils.crypto._crypto") as mock_crypto:
            mock_crypto.return_value.get_secret_manager.return_value = mock_manager
            result = encrypt_config({"host": "localhost", "pw": "secret"}, ["pw"])

        mock_manager.encrypt_config.assert_called_once_with(
            {"host": "localhost", "pw": "secret"}, ["pw"]
        )
        assert result == {"host": "localhost", "pw": "ENC"}

    def test_empty_secret_keys(self):
        """No keys to encrypt → passes through unchanged."""
        mock_manager = MagicMock()
        mock_manager.encrypt_config.return_value = {"host": "localhost"}

        with patch("utils.crypto._crypto") as mock_crypto:
            mock_crypto.return_value.get_secret_manager.return_value = mock_manager
            result = encrypt_config({"host": "localhost"}, [])

        mock_manager.encrypt_config.assert_called_once_with({"host": "localhost"}, [])
        assert result == {"host": "localhost"}


class TestDecryptConfig:
    def test_delegates_to_secret_manager(self):
        """Lines 244-245: decrypt_config calls manager.decrypt_config."""
        mock_manager = MagicMock()
        mock_manager.decrypt_config.return_value = {"host": "localhost", "pw": "secret"}

        with patch("utils.crypto._crypto") as mock_crypto:
            mock_crypto.return_value.get_secret_manager.return_value = mock_manager
            result = decrypt_config({"host": "localhost", "pw": "ENC"}, ["pw"])

        mock_manager.decrypt_config.assert_called_once_with(
            {"host": "localhost", "pw": "ENC"}, ["pw"]
        )
        assert result == {"host": "localhost", "pw": "secret"}

    def test_empty_secret_keys(self):
        """No keys to decrypt → passes through unchanged."""
        mock_manager = MagicMock()
        mock_manager.decrypt_config.return_value = {"host": "localhost"}

        with patch("utils.crypto._crypto") as mock_crypto:
            mock_crypto.return_value.get_secret_manager.return_value = mock_manager
            result = decrypt_config({"host": "localhost"}, [])

        mock_manager.decrypt_config.assert_called_once_with({"host": "localhost"}, [])
        assert result == {"host": "localhost"}
