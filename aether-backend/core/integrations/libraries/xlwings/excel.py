"""
XLWings Excel Automation - Layer 1 Implementation

Provides comprehensive Excel workbook creation, manipulation, and automation
via xlwings API server.

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
Incoming: api/v1/endpoints/xlwings_api.py, services/xlwings --- {Dict workbook config, str workbook_id, List[List] data, Dict chart config}
Processing: excel_workbook_create(), excel_sheet_create(), excel_data_write(), excel_data_read(), excel_chart_create() --- {5 jobs: chart_creation, data_manipulation, excel_automation, formatting, workbook_management}
Outgoing: api/v1/endpoints/xlwings_api.py, XLWings server --- {Dict[str, Any] workbook info, str workbook_id, List[List] read data, HTTP requests to xlwings server}
"""

import json
import logging
from typing import Any, Dict, List, Optional, Union

import httpx

logger = logging.getLogger(__name__)


def _get_xlwings_url() -> str:
    """Get XLWings URL from settings or use default."""
    try:
        from config.settings import get_settings
        return get_settings().integrations.xlwings_url
    except Exception:
        # Fallback if settings not available
        return "http://localhost:8080"


def _xlwings_api_call(
    endpoint: str,
    method: str = "GET",
    data: Optional[Dict] = None,
    timeout: float = 30.0
) -> Dict[str, Any]:
    """
    Make API call to xlwings backend service.
    
    Args:
        endpoint: API endpoint (e.g., "/workbooks/create")
        method: HTTP method (GET, POST)
        data: Request data (for POST)
        timeout: Request timeout
        
    Returns:
        Dict with API response or error
    """
    xlwings_url = _get_xlwings_url()
    url = f"{xlwings_url}{endpoint}"
    
    try:
        with httpx.Client(timeout=timeout) as client:
            if method == "GET":
                response = client.get(url)
            elif method == "POST":
                if data:
                    response = client.post(url, json=data)
                else:
                    response = client.post(url)
            else:
                return {"error": f"Unsupported HTTP method: {method}"}
            
            response.raise_for_status()
            return response.json()
            
    except httpx.TimeoutException:
        error_msg = f"XLWings API timeout after {timeout}s"
        logger.error(error_msg)
        return {"error": error_msg}
    except httpx.HTTPStatusError as e:
        error_msg = f"XLWings API error: HTTP {e.response.status_code}"
        logger.error(f"{error_msg}: {e.response.text}")
        return {"error": error_msg}
    except httpx.ConnectError:
        error_msg = f"Cannot connect to XLWings at {xlwings_url}"
        logger.error(error_msg)
        return {"error": error_msg}
    except Exception as e:
        error_msg = f"XLWings operation failed: {str(e)}"
        logger.error(error_msg)
        return {"error": error_msg}


# ============================================================================
# WORKBOOK MANAGEMENT
# ============================================================================


def create_workbook() -> Dict[str, Any]:
    """
    Create a new Excel workbook.
    
    Returns:
        Dict with:
            - workbook_id: str (REQUIRED for all subsequent operations)
            - info: dict (workbook metadata)
            - error: str (if failed)
    
    Example:
        result = create_workbook()
        if "error" not in result:
            wb_id = result['workbook_id']  # Save this!
    
    Important:
        Always save the returned workbook_id for subsequent operations.
    """
    result = _xlwings_api_call("/workbooks/create", "POST")
    if "error" not in result:
        logger.info(f"Created workbook: {result.get('workbook_id')}")
    return result


def load_workbook(filename: str) -> Dict[str, Any]:
    """
    Load an existing Excel workbook from file.
    
    Args:
        filename: Path to Excel file
        
    Returns:
        Dict with workbook_id and info
        
    Note:
        Currently not fully implemented - use save_workbook to create files.
    """
    return {"error": "File upload not yet implemented in xlwings API server"}


