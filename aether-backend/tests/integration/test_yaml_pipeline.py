"""
Test YAML Pipeline Integration (legal-clean)

Tests the Aether-owned YAML generation pipeline WITHOUT importing vendored Open Interpreter code:
1. Backend generates backend_tools_registry.yaml from OpenAPI
2. YAML has expected structure and non-empty tool catalog
"""



async def test_yaml_pipeline():
    """Test backend YAML generation + structure (no Open Interpreter runtime)."""
    try:
        # 1. Test Backend YAML Generation
        from config.settings import get_settings
        from app import create_app
        from core.integrations.framework import generate_backend_tools_yaml
        
        settings = get_settings()
        app = create_app()
        
        success = generate_backend_tools_yaml(
            fastapi_app=app,
            settings=settings
        )
        
        if not success:
            return False
        
        yaml_path = settings.config_dir / "backend_tools_registry.yaml"
        if not yaml_path.exists():
            return False

        # Check YAML content
        import yaml
        with open(yaml_path, 'r') as f:
            backend_data = yaml.safe_load(f)

        if not isinstance(backend_data, dict):
            return False
        if "metadata" not in backend_data or "categories" not in backend_data:
            return False

        categories = backend_data.get("categories") or {}
        if not isinstance(categories, dict):
            return False
        if len(categories) == 0:
            return False

        # Ensure there is at least one tool somewhere
        total_tools = 0
        for cat_data in categories.values():
            if isinstance(cat_data, dict):
                tools = cat_data.get("tools", [])
                if isinstance(tools, list):
                    total_tools += len(tools)
        if total_tools <= 0:
            return False

        return True
        
    except Exception:
        return False


