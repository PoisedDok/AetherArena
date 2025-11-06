"""
Code Validator - Security layer to prevent dangerous code execution

Prevents the agent from:
- Running backend startup scripts
- Importing system launcher modules
- Restarting already-running services
- Executing destructive system operations
"""

import re
from typing import Tuple, Optional


# Patterns for dangerous operations
DANGEROUS_PATTERNS = [
    # Backend startup scripts
    (r'start_integrated_backend', 'Backend services are already running. Use API calls instead.'),
    (r'start_xlwings_server', 'xlwings service is already running. Use computer.xlwings.* functions.'),
    (r'xlwings_api_server', 'xlwings API server is already running. Use computer.xlwings.* functions.'),
    (r'from\s+backend\.launcher', 'Do not import launcher modules. Backend is already running.'),
    (r'import\s+start_integrated_backend', 'Do not import startup scripts. Backend is already running.'),
    
    # Subprocess calls to backend scripts
    (r'subprocess.*start_integrated_backend', 'Do not run backend scripts. Services are already running.'),
    (r'subprocess.*start_xlwings', 'Do not run xlwings server. Service is already running.'),
    (r'os\.system.*start_integrated_backend', 'Do not run backend scripts. Services are already running.'),
    
    # Direct python execution of backend scripts
    (r'python\s+.*start_integrated_backend\.py', 'Backend is already running. Use API calls.'),
    (r'python3\s+.*start_integrated_backend\.py', 'Backend is already running. Use API calls.'),
    
    # Service restarts
    (r'uvicorn.*backend\.app', 'Backend server is already running on port 8765.'),
    (r'fastapi.*backend\.app', 'Backend server is already running on port 8765.'),
]


def validate_code(code: str, language: str) -> Tuple[bool, Optional[str]]:
    """
    Validate code for dangerous operations.
    
    Args:
        code: The code to validate
        language: The programming language (python, shell, etc.)
    
    Returns:
        (is_safe, error_message): Tuple indicating if code is safe and optional error message
    """
    if language not in ('python', 'shell', 'bash', 'sh'):
        # Only validate Python and shell code
        return True, None
    
    code_lower = code.lower()
    
    for pattern, error_msg in DANGEROUS_PATTERNS:
        if re.search(pattern, code, re.IGNORECASE):
            return False, f"🚫 SECURITY BLOCK: {error_msg}"
    
    return True, None


def get_safe_alternative(blocked_code: str) -> str:
    """
    Suggest safe alternatives for blocked operations.
    
    Args:
        blocked_code: The code that was blocked
    
    Returns:
        Helpful suggestion for safe alternative
    """
    suggestions = {
        'start_integrated_backend': """
Instead of running start_integrated_backend.py, the backend is ALREADY RUNNING.
Use the provided APIs:
- computer.xlwings.* for Excel operations
- computer.perplexica_search() for web search
- computer.web_search() for general search
- And other computer.* functions
""",
        'start_xlwings': """
Instead of starting xlwings server, use the xlwings API:

Example - Create Excel workbook:
```python
# CORRECT - Use API
result = computer.xlwings.create_workbook()
wb_id = result['workbook_id']
computer.xlwings.write_data(wb_id, "Sheet1", [["A", "B"], [1, 2]])
computer.xlwings.save_workbook(wb_id, "output.xlsx")
```

❌ WRONG - Don't run scripts:
```python
import subprocess
subprocess.run(['python', 'start_xlwings_server.py'])  # This is blocked
```
""",
        'backend': """
Backend services are already running and managed by the system.
Use computer.* functions to interact with services instead of managing them directly.
"""
    }
    
    for key, suggestion in suggestions.items():
        if key in blocked_code.lower():
            return suggestion
    
    return "Backend services are already running. Use computer.* API functions instead."

