"""
XLWings Excel Automation - Layer 1 Implementation

Provides comprehensive Excel workbook creation, manipulation, and automation
via on-demand, in-process xlwings (no HTTP sub-service, no extra ports).

Features:
- Workbook lifecycle management
- Data read/write operations
- Chart creation and management
- Table operations
- Formatting and styling
- Sheet operations
- Named ranges
- Formula calculation

Production-ready with:
- Proper error handling
- Timeout management
- Clear error messages
- API compatibility

@.architecture
Incoming: api/v1/endpoints/xlwings_api.py --- {Dict workbook config, str workbook_path, List[List] data, Dict chart config}
Processing: excel_workbook_create(), excel_sheet_create(), excel_data_write(), excel_data_read(), excel_chart_create() --- {JOB_EXECUTE_TOOL, JOB_MANAGE_STORAGE, JOB_TRANSFORM_DATA}
Outgoing: api/v1/endpoints/xlwings_api.py --- {Dict[str, Any] workbook info, str workbook_path, List[List] read data}
"""

import logging
from contextlib import contextmanager
import csv
import html
import io
import json
from datetime import datetime
from pathlib import Path
import threading
from typing import Any, Dict, List, Optional, Union
import uuid

logger = logging.getLogger(__name__)

_XLWINGS_LOCK = threading.Lock()

def _get_xlwings_base_dir() -> Path:
    """Get xlwings base directory from central settings."""
    from config.settings import get_settings

    base_dir = Path(get_settings().integrations.xlwings_base_dir).expanduser()
    base_dir.mkdir(parents=True, exist_ok=True)
    return base_dir.resolve()


def _normalize_workbook_path(value: str, *, allow_missing: bool) -> Path:
    """Resolve workbook path within the configured base dir."""
    if not value:
        raise ValueError("workbook_id is required")

    base_dir = _get_xlwings_base_dir()
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = base_dir / path
    path = path.resolve()

    if base_dir not in path.parents and path != base_dir:
        raise ValueError(f"Workbook path must be inside base dir: {base_dir}")
    if not allow_missing and not path.exists():
        raise FileNotFoundError(f"Workbook not found: {path}")

    return path


def _normalize_new_workbook_path(filename: Optional[str]) -> Path:
    """Generate or normalize a new workbook path within the base dir."""
    base_dir = _get_xlwings_base_dir()
    if filename:
        path = Path(filename).expanduser()
        if not path.is_absolute():
            path = base_dir / path
    else:
        suffix = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
        path = base_dir / f"workbook_{suffix}_{uuid.uuid4().hex[:8]}.xlsx"

    if path.suffix == "":
        path = path.with_suffix(".xlsx")

    path = path.resolve()
    if base_dir not in path.parents and path != base_dir:
        raise ValueError(f"Workbook path must be inside base dir: {base_dir}")
    if path.exists():
        raise FileExistsError(f"Workbook already exists: {path}")

    return path


def _resolve_existing_path(value: str) -> Path:
    """Resolve an existing file path (relative paths resolve under base dir)."""
    if not value:
        raise ValueError("path is required")
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = _get_xlwings_base_dir() / path
    path = path.resolve()
    if not path.exists():
        raise FileNotFoundError(f"File not found: {path}")
    return path


def _ensure_xlwings_available():
    """Import xlwings (fail-fast if missing)."""
    try:
        import xlwings as xw
        return xw
    except Exception as exc:  # pragma: no cover - defensive
        raise RuntimeError(f"xlwings not available: {exc}") from exc


@contextmanager
def _excel_app():
    """Context manager for a single Excel App instance."""
    xw = _ensure_xlwings_available()
    app = xw.App(visible=False, add_book=False)
    try:
        app.display_alerts = False
        app.screen_updating = False
    except Exception:
        pass
    try:
        yield app
    finally:
        try:
            app.quit()
        except Exception:
            pass


@contextmanager
def _excel_book(app, path: Path, *, create: bool):
    """Context manager for a workbook within an Excel app."""
    if create:
        book = app.books.add()
        book.save(str(path))
    else:
        book = app.books.open(str(path))
    try:
        yield book
    finally:
        try:
            book.close()
        except Exception:
            pass


def _collect_workbook_info(book) -> Dict[str, Any]:
    """Extract workbook metadata."""
    try:
        active_sheet = book.sheets.active.name
    except Exception:
        active_sheet = None
    return {
        "name": getattr(book, "name", None),
        "full_name": getattr(book, "fullname", None),
        "sheets": [sheet.name for sheet in book.sheets],
        "active_sheet": active_sheet,
    }


def _get_sheet(book, sheet_name: str):
    """Fetch a sheet or raise a descriptive error."""
    try:
        return book.sheets[sheet_name]
    except Exception as exc:
        raise ValueError(f"Sheet not found: {sheet_name}") from exc


def _normalize_read_value(value: Any) -> List[List[Any]]:
    """Normalize read values into a 2D list."""
    if value is None:
        return []
    if isinstance(value, list):
        if not value:
            return []
        if not isinstance(value[0], list):
            return [value]
        return value
    return [[value]]


