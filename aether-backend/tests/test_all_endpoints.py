#!/usr/bin/env python3
"""
Comprehensive API Endpoint Testing Script

Tests all Aether Backend endpoints and generates detailed report.
"""

import httpx
import json
import time
from typing import Dict, Any, List, Tuple
from datetime import datetime
import sys
import uuid

BASE_URL = "http://127.0.0.1:5002"
TIMEOUT = 30.0

class Colors:
    GREEN = '\033[92m'
    RED = '\033[91m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    RESET = '\033[0m'

class EndpointTest:
    def __init__(self, method: str, path: str, description: str, 
                 payload: Any = None, query: Dict = None, 
                 expected_status: int = 200):
        self.method = method
        self.path = path
        self.description = description
        self.payload = payload
        self.query = query
        self.expected_status = expected_status
        self.result = None
        self.status_code = None
        self.response_time = None
        self.error = None
        
    def run(self, client: httpx.Client) -> bool:
        """Run the test and return success status."""
        url = f"{BASE_URL}{self.path}"
        
        try:
            start = time.time()
            
            if self.method == "GET":
                response = client.get(url, params=self.query)
            elif self.method == "POST":
                response = client.post(url, json=self.payload, params=self.query)
            elif self.method == "PUT":
                response = client.put(url, json=self.payload)
            elif self.method == "PATCH":
                response = client.patch(url, json=self.payload)
            elif self.method == "DELETE":
                response = client.delete(url)
            else:
                raise ValueError(f"Unsupported method: {self.method}")
            
            self.response_time = (time.time() - start) * 1000
            self.status_code = response.status_code
            
            try:
                self.result = response.json()
            except:
                self.result = response.text
            
            # Check if status matches expected
            success = self.status_code == self.expected_status
            
            return success
            
        except Exception as e:
            self.error = str(e)
            return False
    
    def __str__(self) -> str:
        status = f"{Colors.GREEN}PASS{Colors.RESET}" if self.status_code == self.expected_status else f"{Colors.RED}FAIL{Colors.RESET}"
        return f"{status} | {self.method:6} {self.path:40} | {self.status_code or 'ERR':3} | {self.response_time:6.0f}ms | {self.description}"

# =============================================================================
# Test Definitions
# =============================================================================

TESTS = [
    # Root & Health
    EndpointTest("GET", "/", "Root endpoint"),
    EndpointTest("GET", "/v1/health", "Simple health check"),
    EndpointTest("GET", "/v1/health/detailed", "Detailed health check"),
    EndpointTest("GET", "/v1/health/ready", "Readiness probe"),
    EndpointTest("GET", "/v1/health/live", "Liveness probe"),
    EndpointTest("GET", "/v1/api/status", "Legacy status endpoint"),
    
    # Health - Component checks (test a few)
    EndpointTest("GET", "/v1/health/component/system", "System component health"),
    EndpointTest("GET", "/v1/health/component/runtime", "Runtime component health", expected_status=200),
    EndpointTest("GET", "/v1/health/component/database", "Database component health", expected_status=200),
    EndpointTest("GET", "/v1/health/component/nonexistent", "Non-existent component", expected_status=404),
    
    # Settings
    EndpointTest("GET", "/v1/settings", "Get application settings"),
    EndpointTest("POST", "/v1/settings", "Update settings (POST)", 
                 payload={"llm": {"temperature": 0.8}}),
    EndpointTest("PUT", "/v1/settings", "Update settings (PUT)", 
                 payload={"llm": {"temperature": 0.7}}),
    EndpointTest("PATCH", "/v1/settings", "Update settings (PATCH)", 
                 payload={"llm": {"temperature": 0.7}}),
    EndpointTest("POST", "/v1/settings/reload", "Reload settings"),
    
    # Models
    EndpointTest("GET", "/v1/models", "List models", 
                 query={"base": "http://localhost:1234/v1"}),
    EndpointTest("GET", "/v1/models/active", "Get active model"),
    EndpointTest("GET", "/v1/models/capabilities", "Model capabilities",
                 query={"model": "qwen/qwen3-4b-2507"}),
    
    # Profiles
    EndpointTest("GET", "/v1/profiles", "List profiles"),
    EndpointTest("GET", "/v1/profiles/active", "Get active profile"),
    EndpointTest("POST", "/v1/profiles/switch", "Switch profile",
                 payload={"profile": "default"}),
    EndpointTest("GET", "/v1/profiles/GURU.yaml", "Get profile details", expected_status=404),  # May not exist
    
    # Skills
    EndpointTest("GET", "/v1/skills", "List skills"),
    EndpointTest("POST", "/v1/skills/new", "Create new skill",
                 payload={"name": f"test_skill_{str(uuid.uuid4())[:8]}", "content": "def test(): pass"}),
    EndpointTest("POST", "/v1/skills/import", "Import skill",
                 payload={"name": f"imported_skill_{str(uuid.uuid4())[:8]}", "content": "def imported(): pass"}),
    
    # Terminal
    EndpointTest("GET", "/v1/launch_terminal", "Launch terminal"),
    
    # Files
    EndpointTest("POST", "/v1/files/upload", "Upload file (no file)", expected_status=422),
    EndpointTest("GET", "/v1/files", "List files"),
    
    # Chat
    EndpointTest("POST", "/v1/chat", "Send chat message", 
                 payload={"message": "Hello"}, expected_status=200),
    EndpointTest("GET", "/v1/chat/history/default", "Get chat history", expected_status=200),
    
    # Storage  
    EndpointTest("GET", "/v1/api/storage", "List storage items", expected_status=200),
    EndpointTest("GET", "/v1/api/storage/stats", "Get storage stats", expected_status=200),
    EndpointTest("GET", "/v1/api/health", "Storage health check"),
    
    # Storage - Chat operations (stubs)
    EndpointTest("POST", "/v1/api/chats", "Create chat",
                 payload={"title": "Test Chat"}, expected_status=501),
    EndpointTest("GET", "/v1/api/chats/00000000-0000-0000-0000-000000000000", 
                 "Get chat (stub)", expected_status=501),
    EndpointTest("PUT", "/v1/api/chats/00000000-0000-0000-0000-000000000000",
                 "Update chat (stub)", payload={"title": "Updated"}, expected_status=501),
    EndpointTest("DELETE", "/v1/api/chats/00000000-0000-0000-0000-000000000000",
                 "Delete chat (stub)", expected_status=501),
    
    # MCP
    EndpointTest("GET", "/v1/api/mcp/servers", "List MCP servers"),
    EndpointTest("GET", "/v1/api/mcp/health", "MCP system health"),
    EndpointTest("POST", "/v1/api/mcp/servers", "Register MCP server",
                 payload={
                     "name": f"test-mcp-{str(uuid.uuid4())[:8]}",  # Unique name each run
                     "display_name": "Test MCP Server",
                     "server_type": "local",
                     "config": {
                         "command": "python",
                         "args": ["-m", "mcp_server"],
                         "transport": "stdio"
                     },
                     "auto_start": False
                 }, expected_status=201),
    # Note: Following tests expect non-existent server, so we expect errors  
    # (We're not testing with real test-mcp server registration/start)
]

# =============================================================================
# Test Runner
# =============================================================================

def run_all_tests() -> Tuple[List[EndpointTest], Dict[str, Any]]:
    """Run all tests and return results."""
    print(f"{Colors.BLUE}{'='*100}{Colors.RESET}")
    print(f"{Colors.BLUE}Aether Backend API Endpoint Testing{Colors.RESET}")
    print(f"{Colors.BLUE}{'='*100}{Colors.RESET}")
    print(f"Base URL: {BASE_URL}")
    print(f"Total Tests: {len(TESTS)}")
    print(f"Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{Colors.BLUE}{'='*100}{Colors.RESET}\n")
    
    client = httpx.Client(timeout=TIMEOUT)
    
    passed = 0
    failed = 0
    errors = 0
    
    for i, test in enumerate(TESTS, 1):
        success = test.run(client)
        
        if test.error:
            errors += 1
            print(f"{Colors.RED}ERR {Colors.RESET} | {test.method:6} {test.path:40} | ERROR: {test.error}")
        elif success:
            passed += 1
            print(str(test))
        else:
            failed += 1
            print(str(test))
        
        # Small delay between requests
        time.sleep(0.1)
    
    client.close()
    
    stats = {
        "total": len(TESTS),
        "passed": passed,
        "failed": failed,
        "errors": errors,
        "pass_rate": (passed / len(TESTS) * 100) if len(TESTS) > 0 else 0
    }
    
    return TESTS, stats

def print_summary(tests: List[EndpointTest], stats: Dict[str, Any]):
    """Print test summary."""
    print(f"\n{Colors.BLUE}{'='*100}{Colors.RESET}")
    print(f"{Colors.BLUE}Test Summary{Colors.RESET}")
    print(f"{Colors.BLUE}{'='*100}{Colors.RESET}")
    print(f"Total Tests: {stats['total']}")
    print(f"{Colors.GREEN}Passed: {stats['passed']}{Colors.RESET}")
    print(f"{Colors.RED}Failed: {stats['failed']}{Colors.RESET}")
    print(f"{Colors.YELLOW}Errors: {stats['errors']}{Colors.RESET}")
    print(f"Pass Rate: {stats['pass_rate']:.1f}%")
    
    # Show failures
    if stats['failed'] > 0 or stats['errors'] > 0:
        print(f"\n{Colors.RED}Failed/Error Tests:{Colors.RESET}")
        for test in tests:
            if test.error or (test.status_code and test.status_code != test.expected_status):
                print(f"  - {test.method} {test.path}")
                if test.error:
                    print(f"    Error: {test.error}")
                else:
                    print(f"    Expected {test.expected_status}, got {test.status_code}")
                    if isinstance(test.result, dict):
                        print(f"    Response: {json.dumps(test.result, indent=2)[:200]}")

def generate_report(tests: List[EndpointTest], stats: Dict[str, Any], output_file: str):
    """Generate detailed test report."""
    with open(output_file, 'w') as f:
        f.write("# Aether Backend API Test Report\n\n")
        f.write(f"**Test Date:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
        f.write(f"**Base URL:** {BASE_URL}\n")
        f.write(f"**Total Tests:** {stats['total']}\n")
        f.write(f"**Passed:** {stats['passed']}\n")
        f.write(f"**Failed:** {stats['failed']}\n")
        f.write(f"**Errors:** {stats['errors']}\n")
        f.write(f"**Pass Rate:** {stats['pass_rate']:.1f}%\n\n")
        
        f.write("## Detailed Results\n\n")
        
        categories = {}
        for test in tests:
            category = test.path.split('/')[1] if len(test.path.split('/')) > 1 else 'root'
            if category not in categories:
                categories[category] = []
            categories[category].append(test)
        
        for category, cat_tests in sorted(categories.items()):
            f.write(f"### {category.upper()}\n\n")
            f.write("| Status | Method | Endpoint | Status Code | Response Time | Description |\n")
            f.write("|--------|--------|----------|-------------|---------------|-------------|\n")
            
            for test in cat_tests:
                status_icon = "✅" if test.status_code == test.expected_status else "❌"
                if test.error:
                    status_icon = "⚠️"
                
                f.write(f"| {status_icon} | {test.method} | {test.path} | {test.status_code or 'ERR'} | "
                       f"{test.response_time:.0f}ms | {test.description} |\n")
            
            f.write("\n")
    
    print(f"\n{Colors.GREEN}Report generated: {output_file}{Colors.RESET}")

# =============================================================================
# Main
# =============================================================================

def main():
    """Main entry point."""
    try:
        tests, stats = run_all_tests()
        print_summary(tests, stats)
        
        # Generate report
        report_file = "/Volumes/Disk-D/Aether/Aether/AetherArena/aether-backend/docs/API_TEST_REPORT.md"
        generate_report(tests, stats, report_file)
        
        # Exit with error code if tests failed
        if stats['failed'] > 0 or stats['errors'] > 0:
            sys.exit(1)
        
    except KeyboardInterrupt:
        print(f"\n{Colors.YELLOW}Testing interrupted{Colors.RESET}")
        sys.exit(1)
    except Exception as e:
        print(f"\n{Colors.RED}Fatal error: {e}{Colors.RESET}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()

