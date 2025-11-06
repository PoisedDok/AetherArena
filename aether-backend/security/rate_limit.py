"""
Rate Limiting - Security Layer

Implements token bucket rate limiting per client to prevent abuse and DoS attacks.
Supports per-IP, per-user, and per-endpoint rate limiting strategies.

@.architecture
Incoming: api/middleware/rate_limiter.py, HTTP requests --- {str client_id, int tokens, str tier}
Processing: check_rate_limit(), consume(), _get_bucket(), _cleanup_old_buckets() --- {4 jobs: cleanup, rate_limiting, tier_management, token_bucket_management}
Outgoing: api/middleware/rate_limiter.py --- {None or raises RateLimitExceeded, Dict[str, any] limit info}
"""

import time
import asyncio
import logging
from typing import Dict, Optional, Tuple
from dataclasses import dataclass
from collections import defaultdict
from enum import Enum

logger = logging.getLogger(__name__)


class RateLimitExceeded(Exception):
    """Raised when rate limit is exceeded."""
    
    def __init__(self, message: str, retry_after: float):
        super().__init__(message)
        self.retry_after = retry_after


class RateLimitStrategy(str, Enum):
    """Rate limiting strategies."""
    PER_IP = "per_ip"
    PER_USER = "per_user"
    PER_ENDPOINT = "per_endpoint"
    GLOBAL = "global"


@dataclass
class RateLimitConfig:
    """Configuration for rate limiter."""
    
    # Token bucket parameters
    requests_per_window: int = 100      # Number of requests allowed
    window_seconds: float = 60.0        # Time window in seconds
    burst_size: Optional[int] = None    # Max burst (defaults to requests_per_window)
    
    # Cleanup
    cleanup_interval: float = 300.0     # Clean old entries every 5 minutes
    
    # Strategy
    strategy: RateLimitStrategy = RateLimitStrategy.PER_IP
    
    def __post_init__(self):
        """Set defaults after initialization."""
        if self.burst_size is None:
            self.burst_size = self.requests_per_window


class TokenBucket:
    """
    Token bucket implementation for rate limiting.
    
    Algorithm:
    - Bucket starts with 'capacity' tokens
    - Tokens are added at 'refill_rate' per second
    - Each request consumes 1 token
    - If no tokens available, request is denied
    """
    
    def __init__(
        self,
        capacity: int,
        refill_rate: float,
        current_tokens: Optional[float] = None,
        last_refill: Optional[float] = None
    ):
        """
        Initialize token bucket.
        
        Args:
            capacity: Maximum tokens in bucket (burst size)
            refill_rate: Tokens added per second
            current_tokens: Initial token count (defaults to capacity)
            last_refill: Last refill timestamp (defaults to now)
        """
        self.capacity = capacity
        self.refill_rate = refill_rate
        self.tokens = current_tokens if current_tokens is not None else capacity
        self.last_refill = last_refill if last_refill is not None else time.time()
        self._lock = asyncio.Lock()
    
    async def consume(self, tokens: int = 1) -> Tuple[bool, float]:
        """
        Try to consume tokens from bucket.
        
        Args:
            tokens: Number of tokens to consume
            
        Returns:
            Tuple of (success, retry_after_seconds)
        """
        async with self._lock:
            # Refill tokens based on time elapsed
            now = time.time()
            elapsed = now - self.last_refill
            self.tokens = min(
                self.capacity,
                self.tokens + elapsed * self.refill_rate
            )
            self.last_refill = now
            
            # Check if we have enough tokens
            if self.tokens >= tokens:
                self.tokens -= tokens
                return True, 0.0
            else:
                # Calculate retry after time
                tokens_needed = tokens - self.tokens
                retry_after = tokens_needed / self.refill_rate
                return False, retry_after
    
    def get_remaining(self) -> int:
        """Get current token count."""
        return int(self.tokens)
    
    def is_expired(self, max_age: float) -> bool:
        """Check if bucket hasn't been used recently."""
        return (time.time() - self.last_refill) > max_age