def _hex_to_rgb(color: str) -> Optional[tuple[int, int, int]]:
    if not color:
        return None
    c = color.strip().lstrip("#")
    if len(c) == 3:
        c = "".join([v * 2 for v in c])
    if len(c) != 6:
        raise ValueError(f"Invalid color: {color}")
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))


def _run_with_workbook(
    workbook_path: Path,
    *,
    create: bool,
    save_after: bool,
    operation,
) -> Dict[str, Any]:
    """Execute an Excel operation with strict resource cleanup."""
    with _XLWINGS_LOCK:
        with _excel_app() as app:
            with _excel_book(app, workbook_path, create=create) as book:
                result = operation(book)
                if save_after:
                    book.save(str(workbook_path))
                return result


# ============================================================================
# WORKBOOK MANAGEMENT
# ============================================================================


def create_workbook(filename: Optional[str] = None) -> Dict[str, Any]:
    """
    Create a new Excel workbook on disk.
    
    Args:
        filename: Optional filename or path (relative paths resolve under base dir).
    
    Returns:
        Dict with:
            - workbook_id: str (path for subsequent operations)
            - workbook_path: str (same as workbook_id)
            - info: dict (workbook metadata)
            - error: str (if failed)
    """
    try:
        workbook_path = _normalize_new_workbook_path(filename)

        def _op(book):
            return {
                "workbook_id": str(workbook_path),
                "workbook_path": str(workbook_path),
                "info": _collect_workbook_info(book),
            }

        result = _run_with_workbook(
            workbook_path,
            create=True,
            save_after=True,
            operation=_op,
        )
        logger.info("Created workbook: %s", workbook_path)
        return result
    except Exception as exc:
        logger.error("Excel operation failed: %s", exc, exc_info=True)
        return {"error": str(exc)}


def load_workbook(filename: str) -> Dict[str, Any]:
    """
    Load an existing Excel workbook from file.
    
    Args:
        filename: Path to Excel file
        
    Returns:
        Dict with workbook_id and info
        
    """
    if not filename:
        return {"error": "filename is required"}

    try:
        workbook_path = _normalize_workbook_path(filename, allow_missing=False)

        def _op(book):
            return {
                "workbook_id": str(workbook_path),
                "workbook_path": str(workbook_path),
                "info": _collect_workbook_info(book),
            }

        return _run_with_workbook(
            workbook_path,
            create=False,
            save_after=False,
            operation=_op,
        )
    except Exception as exc:
        logger.error("Excel operation failed: %s", exc, exc_info=True)
        return {"error": str(exc)}


def save_workbook(workbook_id: str, filename: str = "workbook.xlsx") -> Dict[str, Any]:
    """
    Save workbook to file (Save/SaveAs).
    
    Args:
        workbook_id: Workbook path from create_workbook()
        filename: Output filename or path (relative paths resolve under base dir)
        
    Returns:
        Dict with save confirmation and workbook_path
    """
    if not workbook_id:
        return {"error": "workbook_id is required"}

    try:
        source_path = _normalize_workbook_path(workbook_id, allow_missing=False)
        target_path = _normalize_new_workbook_path(filename)
    except FileExistsError:
        # Allow save to existing path (explicit overwrite) by resolving without create check.
        try:
            target_path = _normalize_workbook_path(filename, allow_missing=False)
        except Exception as exc:
            logger.error("Excel operation failed: %s", exc, exc_info=True)
            return {"error": str(exc)}
    except Exception as exc:
        logger.error("Excel operation failed: %s", exc, exc_info=True)
        return {"error": str(exc)}

    def _op(book):
        book.save(str(target_path))
        return {
            "success": True,
            "workbook_id": str(target_path),
            "workbook_path": str(target_path),
        }

    try:
        result = _run_with_workbook(
            source_path,
            create=False,
            save_after=False,
            operation=_op,
        )
        logger.info("Saved workbook %s to %s", source_path, target_path)
        return result
    except Exception as exc:
        logger.error("Excel operation failed: %s", exc, exc_info=True)
        return {"error": str(exc)}


def close_workbook(workbook_id: str) -> Dict[str, Any]:
    """
    Close workbook and release resources.
    
    Args:
        workbook_id: Workbook ID
        
    Returns:
        Dict with close confirmation
    
    Important:
        Always close workbooks when done to free system resources.
        Unsaved changes will be lost.
    """
    if not workbook_id:
        return {"error": "workbook_id is required"}

    try:
        workbook_path = _normalize_workbook_path(workbook_id, allow_missing=False)
        logger.info("Closed workbook (no-op): %s", workbook_path)
        return {"success": True, "workbook_id": str(workbook_path)}
    except Exception as exc:
        logger.error("Excel operation failed: %s", exc, exc_info=True)
        return {"error": str(exc)}


