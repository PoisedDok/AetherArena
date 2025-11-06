# xlwings Backend Service

A FastAPI-based backend service that provides Excel automation capabilities using xlwings.

## Features

- **Excel Workbook Management**: Create, load, save, and close workbooks
- **Sheet Operations**: Add, delete, and manage worksheets
- **Data Operations**: Read and write data to/from Excel ranges
- **Chart Creation**: Generate various chart types
- **Formula Calculations**: Execute Excel formulas
- **RESTful API**: Complete REST API for all operations

## Quick Start

1. Install dependencies:
```bash
pip install -r requirements.txt
```

2. Start the service:
```bash
python xlwings_api_server.py
```

The service will be available at `http://localhost:8001`

## API Endpoints

### Health Check
- `GET /health` - Check service health and xlwings status

### Workbook Operations
- `POST /workbooks/create` - Create new workbook
- `POST /workbooks/load` - Load workbook from uploaded file
- `GET /workbooks/{workbook_id}/info` - Get workbook information
- `POST /workbooks/{workbook_id}/save` - Save workbook
- `POST /workbooks/{workbook_id}/close` - Close workbook

### Sheet Operations
- `POST /workbooks/{workbook_id}/sheets/create` - Create new sheet
- `POST /workbooks/{workbook_id}/sheets/{sheet_name}/write` - Write data to sheet
- `GET /workbooks/{workbook_id}/sheets/{sheet_name}/read` - Read data from sheet

### Chart Operations
- `POST /workbooks/{workbook_id}/charts/create` - Create chart

## Usage Examples

### Create a new workbook and add data:

```python
import requests

# Create workbook
response = requests.post("http://localhost:8001/workbooks/create")
workbook_id = response.json()["workbook_id"]

# Add data
data = [["Name", "Age", "City"], ["John", 30, "NYC"], ["Jane", 25, "LA"]]
response = requests.post(
    f"http://localhost:8001/workbooks/{workbook_id}/sheets/Sheet1/write",
    data={"range_address": "A1", "data": str(data)}
)
```

## Requirements

- Python 3.9+
- Excel (Microsoft Excel on Windows/macOS)
- xlwings library
- FastAPI and related dependencies

## Notes

- The service runs Excel in invisible mode by default
- Workbooks are cached in memory during the session
- Make sure Excel is properly installed and accessible
