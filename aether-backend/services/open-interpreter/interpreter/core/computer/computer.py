import json

from .ai.ai import Ai
from .browser.browser import Browser
from .calendar.calendar import Calendar
from .clipboard.clipboard import Clipboard
from .contacts.contacts import Contacts
from .display.display import Display
from .docs.docs import Docs
from .files import Files
from .keyboard.keyboard import Keyboard
from .mail.mail import Mail
from .mouse.mouse import Mouse
from .os.os import Os
from .screenshot.screenshot_analyzer import ScreenshotAnalyzer
from .skills.skills import Skills
from .sms.sms import SMS
from .terminal.terminal import Terminal
from .tools import Tools
from .vision.vision import Vision


class Computer:
    def __init__(self, interpreter):
        self.interpreter = interpreter

        self.terminal = Terminal(self)

        self.offline = False
        self.verbose = False
        self.debug = False

        self.mouse = Mouse(self)
        self.keyboard = Keyboard(self)
        self.display = Display(self)
        self.clipboard = Clipboard(self)
        self.mail = Mail(self)
        self.sms = SMS(self)
        self.calendar = Calendar(self)
        self.contacts = Contacts(self)
        self.browser = Browser(self)
        self.os = Os(self)
        self.vision = Vision(self)
        self.skills = Skills(self)
        self.docs = Docs(self)
        self.ai = Ai(self)
        self.files = Files(self)
        self.screenshot_analyzer = ScreenshotAnalyzer(self)
        # Add alias for easier access
        self.screenshotanalyzer = self.screenshot_analyzer
        
        # Perplexica and Docling loaded via integration_loader in oi_runtime
        # Available as function imports: from integrations import perplexica_search, docling_convert

        # Initialize xlwings Excel automation (lazy loading)
        self._xlwings_initialized = False
        self._xlwings = None

        # Ensure xlwings is initialized before tools
        _ = self.xlwings  # Access xlwings to trigger initialization

        self.tools = Tools(self)

        self.emit_images = True
        self.api_base = "https://api.openinterpreter.com/v0"
        self.save_skills = True

        self.import_computer_api = False  # Defaults to false
        self._has_imported_computer_api = False  # Because we only want to do this once

        self.import_skills = False
        self._has_imported_skills = False
        self.max_output = (
            self.interpreter.max_output
        )  # Should mirror interpreter.max_output

        # System message - delegates to semantic tool discovery
        # Set default, but profiles can override this to empty string to disable
        excel_guidance = """

# EXCEL AUTOMATION - computer.xlwings.*

✅ Excel tools are WORKING. CORRECT usage:
```python
# 1. Create returns a DICT - extract workbook_id
result = computer.xlwings.create_workbook()
wb_id = result['workbook_id']  # MUST extract the ID string!

# 2. Use the wb_id STRING for all operations
computer.xlwings.write_data(wb_id, "Sheet1", [["Name", "Age"], ["Alice", 30]])
computer.xlwings.save_workbook(wb_id, "output.xlsx")  # Saves to data/files/
computer.xlwings.close_workbook(wb_id)
```

❌ COMMON MISTAKES:
- Using `computer.xlwingstools.*` instead of `computer.xlwings.*`
- Passing whole dict instead of extracting wb_id: `close_workbook(result)` ← WRONG
- Not extracting workbook_id from create_workbook() result
""".strip()
        
        self.system_message = f"""

# THE COMPUTER API

A python `computer` module is ALREADY IMPORTED with an intelligent tool discovery system.

{self.tools.get_system_message()}

{excel_guidance}

Do not import the computer module, or any of its sub-modules. They are already imported.

        """.strip()

    # Shortcut for computer.terminal.languages
    @property
    def languages(self):
        return self.terminal.languages

    @languages.setter
    def languages(self, value):
        self.terminal.languages = value

    def run(self, *args, **kwargs):
        """
        Shortcut for computer.terminal.run
        """
        return self.terminal.run(*args, **kwargs)

    def exec(self, code):
        """
        Shortcut for computer.terminal.run("shell", code)
        It has hallucinated this.
        """
        return self.terminal.run("shell", code)

    def stop(self):
        """
        Shortcut for computer.terminal.stop
        """
        return self.terminal.stop()

    def terminate(self):
        """
        Shortcut for computer.terminal.terminate
        """
        return self.terminal.terminate()

    def screenshot(self, *args, **kwargs):
        """
        Shortcut for computer.display.screenshot
        """
        return self.display.screenshot(*args, **kwargs)

    def view(self, *args, **kwargs):
        """
        Shortcut for computer.display.screenshot
        """
        return self.display.screenshot(*args, **kwargs)

    @property
    def xlwings(self):
        """
        Lazy-loaded xlwings Excel automation tools
        """
        if not self._xlwings_initialized:
            try:
                # Import xlwings tools from backend integrations
                import sys
                from pathlib import Path
                
                # Add backend to path if needed
                # __file__ is in: backend/open-interpreter/interpreter/core/computer/computer.py
                # We need: backend/
                oi_root = Path(__file__).parent.parent.parent.parent  # backend/open-interpreter
                backend_path = oi_root.parent  # backend/
                if str(backend_path) not in sys.path:
                    sys.path.insert(0, str(backend_path))
                
                from integrations.xlwings.excel import (
                    create_workbook, save_workbook, write_data, read_data, create_chart,
                    close_workbook, get_workbook_info, xlwings_health
                )

                # Create xlwings tool class with proper method binding
                class XlwingsTools:
                    def create_workbook(self):
                        return create_workbook()

                    def save_workbook(self, workbook_id, filename="workbook.xlsx"):
                        return save_workbook(workbook_id, filename)

                    def write_data(self, workbook_id, sheet_name, data, range_address="A1"):
                        return write_data(workbook_id, sheet_name, data, range_address)

                    def read_data(self, workbook_id, sheet_name, range_address=None):
                        return read_data(workbook_id, sheet_name, range_address)

                    def create_chart(self, workbook_id, sheet_name, chart_type="column",
                                   data_range="A1:B10", title="Chart", position="E1"):
                        return create_chart(workbook_id, sheet_name, chart_type, data_range, title, position)

                    def close_workbook(self, workbook_id):
                        return close_workbook(workbook_id)

                    def get_workbook_info(self, workbook_id):
                        return get_workbook_info(workbook_id)

                    def health(self):
                        return xlwings_health()

                xlwings_obj = XlwingsTools()

                self._xlwings = xlwings_obj
                # Also store in __dict__ so tool catalog can find it
                self.__dict__['xlwings'] = xlwings_obj
                self._xlwings_initialized = True

            except Exception as e:
                # Fallback: create a stub that provides helpful error messages
                def _xlwings_not_available(*args, **kwargs):
                    return {
                        "error": "xlwings not available. Make sure xlwings service is running and try: python start_integrated_backend.py",
                        "help": "xlwings provides Excel automation. Start the backend services to enable Excel functionality."
                    }

                self._xlwings = type('xlwings', (), {
                    method: _xlwings_not_available for method in [
                        'create_workbook', 'save_workbook', 'write_data', 'read_data',
                        'create_chart', 'close_workbook', 'get_workbook_info', 'health'
                    ]
                })()
                # Also store in __dict__ so tool catalog can find it
                self.__dict__['xlwings'] = self._xlwings
                self._xlwings_initialized = True

        return self._xlwings

    def analyze_screenshot(
        self,
        prompt: str = "Analyze this screenshot and determine if the task was completed successfully. Provide a detailed explanation of what you see and whether the expected outcome was achieved.",
        window: str = "active",
        model: str = "omniparser"
    ) -> str:
        """
        🤖 AGENT SCREENSHOT ANALYSIS - Take screenshot and analyze with OmniParser

        This is the PRIMARY function agents should use for screenshot analysis.
        Uses OmniParser by default for structured UI element analysis.
        It provides a clean interface with optional parameters.

        Args:
            prompt (str, optional): Custom analysis prompt (only used with InternVL fallback)
                                   Default: Task completion analysis
            window (str, optional): App/window name to target:
                                   - "active" (default) = currently focused window
                                   - "full" = entire screen
                                   - "Stremio", "Chrome", "VS Code", etc. = specific app
            model (str, optional): Vision model to use:
                                   - "omniparser" (default) = Structured UI analysis
                                   - "internvl3_5-2b" = Custom prompt analysis

        Returns:
            str: Detailed analysis of what's visible on screen with structured UI elements

        🎯 AGENT USAGE EXAMPLES:

        # 1. Basic usage - analyze active window
        result = computer.analyze_screenshot()

        # 2. Analyze specific app (RECOMMENDED for your use case)
        result = computer.analyze_screenshot(window="Stremio")

        # 3. Custom analysis prompt
        result = computer.analyze_screenshot(
            prompt="Describe the movies and TV shows visible in this media app"
        )

        # 4. Combine both parameters
        result = computer.analyze_screenshot(
            window="Stremio",
            prompt="Check if the media library is visible and what content is shown"
        )

        💡 FOR YOUR STREMI O USE CASE:
        ```python
        # This is what you should use:
        analysis = computer.analyze_screenshot(window="Stremio")
        print(analysis)  # Shows what's in the Stremio app
        ```
        """
        result = self.screenshot_analyzer.take_and_analyze_screenshot(
            prompt=prompt,
            window_target=window,
            model=model
        )

        if result["success"]:
            return result["analysis"]
        else:
            return f"Analysis failed: {result.get('error', 'Unknown error')}"

    def to_dict(self):
        def json_serializable(obj):
            try:
                json.dumps(obj)
                return True
            except:
                return False

        return {k: v for k, v in self.__dict__.items() if json_serializable(v)}

    def load_dict(self, data_dict):
        for key, value in data_dict.items():
            if hasattr(self, key):
                setattr(self, key, value)