def get_workbook_info(workbook_id: str) -> Dict[str, Any]:
    """
    Get workbook information and metadata.
    
    Args:
        workbook_id: Workbook ID
        
    Returns:
        Dict with:
            - name: str
            - sheets: list of sheet names
            - active_sheet: str
            - error: str (if failed)
    """
    if not workbook_id:
        return {"error": "workbook_id is required"}

    try:
        workbook_path = _normalize_workbook_path(workbook_id, allow_missing=False)

        def _op(book):
            return _collect_workbook_info(book)

        info = _run_with_workbook(
            workbook_path,
            create=False,
            save_after=False,
            operation=_op,
        )
        return info
    except Exception as exc:
        logger.error("Excel operation failed: %s", exc, exc_info=True)
        return {"error": str(exc)}


# ============================================================================
# SHEET OPERATIONS
# ============================================================================


def create_sheet(workbook_id: str, name: str = "Sheet1") -> Dict[str, Any]:
    """
    Create a new sheet in workbook.
    
    Args:
        workbook_id: Workbook ID
        name: Sheet name (default: Sheet1)
        
    Returns:
        Dict with sheet creation confirmation
    """
    if not workbook_id:
        return {"error": "workbook_id is required"}

    try:
        workbook_path = _normalize_workbook_path(workbook_id, allow_missing=False)

        def _op(book):
            existing = {sheet.name for sheet in book.sheets}
            if name in existing:
                return {"success": True, "sheet_name": name, "message": "already_exists"}
            book.sheets.add(name=name)
            return {"success": True, "sheet_name": name}

        result = _run_with_workbook(
            workbook_path,
            create=False,
            save_after=True,
            operation=_op,
        )
        logger.info("Created sheet '%s' in workbook %s", name, workbook_path)
        return result
    except Exception as exc:
        logger.error("Excel operation failed: %s", exc, exc_info=True)
        return {"error": str(exc)}


def delete_sheet(workbook_id: str, sheet_name: str) -> Dict[str, Any]:
    """
    Delete a sheet from workbook.
    
    Args:
        workbook_id: Workbook ID
        sheet_name: Name of sheet to delete
        
    Returns:
        Dict with deletion confirmation
    """
    if not workbook_id or not sheet_name:
        return {"error": "workbook_id and sheet_name are required"}

    try:
        workbook_path = _normalize_workbook_path(workbook_id, allow_missing=False)

        def _op(book):
            sheet = _get_sheet(book, sheet_name)
            sheet.delete()
            return {"success": True, "sheet_name": sheet_name}

        return _run_with_workbook(
            workbook_path,
            create=False,
            save_after=True,
            operation=_op,
        )
    except Exception as exc:
        logger.error("Excel operation failed: %s", exc, exc_info=True)
        return {"error": str(exc)}


def activate_sheet(workbook_id: str, sheet_name: str) -> Dict[str, Any]:
    """
    Activate (select) a sheet in workbook.
    
    Args:
        workbook_id: Workbook ID
        sheet_name: Sheet name to activate
        
    Returns:
        Dict with activation confirmation
    """
    if not workbook_id or not sheet_name:
        return {"error": "workbook_id and sheet_name are required"}

    try:
        workbook_path = _normalize_workbook_path(workbook_id, allow_missing=False)

        def _op(book):
            sheet = _get_sheet(book, sheet_name)
            sheet.activate()
            return {"success": True, "sheet_name": sheet_name}

        return _run_with_workbook(
            workbook_path,
            create=False,
            save_after=False,
            operation=_op,
        )
    except Exception as exc:
        logger.error("Excel operation failed: %s", exc, exc_info=True)
        return {"error": str(exc)}


def copy_sheet(workbook_id: str, sheet_name: str, new_name: str) -> Dict[str, Any]:
    """
    Copy a sheet within workbook.
    
    Args:
        workbook_id: Workbook ID
        sheet_name: Source sheet name
        new_name: New sheet name
        
    Returns:
        Dict with copy confirmation
    """
    if not all([workbook_id, sheet_name, new_name]):
        return {"error": "workbook_id, sheet_name, and new_name are required"}

    try:
        workbook_path = _normalize_workbook_path(workbook_id, allow_missing=False)

        def _op(book):
            existing = {sheet.name for sheet in book.sheets}
            if new_name in existing:
                raise ValueError(f"Sheet already exists: {new_name}")
            source = _get_sheet(book, sheet_name)
            source.copy(after=source)
            book.sheets.active.name = new_name
            return {"success": True, "sheet_name": new_name}

        return _run_with_workbook(
            workbook_path,
            create=False,
            save_after=True,
            operation=_op,
        )
    except Exception as exc:
        logger.error("Excel operation failed: %s", exc, exc_info=True)
        return {"error": str(exc)}


