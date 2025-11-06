#!/usr/bin/env python3
"""
Production-ready SearXNG server for Perplexica integration.
Runs SearXNG as an HTTP server on port 4000 with robust error handling and logging.
"""

import os
import sys
import logging
from pathlib import Path

# Add SearXNG to path
searxng_path = Path(__file__).parent
sys.path.insert(0, str(searxng_path))

# Set environment variables for SearXNG
os.environ.setdefault('SEARXNG_DISABLE_ETC_SETTINGS', '1')
os.environ.setdefault('SEARXNG_DATA_DIR', str(searxng_path / 'data'))

def setup_searxng_venv():
    """Add SearXNG venv to path if it exists"""
    venv_lib = searxng_path / 'venv' / 'lib'
    try:
        if venv_lib.exists():
            for name in venv_lib.iterdir():
                if name.name.startswith('python'):
                    site_packages = name / 'site-packages'
                    if site_packages.exists():
                        sys.path.insert(0, str(site_packages))
                        print(f"✓ Added SearXNG venv to path: {site_packages}")
                    break
    except Exception as e:
        print(f"⚠ Warning: Could not add SearXNG venv to path: {e}")

def start_searxng_server():
    """Start production-ready SearXNG HTTP server"""
    try:
        setup_searxng_venv()
        
        # Configure production logging
        logging.basicConfig(
            level=logging.INFO,
            format='%(asctime)s | %(levelname)s | %(name)s | %(message)s'
        )
        logger = logging.getLogger(__name__)
        
        # Set SearXNG settings path
        settings_file = searxng_path / "searx" / "settings.yml"
        os.environ['SEARXNG_SETTINGS_PATH'] = str(settings_file)
        
        logger.info("Starting Aether SearXNG Server")
        logger.info(f"Settings file: {settings_file}")
        
        # Suppress SQLite warnings
        import warnings
        warnings.filterwarnings("ignore", message=".*SQLite library.*")
        logging.getLogger('searx.sqlitedb').setLevel(logging.CRITICAL)
        logging.getLogger('searx').setLevel(logging.WARNING)
        
        # Import SearXNG components
        from searx import settings
        from searx.webapp import app
        from searx.search import initialize
        
        # Production settings override
        settings['default_doi_resolver'] = 'doi.org'
        if 'doi_resolvers' not in settings:
            settings['doi_resolvers'] = {
                'doi.org': 'https://doi.org',
                'dx.doi.org': 'https://dx.doi.org'
            }
        
        # Force English locale to prevent regional result pollution
        if 'search' in settings:
            settings['search']['default_lang'] = 'en'
        
        # Initialize SearXNG
        logger.info("Initializing SearXNG search engines...")
        initialize(enable_checker=False, check_network=False, enable_metrics=False)
        
        # Configure Flask app for production
        app.config.update(
            HOST='127.0.0.1',
            PORT=4000,
            DEBUG=False,
            SECRET_KEY='aether_searxng_secret_key_production_2025',
            # Production settings
            JSON_SORT_KEYS=False,
            JSONIFY_PRETTYPRINT_REGULAR=False,
        )
        
        logger.info("=" * 60)
        logger.info("SearXNG Server Ready")
        logger.info("=" * 60)
        logger.info("URL: http://127.0.0.1:4000")
        logger.info("API: http://127.0.0.1:4000/search?format=json")
        logger.info("Serving Perplexica web search backend")
        logger.info("=" * 60)
        
        # Start production server
        app.run(
            host='127.0.0.1',
            port=4000,
            debug=False,
            threaded=True,
            use_reloader=False
        )
        
    except ImportError as e:
        print(f"❌ Failed to import SearXNG: {e}")
        print("Make sure SearXNG dependencies are installed:")
        print("  cd backend/searxng")
        print("  python3 -m venv venv")
        print("  source venv/bin/activate")
        print("  pip install -r requirements.txt")
        sys.exit(1)
    except Exception as e:
        print(f"❌ Failed to start SearXNG server: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    print("🚀 Starting Production SearXNG Server for Aether...")
    start_searxng_server()
