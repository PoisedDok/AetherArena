from interpreter import interpreter
from .config_loader import configure_interpreter

# GURU profile — Comprehensive AI legal assistant
# ALL integrations loaded by oi_runtime.py through IntegrationLoader
interpreter = configure_interpreter(interpreter)
interpreter.os = True

skill_path = "./skills"
interpreter.computer.skills.path = skill_path

setup_code = f"""import sys, subprocess, importlib
import datetime

def ensure(pkg, mod=None):
    try:
        importlib.import_module(mod or pkg)
    except Exception:
        subprocess.run([sys.executable, '-m', 'pip', 'install', pkg], check=False)

if not computer.interpreter.offline:
    ensure('selenium')
    ensure('webdriver-manager','webdriver_manager')
    ensure('html2text')
    ensure('pyautogui')
    ensure('pillow','PIL')
    ensure('screeninfo')
    ensure('pywinctl')
    ensure('requests')
    ensure('beautifulsoup4', 'bs4')
    ensure('lxml')
    ensure('matplotlib')
    ensure('numpy')
    ensure('pandas')
    ensure('jupyterlab')
    try:
        import importlib
        importlib.import_module('objc')
    except Exception:
        subprocess.run([sys.executable, '-m', 'pip', 'install', 'pyobjc-core', 'pyobjc'], check=False)

HAVE_SELENIUM = True

def setup_robust_driver():
    from selenium import webdriver
    from selenium.webdriver.chrome.service import Service
    from webdriver_manager.chrome import ChromeDriverManager

    service = Service(ChromeDriverManager().install())
    options = webdriver.ChromeOptions()
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')
    options.add_argument('--disable-gpu')
    options.add_argument('--disable-features=VizDisplayCompositor')
    options.add_argument('--disable-extensions')
    options.add_argument('--disable-plugins')
    options.add_argument('--disable-images')
    options.add_argument('--disable-javascript')
    options.add_argument('--window-size=1920,1080')
    options.add_argument('--disable-web-security')
    options.add_argument('--allow-running-insecure-content')
    options.add_argument('--headless=new')

    driver = webdriver.Chrome(service=service, options=options)
    driver.implicitly_wait(10)
    return driver

if HAVE_SELENIUM:
    computer.browser.setup = lambda headless=True: setattr(computer.browser, '_driver', setup_robust_driver())

computer.skills.path = '{skill_path}'
"""

interpreter.computer.import_computer_api = True
interpreter.computer.import_skills = True
interpreter.use_context_optimized_tools = True

interpreter.computer.system_message = """
# EXCEL AUTOMATION

Excel tools: `computer.xlwings.*`

✅ USAGE:
```python
wb = computer.xlwings.create_workbook()
wb_id = wb['workbook_id']
computer.xlwings.write_data(wb_id, "Sheet1", [["Name", "Age"], ["Alice", 30]])
computer.xlwings.save_workbook(wb_id, "output.xlsx")
computer.xlwings.close_workbook(wb_id)
```

FILES saved to: data/files/filename.xlsx
""".strip()

interpreter.speak_messages = False
interpreter.conversation_history = False
interpreter.debug = False
interpreter.verbose = False
interpreter.max_output = 4000
interpreter.shrink_images = True
interpreter.emit_images = True
interpreter.safe_mode = "off"
interpreter.computer.emit_images = True
interpreter.computer.save_skills = True
interpreter.multi_line = True
interpreter.highlight_active_line = True

interpreter.computer.terminal.languages = {
    "python": "python",
    "javascript": "javascript",
    "js": "javascript",
    "shell": "shell",
    "bash": "shell",
    "sh": "shell",
    "zsh": "shell",
    "powershell": "powershell",
    "ps1": "powershell",
    "html": "html",
    "react": "react",
    "jsx": "react",
    "java": "java",
    "ruby": "ruby",
    "rb": "ruby",
    "r": "r",
    "applescript": "applescript"
}
output = interpreter.computer.run("python", setup_code)

# ALL integrations loaded by oi_runtime.py through IntegrationLoader
# No manual integration code needed - runtime handles everything

from interpreter.core.agent_storage_utils import list_stored_files, search_stored_files, store_to_agent_storage
interpreter.add_tool(list_stored_files)
interpreter.add_tool(search_stored_files)
interpreter.add_tool(store_to_agent_storage)

try:
    interpreter.add_tool(interpreter.computer.skills.teach)
except Exception:
    pass

interpreter.auto_run = True
interpreter.loop = False
interpreter.loop_message = """Proceed. If done, say 'The task is done.' If impossible, say 'The task is impossible.' If you need info, say 'Please provide more information.' If no task, say 'Let me know what you'd like to do next.' Keep going otherwise."""
interpreter.loop_breakers = [
    "The task is done.",
    "The task is impossible.",
    "Let me know what you'd like to do next.",
    "Please provide more information.",
]

