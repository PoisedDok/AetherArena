"""
Rate Limiting - Security Layer

@.architecture
Incoming: api/middleware/rate_limiter.py, HTTP requests --- {http_request, Dict[str, Any]}
Processing: manage token buckets, enforce rate tiers, schedule cleanup, emit enforcement logs --- {JOB_CLEANUP_RESOURCE, JOB_LOG, JOB_MANAGE_RATE_LIMITS, JOB_SCHEDULE_TASK}
Outgoing: api/middleware/rate_limiter.py --- {RateLimiter, Dict[str, Any]}
"""

import time
import asyncio
import logging
from typing import Any, Dict, Optional, Tuple
from dataclasses import dataclass
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


class RedisRateLimitBackend:
    """
    Redis-backed token bucket implementation for multi-process rate limiting.
    """

    _LUA_SCRIPT = """
    local key = KEYS[1]
    local now = tonumber(ARGV[1])
    local refill_rate = tonumber(ARGV[2])
    local capacity = tonumber(ARGV[3])
    local requested = tonumber(ARGV[4])
    local ttl = tonumber(ARGV[5])
    local bucket = redis.call('HMGET', key, 'tokens', 'timestamp')
    local tokens = tonumber(bucket[1])
    local timestamp = tonumber(bucket[2])
    if tokens == nil then tokens = capacity end
    if timestamp == nil then timestamp = now end
    if tokens < 0 then tokens = 0 end
    local elapsed = math.max(0, now - timestamp)
    tokens = math.min(capacity, tokens + (elapsed * refill_rate))
    local allowed = 0
    if tokens >= requested then
      allowed = 1
      tokens = tokens - requested
    end
    redis.call('HMSET', key, 'tokens', tokens, 'timestamp', now)
    redis.call('EXPIRE', key, ttl)
    return {allowed, tokens}
    """

    def __init__(
        self,
        cache: Any,
        *,
        namespace: str = "rate",
        bucket_ttl: int = 180,
    ):
        self.cache = cache
        self.namespace = namespace
        self.bucket_ttl = bucket_ttl

    def _bucket_key(self, tier: str, client_id: str) -> str:
        return f"{self.namespace}:{tier}:{client_id}"

    async def consume(
        self,
        tier_config: RateLimitConfig,
        tier: str,
        client_id: str,
        tokens: int,
    ) -> Optional[Tuple[bool, float]]:
        """
        Attempt to consume tokens from Redis bucket.
        Returns (allowed, retry_after_seconds) or None on backend failure.
        """
        client = self.cache.raw_client
        if not self.cache or not self.cache.is_connected() or client is None:
            return None
        
        refill_rate = tier_config.requests_per_window / tier_config.window_seconds
        capacity = tier_config.burst_size or tier_config.requests_per_window
        ttl = max(self.bucket_ttl, int(tier_config.window_seconds * 2))
        bucket_key = f"{self.cache.namespace}:{self._bucket_key(tier, client_id)}"
        
        try:
            result = await client.eval(
                self._LUA_SCRIPT,
                numkeys=1,
                keys=[bucket_key],
                args=[
                    time.time(),
                    refill_rate,
                    capacity,
                    tokens,
                    ttl,
                ],
            )
            allowed = bool(int(result[0]))
            remaining = float(result[1])
            retry_after = 0.0
            if not allowed:
                deficit = max(0.0, tokens - remaining)
                retry_after = deficit / refill_rate if refill_rate > 0 else ttl
            return allowed, retry_after
        except Exception as e:
            logger.warning("Redis rate limiter degraded: %s", e)
            return None

    async def get_bucket_info(
        self,
        tier_config: RateLimitConfig,
        tier: str,
        client_id: str,
    ) -> Optional[Dict[str, Any]]:
        if not self.cache or not self.cache.is_connected():
            return None
        try:
            key = f"{self.cache.namespace}:{self._bucket_key(tier, client_id)}"
            data = await self.cache.hgetall(key)
            if not data:
                return None
            tokens = float(data.get("tokens", tier_config.burst_size))
            timestamp = float(data.get("timestamp", time.time()))
            reset = max(0, int(timestamp + tier_config.window_seconds - time.time()))
            return {
                "limit": tier_config.requests_per_window,
                "remaining": max(0, int(tokens)),
                "reset": reset,
                "window_seconds": tier_config.window_seconds,
            }
        except Exception:
            return None


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
                logger.info("Rate limit reset for %s", client_id)
    
    async def _cleanup_loop(self):
        """Background task to clean up old buckets."""
        while self._running:
            try:
                await asyncio.sleep(self.config.cleanup_interval)
                await self._cleanup_old_buckets()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("Error in rate limiter cleanup: %s", e)
    
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
                logger.debug("Cleaned up %d expired rate limit buckets", len(expired))
    
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
        self._cache_backend: Optional[RedisRateLimitBackend] = None
    
    def add_tier(self, tier_name: str, config: RateLimitConfig) -> None:
        """
        Add a rate limit tier.
        
        Args:
            tier_name: Name of the tier (e.g., "free", "premium", "api_heavy")
            config: Rate limit configuration for this tier
        """
        self._tier_configs[tier_name] = config
        self._limiters[tier_name] = RateLimiter(config)
        logger.info("Added rate limit tier '%s': %d req/%ds", tier_name, config.requests_per_window, config.window_seconds)
    
    def set_cache_backend(self, backend: Optional[RedisRateLimitBackend]) -> None:
        """Configure Redis-backed token bucket."""
        self._cache_backend = backend
    
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
        backend = self._cache_backend
        tier_config = self._tier_configs.get(tier)
        if backend and tier_config:
            result = await backend.consume(tier_config, tier, client_id, tokens)
            if result is not None:
                allowed, retry_after = result
                if allowed:
                    return
                raise RateLimitExceeded(
                    f"Rate limit exceeded. Try again in {retry_after:.0f} seconds.",
                    retry_after,
                )
        await self._limiters[tier].check_rate_limit(client_id, tokens)
    
    async def get_limit_info(self, client_id: str, tier: str = "default") -> Dict[str, any]:
        """Get rate limit info for specific tier."""
        if tier not in self._limiters:
            raise ValueError(f"Unknown rate limit tier: {tier}")
        backend = self._cache_backend
        tier_config = self._tier_configs.get(tier)
        if backend and tier_config:
            info = await backend.get_bucket_info(tier_config, tier, client_id)
            if info:
                return info
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
_redis_backend: Optional[RedisRateLimitBackend] = None


