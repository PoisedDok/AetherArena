import pytest
from unittest.mock import Mock

from application.skills.skill_service import SkillService, SkillValidationError, SkillExistsError, SkillSizeError
from api.dependencies import get_skill_service, require_local_request_dependency

@pytest.fixture
def mock_skill_service():
    service = Mock(spec=SkillService)
    return service

@pytest.fixture(autouse=True)
def override_dependencies(app, mock_skill_service):
    app.dependency_overrides[get_skill_service] = lambda: mock_skill_service
    app.dependency_overrides[require_local_request_dependency] = lambda: None
    yield

@pytest.mark.asyncio
async def test_list_skills(client, mock_skill_service):
    mock_skill_service.list_skills.return_value = [
        {"name": "test_skill", "filename": "test_skill.py", "path": "/fake/path/test_skill.py", "size_bytes": 100}
    ]
    
    response = await client.get("/v1/skills")
    assert response.status_code == 200
    assert response.json() == {
        "count": 1,
        "skills": [
            {"name": "test_skill", "filename": "test_skill.py", "path": "/fake/path/test_skill.py", "size_bytes": 100}
        ]
    }

@pytest.mark.asyncio
async def test_list_skills_error(client, mock_skill_service):
    mock_skill_service.list_skills.side_effect = Exception("Storage error")
    
    response = await client.get("/v1/skills")
    assert response.status_code == 500

@pytest.mark.asyncio
async def test_new_skill_success(client, mock_skill_service):
    mock_skill_service.create_skill.return_value = {
        "name": "new_skill", "path": "/fake/path", "size_bytes": 50
    }
    
    response = await client.post("/v1/skills/new", json={"name": "new_skill", "content": ""})
    assert response.status_code == 200
    assert response.json() == {
        "success": True,
        "name": "new_skill",
        "path": "/fake/path",
        "size_bytes": 50
    }

@pytest.mark.asyncio
async def test_new_skill_validation_error(client, mock_skill_service):
    mock_skill_service.create_skill.side_effect = SkillValidationError("Invalid name")
    
    response = await client.post("/v1/skills/new", json={"name": "bad name!"})
    assert response.status_code == 400

@pytest.mark.asyncio
async def test_new_skill_exists_error(client, mock_skill_service):
    mock_skill_service.create_skill.side_effect = SkillExistsError("Already exists")
    
    response = await client.post("/v1/skills/new", json={"name": "existing_skill"})
    assert response.status_code == 409

@pytest.mark.asyncio
async def test_import_skill_success(client, mock_skill_service):
    mock_skill_service.import_skill.return_value = {
        "name": "imported_skill", "path": "/fake/path", "size_bytes": 100
    }
    
    response = await client.post("/v1/skills/import", json={"name": "imported_skill", "content": "print('hello')"})
    assert response.status_code == 200
    assert response.json() == {
        "success": True,
        "name": "imported_skill",
        "path": "/fake/path",
        "size_bytes": 100
    }

@pytest.mark.asyncio
async def test_import_skill_size_error(client, mock_skill_service):
    mock_skill_service.import_skill.side_effect = SkillSizeError("Too big")
    
    response = await client.post("/v1/skills/import", json={"name": "huge_skill", "content": "x" * 10000000})
    assert response.status_code == 413