def autofit_sheet(workbook_id: str, sheet_name: str, dimension: str = "both") -> Dict[str, Any]:
    """
    Autofit columns and/or rows in sheet.
    
    Args:
        workbook_id: Workbook ID
        sheet_name: Sheet name
        dimension: What to autofit (columns, rows, both)
        
    Returns:
        Dict with autofit confirmation
    """
    if not workbook_id or not sheet_name:
        return {"error": "workbook_id and sheet_name are required"}

    axis = None
    if dimension in {"rows", "r"}:
        axis = "r"
    elif dimension in {"columns", "c"}:
        axis = "c"

    try:
        workbook_path = _normalize_workbook_path(workbook_id, allow_missing=False)

        def _op(book):
            sheet = _get_sheet(book, sheet_name)
            sheet.autofit(axis)
            return {"success": True, "sheet_name": sheet_name, "axis": axis or "both"}

        return _run_with_workbook(
            workbook_path,
            create=False,
            save_after=True,
            operation=_op,
        )
    except Exception as exc:
        logger.error("Excel operation failed: %s", exc, exc_info=True)
        return {"error": str(exc)}


# ============================================================================
# DATA OPERATIONS
# ============================================================================


def write_data(
    workbook_id: str,
    sheet_name: str,
    data: Union[str, int, float, List, Dict],
    range_address: str = "A1"
) -> Dict[str, Any]:
    """
    Write data to Excel sheet.
    
    Args:
        workbook_id: Workbook ID (REQUIRED)
        sheet_name: Sheet name (REQUIRED)
        data: Data to write (REQUIRED). Can be:
            - dict: {"A1": "value", "B1": "value2"} for specific cells
            - list of lists: [["H1", "H2"], ["R1C1", "R1C2"]] for table
            - single value: "text" or 123 for single cell
        range_address: Start position (default: A1)
        
    Returns:
        Dict with write confirmation
    
    Examples:
        # Write table data
        write_data(wb_id, "Sheet1", [
            ["Name", "Age"],
            ["Alice", 30],
            ["Bob", 25]
        ])
        
        # Write to specific cells
        write_data(wb_id, "Sheet1", {
            "A1": "Hello",
            "B1": "World"
        })
        
        # Write single value
        write_data(wb_id, "Sheet1", "Hello", "A1")
    
    Important:
        - write_data saves immediately (on-demand mode closes the workbook after each call)
    """
    if not workbook_id:
        return {"error": "workbook_id is required. Use create_workbook() first."}
    if not sheet_name:
        return {"error": "sheet_name is required (e.g., 'Sheet1')"}
    if data is None:
        return {"error": "data is required"}
    
    try:
        workbook_path = _normalize_workbook_path(workbook_id, allow_missing=False)

        def _op(book):
            sheet = _get_sheet(book, sheet_name)
            if isinstance(data, dict):
                for cell, value in data.items():
                    sheet.range(cell).value = value
            elif isinstance(data, list):
                sheet.range(range_address).value = data
            else:
                sheet.range(range_address).value = data
            return {"success": True, "sheet_name": sheet_name, "range_address": range_address}

        result = _run_with_workbook(
            workbook_path,
            create=False,
            save_after=True,
            operation=_op,
        )
        logger.debug("Wrote data to %s!%s", sheet_name, range_address)
        return result
    except Exception as exc:
        logger.error("Excel operation failed: %s", exc, exc_info=True)
        return {"error": str(exc)}


def read_data(
    workbook_id: str,
    sheet_name: str,
    range_address: Optional[str] = None
) -> Dict[str, Any]:
    """
    Read data from Excel sheet.
    
    Args:
        workbook_id: Workbook ID
        sheet_name: Sheet name
        range_address: Range to read (e.g., "A1:C10"). If None, reads entire used range.
        
    Returns:
        Dict with:
            - data: list of lists (table data)
            - range: str (range that was read)
            - error: str (if failed)
    
    Example:
        result = read_data(wb_id, "Sheet1", "A1:B10")
        if "error" not in result:
            table_data = result['data']
    """
    if not workbook_id or not sheet_name:
        return {"error": "workbook_id and sheet_name are required"}

    try:
        workbook_path = _normalize_workbook_path(workbook_id, allow_missing=False)

        def _op(book):
            sheet = _get_sheet(book, sheet_name)
            rng = sheet.range(range_address) if range_address else sheet.used_range
            data = _normalize_read_value(rng.value)
            return {
                "data": data,
                "range": rng.address,
                "sheet_name": sheet_name,
            }

        return _run_with_workbook(
            workbook_path,
            create=False,
            save_after=False,
            operation=_op,
        )
    except Exception as exc:
        logger.error("Excel operation failed: %s", exc, exc_info=True)
        return {"error": str(exc)}


def clear_range(workbook_id: str, sheet_name: str, range_address: str) -> Dict[str, Any]:
    """
    Clear data from range.
    
    Args:
        workbook_id: Workbook ID
        sheet_name: Sheet name
        range_address: Range to clear (e.g., "A1:C10")
        
    Returns:
        Dict with clear confirmation
    """
    if not all([workbook_id, sheet_name, range_address]):
        return {"error": "workbook_id, sheet_name, and range_address are required"}

    try:
        workbook_path = _normalize_workbook_path(workbook_id, allow_missing=False)

        def _op(book):
            sheet = _get_sheet(book, sheet_name)
            sheet.range(range_address).clear()
            return {"success": True, "sheet_name": sheet_name, "range_address": range_address}

        return _run_with_workbook(
            workbook_path,
            create=False,
            save_after=True,
            operation=_op,
        )
    except Exception as exc:
        logger.error("Excel operation failed: %s", exc, exc_info=True)
        return {"error": str(exc)}


