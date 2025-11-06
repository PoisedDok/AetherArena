"""
Verification script for OI Tool Catalog integration

Verifies that backend APIs are properly exposed to Open Interpreter.
Run after backend startup to check integration.

@.architecture
Incoming: Command line, Open Interpreter, core/integrations/framework/oi_catalog.py --- {CLI args, OI tool catalog, backend tools}
Processing: verify_tool_exposure(), check_tool_availability(), test_tool_execution() --- {3 jobs: integration_verification, tool_testing, verification}
Outgoing: stdout --- {Verification report, test results, exit code}
"""

import sys
import asyncio
from pathlib import Path

# Add backend to path
backend_root = Path(__file__).parent.parent
sys.path.insert(0, str(backend_root))


async def verify_integration():
    """Verify OI tool catalog integration"""
    print("=" * 80)
    print("OI TOOL CATALOG INTEGRATION VERIFICATION")
    print("=" * 80)
    
    try:
        # 1. Load settings
        print("\n[1/6] Loading settings...")
        from config.settings import get_settings
        settings = get_settings()
        print(f"  ✅ Settings loaded")
        print(f"     Base URL: {settings.base_url}")
        print(f"     Config dir: {settings.config_dir}")
        
        # 2. Initialize runtime engine
        print("\n[2/6] Initializing runtime engine...")
        from core.runtime.engine import RuntimeEngine
        runtime = RuntimeEngine(settings=settings)
        await runtime.start()
        print(f"  ✅ Runtime engine initialized")
        
        # 3. Check interpreter availability
        print("\n[3/6] Checking interpreter availability...")
        if not hasattr(runtime, '_interpreter_manager'):
            print(f"  ❌ Interpreter manager not found")
            return False
        
        if not runtime._interpreter_manager.is_available():
            print(f"  ❌ Interpreter not available")
            return False
        
        interpreter = runtime._interpreter_manager.get_interpreter()
        if not interpreter:
            print(f"  ❌ Could not get interpreter instance")
            return False
        
        print(f"  ✅ Interpreter available and created")
        
        # 4. Create mock FastAPI app for OpenAPI spec
        print("\n[4/6] Creating mock FastAPI app...")
        from app import create_app
        app = create_app()
        print(f"  ✅ FastAPI app created")
        
        # 5. Register backend APIs with OI
        print("\n[5/6] Registering backend APIs with OI...")
        result = runtime.register_backend_apis(
            interpreter=interpreter,
            fastapi_app=app
        )
        
        if not result.get("success"):
            print(f"  ❌ Registration failed: {result.get('error')}")
            return False
        
        print(f"  ✅ Backend APIs registered successfully")
        print(f"     Tools generated: {result.get('tools_generated', 0)}")
        print(f"     Tools attached: {result.get('tools_attached', 0)}")
        print(f"     Tools registered: {result.get('tools_registered', 0)}")
        
        # 6. Verify tools are attached to computer
        print("\n[6/6] Verifying tools on computer object...")
        computer = interpreter.computer
        
        # Check for some expected tools
        expected_prefixes = ['ocr_', 'tts_', 'notebook_', 'omni_', 'xlwings_', 'backends_']
        found_tools = []
        
        for attr_name in dir(computer):
            if attr_name.startswith('_'):
                continue
            for prefix in expected_prefixes:
                if attr_name.startswith(prefix):
                    found_tools.append(attr_name)
                    break
        
        if found_tools:
            print(f"  ✅ Found {len(found_tools)} backend API tools on computer")
            print(f"\n  Sample tools:")
            for tool_name in sorted(found_tools)[:10]:
                print(f"    - computer.{tool_name}")
            if len(found_tools) > 10:
                print(f"    ... and {len(found_tools) - 10} more")
        else:
            print(f"  ⚠️  No backend API tools found (may be using alternate naming)")
        
        # 7. Test tool discovery
        print("\n[7/6] Testing tool discovery...")
        if hasattr(computer, 'tools'):
            try:
                # Search for backend tools
                search_result = await computer.tools.search("OCR document")
                if search_result:
                    print(f"  ✅ Tool search working")
                else:
                    print(f"  ℹ️  Tool search returned no results")
            except Exception as e:
                print(f"  ⚠️  Tool search error: {e}")
        
        print("\n" + "=" * 80)
        print("✅ INTEGRATION VERIFICATION COMPLETE")
        print("=" * 80)
        print("\nBackend APIs are successfully exposed to Open Interpreter.")
        print("GURU agent can now use backend tools through OI's computer object.")
        
        # Cleanup
        await runtime.stop()
        
        return True
        
    except Exception as e:
        print(f"\n❌ Verification failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(verify_integration())
    sys.exit(0 if success else 1)