class RateLimiter:
    """
    Rate limiter with token bucket algorithm.
    
    Features:
    - Per-client rate limiting
    - Configurable limits and windows
    - Automatic cleanup of old entries
    - Thread-safe operation
    - Support for multiple strategies
    """
    
    def __init__(self, config: Optional[RateLimitConfig] = None):
        """
        Initialize rate limiter.
        
        Args:
            config: Rate limit configuration
        """
        self.config = config or RateLimitConfig()
        
        # Calculate refill rate (tokens per second)
        self.refill_rate = self.config.requests_per_window / self.config.window_seconds
        
        # Storage for token buckets per client
        self._buckets: Dict[str, TokenBucket] = {}
        self._lock = asyncio.Lock()
        
        # Statistics
        self._total_requests = 0
        self._total_limited = 0
        
        # Start cleanup task
        self._cleanup_task: Optional[asyncio.Task] = None
        self._running = False
    
    async def start(self):
        """Start background cleanup task."""
        if not self._running:
            self._running = True
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())
            logger.info("Rate limiter started")
    
    async def stop(self):
        """Stop background cleanup task."""
        self._running = False
        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
        logger.info("Rate limiter stopped")
    
    async def check_rate_limit(
        self,
        client_id: str,
        tokens: int = 1
    ) -> None:
        """
        Check if request is within rate limit.
        
        Args:
            client_id: Client identifier (IP, user ID, etc.)
            tokens: Number of tokens to consume (default 1)
            
        Raises:
            RateLimitExceeded: If rate limit exceeded
        """
        self._total_requests += 1
        
        # Get or create bucket for client
        bucket = await self._get_bucket(client_id)
        
        # Try to consume tokens
        allowed, retry_after = await bucket.consume(tokens)
        
        if not allowed:
            self._total_limited += 1
            logger.warning(
                f"Rate limit exceeded for {client_id}. "
                f"Retry after {retry_after:.2f}s"
            )
            raise RateLimitExceeded(
                f"Rate limit exceeded. Try again in {retry_after:.0f} seconds.",
                retry_after
            )
    
    async def _get_bucket(self, client_id: str) -> TokenBucket:
        """Get or create token bucket for client."""
        async with self._lock:
            if client_id not in self._buckets:
                self._buckets[client_id] = TokenBucket(
                    capacity=self.config.burst_size,
                    refill_rate=self.refill_rate
                )
            return self._buckets[client_id]
    
    async def get_limit_info(self, client_id: str) -> Dict[str, any]:
        """
        Get rate limit info for client.
        
        Args:
            client_id: Client identifier
            
        Returns:
            Dict with limit, remaining, reset info
        """
        bucket = await self._get_bucket(client_id)
        remaining = bucket.get_remaining()
        
        return {
            'limit': self.config.requests_per_window,
            'remaining': max(0, remaining),
            'reset': int(time.time() + self.config.window_seconds),
            'window_seconds': self.config.window_seconds
        }
    
    async def reset_client(self, client_id: str) -> None:
        """Reset rate limit for specific client."""
        async with self._lock:
            if client_id in self._buckets:
                del self._buckets[client_id]
                logger.info(f"Rate limit reset for {client_id}")
    
    async def _cleanup_loop(self):
        """Background task to clean up old buckets."""
        while self._running:
            try:
                await asyncio.sleep(self.config.cleanup_interval)
                await self._cleanup_old_buckets()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in rate limiter cleanup: {e}")
    
    async def _cleanup_old_buckets(self):
        """Remove buckets that haven't been used recently."""
        async with self._lock:
            max_age = self.config.window_seconds * 2  # 2x the window
            expired = [
                client_id
                for client_id, bucket in self._buckets.items()
                if bucket.is_expired(max_age)
            ]
            
            for client_id in expired:
                del self._buckets[client_id]
            
            if expired:
                logger.debug(f"Cleaned up {len(expired)} expired rate limit buckets")
    
    def get_statistics(self) -> Dict[str, any]:
        """
        Get rate limiter statistics.
        
        Returns:
            Dict with statistics
        """
        return {
            'total_requests': self._total_requests,
            'total_limited': self._total_limited,
            'active_clients': len(self._buckets),
            'limit_rate': (
                f"{self._total_limited / self._total_requests * 100:.2f}%"
                if self._total_requests > 0
                else "0%"
            ),
            'config': {
                'requests_per_window': self.config.requests_per_window,
                'window_seconds': self.config.window_seconds,
                'burst_size': self.config.burst_size,
                'strategy': self.config.strategy.value
            }
        }