def get_rate_limiter() -> MultiTierRateLimiter:
    """Get or create global rate limiter."""
    global _global_limiter
    if _global_limiter is None:
        configure_rate_limits(DEFAULT_CONFIGS, reset=True)
    return _global_limiter


def configure_rate_limits(
    tier_configs: Dict[str, RateLimitConfig],
    *,
    reset: bool = True,
) -> None:
    """
    Configure global rate limiter tiers from configuration.
    
    Args:
        tier_configs: Mapping of tier name -> RateLimitConfig
        reset: Whether to replace existing limiter (default True)
    """
    global _global_limiter
    limiter = MultiTierRateLimiter()
    for tier_name, config in tier_configs.items():
        limiter.add_tier(tier_name, config)
    if _redis_backend:
        limiter.set_cache_backend(_redis_backend)
    if reset or _global_limiter is None:
        _global_limiter = limiter
    else:
        # Merge existing limiter statistics if needed by replacing reference
        _global_limiter = limiter


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


def configure_cache_backend(
    cache: Any,
    *,
    namespace: str = "rate",
    bucket_ttl: int = 180,
) -> None:
    """
    Configure Redis as the backing store for rate limiting.
    """
    global _redis_backend
    if cache is None:
        return
    _redis_backend = RedisRateLimitBackend(
        cache,
        namespace=namespace,
        bucket_ttl=bucket_ttl,
    )
    limiter = get_rate_limiter()
    limiter.set_cache_backend(_redis_backend)
    logger.info("Rate limiter now using Redis backend (namespace=%s)", namespace)

