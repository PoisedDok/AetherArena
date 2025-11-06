#!/usr/bin/env python3
"""
xlwings API Server - Excel Automation Backend Service
==================================================

A comprehensive FastAPI server that provides Excel automation services
using xlwings for programmatic spreadsheet operations.

Features:
- Excel file creation and manipulation
- Data import/export with pandas
- Chart creation and visualization
- Formula calculations
- Workbook/sheet management
- RESTful API endpoints
"""

import asyncio
import io
import logging
import tempfile
import time
import os
from pathlib import Path
from typing import Dict, List, Optional, Union, Any
from enum import Enum
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, BackgroundTasks, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from pydantic import BaseModel, Field
import xlwings as xw
import pandas as pd
import numpy as np

# ---------------------------------------------------------------------------
# Default documents directory for xlwings workbooks
# ---------------------------------------------------------------------------

BASE_SAVE_DIR = Path("data/files").expanduser().resolve()
BASE_SAVE_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Helper: flexible parameter extraction (supports query, form, JSON)
# ---------------------------------------------------------------------------

from typing import Any, Optional


def _flex(primary: Optional[Any], *fallbacks, required: bool = False, name: str = "param"):
    """Return the first non-None/non-empty value among arguments.

    primary – the explicit arg (e.g. query/form param)
    *fallbacks – values to try next (e.g. JSON body fields)
    required – if True, raise 422 when nothing provided
    name – field name for error message
    """

    if primary not in (None, ""):
        return primary
    for val in fallbacks:
        if val not in (None, ""):
            return val
    if required:
        raise HTTPException(status_code=422, detail=f"Field '{name}' is required")
    return None

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize FastAPI app
app = FastAPI(
    title="xlwings API Server",
    description="Excel automation backend service using xlwings",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc"
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Enums and Models
class OperationType(str, Enum):
    CREATE_WORKBOOK = "create_workbook"
    LOAD_WORKBOOK = "load_workbook"
    SAVE_WORKBOOK = "save_workbook"
    ADD_SHEET = "add_sheet"
    DELETE_SHEET = "delete_sheet"
    WRITE_DATA = "write_data"
    READ_DATA = "read_data"
    INSERT_CHART = "insert_chart"
    CALCULATE_FORMULA = "calculate_formula"
    FORMAT_RANGE = "format_range"
    CREATE_TABLE = "create_table"

class ChartType(str, Enum):
    COLUMN = "column"
    LINE = "line"
    PIE = "pie"
    BAR = "bar"
    AREA = "area"
    SCATTER = "scatter"

class DataFormat(str, Enum):
    EXCEL = "excel"
    CSV = "csv"
    JSON = "json"
    HTML = "html"

class ExcelRequest(BaseModel):
    operation: OperationType
    workbook_path: Optional[str] = None
    sheet_name: Optional[str] = None
    data: Optional[Any] = None
    range_address: Optional[str] = None
    parameters: Optional[Dict[str, Any]] = None

class WorkbookInfo(BaseModel):
    name: str
    path: Optional[str] = None
    sheets: List[str]
    active_sheet: str

class SheetInfo(BaseModel):
    name: str
    used_range: str
    row_count: int
    column_count: int

# Global workbook cache (in production, use Redis or database)
workbook_cache: Dict[str, xw.Book] = {}

# xlwings Engine Manager
class ExcelEngine:
    """Manages xlwings Excel engine lifecycle"""

    def __init__(self):
        self.apps: Dict[str, xw.App] = {}
        self._initialized = False
        self._keep_alive_book: Optional[xw.Book] = None

    def initialize(self):
        """Initialize xlwings engine"""
        if not self._initialized:
            try:
                logger.info("Initializing xlwings engine...")

                # Initialize app variable
                app = None

                # Try to connect to existing Excel instance first
                try:
                    app = xw.apps.active
                    logger.info(f"Connected to existing Excel instance: {app}")
                    # Validate that the app is actually working
                    try:
                        version = app.version
                        logger.info(f"Excel version: {version}")
                        # Try to access books to make sure Excel is responsive
                        books_count = len(app.books)
                        logger.info(f"Excel has {books_count} workbooks open")
                    except Exception as validate_err:
                        logger.warning(f"Excel connection validation failed: {validate_err}")
                        logger.info("Excel instance found but not responsive, will try to create new one")
                        app = None
                except Exception as e:
                    logger.info(f"No existing Excel instance found ({e})")
                    app = None

                # If we don't have a working Excel instance, try to create one
                if app is None:
                    # --- macOS fallback: explicitly launch Excel ---------------------------------
                    try:
                        import subprocess, platform, time

                        if platform.system() == "Darwin":
                            logger.info("Attempting to start Microsoft Excel via 'open -a' ...")
                            # Launch Excel in the background (does nothing if already running)
                            subprocess.Popen(["open", "-a", "Microsoft Excel"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                            # Give Excel a moment to start up
                            time.sleep(3)  # Increased wait time
                            # Try again to attach
                            app = xw.apps.active

                            # Perform a quick health check to ensure Excel is responsive
                            try:
                                version = app.version
                                logger.info(f"Excel version: {version}")
                                # Try to access books to make sure Excel is responsive
                                books_count = len(app.books)
                                logger.info(f"Excel has {books_count} workbooks open")
                            except Exception as health_err:
                                logger.warning(f"Excel health check failed: {health_err}")
                                # If health check fails, wait a bit more and try again
                                time.sleep(2)
                                try:
                                    version = app.version
                                    books_count = len(app.books)
                                    logger.info(f"Excel health check passed after retry: {version}, {books_count} books")
                                except Exception as retry_health_err:
                                    logger.error(f"Excel health check failed after retry: {retry_health_err}")
                                    app = None  # Force fallback to xlwings App()

                            if app:
                                logger.info("Attached to newly started Excel instance")
                        else:
                            logger.info("Non-macOS system: skipping 'open -a' fallback")
                    except Exception as launch_err:
                        logger.info(f"Automatic Excel launch failed: {launch_err} — falling back to xlwings App()")

                # Final fallback: create a headless instance via xlwings
                if app is None:
                    try:
                        app = xw.App(visible=False)
                        logger.info("Created new Excel instance (headless)")
                    except Exception as app_err:
                        logger.warning(f"Failed to create xlwings App with visible=False: {app_err}")

                        # macOS-specific fallback: try without visibility check
                        if platform.system() == "Darwin":
                            logger.info("Trying macOS-specific xlwings App() without visibility...")
                            try:
                                # Try creating app without specifying visibility
                                app = xw.App()
                                logger.info("Created Excel instance (macOS fallback)")
                            except Exception as mac_err:
                                logger.error(f"macOS fallback also failed: {mac_err}")
                                # Last resort: try with visible=True
                                try:
                                    app = xw.App(visible=True)
                                    logger.info("Created Excel instance (visible=True fallback)")
                                except Exception as visible_err:
                                    logger.error(f"All xlwings App creation methods failed: {visible_err}")
                                    raise app_err  # Re-raise original error
                        else:
                            raise app_err  # Re-raise original error for non-macOS

                # Ensure we have an app instance
                if app is None:
                    raise RuntimeError("Failed to create or connect to Excel application")

                logger.info(f"Final Excel app instance: {app}")

                # --- Keep Excel alive ----------------------------------------------------
                try:
                    if len(app.books) == 0:
                        logger.info("No open workbooks detected – adding keep-alive workbook")
                        keep_book = app.books.add()
                        keep_book.name = "KeepAlive"
                        # Store reference so it isn't garbage-collected
                        self._keep_alive_book = keep_book
                    else:
                        # Store reference to the first workbook to prevent GC closing the app
                        self._keep_alive_book = app.books[0]
                except Exception as keep_err:
                    logger.warning(f"Failed to create keep-alive workbook: {keep_err}")

                self.apps["default"] = app
                self._initialized = True
                logger.info("✅ xlwings engine initialized successfully")
                logger.info(f"Excel version: {app.version if hasattr(app, 'version') else 'Unknown'}")
                return True
            except Exception as e:
                logger.error(f"❌ Failed to initialize xlwings engine: {e}")
                import traceback
                logger.error(f"Traceback: {traceback.format_exc()}")
                return False

    def get_app(self, app_id: str = "default") -> Optional[xw.App]:
        """Get Excel application instance"""
        if not self._initialized:
            self.initialize()
        return self.apps.get(app_id)

    def cleanup(self):
        """Clean up Excel instances"""
        for app in self.apps.values():
            try:
                app.quit()
            except:
                pass
        self.apps.clear()
        self._initialized = False

# Initialize engine
engine = ExcelEngine()
# Don't initialize here - do it lazily when first needed

# Utility Functions
def get_or_create_workbook(workbook_path: Optional[str] = None) -> tuple[xw.Book, str]:
    """Get existing workbook or create new one"""
    logger.info("get_or_create_workbook called")

    # Lazy initialization - only initialize when actually needed
    if not engine._initialized:
        logger.info("Engine not initialized, initializing now...")
        success = engine.initialize()
        if not success:
            raise HTTPException(status_code=500, detail="Failed to initialize xlwings engine")

    if workbook_path and os.path.exists(workbook_path):
        try:
            logger.info(f"Opening existing workbook: {workbook_path}")
            book = xw.Book(workbook_path)
            workbook_id = f"wb_{int(time.time() * 1000)}"
            workbook_cache[workbook_id] = book
            logger.info(f"Successfully opened workbook: {workbook_id}")
            return book, workbook_id
        except Exception as e:
            logger.error(f"Could not open workbook: {e}")
            raise HTTPException(status_code=400, detail=f"Could not open workbook: {e}")

    # Create new workbook
    logger.info("Creating new workbook")
    app = engine.get_app()
    logger.info(f"Engine app: {app}")
    logger.info(f"Engine initialized: {engine._initialized}")
    logger.info(f"Available apps: {list(engine.apps.keys())}")

    if not app:
        logger.error("Excel engine not available")
        logger.error(f"Engine initialization status: {engine._initialized}")
        logger.error(f"Available Excel apps: {list(engine.apps.keys())}")
        raise HTTPException(status_code=500, detail="Excel engine not available - Excel may not be running")

    try:
        logger.info("Adding new book to Excel app")
        book = app.books.add()
        workbook_id = f"wb_{int(time.time() * 1000)}"
        workbook_cache[workbook_id] = book
        logger.info(f"Successfully created workbook: {workbook_id}")
        return book, workbook_id
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        logger.error(f"Failed to create workbook: {e}\n{tb}")

        # macOS-specific error handling for AppleScript issues
        error_msg = str(e)
        if "list index out of range" in error_msg or "IndexError" in error_msg or "appscript" in error_msg:
            logger.warning("Detected macOS AppleScript visibility check error - trying comprehensive workarounds")

            # Try multiple workarounds for macOS AppleScript issues
            workarounds = [
                # Workaround 1: Simple retry after delay
                lambda: _workbook_creation_retry(app, 1),
                # Workaround 2: Longer delay
                lambda: _workbook_creation_retry(app, 2),
                # Workaround 3: Try creating a new Excel instance
                lambda: _create_new_excel_instance_and_workbook(),
                # Workaround 4: Force visibility and retry
                lambda: _force_excel_visibility_and_retry(),
            ]

            for i, workaround in enumerate(workarounds):
                try:
                    logger.info(f"Trying workaround {i+1}...")
                    book, workbook_id = workaround()
                    logger.info(f"Workaround {i+1} succeeded! Created workbook: {workbook_id}")
                    return book, workbook_id
                except Exception as workaround_e:
                    logger.warning(f"Workaround {i+1} failed: {workaround_e}")
                    continue

            # All workarounds failed
            error_msg = "All macOS Excel workarounds failed. Excel may need to be restarted or there may be a system-level AppleScript issue."
        else:
            # For other types of errors, use the original error message
            error_msg = f"Failed to create workbook: {repr(e)}"

        # Include full traceback in API response for easier debugging (remove in prod)
        raise HTTPException(status_code=500, detail=error_msg)

def _workbook_creation_retry(app: xw.App, delay_seconds: int):
    """Simple retry with delay"""
    import time
    time.sleep(delay_seconds)
    book = app.books.add()
    workbook_id = f"wb_{int(time.time() * 1000)}"
    workbook_cache[workbook_id] = book
    return book, workbook_id

def _create_new_excel_instance_and_workbook():
    """Create a completely new Excel instance and workbook"""
    import platform

    logger.info("Creating new Excel instance...")

    # Force kill any existing problematic instances
    try:
        import subprocess
        if platform.system() == "Darwin":
            # Kill any Excel processes that might be hanging
            subprocess.run(["pkill", "-f", "Microsoft Excel"], capture_output=True)
            import time
            time.sleep(2)  # Wait for processes to terminate
    except Exception as kill_err:
        logger.warning(f"Could not kill existing Excel processes: {kill_err}")

    # Create a new Excel instance
    try:
        new_app = xw.App(visible=True)  # Force visible to avoid AppleScript issues
        logger.info("Created new Excel instance for workaround")

        # Try to create workbook
        book = new_app.books.add()
        workbook_id = f"wb_{int(time.time() * 1000)}"
        workbook_cache[workbook_id] = book

        # Update the engine with the new app
        engine.apps["default"] = new_app

        return book, workbook_id
    except Exception as new_app_err:
        logger.error(f"Failed to create new Excel instance: {new_app_err}")
        raise

def _force_excel_visibility_and_retry():
    """Force Excel visibility and retry workbook creation"""
    import platform
    import subprocess

    if platform.system() != "Darwin":
        raise Exception("This workaround is only for macOS")

    logger.info("Forcing Excel visibility via AppleScript...")

    try:
        # Use AppleScript to force Excel to the front and make it visible
        applescript = '''
        tell application "Microsoft Excel"
            activate
            set visible to true
        end tell
        '''
        subprocess.run(["osascript", "-e", applescript], capture_output=True, timeout=10)
        import time
        time.sleep(2)  # Give Excel time to respond

        # Now try to create workbook with the existing app
        app = engine.get_app()
        book = app.books.add()
        workbook_id = f"wb_{int(time.time() * 1000)}"
        workbook_cache[workbook_id] = book
        return book, workbook_id

    except subprocess.TimeoutExpired:
        raise Exception("AppleScript command timed out")
    except Exception as script_err:
        logger.error(f"AppleScript visibility forcing failed: {script_err}")
        raise

def get_workbook_info(book: xw.Book) -> WorkbookInfo:
    """Get workbook information"""
    return WorkbookInfo(
        name=book.name,
        path=getattr(book, 'fullname', None),
        sheets=[sheet.name for sheet in book.sheets],
        active_sheet=book.sheets.active.name
    )

def get_sheet_info(sheet: xw.Sheet) -> SheetInfo:
    """Get sheet information"""
    used_range = sheet.used_range
    return SheetInfo(
        name=sheet.name,
        used_range=str(used_range.address),
        row_count=used_range.shape[0] if used_range else 0,
        column_count=used_range.shape[1] if used_range else 0
    )

# API Endpoints
# ---------------------------------------------------------------------------
# Table management endpoints
# ---------------------------------------------------------------------------

@app.post("/workbooks/{workbook_id}/tables/create")
async def create_table_endpoint(
    workbook_id: str,
    sheet_name: str = Form(None),
    range_address: str = Form(None),
    table_name: str = Form("Table1"),
    has_headers: bool = Form(True),
    payload: dict | None = Body(default=None)
):
    """Create a table from a range"""
    if workbook_id not in workbook_cache:
        raise HTTPException(status_code=404, detail="Workbook not found")

    sheet_name = _flex(sheet_name, (payload or {}).get("sheet_name"), required=True, name="sheet_name")
    range_address = _flex(range_address, (payload or {}).get("range_address"), required=True, name="range_address")
    table_name = _flex(table_name, (payload or {}).get("table_name"), "Table1")
    has_headers = _flex(has_headers, (payload or {}).get("has_headers"), True)

    try:
        book = workbook_cache[workbook_id]
        sheet = book.sheets[sheet_name]
        table_range = sheet.range(range_address)

        # Create table using xlwings
        table = sheet.tables.add(table_range, name=table_name, has_headers=has_headers)

        return {
            "success": True,
            "table_name": table.name,
            "range": str(table.range.address),
            "has_headers": has_headers,
            "message": f"Created table: {table_name}"
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/workbooks/{workbook_id}/sheets/{sheet_name}/tables/{table_name}/info")
async def get_table_info_endpoint(workbook_id: str, sheet_name: str, table_name: str):
    """Get table information"""
    if workbook_id not in workbook_cache:
        raise HTTPException(status_code=404, detail="Workbook not found")

    try:
        book = workbook_cache[workbook_id]
        sheet = book.sheets[sheet_name]
        table = sheet.tables[table_name]

        return {
            "success": True,
            "table_name": table.name,
            "range": str(table.range.address),
            "data_body_range": str(table.data_body_range.address) if table.data_body_range else None,
            "header_row_range": str(table.header_row_range.address) if table.header_row_range else None,
            "show_headers": table.show_headers,
            "show_table_style_first_column": table.show_table_style_first_column,
            "show_table_style_last_column": table.show_table_style_last_column
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/workbooks/{workbook_id}/sheets/{sheet_name}/tables/{table_name}/update")
async def update_table_endpoint(
    workbook_id: str,
    sheet_name: str,
    table_name: str,
    data: str = Form(None),
    payload: dict | None = Body(default=None)
):
    """Update table data"""
    if workbook_id not in workbook_cache:
        raise HTTPException(status_code=404, detail="Workbook not found")

    data = _flex(data, (payload or {}).get("data"), required=True, name="data")

    try:
        book = workbook_cache[workbook_id]
        sheet = book.sheets[sheet_name]
        table = sheet.tables[table_name]

        # Parse data
        try:
            data_parsed = pd.read_json(io.StringIO(data))
        except ValueError:
            data_parsed = data

        # Update table data
        if table.data_body_range:
            table.data_body_range.value = data_parsed

        return {
            "success": True,
            "message": f"Updated table: {table_name}",
            "data_shape": getattr(data_parsed, 'shape', 'scalar')
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

# ---------------------------------------------------------------------------
# Picture management endpoints
# ---------------------------------------------------------------------------

@app.post("/workbooks/{workbook_id}/pictures/add")
async def add_picture_endpoint(
    workbook_id: str,
    sheet_name: str = Form(None),
    image_path: str = Form(None),
    position: str = Form("A1"),
    width: int = Form(None),
    height: int = Form(None),
    payload: dict | None = Body(default=None)
):
    """Add a picture to a worksheet"""
    if workbook_id not in workbook_cache:
        raise HTTPException(status_code=404, detail="Workbook not found")

    sheet_name = _flex(sheet_name, (payload or {}).get("sheet_name"), required=True, name="sheet_name")
    image_path = _flex(image_path, (payload or {}).get("image_path"), required=True, name="image_path")
    position = _flex(position, (payload or {}).get("position"), "A1")
    width = _flex(width, (payload or {}).get("width"))
    height = _flex(height, (payload or {}).get("height"))

    try:
        book = workbook_cache[workbook_id]
        sheet = book.sheets[sheet_name]

        # Add picture
        picture = sheet.pictures.add(image_path, name=None, left=sheet.range(position).left, top=sheet.range(position).top)

        # Set size if specified
        if width:
            picture.width = width
        if height:
            picture.height = height

        return {
            "success": True,
            "picture_name": picture.name,
            "position": position,
            "width": picture.width,
            "height": picture.height,
            "message": f"Added picture: {picture.name}"
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

# ---------------------------------------------------------------------------
# Named range endpoints
# ---------------------------------------------------------------------------

@app.post("/workbooks/{workbook_id}/names/create")
async def create_named_range_endpoint(
    workbook_id: str,
    name: str = Form(None),
    range_address: str = Form(None),
    sheet_name: str = Form(None),
    payload: dict | None = Body(default=None)
):
    """Create a named range"""
    if workbook_id not in workbook_cache:
        raise HTTPException(status_code=404, detail="Workbook not found")

    name = _flex(name, (payload or {}).get("name"), required=True, name="name")
    range_address = _flex(range_address, (payload or {}).get("range_address"), required=True, name="range_address")
    sheet_name = _flex(sheet_name, (payload or {}).get("sheet_name"))

    try:
        book = workbook_cache[workbook_id]

        # Create named range
        if sheet_name:
            full_address = f"{sheet_name}!{range_address}"
            named_range = book.names.add(name, f"='{sheet_name}'!{range_address}")
        else:
            named_range = book.names.add(name, range_address)

        return {
            "success": True,
            "name": named_range.name,
            "refers_to": named_range.refers_to,
            "message": f"Created named range: {name}"
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

# ---------------------------------------------------------------------------
# Formula calculation endpoints
# ---------------------------------------------------------------------------

@app.post("/workbooks/{workbook_id}/calculate")
async def calculate_formula_endpoint(
    workbook_id: str,
    sheet_name: str = Form(None),
    formula: str = Form(None),
    range_address: str = Form("A1"),
    payload: dict | None = Body(default=None)
):
    """Calculate Excel formula"""
    if workbook_id not in workbook_cache:
        raise HTTPException(status_code=404, detail="Workbook not found")

    sheet_name = _flex(sheet_name, (payload or {}).get("sheet_name"), required=True, name="sheet_name")
    formula = _flex(formula, (payload or {}).get("formula"), required=True, name="formula")
    range_address = _flex(range_address, (payload or {}).get("range_address"), "A1")

    try:
        book = workbook_cache[workbook_id]
        sheet = book.sheets[sheet_name]

        # Set formula and calculate
        cell = sheet.range(range_address)
        cell.formula = formula
        result = cell.value

        return {
            "success": True,
            "formula": formula,
            "result": result,
            "range": range_address,
            "message": f"Calculated formula: {formula} = {result}"
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

# ---------------------------------------------------------------------------
# Formatting endpoints
# ---------------------------------------------------------------------------

@app.post("/workbooks/{workbook_id}/format")
async def format_range_endpoint(
    workbook_id: str,
    sheet_name: str = Form(None),
    range_address: str = Form(None),
    format_options: dict = Form(None),
    payload: dict | None = Body(default=None)
):
    """Apply formatting to a range"""
    if workbook_id not in workbook_cache:
        raise HTTPException(status_code=404, detail="Workbook not found")

    sheet_name = _flex(sheet_name, (payload or {}).get("sheet_name"), required=True, name="sheet_name")
    range_address = _flex(range_address, (payload or {}).get("range_address"), required=True, name="range_address")
    format_options = _flex(format_options, (payload or {}).get("format_options"), required=True, name="format_options")

    try:
        book = workbook_cache[workbook_id]
        sheet = book.sheets[sheet_name]
        rng = sheet.range(range_address)

        # Apply formatting options
        if "font" in format_options:
            font_options = format_options["font"]
            if "name" in font_options:
                rng.font.name = font_options["name"]
            if "size" in font_options:
                rng.font.size = font_options["size"]
            if "bold" in font_options:
                rng.font.bold = font_options["bold"]
            if "italic" in font_options:
                rng.font.italic = font_options["italic"]
            if "color" in font_options:
                rng.font.color = font_options["color"]

        if "number_format" in format_options:
            rng.number_format = format_options["number_format"]

        if "interior" in format_options:
            interior_options = format_options["interior"]
            if "color" in interior_options:
                rng.color = interior_options["color"]

        return {
            "success": True,
            "range": range_address,
            "message": f"Applied formatting to range: {range_address}"
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/workbooks/{workbook_id}/sheets/{sheet_name}/autofit")
async def autofit_sheet_endpoint(
    workbook_id: str,
    sheet_name: str,
    axis: str = Form("both"),
    payload: dict | None = Body(default=None)
):
    """Autofit columns and/or rows"""
    if workbook_id not in workbook_cache:
        raise HTTPException(status_code=404, detail="Workbook not found")

    axis = _flex(axis, (payload or {}).get("axis"), "both")

    try:
        book = workbook_cache[workbook_id]
        sheet = book.sheets[sheet_name]

        if axis in ["columns", "both"]:
            sheet.autofit("columns")
        if axis in ["rows", "both"]:
            sheet.autofit("rows")

        return {
            "success": True,
            "axis": axis,
            "message": f"Autofit applied to {axis}"
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

# ---------------------------------------------------------------------------
# Sheet operations endpoints
# ---------------------------------------------------------------------------

@app.post("/workbooks/{workbook_id}/sheets/{sheet_name}/delete")
async def delete_sheet_endpoint(workbook_id: str, sheet_name: str):
    """Delete a worksheet"""
    if workbook_id not in workbook_cache:
        raise HTTPException(status_code=404, detail="Workbook not found")

    try:
        book = workbook_cache[workbook_id]
        sheet = book.sheets[sheet_name]
        sheet.delete()

        return {
            "success": True,
            "message": f"Deleted sheet: {sheet_name}"
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/workbooks/{workbook_id}/sheets/{sheet_name}/activate")
async def activate_sheet_endpoint(workbook_id: str, sheet_name: str):
    """Activate a worksheet"""
    if workbook_id not in workbook_cache:
        raise HTTPException(status_code=404, detail="Workbook not found")

    try:
        book = workbook_cache[workbook_id]
        sheet = book.sheets[sheet_name]
        sheet.activate()

        return {
            "success": True,
            "message": f"Activated sheet: {sheet_name}"
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/workbooks/{workbook_id}/sheets/{sheet_name}/copy")
async def copy_sheet_endpoint(
    workbook_id: str,
    sheet_name: str,
    new_name: str = Form("Sheet1 (2)"),
    payload: dict | None = Body(default=None)
):
    """Copy a worksheet"""
    if workbook_id not in workbook_cache:
        raise HTTPException(status_code=404, detail="Workbook not found")

    new_name = _flex(new_name, (payload or {}).get("new_name"), "Sheet1 (2)")

    try:
        book = workbook_cache[workbook_id]
        sheet = book.sheets[sheet_name]
        new_sheet = sheet.copy(before=sheet)

        # Rename if specified
        if new_name != "Sheet1 (2)":
            new_sheet.name = new_name

        return {
            "success": True,
            "original_sheet": sheet_name,
            "new_sheet": new_sheet.name,
            "message": f"Copied sheet '{sheet_name}' to '{new_sheet.name}'"
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

# ---------------------------------------------------------------------------
# Data export endpoints
# ---------------------------------------------------------------------------

@app.get("/workbooks/{workbook_id}/sheets/{sheet_name}/export")
async def export_data_endpoint(
    workbook_id: str,
    sheet_name: str,
    format: str = "csv",
    range_address: str = None
):
    """Export data from worksheet"""
    if workbook_id not in workbook_cache:
        raise HTTPException(status_code=404, detail="Workbook not found")

    try:
        book = workbook_cache[workbook_id]
        sheet = book.sheets[sheet_name]

        if range_address:
            rng = sheet.range(range_address)
        else:
            rng = sheet.used_range

        data = rng.value

        if format.lower() == "csv":
            if hasattr(data, 'to_csv'):
                exported_data = data.to_csv(index=False)
            else:
                # Convert to DataFrame first
                df = pd.DataFrame(data)
                exported_data = df.to_csv(index=False)
        elif format.lower() == "json":
            if hasattr(data, 'to_json'):
                exported_data = data.to_json()
            else:
                df = pd.DataFrame(data)
                exported_data = df.to_json()
        elif format.lower() == "html":
            if hasattr(data, 'to_html'):
                exported_data = data.to_html(index=False)
            else:
                df = pd.DataFrame(data)
                exported_data = df.to_html(index=False)
        else:
            raise HTTPException(status_code=400, detail=f"Unsupported format: {format}")

        return {
            "success": True,
            "format": format,
            "data": exported_data,
            "range": str(rng.address),
            "message": f"Exported data in {format} format"
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

# ---------------------------------------------------------------------------
# Cell operations endpoints
# ---------------------------------------------------------------------------

@app.post("/workbooks/{workbook_id}/merge")
async def merge_cells_endpoint(
    workbook_id: str,
    sheet_name: str = Form(None),
    range_address: str = Form(None),
    payload: dict | None = Body(default=None)
):
    """Merge cells in a range"""
    if workbook_id not in workbook_cache:
        raise HTTPException(status_code=404, detail="Workbook not found")

    sheet_name = _flex(sheet_name, (payload or {}).get("sheet_name"), required=True, name="sheet_name")
    range_address = _flex(range_address, (payload or {}).get("range_address"), required=True, name="range_address")

    try:
        book = workbook_cache[workbook_id]
        sheet = book.sheets[sheet_name]
        rng = sheet.range(range_address)
        rng.merge()

        return {
            "success": True,
            "range": range_address,
            "message": f"Merged cells in range: {range_address}"
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/workbooks/{workbook_id}/clear")
async def clear_range_endpoint(
    workbook_id: str,
    sheet_name: str = Form(None),
    range_address: str = Form(None),
    clear_type: str = Form("all"),
    payload: dict | None = Body(default=None)
):
    """Clear contents, formats, or all from a range"""
    if workbook_id not in workbook_cache:
        raise HTTPException(status_code=404, detail="Workbook not found")

    sheet_name = _flex(sheet_name, (payload or {}).get("sheet_name"), required=True, name="sheet_name")
    range_address = _flex(range_address, (payload or {}).get("range_address"), required=True, name="range_address")
    clear_type = _flex(clear_type, (payload or {}).get("clear_type"), "all")

    try:
        book = workbook_cache[workbook_id]
        sheet = book.sheets[sheet_name]
        rng = sheet.range(range_address)

        if clear_type == "contents":
            rng.clear_contents()
        elif clear_type == "formats":
            rng.clear_formats()
        elif clear_type == "all":
            rng.clear()

        return {
            "success": True,
            "range": range_address,
            "clear_type": clear_type,
            "message": f"Cleared {clear_type} from range: {range_address}"
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/workbooks/{workbook_id}/sheets/{sheet_name}/freeze")
async def freeze_panes_endpoint(
    workbook_id: str,
    sheet_name: str,
    range_address: str = Form("A2"),
    payload: dict | None = Body(default=None)
):
    """Freeze panes at a specific cell"""
    if workbook_id not in workbook_cache:
        raise HTTPException(status_code=404, detail="Workbook not found")

    range_address = _flex(range_address, (payload or {}).get("range_address"), "A2")

    try:
        book = workbook_cache[workbook_id]
        sheet = book.sheets[sheet_name]

        # Use the freeze_at method
        sheet.freeze_at(range_address)

        return {
            "success": True,
            "freeze_at": range_address,
            "message": f"Froze panes at: {range_address}"
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/workbooks/{workbook_id}/sheets/{sheet_name}/autofilter")
async def show_autofilter_endpoint(
    workbook_id: str,
    sheet_name: str,
    enable: bool = Form(True),
    payload: dict | None = Body(default=None)
):
    """Show or hide autofilter for a sheet"""
    if workbook_id not in workbook_cache:
        raise HTTPException(status_code=404, detail="Workbook not found")

    enable = _flex(enable, (payload or {}).get("enable"), True)

    try:
        book = workbook_cache[workbook_id]
        sheet = book.sheets[sheet_name]

        sheet.show_autofilter = enable

        return {
            "success": True,
            "autofilter_enabled": enable,
            "message": f"{'Enabled' if enable else 'Disabled'} autofilter for sheet: {sheet_name}"
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

# ---------------------------------------------------------------------------
# Chart management endpoints
# ---------------------------------------------------------------------------

@app.post("/workbooks/{workbook_id}/sheets/{sheet_name}/charts/{chart_name}/update")
async def update_chart_endpoint(
    workbook_id: str,
    sheet_name: str,
    chart_name: str,
    updates: dict = Body(...)
):
    """Update chart properties"""
    if workbook_id not in workbook_cache:
        raise HTTPException(status_code=404, detail="Workbook not found")

    try:
        book = workbook_cache[workbook_id]
        sheet = book.sheets[sheet_name]
        chart = sheet.charts[chart_name]

        # Apply updates
        if "name" in updates:
            chart.name = updates["name"]
        if "chart_type" in updates:
            chart.chart_type = updates["chart_type"]
        if "left" in updates:
            chart.left = updates["left"]
        if "top" in updates:
            chart.top = updates["top"]
        if "width" in updates:
            chart.width = updates["width"]
        if "height" in updates:
            chart.height = updates["height"]

        return {
            "success": True,
            "chart_name": chart.name,
            "message": f"Updated chart: {chart_name}"
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/workbooks/{workbook_id}/sheets/{sheet_name}/charts/{chart_name}/delete")
async def delete_chart_endpoint(workbook_id: str, sheet_name: str, chart_name: str):
    """Delete a chart"""
    if workbook_id not in workbook_cache:
        raise HTTPException(status_code=404, detail="Workbook not found")

    try:
        book = workbook_cache[workbook_id]
        sheet = book.sheets[sheet_name]
        chart = sheet.charts[chart_name]
        chart.delete()

        return {
            "success": True,
            "message": f"Deleted chart: {chart_name}"
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "xlwings_version": xw.__version__,
        "engine_initialized": engine._initialized,
        "active_workbooks": len(workbook_cache)
    }

@app.post("/workbooks/create")
async def create_workbook():
    """Create a new workbook"""
    try:
        book, workbook_id = get_or_create_workbook()
        info = get_workbook_info(book)
        return {
            "success": True,
            "workbook_id": workbook_id,
            "workbook_info": info.dict(),
            "message": f"Created new workbook: {info.name}"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/workbooks/load")
async def load_workbook(file: UploadFile = File(...)):
    """Load workbook from uploaded file"""
    try:
        # Save uploaded file temporarily
        with tempfile.NamedTemporaryFile(delete=False, suffix=".xlsx") as temp_file:
            content = await file.read()
            temp_file.write(content)
            temp_path = temp_file.name

        # Load workbook
        book, workbook_id = get_or_create_workbook(temp_path)
        info = get_workbook_info(book)

        return {
            "success": True,
            "workbook_id": workbook_id,
            "workbook_info": info.dict(),
            "message": f"Loaded workbook: {file.filename}"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/workbooks/{workbook_id}/info")
async def get_workbook_info_endpoint(workbook_id: str):
    """Get workbook information"""
    if workbook_id not in workbook_cache:
        raise HTTPException(status_code=404, detail="Workbook not found")

    book = workbook_cache[workbook_id]
    info = get_workbook_info(book)

    return {
        "success": True,
        "workbook_info": info.dict()
    }

# ---------------------------------------------------------------------------
# Sheet creation (supports JSON {"name":"..."}, form, or query param)
# ---------------------------------------------------------------------------

@app.post("/workbooks/{workbook_id}/sheets/create")
async def create_sheet(
    workbook_id: str,
    name: Optional[str] = None,
    payload: dict | None = Body(default=None)
):
    """Create a new sheet in workbook (robust parameter handling)"""
    if workbook_id not in workbook_cache:
        raise HTTPException(status_code=404, detail="Workbook not found")

    # Extract name from possible sources
    name = _flex(name, (payload or {}).get("name"), required=True, name="name")

    try:
        book = workbook_cache[workbook_id]
        sheet = book.sheets.add(name)
        info = get_sheet_info(sheet)

        return {"success": True, "sheet_info": info.dict(), "message": f"Created sheet: {name}"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# ---------------------------------------------------------------------------
# Write data (supports JSON body {range_address, data}, form or query)
# ---------------------------------------------------------------------------

@app.post("/workbooks/{workbook_id}/sheets/{sheet_name}/write")
async def write_data(
    workbook_id: str,
    sheet_name: str,
    range_address: Optional[str] = None,
    data: Optional[str] = None,
    payload: dict | None = Body(default=None)
):
    """Write data to a sheet (robust parameter handling)"""
    if workbook_id not in workbook_cache:
        raise HTTPException(status_code=404, detail="Workbook not found")

    # Extract params
    range_address = _flex(range_address, (payload or {}).get("range_address"), "A1", required=True, name="range_address")
    data = _flex(data, (payload or {}).get("data"), required=True, name="data")

    try:
        book = workbook_cache[workbook_id]
        sheet = book.sheets[sheet_name]

        # Try to parse JSON (DataFrame) else treat as raw value
        try:
            data_parsed = pd.read_json(io.StringIO(data))
        except ValueError:
            data_parsed = data

        sheet.range(range_address).value = data_parsed

        return {"success": True, "message": f"Data written to {sheet_name}!{range_address}", "data_shape": getattr(data_parsed, 'shape', 'scalar')}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/workbooks/{workbook_id}/sheets/{sheet_name}/read")
async def read_data(
    workbook_id: str,
    sheet_name: str,
    range_address: Optional[str] = None
):
    """Read data from a sheet"""
    if workbook_id not in workbook_cache:
        raise HTTPException(status_code=404, detail="Workbook not found")

    try:
        book = workbook_cache[workbook_id]
        sheet = book.sheets[sheet_name]

        if range_address:
            range_obj = sheet.range(range_address)
        else:
            range_obj = sheet.used_range

        data = range_obj.value

        # Convert to JSON-serializable format
        if hasattr(data, 'to_json'):
            # pandas DataFrame
            data_json = data.to_json()
        elif isinstance(data, list):
            # Convert numpy arrays to lists
            data_json = pd.DataFrame(data).to_json()
        else:
            data_json = str(data)

        return {
            "success": True,
            "data": data_json,
            "range": str(range_obj.address),
            "shape": getattr(range_obj, 'shape', None)
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

# ---------------------------------------------------------------------------
# Save workbook (accepts JSON or query param)
# ---------------------------------------------------------------------------

@app.post("/workbooks/{workbook_id}/save")
async def save_workbook(
    workbook_id: str,
    filename: Optional[str] = None,
    payload: dict | None = Body(default=None)
):
    """Save workbook to file"""
    if workbook_id not in workbook_cache:
        raise HTTPException(status_code=404, detail="Workbook not found")

    from pathlib import Path
    filename_in = _flex(filename, (payload or {}).get("filename"), name="filename")

    # If user passed bare filename (no slashes), place it into BASE_SAVE_DIR
    fp = Path(filename_in)
    if not fp.is_absolute() and fp.parent == Path('.'):
        fp = BASE_SAVE_DIR / fp

    # Ensure directory exists
    fp.parent.mkdir(parents=True, exist_ok=True)

    # POSIX path for Excel/appscript compatibility
    filename_path = fp.expanduser().resolve()

    try:
        book = workbook_cache[workbook_id]
        try:
            book.save(filename_path)
        except Exception as e:
            logger.warning(f"Primary save failed ({e}), trying save_copy ...")
            try:
                book.save_copy(filename_path)
            except Exception as e2:
                # Final fallback: save_copy into BASE_SAVE_DIR
                try:
                    alt_path = BASE_SAVE_DIR / filename_path.name
                    book.save_copy(alt_path.as_posix())
                    filename_posix = alt_path.as_posix()
                except Exception as e3:
                    raise HTTPException(status_code=400, detail=str(e3))

        return {"success": True, "filename": filename_path, "message": f"Workbook saved as: {filename_path}"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

# ---------------------------------------------------------------------------
# Chart creation (robust parameter handling)
# ---------------------------------------------------------------------------

@app.post("/workbooks/{workbook_id}/charts/create")
async def create_chart(
    workbook_id: str,
    sheet_name: Optional[str] = None,
    chart_type: Optional[ChartType] = None,
    data_range: Optional[str] = None,
    title: Optional[str] = "Chart",
    position: Optional[str] = "A10",
    payload: dict | None = Body(default=None)
):
    """Create a chart in the workbook"""
    if workbook_id not in workbook_cache:
        raise HTTPException(status_code=404, detail="Workbook not found")

    sheet_name = _flex(sheet_name, (payload or {}).get("sheet_name"), name="sheet_name")
    chart_type_in = _flex(chart_type, (payload or {}).get("chart_type"), name="chart_type")
    data_range = _flex(data_range, (payload or {}).get("data_range"), name="data_range")

    # Normalize chart type
    if isinstance(chart_type_in, ChartType):
        chart_type_str = chart_type_in.value
    else:
        chart_type_str = str(chart_type_in).lower()

    CHART_MAP = {
        "column": "column_clustered",
        "line": "line_markers",
        "pie": "pie",
        "bar": "bar_clustered",
        "area": "area",
        "scatter": "scatter_markers",
    }

    chart_type_final = CHART_MAP.get(chart_type_str, chart_type_str)

    title = _flex(title, (payload or {}).get("title"), required=False)
    position = _flex(position, (payload or {}).get("position"), required=False)

    try:
        book = workbook_cache[workbook_id]
        sheet = book.sheets[sheet_name]

        chart = sheet.charts.add()
        chart.set_source_data(sheet.range(data_range))
        chart.chart_type = chart_type_final
        chart.name = title
        chart.top = sheet.range(position).top
        chart.left = sheet.range(position).left

        return {"success": True, "chart_name": title, "chart_type": chart_type_final, "message": f"Created {chart_type_final} chart: {title}"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/workbooks/{workbook_id}/close")
async def close_workbook(workbook_id: str, background_tasks: BackgroundTasks):
    """Close and cleanup workbook"""
    if workbook_id not in workbook_cache:
        raise HTTPException(status_code=404, detail="Workbook not found")

    try:
        book = workbook_cache[workbook_id]
        book.close()
        del workbook_cache[workbook_id]

        return {
            "success": True,
            "message": f"Workbook {workbook_id} closed"
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Handle application startup and shutdown events"""
    # Startup
    logger.info("xlwings API server started - Excel will be initialized on first use")
    # Don't initialize xlwings here - do it lazily when first workbook is created
    # This ensures proper environment context when Excel is actually needed

    yield

    # Shutdown
    engine.cleanup()

if __name__ == "__main__":
    import os
    dev_mode = os.getenv("XLWINGS_DEV_MODE", "").lower() in ("1", "true", "yes")

    uvicorn.run(
        "xlwings_api_server:app",
        host="0.0.0.0",
        port=8001,
        reload=dev_mode,
        log_level="info"
    )
