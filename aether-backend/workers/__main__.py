"""
Workers Module Entry Point

Allows running worker as: python -m workers
Follows Python module pattern for background services.

@.architecture
Incoming: CLI invocation (python -m workers) --- {command line args}
Processing: Parse args, configure logging, start job_processor --- {2 jobs: JOB_CONFIG, JOB_ORCHESTRATE}
Outgoing: job_processor.main_loop() --- {Worker execution}
"""

import argparse
import asyncio
import logging
import sys

from workers.job_processor import main_loop
from config.settings import get_settings


def configure_logging(verbose: bool = False) -> None:
    """
    Configure logging for worker process.
    
    Args:
        verbose: Enable debug-level logging
    """
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s :: %(message)s",
        handlers=[
            logging.StreamHandler(sys.stdout)
        ]
    )


def parse_args() -> argparse.Namespace:
    """
    Parse command line arguments.
    
    Returns:
        Parsed arguments
    """
    parser = argparse.ArgumentParser(
        description="Background job worker for chat summarization and memory extraction",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )
    
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable verbose (DEBUG) logging"
    )
    
    parser.add_argument(
        "--poll-interval",
        type=float,
        help="Override poll interval (seconds) from config"
    )
    
    parser.add_argument(
        "--batch-size",
        type=int,
        help="Override batch size from config"
    )
    
    parser.add_argument(
        "--max-concurrent",
        type=int,
        help="Override max concurrent jobs from config"
    )
    
    return parser.parse_args()


def main() -> None:
    """
    Main entry point for worker module.
    
    Parses args, configures logging, starts worker loop.
    """
    args = parse_args()
    
    # Configure logging
    configure_logging(verbose=args.verbose)
    
    # Load settings (can be overridden by CLI args)
    full_settings = get_settings()
    settings = full_settings.workers
    
    # Override settings from CLI if provided
    if args.poll_interval is not None:
        settings.poll_interval = args.poll_interval
    if args.batch_size is not None:
        settings.batch_size = args.batch_size
    if args.max_concurrent is not None:
        settings.max_concurrent = args.max_concurrent
    
    # Log startup configuration
    logger = logging.getLogger("workers")
    logger.info("=" * 60)
    logger.info("Background Job Worker Starting")
    logger.info("=" * 60)
    logger.info("Poll interval: %ss", settings.poll_interval)
    logger.info("Batch size: %s", settings.batch_size)
    logger.info("Max concurrent: %s", settings.max_concurrent)
    logger.info("Health check interval: %ss", settings.health_check_interval)
    logger.info("Verbose logging: %s", args.verbose)
    logger.info("=" * 60)
    
    try:
        # Run main worker loop
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        logger.info("Worker interrupted by user (Ctrl+C)")
    except Exception as e:  # noqa: BLE001 -- top-level entrypoint: must catch all to log before exit
        logger.error("Worker failed with error: %s", e, exc_info=True)
        sys.exit(1)
    
    logger.info("Worker shutdown complete")


if __name__ == "__main__":
    main()