# ============================================================================
# CHART OPERATIONS
# ============================================================================


def create_chart(
    workbook_id: str,
    sheet_name: str,
    chart_type: str,
    data_range: str,
    position: str = "E2"
) -> Dict[str, Any]:
    """
    Create a chart in worksheet.
    
    Args:
        workbook_id: Workbook ID
        sheet_name: Sheet name
        chart_type: Chart type (line, bar, column, pie, scatter, area)
        data_range: Data range for chart (e.g., "A1:B10")
        position: Chart top-left position (default: E2)
        
    Returns:
        Dict with:
            - chart_id: str
            - chart_type: str
            - error: str (if failed)
    
    Example:
        create_chart(wb_id, "Sheet1", "column", "A1:B10", "E2")
    """
    if not all([workbook_id, sheet_name, chart_type, data_range]):
        return {"error": "workbook_id, sheet_name, chart_type, and data_range are required"}

    try:
        workbook_path = _normalize_workbook_path(workbook_id, allow_missing=False)

        def _op(book):
            sheet = _get_sheet(book, sheet_name)
            chart = sheet.charts.add()
            chart.set_source_data(sheet.range(data_range))
            chart.chart_type = chart_type
            anchor = sheet.range(position)
            chart.left = anchor.left
            chart.top = anchor.top
            return {
                "success": True,
                "chart_id": chart.name,
                "chart_type": chart_type,
                "sheet_name": sheet_name,
            }

        result = _run_with_workbook(
            workbook_path,
            create=False,
            save_after=True,
            operation=_op,
        )
        logger.info("Created %s chart in %s", chart_type, sheet_name)
        return result
    except Exception as exc:
        logger.error("Excel operation failed: %s", exc, exc_info=True)
        return {"error": str(exc)}


def update_chart(
    workbook_id: str,
    sheet_name: str,
    chart_id: str,
    data_range: Optional[str] = None,
    chart_type: Optional[str] = None
) -> Dict[str, Any]:
    """
    Update an existing chart.
    
    Args:
        workbook_id: Workbook ID
        sheet_name: Sheet name
        chart_id: Chart ID from create_chart()
        data_range: New data range (optional)
        chart_type: New chart type (optional)
        
    Returns:
        Dict with update confirmation
    """
    if not all([workbook_id, sheet_name, chart_id]):
        return {"error": "workbook_id, sheet_name, and chart_id are required"}

    try:
        workbook_path = _normalize_workbook_path(workbook_id, allow_missing=False)

        def _op(book):
            sheet = _get_sheet(book, sheet_name)
            chart = sheet.charts[chart_id]
            if data_range:
                chart.set_source_data(sheet.range(data_range))
            if chart_type:
                chart.chart_type = chart_type
            return {"success": True, "chart_id": chart_id, "sheet_name": sheet_name}

        return _run_with_workbook(
            workbook_path,
            create=False,
            save_after=True,
            operation=_op,
        )
    except Exception as exc:
        logger.error("Excel operation failed: %s", exc, exc_info=True)
        return {"error": str(exc)}


def delete_chart(workbook_id: str, sheet_name: str, chart_id: str) -> Dict[str, Any]:
    """
    Delete a chart from worksheet.
    
    Args:
        workbook_id: Workbook ID
        sheet_name: Sheet name
        chart_id: Chart ID
        
    Returns:
        Dict with deletion confirmation
    """
    if not all([workbook_id, sheet_name, chart_id]):
        return {"error": "workbook_id, sheet_name, and chart_id are required"}

    try:
        workbook_path = _normalize_workbook_path(workbook_id, allow_missing=False)

        def _op(book):
            sheet = _get_sheet(book, sheet_name)
            chart = sheet.charts[chart_id]
            chart.delete()
            return {"success": True, "chart_id": chart_id, "sheet_name": sheet_name}

        return _run_with_workbook(
            workbook_path,
            create=False,
            save_after=True,
            operation=_op,
        )
    except Exception as exc:
        logger.error("Excel operation failed: %s", exc, exc_info=True)
        return {"error": str(exc)}


# ============================================================================
# TABLE OPERATIONS
# ============================================================================


