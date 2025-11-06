"""
Test YAML Pipeline Integration

Tests the complete YAML-based tool loading pipeline:
1. Backend generates backend_tools_registry.yaml
2. OI loads both registries
3. Unified tool catalog available
"""

import sys
import asyncio
from pathlib import Path

# Add backend to path
backend_root = Path(__file__).parent.parent
sys.path.insert(0, str(backend_root))


async def test_yaml_pipeline():
    """Test complete YAML pipeline"""
    print("=" * 80)
    print("YAML PIPELINE INTEGRATION TEST")
    print("=" * 80)
    
    try:
        # 1. Test Backend YAML Generation
        print("\n[1/3] Testing backend YAML generation...")
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
            print("  ❌ Backend YAML generation failed")
            return False
        
        yaml_path = settings.config_dir / "backend_tools_registry.yaml"
        if not yaml_path.exists():
            print(f"  ❌ YAML not found: {yaml_path}")
            return False
        
        print(f"  ✅ Backend YAML generated: {yaml_path}")
        
        # Check YAML content
        import yaml
        with open(yaml_path, 'r') as f:
            backend_data = yaml.safe_load(f)
        
        categories_count = len(backend_data.get('categories', {}))
        print(f"     Categories: {categories_count}")
        
        # 2. Test OI Registry Loading
        print("\n[2/3] Testing OI registry loading...")
        
        # Change to OI directory for tools_loader import
        oi_computer_path = backend_root / "services" / "open-interpreter" / "interpreter" / "core" / "computer"
        sys.path.insert(0, str(oi_computer_path))
        
        from tools_loader import load_tool_registry
        
        combined_registry = load_tool_registry()
        
        if not combined_registry:
            print("  ❌ Failed to load combined registry")
            return False
        
        combined_categories = len(combined_registry.get('categories', {}))
        print(f"  ✅ Combined registry loaded")
        print(f"     Total categories: {combined_categories}")
        
        metadata = combined_registry.get('metadata', {})
        if metadata.get('combined'):
            oi_cats = metadata.get('oi_categories', 0)
            backend_cats = metadata.get('backend_categories', 0)
            print(f"     OI categories: {oi_cats}")
            print(f"     Backend categories: {backend_cats}")
        
        # 3. Test Tool Discovery
        print("\n[3/3] Testing tool discovery...")
        
        categories = combined_registry.get('categories', {})
        
        # Count tools
        total_tools = 0
        oi_tools = 0
        backend_tools = 0
        
        for cat_name, cat_data in categories.items():
            tools_in_cat = len(cat_data.get('tools', []))
            total_tools += tools_in_cat
            
            # Check if backend category
            if 'Backend:' in cat_name or cat_data.get('integration'):
                backend_tools += tools_in_cat
            else:
                oi_tools += tools_in_cat
        
        print(f"  ✅ Tool discovery complete")
        print(f"     Total tools: {total_tools}")
        print(f"     OI built-in tools: {oi_tools}")
        print(f"     Backend API tools: {backend_tools}")
        
        # Sample tools
        print(f"\n  Sample categories:")
        for cat_name in list(categories.keys())[:5]:
            tool_count = len(categories[cat_name].get('tools', []))
            print(f"    - {cat_name}: {tool_count} tools")
        
        print("\n" + "=" * 80)
        print("✅ YAML PIPELINE TEST PASSED")
        print("=" * 80)
        print("\nPipeline Flow:")
        print("  1. Backend generates backend_tools_registry.yaml from OpenAPI")
        print("  2. OI loads tools_registry.yaml (built-in) + backend_tools_registry.yaml")
        print("  3. Unified tool catalog available with NO hardcoded data")
        print("\nClean separation achieved:")
        print(f"  - OI tools: {oi_tools}")
        print(f"  - Backend tools: {backend_tools}")
        print(f"  - Total unified: {total_tools}")
        
        return True
        
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(test_yaml_pipeline())
    sys.exit(0 if success else 1)

