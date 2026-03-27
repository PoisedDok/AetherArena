"""
Unit tests for xlwings endpoint (api/v1/endpoints/xlwings_api.py).

10 routes:
  POST /v1/xlwings/workbook/create
  POST /v1/xlwings/workbook/save
  GET  /v1/xlwings/workbook/{id}/info
  POST /v1/xlwings/workbook/{id}/close
  POST /v1/xlwings/sheet/create
  POST /v1/xlwings/data/write
  POST /v1/xlwings/data/read
  POST /v1/xlwings/chart/create
  POST /v1/xlwings/format/range
  GET  /v1/xlwings/health

NOTE: All routes require `require_local_request_dependency` — in test mode this is
      typically bypassed or permissive. We mock the `excel` module.

CI: pytest tests/unit/api/test_xlwings_endpoint.py -m unit --no-cov -q
"""

import pytest
from unittest.mock import patch


EXCEL_MODULE = "api.v1.endpoints.xlwings_api.excel"


# ===========================================================================
# Health
# ===========================================================================

class TestXlwingsHealth:
    """Tests for GET /v1/xlwings/health."""

    @pytest.mark.asyncio
    async def test_health_success(self, client):
        """Health returns status."""
        with patch(EXCEL_MODULE) as mock_excel:
            mock_excel.xlwings_health.return_value = {"status": "ok", "platform": "darwin"}
            resp = await client.get("/v1/xlwings/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"

    @pytest.mark.asyncio
    async def test_health_error(self, client):
        """Health error returns error status (not 500)."""
        with patch(EXCEL_MODULE) as mock_excel:
            mock_excel.xlwings_health.side_effect = RuntimeError("crash")
            resp = await client.get("/v1/xlwings/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "error"


# ===========================================================================
# Workbook Management
# ===========================================================================

class TestWorkbookCreate:
    """Tests for POST /v1/xlwings/workbook/create."""

    @pytest.mark.asyncio
    async def test_create_success(self, client):
        """Create workbook returns workbook_id."""
        with patch(EXCEL_MODULE) as mock_excel:
            mock_excel.create_workbook.return_value = {
                "workbook_id": "/tmp/test.xlsx",
                "sheets": ["Sheet1"],
            }
            resp = await client.post("/v1/xlwings/workbook/create", json={})
        assert resp.status_code == 200
        assert "workbook_id" in resp.json()

    @pytest.mark.asyncio
    async def test_create_with_filename(self, client):
        """Create workbook with custom filename."""
        with patch(EXCEL_MODULE) as mock_excel:
            mock_excel.create_workbook.return_value = {"workbook_id": "/tmp/custom.xlsx"}
            resp = await client.post("/v1/xlwings/workbook/create", json={"filename": "custom.xlsx"})
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_create_error_in_result(self, client):
        """Create returning error dict returns 500."""
        with patch(EXCEL_MODULE) as mock_excel:
            mock_excel.create_workbook.return_value = {"error": "xlwings not available"}
            resp = await client.post("/v1/xlwings/workbook/create", json={})
        assert resp.status_code == 500

    @pytest.mark.asyncio
    async def test_create_error_400_in_result(self, client):
        """Create returning 400 error dict returns 400."""
        with patch(EXCEL_MODULE) as mock_excel:
            mock_excel.create_workbook.return_value = {"error": "invalid parameter"}
            resp = await client.post("/v1/xlwings/workbook/create", json={})
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_create_exception(self, client):
        """Create raising exception returns 500."""
        with patch(EXCEL_MODULE) as mock_excel:
            mock_excel.create_workbook.side_effect = RuntimeError("crash")
            resp = await client.post("/v1/xlwings/workbook/create", json={})
        assert resp.status_code == 500


class TestWorkbookSave:
    """Tests for POST /v1/xlwings/workbook/save."""

    @pytest.mark.asyncio
    async def test_save_success(self, client):
        """Save workbook succeeds."""
        with patch(EXCEL_MODULE) as mock_excel:
            mock_excel.save_workbook.return_value = {"saved": True, "path": "/tmp/out.xlsx"}
            resp = await client.post("/v1/xlwings/workbook/save", json={
                "workbook_id": "/tmp/test.xlsx",
                "filename": "out.xlsx",
            })
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_save_error_in_result(self, client):
        """Save returning error dict returns 400."""
        with patch(EXCEL_MODULE) as mock_excel:
            mock_excel.save_workbook.return_value = {"error": "workbook invalid"}
            resp = await client.post("/v1/xlwings/workbook/save", json={
                "workbook_id": "/tmp/test.xlsx",
                "filename": "out.xlsx",
            })
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_save_exception(self, client):
        """Save raising exception returns 500."""
        with patch(EXCEL_MODULE) as mock_excel:
            mock_excel.save_workbook.side_effect = RuntimeError("disk full")
            resp = await client.post("/v1/xlwings/workbook/save", json={
                "workbook_id": "/tmp/test.xlsx",
                "filename": "out.xlsx",
            })
        assert resp.status_code == 500


class TestWorkbookInfo:
    """Tests for GET /v1/xlwings/workbook/{id}/info."""

    @pytest.mark.asyncio
    async def test_info_success(self, client):
        """Get workbook info succeeds."""
        with patch(EXCEL_MODULE) as mock_excel:
            mock_excel.get_workbook_info.return_value = {"sheets": ["Sheet1"], "name": "test"}
            resp = await client.get("/v1/xlwings/workbook/test.xlsx/info")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_info_not_found(self, client):
        """Missing workbook returns 404."""
        with patch(EXCEL_MODULE) as mock_excel:
            mock_excel.get_workbook_info.return_value = {"error": "not found"}
            resp = await client.get("/v1/xlwings/workbook/missing.xlsx/info")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_info_exception(self, client):
        """Info raising exception returns 500."""
        with patch(EXCEL_MODULE) as mock_excel:
            mock_excel.get_workbook_info.side_effect = RuntimeError("crash")
            resp = await client.get("/v1/xlwings/workbook/test.xlsx/info")
        assert resp.status_code == 500


class TestWorkbookClose:
    """Tests for POST /v1/xlwings/workbook/{id}/close."""

    @pytest.mark.asyncio
    async def test_close_success(self, client):
        """Close workbook succeeds."""
        with patch(EXCEL_MODULE) as mock_excel:
            mock_excel.close_workbook.return_value = {"closed": True}
            resp = await client.post("/v1/xlwings/workbook/test.xlsx/close")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_close_error(self, client):
        """Close workbook error returns 400."""
        with patch(EXCEL_MODULE) as mock_excel:
            mock_excel.close_workbook.return_value = {"error": "cannot close workbook"}
            resp = await client.post("/v1/xlwings/workbook/test.xlsx/close")
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_close_exception(self, client):
        """Close raising exception returns 500."""
        with patch(EXCEL_MODULE) as mock_excel:
            mock_excel.close_workbook.side_effect = RuntimeError("crash")
            resp = await client.post("/v1/xlwings/workbook/test.xlsx/close")
        assert resp.status_code == 500


# ===========================================================================
# Sheet Operations
# ===========================================================================

class TestSheetCreate:
    """Tests for POST /v1/xlwings/sheet/create."""

    @pytest.mark.asyncio
    async def test_create_sheet_success(self, client):
        """Create sheet succeeds."""
        with patch(EXCEL_MODULE) as mock_excel:
            mock_excel.create_sheet.return_value = {"sheet": "Report", "created": True}
            resp = await client.post("/v1/xlwings/sheet/create", json={
                "workbook_id": "/tmp/test.xlsx",
                "name": "Report",
            })
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_create_sheet_error(self, client):
        """Create sheet error returns 400."""
        with patch(EXCEL_MODULE) as mock_excel:
            mock_excel.create_sheet.return_value = {"error": "invalid name"}
            resp = await client.post("/v1/xlwings/sheet/create", json={
                "workbook_id": "/tmp/test.xlsx",
                "name": "Dup",
            })
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_create_sheet_exception(self, client):
        """Create sheet raising exception returns 500."""
        with patch(EXCEL_MODULE) as mock_excel:
            mock_excel.create_sheet.side_effect = RuntimeError("crash")
            resp = await client.post("/v1/xlwings/sheet/create", json={
                "workbook_id": "/tmp/test.xlsx",
                "name": "NewSheet",
            })
        assert resp.status_code == 500


# ===========================================================================
# Data Operations
# ===========================================================================

class TestDataWrite:
    """Tests for POST /v1/xlwings/data/write."""

    @pytest.mark.asyncio
    async def test_write_success(self, client):
        """Write data succeeds."""
        with patch(EXCEL_MODULE) as mock_excel:
            mock_excel.write_data.return_value = {"written": True}
            resp = await client.post("/v1/xlwings/data/write", json={
                "workbook_id": "/tmp/test.xlsx",
                "sheet_name": "Sheet1",
                "data": [[1, 2], [3, 4]],
                "range_address": "A1",
            })
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_write_error(self, client):
        """Write data error returns 400."""
        with patch(EXCEL_MODULE) as mock_excel:
            mock_excel.write_data.return_value = {"error": "invalid sheet"}
            resp = await client.post("/v1/xlwings/data/write", json={
                "workbook_id": "/tmp/test.xlsx",
                "sheet_name": "Missing",
                "data": "hello",
            })
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_write_exception(self, client):
        """Write data raising exception returns 500."""
        with patch(EXCEL_MODULE) as mock_excel:
            mock_excel.write_data.side_effect = RuntimeError("crash")
            resp = await client.post("/v1/xlwings/data/write", json={
                "workbook_id": "/tmp/test.xlsx",
                "sheet_name": "Sheet1",
                "data": "hello",
            })
        assert resp.status_code == 500


class TestDataRead:
    """Tests for POST /v1/xlwings/data/read."""

    @pytest.mark.asyncio
    async def test_read_success(self, client):
        """Read data succeeds."""
        with patch(EXCEL_MODULE) as mock_excel:
            mock_excel.read_data.return_value = {"data": [[1, 2]], "range": "A1:B1"}
            resp = await client.post("/v1/xlwings/data/read", json={
                "workbook_id": "/tmp/test.xlsx",
                "sheet_name": "Sheet1",
            })
        assert resp.status_code == 200
        assert "data" in resp.json()

    @pytest.mark.asyncio
    async def test_read_error(self, client):
        """Read data error returns 400."""
        with patch(EXCEL_MODULE) as mock_excel:
            mock_excel.read_data.return_value = {"error": "invalid workbook"}
            resp = await client.post("/v1/xlwings/data/read", json={
                "workbook_id": "/tmp/missing.xlsx",
                "sheet_name": "Sheet1",
            })
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_read_exception(self, client):
        """Read data raising exception returns 500."""
        with patch(EXCEL_MODULE) as mock_excel:
            mock_excel.read_data.side_effect = RuntimeError("crash")
            resp = await client.post("/v1/xlwings/data/read", json={
                "workbook_id": "/tmp/test.xlsx",
                "sheet_name": "Sheet1",
            })
        assert resp.status_code == 500


# ===========================================================================
# Chart Operations
# ===========================================================================

class TestChartCreate:
    """Tests for POST /v1/xlwings/chart/create."""

    @pytest.mark.asyncio
    async def test_chart_success(self, client):
        """Create chart succeeds."""
        with patch(EXCEL_MODULE) as mock_excel:
            mock_excel.create_chart.return_value = {"chart": "bar", "created": True}
            resp = await client.post("/v1/xlwings/chart/create", json={
                "workbook_id": "/tmp/test.xlsx",
                "sheet_name": "Sheet1",
                "chart_type": "bar",
                "data_range": "A1:B5",
            })
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_chart_error(self, client):
        """Create chart error returns 400."""
        with patch(EXCEL_MODULE) as mock_excel:
            mock_excel.create_chart.return_value = {"error": "invalid type"}
            resp = await client.post("/v1/xlwings/chart/create", json={
                "workbook_id": "/tmp/test.xlsx",
                "sheet_name": "Sheet1",
                "chart_type": "invalid",
                "data_range": "A1:B5",
            })
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_chart_exception(self, client):
        """Create chart raising exception returns 500."""
        with patch(EXCEL_MODULE) as mock_excel:
            mock_excel.create_chart.side_effect = RuntimeError("crash")
            resp = await client.post("/v1/xlwings/chart/create", json={
                "workbook_id": "/tmp/test.xlsx",
                "sheet_name": "Sheet1",
                "chart_type": "bar",
                "data_range": "A1:B5",
            })
        assert resp.status_code == 500


# ===========================================================================
# Format Operations
# ===========================================================================

class TestFormatRange:
    """Tests for POST /v1/xlwings/format/range."""

    @pytest.mark.asyncio
    async def test_format_success(self, client):
        """Format range succeeds."""
        with patch(EXCEL_MODULE) as mock_excel:
            mock_excel.format_range.return_value = {"formatted": True}
            resp = await client.post("/v1/xlwings/format/range", json={
                "workbook_id": "/tmp/test.xlsx",
                "sheet_name": "Sheet1",
                "range_address": "A1:D10",
                "format_options": {"bold": True, "font_size": 14},
            })
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_format_error(self, client):
        """Format range error returns 400."""
        with patch(EXCEL_MODULE) as mock_excel:
            mock_excel.format_range.return_value = {"error": "invalid range"}
            resp = await client.post("/v1/xlwings/format/range", json={
                "workbook_id": "/tmp/test.xlsx",
                "sheet_name": "Sheet1",
                "range_address": "INVALID",
                "format_options": {},
            })
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_format_exception(self, client):
        """Format range raising exception returns 500."""
        with patch(EXCEL_MODULE) as mock_excel:
            mock_excel.format_range.side_effect = RuntimeError("crash")
            resp = await client.post("/v1/xlwings/format/range", json={
                "workbook_id": "/tmp/test.xlsx",
                "sheet_name": "Sheet1",
                "range_address": "A1:D10",
                "format_options": {"bold": True},
            })
        assert resp.status_code == 500