def save_workbook(workbook_id: str, filename: str = "workbook.xlsx") -> Dict[str, Any]:
    """
    Save workbook to file.
    
    Args:
        workbook_id: Workbook ID from create_workbook()
        filename: Output filename (default: workbook.xlsx)
        
    Returns:
        Dict with save confirmation
    
    Example:
        save_workbook(wb_id, "report.xlsx")
    
    Important:
        Filename should end with .xlsx extension.
        File is saved to configured save directory (default: data/files/).
    """
    if not workbook_id:
        return {"error": "workbook_id is required"}
    
    data = {"filename": filename}
    result = _xlwings_api_call(f"/workbooks/{workbook_id}/save", "POST", data)
    
    if "error" not in result:
        logger.info(f"Saved workbook {workbook_id} to {filename}")
    
    return result


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
    
    result = _xlwings_api_call(f"/workbooks/{workbook_id}/close", "POST")
    
    if "error" not in result:
        logger.info(f"Closed workbook {workbook_id}")
    
    return result


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
    
    return _xlwings_api_call(f"/workbooks/{workbook_id}/info")


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
    
    data = {"name": name}
    result = _xlwings_api_call(f"/workbooks/{workbook_id}/sheets/create", "POST", data)
    
    if "error" not in result:
        logger.info(f"Created sheet '{name}' in workbook {workbook_id}")
    
    return result


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
    
    data = {"name": sheet_name}
    return _xlwings_api_call(f"/workbooks/{workbook_id}/sheets/delete", "POST", data)


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
    
    data = {"name": sheet_name}
    return _xlwings_api_call(f"/workbooks/{workbook_id}/sheets/activate", "POST", data)


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
    
    data = {"source": sheet_name, "target": new_name}
    return _xlwings_api_call(f"/workbooks/{workbook_id}/sheets/copy", "POST", data)


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
    
    data = {"dimension": dimension}
    return _xlwings_api_call(f"/workbooks/{workbook_id}/sheets/{sheet_name}/autofit", "POST", data)


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
        - write_data does NOT save the file automatically
        - Call save_workbook() afterward to persist changes
    """
    if not workbook_id:
        return {"error": "workbook_id is required. Use create_workbook() first."}
    if not sheet_name:
        return {"error": "sheet_name is required (e.g., 'Sheet1')"}
    if data is None:
        return {"error": "data is required"}
    
    # Serialize data to JSON string
    if isinstance(data, (dict, list)):
        data_serialized = json.dumps(data)
    else:
        data_serialized = str(data)
    
    payload = {
        "range_address": range_address,
        "data": data_serialized
    }
    
    result = _xlwings_api_call(
        f"/workbooks/{workbook_id}/sheets/{sheet_name}/write",
        "POST",
        payload
    )
    
    if "error" not in result:
        logger.debug(f"Wrote data to {sheet_name}!{range_address}")
    
    return result


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
    
    if range_address:
        return _xlwings_api_call(
            f"/workbooks/{workbook_id}/sheets/{sheet_name}/read?range={range_address}"
        )
    else:
        return _xlwings_api_call(
            f"/workbooks/{workbook_id}/sheets/{sheet_name}/read"
        )


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
    
    data = {"range": range_address}
    return _xlwings_api_call(
        f"/workbooks/{workbook_id}/sheets/{sheet_name}/clear",
        "POST",
        data
    )


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
    
    data = {
        "chart_type": chart_type,
        "data_range": data_range,
        "position": position
    }
    
    result = _xlwings_api_call(
        f"/workbooks/{workbook_id}/sheets/{sheet_name}/charts/create",
        "POST",
        data
    )
    
    if "error" not in result:
        logger.info(f"Created {chart_type} chart in {sheet_name}")
    
    return result


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
    
    data = {"chart_id": chart_id}
    if data_range:
        data["data_range"] = data_range
    if chart_type:
        data["chart_type"] = chart_type
    
    return _xlwings_api_call(
        f"/workbooks/{workbook_id}/sheets/{sheet_name}/charts/update",
        "POST",
        data
    )


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
    
    data = {"chart_id": chart_id}
    return _xlwings_api_call(
        f"/workbooks/{workbook_id}/sheets/{sheet_name}/charts/delete",
        "POST",
        data
    )


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
    
    data = {
        "range": range_address,
        "name": table_name,
        "has_headers": has_headers
    }
    
    return _xlwings_api_call(
        f"/workbooks/{workbook_id}/sheets/{sheet_name}/tables/create",
        "POST",
        data
    )


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
    
    return _xlwings_api_call(
        f"/workbooks/{workbook_id}/sheets/{sheet_name}/tables/{table_name}/info"
    )


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
    
    payload = {
        "data": json.dumps(data)
    }
    
    return _xlwings_api_call(
        f"/workbooks/{workbook_id}/sheets/{sheet_name}/tables/{table_name}/update",
        "POST",
        payload
    )


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
    
    data = {
        "range": range_address,
        "format": format_options
    }
    
    return _xlwings_api_call(
        f"/workbooks/{workbook_id}/sheets/{sheet_name}/format",
        "POST",
        data
    )


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
    
    data = {"range": range_address}
    return _xlwings_api_call(
        f"/workbooks/{workbook_id}/sheets/{sheet_name}/merge",
        "POST",
        data
    )


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
    
    data = {"cell": cell_address}
    return _xlwings_api_call(
        f"/workbooks/{workbook_id}/sheets/{sheet_name}/freeze",
        "POST",
        data
    )


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
    
    data = {"range": range_address}
    return _xlwings_api_call(
        f"/workbooks/{workbook_id}/sheets/{sheet_name}/autofilter",
        "POST",
        data
    )


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
    
    data = {
        "name": name,
        "range": range_address
    }
    if sheet_name:
        data["sheet"] = sheet_name
    
    return _xlwings_api_call(
        f"/workbooks/{workbook_id}/names/create",
        "POST",
        data
    )


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
    
    data = {
        "sheet_name": sheet_name,
        "formula": formula,
        "range_address": range_address
    }
    
    return _xlwings_api_call(
        f"/workbooks/{workbook_id}/calculate",
        "POST",
        data
    )


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
    
    data = {
        "image_path": image_path,
        "position": position
    }
    
    return _xlwings_api_call(
        f"/workbooks/{workbook_id}/sheets/{sheet_name}/pictures/add",
        "POST",
        data
    )


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
    
    params = f"?format={format}"
    if range_address:
        params += f"&range={range_address}"
    
    return _xlwings_api_call(
        f"/workbooks/{workbook_id}/sheets/{sheet_name}/export{params}"
    )


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
        result = _xlwings_api_call("/health")
        if "error" not in result:
            logger.debug("XLWings health check passed")
        return result
    except Exception as e:
        return {"status": "error", "error": str(e)}