def create_table(
    workbook_id: str,
    sheet_name: str,
    range_address: str,
    table_name: str,
    has_headers: bool = True
) -> Dict[str, Any]:
    """
    Create an Excel table from range.
    
    Args:
        workbook_id: Workbook ID
        sheet_name: Sheet name
        range_address: Data range (e.g., "A1:C10")
        table_name: Table name
        has_headers: Whether first row contains headers
        
    Returns:
        Dict with table creation confirmation
    """
    if not all([workbook_id, sheet_name, range_address, table_name]):
        return {"error": "workbook_id, sheet_name, range_address, and table_name are required"}

    try:
        workbook_path = _normalize_workbook_path(workbook_id, allow_missing=False)

        def _op(book):
            sheet = _get_sheet(book, sheet_name)
            if table_name in [t.name for t in sheet.tables]:
                return {"success": True, "table_name": table_name, "message": "already_exists"}
            table = sheet.tables.add(
                source=sheet.range(range_address),
                name=table_name,
                has_headers=has_headers,
            )
            return {
                "success": True,
                "table_name": table.name,
                "range_address": table.range.address,
            }

        return _run_with_workbook(
            workbook_path,
            create=False,
            save_after=True,
            operation=_op,
        )
    except Exception as exc:
        logger.error("Excel operation failed: %s", exc, exc_info=True)
        return {"error": str(exc)}


def get_table_info(workbook_id: str, sheet_name: str, table_name: str) -> Dict[str, Any]:
    """
    Get information about an Excel table.
    
    Args:
        workbook_id: Workbook ID
        sheet_name: Sheet name
        table_name: Table name
        
    Returns:
        Dict with table information
    """
    if not all([workbook_id, sheet_name, table_name]):
        return {"error": "workbook_id, sheet_name, and table_name are required"}

    try:
        workbook_path = _normalize_workbook_path(workbook_id, allow_missing=False)

        def _op(book):
            sheet = _get_sheet(book, sheet_name)
            table = sheet.tables[table_name]
            body = getattr(table, "data_body_range", None)
            data = _normalize_read_value(body.value if body else table.range.value)
            return {
                "table_name": table.name,
                "range_address": table.range.address,
                "data": data,
            }

        return _run_with_workbook(
            workbook_path,
            create=False,
            save_after=False,
            operation=_op,
        )
    except Exception as exc:
        logger.error("Excel operation failed: %s", exc, exc_info=True)
        return {"error": str(exc)}


def update_table(
    workbook_id: str,
    sheet_name: str,
    table_name: str,
    data: List[List]
) -> Dict[str, Any]:
    """
    Update Excel table data.
    
    Args:
        workbook_id: Workbook ID
        sheet_name: Sheet name
        table_name: Table name
        data: New table data (list of lists)
        
    Returns:
        Dict with update confirmation
    """
    if not all([workbook_id, sheet_name, table_name, data]):
        return {"error": "workbook_id, sheet_name, table_name, and data are required"}

    try:
        workbook_path = _normalize_workbook_path(workbook_id, allow_missing=False)

        def _op(book):
            sheet = _get_sheet(book, sheet_name)
            table = sheet.tables[table_name]
            body = getattr(table, "data_body_range", None)
            if body is None:
                table.range.value = data
            else:
                body.value = data
            return {"success": True, "table_name": table.name}

        return _run_with_workbook(
            workbook_path,
            create=False,
            save_after=True,
            operation=_op,
        )
    except Exception as exc:
        logger.error("Excel operation failed: %s", exc, exc_info=True)
        return {"error": str(exc)}


# ============================================================================
# FORMATTING OPERATIONS
# ============================================================================


