"""
Unit Tests: Utilities

Tests for utils module including crypto, http, validation, and config.
"""

import pytest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch
import httpx

from utils import crypto, validation
from utils.http import HTTPClient, HTTPClientConfig, get_http_client
from utils.config import load_config, get_provider_url


# =============================================================================
# Crypto Tests
# =============================================================================

class TestCrypto:
    """Test crypto utility functions."""
    
    def test_encrypt_decrypt(self):
        """Test encrypt and decrypt roundtrip."""
        plaintext = "secret data"
        encrypted = crypto.encrypt(plaintext)
        
        assert encrypted != plaintext
        assert isinstance(encrypted, str)
        
        decrypted = crypto.decrypt(encrypted)
        assert decrypted == plaintext
    
    def test_hash_password(self):
        """Test password hashing."""
        password = "test_password_123"
        hashed = crypto.hash_password(password)
        
        assert hashed != password
        assert len(hashed) > 0
        assert hashed.startswith("$2b$")  # bcrypt prefix
    
    def test_verify_password(self):
        """Test password verification."""
        password = "test_password_123"
        hashed = crypto.hash_password(password)
        
        assert crypto.verify_password(password, hashed) is True
        assert crypto.verify_password("wrong_password", hashed) is False
    
    def test_generate_token(self):
        """Test token generation."""
        token = crypto.generate_token(32)
        
        assert isinstance(token, str)
        assert len(token) > 0
        
        # Tokens should be unique
        token2 = crypto.generate_token(32)
        assert token != token2
    
    def test_generate_api_key(self):
        """Test API key generation."""
        api_key, hashed = crypto.generate_api_key("test")
        
        assert isinstance(api_key, str)
        assert isinstance(hashed, str)
        assert api_key.startswith("test_")
        assert api_key != hashed
    
    def test_hash_token(self):
        """Test token hashing."""
        token = "test_token_123"
        hashed = crypto.hash_token(token)
        
        assert isinstance(hashed, str)
        assert len(hashed) == 64  # SHA-256 hex length
        assert hashed != token
        
        # Same token should produce same hash
        hashed2 = crypto.hash_token(token)
        assert hashed == hashed2
    
    def test_checksum_file(self, temp_dir: Path):
        """Test file checksum calculation."""
        test_file = temp_dir / "test.txt"
        test_file.write_text("test content")
        
        checksum = crypto.checksum_file(test_file)
        
        assert isinstance(checksum, str)
        assert len(checksum) == 64  # SHA-256 hex length
        
        # Same file should produce same checksum
        checksum2 = crypto.checksum_file(test_file)
        assert checksum == checksum2
    
    def test_constant_time_compare(self):
        """Test timing-attack resistant comparison."""
        assert crypto.constant_time_compare("test", "test") is True
        assert crypto.constant_time_compare("test", "Test") is False
        assert crypto.constant_time_compare("test", "testing") is False


# =============================================================================
# HTTP Client Tests
# =============================================================================

class TestHTTPClient:
    """Test HTTP client functionality."""
    
    @pytest.mark.asyncio
    async def test_client_initialization(self):
        """Test HTTP client initialization."""
        config = HTTPClientConfig(
            connect_timeout=5.0,
            read_timeout=60.0,
        )
        client = HTTPClient(config=config)
        
        assert client.config == config
        assert client._client is None  # Not created until first use
        
        await client.close()
    
    @pytest.mark.asyncio
    async def test_get_request(self, mock_http_client):
        """Test GET request."""
        mock_http_client.get.return_value = MagicMock(
            status_code=200,
            json=lambda: {"result": "success"}
        )
        
        response = await mock_http_client.get("http://test.com/api")
        
        assert response.status_code == 200
        assert response.json() == {"result": "success"}
        mock_http_client.get.assert_called_once()
    
    @pytest.mark.asyncio
    async def test_post_request(self, mock_http_client):
        """Test POST request."""
        mock_http_client.post.return_value = MagicMock(
            status_code=201,
            json=lambda: {"id": "123"}
        )
        
        response = await mock_http_client.post(
            "http://test.com/api",
            json={"key": "value"}
        )
        
        assert response.status_code == 201
        assert response.json() == {"id": "123"}
        mock_http_client.post.assert_called_once()
    
    @pytest.mark.asyncio
    async def test_health_check_success(self, mock_http_client):
        """Test successful health check."""
        mock_http_client.health_check.return_value = True
        
        result = await mock_http_client.health_check("http://test.com/health")
        
        assert result is True
    
    @pytest.mark.asyncio
    async def test_health_check_failure(self, mock_http_client):
        """Test failed health check."""
        mock_http_client.health_check.return_value = False
        
        result = await mock_http_client.health_check("http://test.com/health")
        
        assert result is False
    
    @pytest.mark.asyncio
    async def test_client_context_manager(self):
        """Test HTTP client as context manager."""
        client = HTTPClient()
        
        async with client.client_context() as ctx:
            assert ctx is not None
            assert isinstance(ctx, httpx.AsyncClient)
        
        await client.close()


# =============================================================================
# Validation Tests
# =============================================================================

