"""
Skills Management Endpoints

Endpoints for Open Interpreter skills management.

@.architecture
Incoming: api/v1/router.py, frontend HTTP clients --- {HTTPRequest, Dict[str, Any]}
Processing: enumerate skills, validate payloads, persist script files --- {JOB_FILE_READ, JOB_FILE_WRITE, JOB_MANAGE_STORAGE}
Outgoing: application/skills/skill_service.py, frontend HTTP clients --- {JSONResponse, Dict[str, Any]}
"""

from typing import Dict, Any
from fastapi import APIRouter, Depends, HTTPException, status, Body
from fastapi.responses import JSONResponse

from api.dependencies import setup_request_context, get_skill_service
from application.skills.skill_service import SkillService, SkillValidationError, SkillExistsError, SkillSizeError
from monitoring import get_logger

logger = get_logger(__name__)
router = APIRouter(tags=["skills"], prefix="/skills")


# =============================================================================
# List Skills
# =============================================================================

@router.get(
    "",
    summary="List available skills",
    description="List all available Open Interpreter skills"
)
async def list_skills(
    skill_service: SkillService = Depends(get_skill_service),
    _context: dict = Depends(setup_request_context)
) -> JSONResponse:
    """
    List available skills.
    
    Skills are Python modules that extend Open Interpreter's capabilities.
    
    Returns:
        List of skill names and metadata
    """
    try:
        skills = skill_service.list_skills()
        
        logger.info("Listed %s skills", len(skills))
        
        return JSONResponse({
            "skills": skills,
            "count": len(skills)
        })
        
    except Exception as e:
        logger.error("Failed to list skills: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list skills"
        )


# =============================================================================
# Create New Skill
# =============================================================================

@router.post(
    "/new",
    summary="Create new skill",
    description="Create a new skill from template or content"
)
async def new_skill(
    payload: Dict[str, Any] = Body(...),
    skill_service: SkillService = Depends(get_skill_service),
    _context: dict = Depends(setup_request_context)
) -> JSONResponse:
    """
    Create new skill.
    
    Args:
        payload: Skill data including name and content
        
    Returns:
        Created skill information
    """
    try:
        skill_name = payload.get("name", "").strip()
        content = payload.get("content", "")
        
        result = skill_service.create_skill(skill_name, content)
        
        logger.info("Created skill: %s", skill_name)
        
        result["success"] = True
        return JSONResponse(result)
        
    except SkillValidationError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except SkillExistsError as e:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(e)
        )
    except Exception as e:
        logger.error("Failed to create skill: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create skill"
        )


# =============================================================================
# Import Skill
# =============================================================================

@router.post(
    "/import",
    summary="Import skill",
    description="Import a skill from external source"
)
async def import_skill(
    payload: Dict[str, Any] = Body(...),
    skill_service: SkillService = Depends(get_skill_service),
    _context: dict = Depends(setup_request_context)
) -> JSONResponse:
    """
    Import skill from external source.
    
    Args:
        payload: Import data including skill name and content
        
    Returns:
        Imported skill information
    """
    try:
        skill_name = payload.get("name", "").strip()
        content = payload.get("content", "")
        
        result = skill_service.import_skill(skill_name, content)
        
        logger.info("Imported skill: %s", skill_name)
        
        result["success"] = True
        return JSONResponse(result)
        
    except SkillValidationError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except SkillSizeError as e:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=str(e)
        )
    except Exception as e:
        logger.error("Failed to import skill: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to import skill"
        )