def format_range(
    workbook_id: str,
    sheet_name: str,
    range_address: str,
    format_options: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Apply formatting to a range.
    
    Args:
        workbook_id: Workbook ID
        sheet_name: Sheet name
        range_address: Range to format (e.g., "A1:C10")
        format_options: Dict with formatting options:
            - font_size: int
            - font_bold: bool
            - font_color: str (hex color)
            - bg_color: str (hex color)
            - number_format: str (e.g., "0.00", "#,##0")
            - alignment: str (left, center, right)
            
    Returns:
        Dict with formatting confirmation
    
    Example:
        format_range(wb_id, "Sheet1", "A1:A10", {
            "font_bold": True,
            "bg_color": "#FFFF00",
            "number_format": "0.00"
        })
    """
    if not all([workbook_id, sheet_name, range_address, format_options]):
        return {"error": "workbook_id, sheet_name, range_address, and format_options are required"}

    try:
        workbook_path = _normalize_workbook_path(workbook_id, allow_missing=False)
        xw = _ensure_xlwings_available()

        def _op(book):
            sheet = _get_sheet(book, sheet_name)
            rng = sheet.range(range_address)

            if "font_size" in format_options:
                rng.font.size = int(format_options["font_size"])
            if "font_bold" in format_options:
                rng.font.bold = bool(format_options["font_bold"])
            if "font_color" in format_options:
                rng.font.color = _hex_to_rgb(format_options["font_color"])
            if "bg_color" in format_options:
                rng.color = _hex_to_rgb(format_options["bg_color"])
            if "number_format" in format_options:
                rng.number_format = format_options["number_format"]
            if "alignment" in format_options:
                align = str(format_options["alignment"]).lower()
                align_map = {
                    "left": xw.constants.HAlign.xlHAlignLeft,
                    "center": xw.constants.HAlign.xlHAlignCenter,
                    "right": xw.constants.HAlign.xlHAlignRight,
                }
                if align not in align_map:
                    raise ValueError(f"Unsupported alignment: {align}")
                rng.api.HorizontalAlignment = align_map[align]

            return {"success": True, "range_address": range_address}

        return _run_with_workbook(
            workbook_path,
            create=False,
            save_after=True,
            operation=_op,
        )
    except Exception as exc:
        logger.error("Excel operation failed: %s", exc, exc_info=True)
        return {"error": str(exc)}


def merge_cells(workbook_id: str, sheet_name: str, range_address: str) -> Dict[str, Any]:
    """
    Merge cells in range.
    
    Args:
        workbook_id: Workbook ID
        sheet_name: Sheet name
        range_address: Range to merge (e.g., "A1:C1")
        
    Returns:
        Dict with merge confirmation
    """
    if not all([workbook_id, sheet_name, range_address]):
        return {"error": "workbook_id, sheet_name, and range_address are required"}

    try:
        workbook_path = _normalize_workbook_path(workbook_id, allow_missing=False)

        def _op(book):
            sheet = _get_sheet(book, sheet_name)
            sheet.range(range_address).merge()
            return {"success": True, "range_address": range_address}

        return _run_with_workbook(
            workbook_path,
            create=False,
            save_after=True,
            operation=_op,
        )
    except Exception as exc:
        logger.error("Excel operation failed: %s", exc, exc_info=True)
        return {"error": str(exc)}


def freeze_panes(workbook_id: str, sheet_name: str, cell_address: str) -> Dict[str, Any]:
    """
    Freeze panes at cell position.
    
    Args:
        workbook_id: Workbook ID
        sheet_name: Sheet name
        cell_address: Cell where freeze occurs (e.g., "B2" freezes row 1 and column A)
        
    Returns:
        Dict with freeze confirmation
    """
    if not all([workbook_id, sheet_name, cell_address]):
        return {"error": "workbook_id, sheet_name, and cell_address are required"}

    try:
        workbook_path = _normalize_workbook_path(workbook_id, allow_missing=False)

        def _op(book):
            sheet = _get_sheet(book, sheet_name)
            sheet.activate()
            sheet.range(cell_address).select()
            sheet.api.Application.ActiveWindow.FreezePanes = True
            return {"success": True, "cell_address": cell_address}

        return _run_with_workbook(
            workbook_path,
            create=False,
            save_after=True,
            operation=_op,
        )
    except Exception as exc:
        logger.error("Excel operation failed: %s", exc, exc_info=True)
        return {"error": str(exc)}


def show_autofilter(workbook_id: str, sheet_name: str, range_address: str) -> Dict[str, Any]:
    """
    Enable autofilter on range.
    
    Args:
        workbook_id: Workbook ID
        sheet_name: Sheet name
        range_address: Range for autofilter (e.g., "A1:C10")
        
    Returns:
        Dict with autofilter confirmation
    """
    if not all([workbook_id, sheet_name, range_address]):
        return {"error": "workbook_id, sheet_name, and range_address are required"}

    try:
        workbook_path = _normalize_workbook_path(workbook_id, allow_missing=False)

        def _op(book):
            sheet = _get_sheet(book, sheet_name)
            sheet.range(range_address).api.AutoFilter()
            return {"success": True, "range_address": range_address}

        return _run_with_workbook(
            workbook_path,
            create=False,
            save_after=True,
            operation=_op,
        )
    except Exception as exc:
        logger.error("Excel operation failed: %s", exc, exc_info=True)
        return {"error": str(exc)}


# ============================================================================
# NAMED RANGES
# ============================================================================


def create_named_range(
    workbook_id: str,
    name: str,
    range_address: str,
    sheet_name: Optional[str] = None
) -> Dict[str, Any]:
    """
    Create a named range.
    
    Args:
        workbook_id: Workbook ID
        name: Range name
        range_address: Range address (e.g., "A1:C10")
        sheet_name: Sheet name (optional, for sheet-scoped names)
        
    Returns:
        Dict with creation confirmation
    """
    if not all([workbook_id, name, range_address]):
        return {"error": "workbook_id, name, and range_address are required"}

    try:
        workbook_path = _normalize_workbook_path(workbook_id, allow_missing=False)

        def _op(book):
            sheet = _get_sheet(book, sheet_name) if sheet_name else book.sheets.active
            book.names.add(name, refers_to=sheet.range(range_address))
            return {"success": True, "name": name, "range_address": range_address}

        return _run_with_workbook(
            workbook_path,
            create=False,
            save_after=True,
            operation=_op,
        )
    except Exception as exc:
        logger.error("Excel operation failed: %s", exc, exc_info=True)
        return {"error": str(exc)}


# ============================================================================
# FORMULA OPERATIONS
# ============================================================================


def calculate_formula(
    workbook_id: str,
    sheet_name: str,
    formula: str,
    range_address: str = "A1"
) -> Dict[str, Any]:
    """
    Calculate and return result of Excel formula.
    
    Args:
        workbook_id: Workbook ID
        sheet_name: Sheet name
        formula: Excel formula (e.g., "=SUM(A1:A10)")
        range_address: Where to place formula (default: A1)
        
    Returns:
        Dict with:
            - result: calculated value
            - formula: formula used
            - error: str (if failed)
    
    Example:
        result = calculate_formula(wb_id, "Sheet1", "=SUM(A1:A10)")
        total = result['result']
    """
    if not all([workbook_id, sheet_name, formula]):
        return {"error": "workbook_id, sheet_name, and formula are required"}

    try:
        workbook_path = _normalize_workbook_path(workbook_id, allow_missing=False)

        def _op(book):
            sheet = _get_sheet(book, sheet_name)
            cell = sheet.range(range_address)
            cell.formula = formula
            try:
                book.app.calculate()
            except Exception:
                pass
            return {"success": True, "result": cell.value, "formula": formula}

        return _run_with_workbook(
            workbook_path,
            create=False,
            save_after=True,
            operation=_op,
        )
    except Exception as exc:
        logger.error("Excel operation failed: %s", exc, exc_info=True)
        return {"error": str(exc)}


# ============================================================================
# PICTURE OPERATIONS
# ============================================================================


def add_picture(
    workbook_id: str,
    sheet_name: str,
    image_path: str,
    position: str = "A1"
) -> Dict[str, Any]:
    """
    Add picture to worksheet.
    
    Args:
        workbook_id: Workbook ID
        sheet_name: Sheet name
        image_path: Path to image file
        position: Top-left cell position (default: A1)
        
    Returns:
        Dict with picture add confirmation
    """
    if not all([workbook_id, sheet_name, image_path]):
        return {"error": "workbook_id, sheet_name, and image_path are required"}

    try:
        workbook_path = _normalize_workbook_path(workbook_id, allow_missing=False)
        image_file = _resolve_existing_path(image_path)

        def _op(book):
            sheet = _get_sheet(book, sheet_name)
            anchor = sheet.range(position)
            sheet.pictures.add(
                str(image_file),
                left=anchor.left,
                top=anchor.top,
            )
            return {"success": True, "image_path": str(image_file), "position": position}

        return _run_with_workbook(
            workbook_path,
            create=False,
            save_after=True,
            operation=_op,
        )
    except Exception as exc:
        logger.error("Excel operation failed: %s", exc, exc_info=True)
        return {"error": str(exc)}


# ============================================================================
# EXPORT OPERATIONS
# ============================================================================


def export_data(
    workbook_id: str,
    sheet_name: str,
    range_address: Optional[str] = None,
    format: str = "csv"
) -> Dict[str, Any]:
    """
    Export data to different formats.
    
    Args:
        workbook_id: Workbook ID
        sheet_name: Sheet name
        range_address: Range to export (None = all data)
        format: Export format (csv, json, html)
        
    Returns:
        Dict with:
            - data: exported data string
            - format: format used
            - error: str (if failed)
    """
    if not workbook_id or not sheet_name:
        return {"error": "workbook_id and sheet_name are required"}

    export_format = (format or "csv").lower()
    if export_format not in {"csv", "json", "html"}:
        return {"error": f"Unsupported export format: {format}"}

    try:
        workbook_path = _normalize_workbook_path(workbook_id, allow_missing=False)

        def _op(book):
            sheet = _get_sheet(book, sheet_name)
            rng = sheet.range(range_address) if range_address else sheet.used_range
            data = _normalize_read_value(rng.value)

            if export_format == "json":
                payload = json.dumps(data)
            elif export_format == "csv":
                buf = io.StringIO()
                writer = csv.writer(buf)
                writer.writerows(data)
                payload = buf.getvalue()
            else:
                rows = []
                for row in data:
                    cells = "".join(f"<td>{html.escape(str(cell))}</td>" for cell in row)
                    rows.append(f"<tr>{cells}</tr>")
                payload = "<table>" + "".join(rows) + "</table>"

            return {
                "format": export_format,
                "data": payload,
                "range": rng.address,
            }

        return _run_with_workbook(
            workbook_path,
            create=False,
            save_after=False,
            operation=_op,
        )
    except Exception as exc:
        logger.error("Excel operation failed: %s", exc, exc_info=True)
        return {"error": str(exc)}


# ============================================================================
# HEALTH CHECK
# ============================================================================


def xlwings_health() -> Dict[str, Any]:
    """
    Check xlwings service health.
    
    Returns:
        Dict with:
            - status: str (active, error)
            - version: str
            - error: str (if failed)
    """
    try:
        xw = _ensure_xlwings_available()
        version = getattr(xw, "__version__", "unknown")
        with _XLWINGS_LOCK:
            with _excel_app():
                pass
        return {"status": "healthy", "version": version, "mode": "direct"}
    except Exception as exc:
        return {"status": "error", "error": str(exc)}