class TestValidation:
    """Test validation utility functions."""
    
    def test_sanitize_text_basic(self):
        """Test basic text sanitization."""
        text = "Hello <script>alert('xss')</script> World"
        sanitized = validation.sanitize_text(text, strip_scripts=True)
        
        assert "script" not in sanitized.lower()
        assert "Hello" in sanitized
        assert "World" in sanitized
    
    def test_sanitize_text_length_limit(self):
        """Test text length limiting."""
        long_text = "a" * 1000
        
        with pytest.raises(validation.SizeExceededError):
            validation.sanitize_text(long_text, max_length=100)
    
    def test_sanitize_prompt(self):
        """Test prompt sanitization."""
        prompt = "User prompt with <tag>content</tag>"
        sanitized = validation.sanitize_prompt(prompt)
        
        assert isinstance(sanitized, str)
        assert len(sanitized) > 0
    
    def test_sanitize_filename_safe(self):
        """Test safe filename sanitization."""
        filename = "document.pdf"
        safe = validation.sanitize_filename(filename)
        
        assert safe == filename
    
    def test_sanitize_filename_traversal(self):
        """Test path traversal prevention."""
        with pytest.raises(validation.PathTraversalError):
            validation.sanitize_filename("../../etc/passwd")
    
    def test_sanitize_path(self, temp_dir: Path):
        """Test path sanitization."""
        safe_path = temp_dir / "test.txt"
        safe_path.touch()
        
        result = validation.sanitize_path(
            str(safe_path),
            allowed_base=temp_dir,
            must_exist=True
        )
        
        assert result == safe_path.resolve()
    
    def test_validate_file_upload(self):
        """Test file upload validation."""
        filename = "document.pdf"
        content = b"PDF content here"
        
        result = validation.validate_file_upload(
            filename,
            content,
            allowed_extensions=['.pdf', '.txt']
        )
        
        assert result['safe_filename'] == filename
        assert 'size_bytes' in result
    
    def test_validate_file_upload_invalid_extension(self):
        """Test file upload with invalid extension."""
        filename = "script.exe"
        content = b"Executable content"
        
        with pytest.raises(validation.ValidationError):
            validation.validate_file_upload(
                filename,
                content,
                allowed_extensions=['.pdf', '.txt']
            )
    
    def test_validate_url_safe(self):
        """Test safe URL validation."""
        url = "https://example.com/api"
        validated = validation.validate_url(url)
        
        assert validated == url
    
    def test_validate_url_private_ip(self):
        """Test URL validation blocks private IPs."""
        with pytest.raises(validation.ValidationError):
            validation.validate_url("http://192.168.1.1/api")
    
    def test_validate_json_depth(self):
        """Test JSON depth validation."""
        shallow = {"level1": {"level2": {"level3": "value"}}}
        validation.validate_json_depth(shallow, max_depth=10)  # Should pass
        
        # Create deep nesting
        deep = {"a": None}
        current = deep
        for i in range(50):
            current["a"] = {"a": None}
            current = current["a"]
        
        with pytest.raises(validation.ValidationError):
            validation.validate_json_depth(deep, max_depth=20)
    
    def test_check_sql_injection(self):
        """Test SQL injection detection."""
        safe_text = "SELECT * FROM users"
        assert validation.check_sql_injection(safe_text) is False
        
        dangerous_text = "'; DROP TABLE users; --"
        assert validation.check_sql_injection(dangerous_text) is True
    
    def test_check_script_injection(self):
        """Test script injection detection."""
        safe_text = "Hello World"
        assert validation.check_script_injection(safe_text) is False
        
        dangerous_text = "<script>alert('xss')</script>"
        assert validation.check_script_injection(dangerous_text) is True


# =============================================================================
# Config Tests
# =============================================================================

class TestConfig:
    """Test configuration loading."""
    
    def test_load_config(self):
        """Test TOML config loading."""
        config = load_config()
        
        assert isinstance(config, dict)
        assert "MODELS" in config
        assert "PROVIDERS" in config
    
    def test_get_provider_url(self):
        """Test provider URL retrieval."""
        url = get_provider_url("perplexica")
        
        assert isinstance(url, str)
        assert url.startswith("http")
    
    def test_get_provider_url_invalid(self):
        """Test invalid provider returns None."""
        url = get_provider_url("nonexistent_provider")
        
        assert url is None


# =============================================================================
# Settings Tests
# =============================================================================

class TestSettings:
    """Test settings management."""
    
    def test_get_settings(self, test_settings):
        """Test settings loading."""
        assert test_settings is not None
        assert test_settings.environment == "test"
    
    def test_settings_llm_config(self, test_settings):
        """Test LLM settings."""
        assert test_settings.llm.provider is not None
        assert test_settings.llm.model is not None
        assert test_settings.llm.context_window > 0
    
    def test_settings_integration_config(self, test_settings):
        """Test integration settings."""
        assert test_settings.integrations.perplexica_url is not None
        assert test_settings.integrations.docling_url is not None
    
    def test_settings_security_config(self, test_settings):
        """Test security settings."""
        assert test_settings.security.bind_host is not None
        assert test_settings.security.bind_port > 0