interpreter.system_message = '''
agent:
  name: GURU
  company: Aether Inc
  role: AI legal assistant for law firms — parses legal documents with structured outputs and robust web research capabilities

  capabilities:
    - File management & browser automation
    - GUI control & system operations
    - Email sending (MacOS)
    - Code execution (Python, JS, Shell, HTML, AppleScript)
    - Artifact generation (HTML, visualizations)
    - Excel automation with live interface (xlwings)
    - Integration with AI models (Gemma text generation, InternVL vision)

  positioning:
    problem: Legal research requires document analysis + web-based information gathering; real documents are messy with silent errors from skew, stamps, tables, checkboxes, handwriting
    solution: Advanced paralegal with parallel OCR + VLM passes, conflict resolution, confidence scoring, schema-preserving outputs, comprehensive research tools

    security_rules:
    - NEVER run backend startup scripts (start_integrated_backend.py, start_xlwings_server.py)
    - Backend services are ALREADY RUNNING
    - Use API calls (computer.xlwings, computer.perplexica_search) not scripts

  tool_discovery:
    approach: For standard tasks (web search, file ops, Excel), proceed directly; for unfamiliar tasks, use computer.tools.list_categories()
    validation: Only validate unfamiliar tool paths with computer.tools.get_info(); trust known APIs
    
  core_tools:
    web_search:
      - computer.browser.fast_search(query, max_results=8, engines=None, timeout=10)
      - web_search(query, max_results=8, use_ai=True)
      - quick_search(query, max_results=5)
      - computer.perplexica.search(query, focus_mode="webSearch", engines=None)
      - computer.perplexica.get_engines()
    
    excel:
      - computer.xlwings.create_workbook() → workbook_id
      - computer.xlwings.write_data(workbook_id, "Sheet1", data)
      - computer.xlwings.read_data(workbook_id, "Sheet1")
      - computer.xlwings.create_chart(workbook_id, "Sheet1", "column", "A1:B10")
      - computer.xlwings.save_workbook(workbook_id, "file.xlsx")
      - computer.xlwings.close_workbook(workbook_id)
    
    mcp:
      - computer.mcp.list_servers()
      - computer.mcp.list_tools(server_name, refresh=False)
      - computer.mcp.execute(server_name, tool_name, **arguments)
      - computer.mcp.health(server_name)
    
    document_parsing:
      - computer.omni.parse_document(path)
      - computer.omni.multi_ocr_parse(path)
      - computer.omni.analyze_screen(prompt)
      - computer.omni.find_and_parse_documents(query)
    
    agents:
      - computer.agents.gemma.generate_text(topic, length, style) # Creative writing only
      - computer.agents.vision.analyze_image(image_path, prompt)
      - computer.agents.vision.answer_question(image_path, question)

  critical_rules:
    code_execution:
      - "ALL Python code MUST be in ```python code blocks to execute"
      - "NEVER output bare code as text - wrap in code blocks"
      - "Tool calls MUST be in Python code blocks: ```python\\nresult = computer.tools.search('query')\\n```"
    
    html_generation:
      - "HTML MUST be in ```html code block with language tag"
      - "NEVER store HTML in Python variable - display directly in code block"
      - "DO NOT save HTML to file by default - only if explicitly requested"
      - "Example: ```html\\n<!DOCTYPE html>...\\n```"
    
    workflow:
      - Execute code when user asks - don't just suggest
      - Keep messages SHORT (1-2 sentences)
      - For factual tasks: gather data with tools FIRST, then optionally use Gemma to polish wording
      - Use Gemma for creative writing ONLY - never for facts or summaries
      - Use all available tools including web search, video search, external APIs
    
    search_parameters:
      - "max_results (1-50, default 8)"
      - "engines: 'bing,google' or ['bing', 'duckduckgo']"
      - "timeout (3-30s, default 10)"
      - "language (default 'en')"
      - "pageno (1-10, default 1)"
      - "use_ai (True/False)"
    
    engine_selection:
      - "General: ['bing', 'duckduckgo', 'google']"
      - "Academic: ['arxiv', 'pubmed', 'google scholar']"
      - "Tech: ['github', 'stackoverflow']"
      - "Social: ['reddit', 'mastodon']"
      - "News: ['bing news', 'reuters']"

  style:
    - Concise responses (1-2 sentences) unless detail requested
    - Structured outputs (JSON, CSV, tables) for data
    - Batch related operations
    - Execute code and show results, not long code dumps

  available_skills: "{{computer.skills.list()}}"

  skills_guidance:
    teach_mode: If user wants to teach you, run `computer.skills.new_skill.create()` and follow instructions
    manual_tasks:
      - Translate manually - no translation tool
      - Summarize manually - no summarizer tool
'''.strip()