class MultiTierRateLimiter:
    """
    Multi-tier rate limiter with different limits for different tiers.
    
    Use cases:
    - Free vs paid users
    - Different API endpoints
    - Multiple time windows
    """
    
    def __init__(self):
        """Initialize multi-tier rate limiter."""
        self._limiters: Dict[str, RateLimiter] = {}
        self._tier_configs: Dict[str, RateLimitConfig] = {}
    
    def add_tier(self, tier_name: str, config: RateLimitConfig) -> None:
        """
        Add a rate limit tier.
        
        Args:
            tier_name: Name of the tier (e.g., "free", "premium", "api_heavy")
            config: Rate limit configuration for this tier
        """
        self._tier_configs[tier_name] = config
        self._limiters[tier_name] = RateLimiter(config)
        logger.info(f"Added rate limit tier '{tier_name}': {config.requests_per_window} req/{config.window_seconds}s")
    
    async def start(self):
        """Start all tier limiters."""
        for limiter in self._limiters.values():
            await limiter.start()
    
    async def stop(self):
        """Stop all tier limiters."""
        for limiter in self._limiters.values():
            await limiter.stop()
    
    async def check_rate_limit(
        self,
        client_id: str,
        tier: str = "default",
        tokens: int = 1
    ) -> None:
        """
        Check rate limit for specific tier.
        
        Args:
            client_id: Client identifier
            tier: Tier name
            tokens: Number of tokens to consume
            
        Raises:
            RateLimitExceeded: If rate limit exceeded
            ValueError: If tier doesn't exist
        """
        if tier not in self._limiters:
            raise ValueError(f"Unknown rate limit tier: {tier}")
        
        await self._limiters[tier].check_rate_limit(client_id, tokens)
    
    async def get_limit_info(self, client_id: str, tier: str = "default") -> Dict[str, any]:
        """Get rate limit info for specific tier."""
        if tier not in self._limiters:
            raise ValueError(f"Unknown rate limit tier: {tier}")
        
        return await self._limiters[tier].get_limit_info(client_id)
    
    def get_statistics(self) -> Dict[str, Dict[str, any]]:
        """Get statistics for all tiers."""
        return {
            tier: limiter.get_statistics()
            for tier, limiter in self._limiters.items()
        }


# Default rate limit configurations
DEFAULT_CONFIGS = {
    'api_default': RateLimitConfig(
        requests_per_window=100,
        window_seconds=60.0,
        strategy=RateLimitStrategy.PER_IP
    ),
    'api_heavy': RateLimitConfig(
        requests_per_window=20,
        window_seconds=60.0,
        strategy=RateLimitStrategy.PER_IP
    ),
    'chat_streaming': RateLimitConfig(
        requests_per_window=10,
        window_seconds=60.0,
        strategy=RateLimitStrategy.PER_IP
    ),
    'file_upload': RateLimitConfig(
        requests_per_window=5,
        window_seconds=60.0,
        strategy=RateLimitStrategy.PER_IP
    ),
    'websocket': RateLimitConfig(
        requests_per_window=1000,  # Higher limit for message bursts
        window_seconds=60.0,
        strategy=RateLimitStrategy.PER_IP
    ),
}


# Global rate limiter instance
_global_limiter: Optional[MultiTierRateLimiter] = None


def get_rate_limiter() -> MultiTierRateLimiter:
    """Get or create global rate limiter."""
    global _global_limiter
    if _global_limiter is None:
        _global_limiter = MultiTierRateLimiter()
        
        # Add default tiers
        for tier_name, config in DEFAULT_CONFIGS.items():
            _global_limiter.add_tier(tier_name, config)
    
    return _global_limiter


async def check_rate_limit(
    client_id: str,
    tier: str = "api_default",
    tokens: int = 1
) -> None:
    """
    Check rate limit using global limiter.
    
    Args:
        client_id: Client identifier (typically IP address)
        tier: Rate limit tier
        tokens: Number of tokens to consume
        
    Raises:
        RateLimitExceeded: If rate limit exceeded
    """
    limiter = get_rate_limiter()
    await limiter.check_rate_limit(client_id, tier, tokens)


async def get_limit_info(client_id: str, tier: str = "api_default") -> Dict[str, any]:
    """Get rate limit info for client."""
    limiter = get_rate_limiter()
    return await limiter.get_limit_info(client_id, tier)

