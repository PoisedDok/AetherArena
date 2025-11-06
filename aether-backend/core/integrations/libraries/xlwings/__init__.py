"""
XLWings Excel Automation - Layer 2 Exposure

Exports all xlwings Excel automation functions.
"""

from .excel import (
    # Workbook management
    create_workbook,
    load_workbook,
    save_workbook,
    close_workbook,
    get_workbook_info,
    # Sheet operations
    create_sheet,
    delete_sheet,
    activate_sheet,
    copy_sheet,
    autofit_sheet,
    # Data operations
    write_data,
    read_data,
    clear_range,
    # Chart operations
    create_chart,
    update_chart,
    delete_chart,
    # Table operations
    create_table,
    get_table_info,
    update_table,
    # Formatting
    format_range,
    merge_cells,
    freeze_panes,
    show_autofilter,
    # Named ranges
    create_named_range,
    # Formula
    calculate_formula,
    # Pictures
    add_picture,
    # Export
    export_data,
    # Health
    xlwings_health
)

__all__ = [
    # Workbook management
    'create_workbook',
    'load_workbook',
    'save_workbook',
    'close_workbook',
    'get_workbook_info',
    # Sheet operations
    'create_sheet',
    'delete_sheet',
    'activate_sheet',
    'copy_sheet',
    'autofit_sheet',
    # Data operations
    'write_data',
    'read_data',
    'clear_range',
    # Chart operations
    'create_chart',
    'update_chart',
    'delete_chart',
    # Table operations
    'create_table',
    'get_table_info',
    'update_table',
    # Formatting
    'format_range',
    'merge_cells',
    'freeze_panes',
    'show_autofilter',
    # Named ranges
    'create_named_range',
    # Formula
    'calculate_formula',
    # Pictures
    'add_picture',
    # Export
    'export_data',
    # Health
    'xlwings_health'
]

