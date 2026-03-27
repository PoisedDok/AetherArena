"""
Shared HTTP wait helpers for E2E tests.
"""

import asyncio
from typing import Optional

from httpx import AsyncClient


async def wait_for_endpoint(
    client: AsyncClient,
    path: str,
    attempts: int = 5,
    delay: float = 2.0,
) -> Optional[int]:
    for attempt in range(attempts):
        try:
            response = await client.get(path)
            return response.status_code
        except Exception:
            if attempt == attempts - 1:
                return None
            await asyncio.sleep(delay)
    return None
