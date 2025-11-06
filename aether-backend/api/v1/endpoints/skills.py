"""
Skills Management Endpoints

Endpoints for Open Interpreter skills management.

@.architecture
Incoming: api/v1/router.py, Frontend (HTTP GET/POST) --- {HTTP requests to /v1/skills, /v1/skills/new, /v1/skills/import, JSON payloads with skill name and content}
Processing: list_skills(), new_skill(), import_skill() --- {3 jobs: file_discovery, skill_validation, file_creation}
Outgoing: Local filesystem (skills directory), Frontend (HTTP) --- {JSONResponse with skill lists, creation/import results}
"""

from pathlib import Path
from typing import Dict, Any, List
from fastapi import APIRouter, Depends, HTTPException, status, Body
from fastapi.responses import JSONResponse

from api.dependencies import setup_request_context
from monitoring import get_logger

logger = get_logger(__name__)
router = APIRouter(tags=["skills"])

# Skills directory
SKILLS_DIR = Path("./skills").resolve()


# =============================================================================
# List Skills
# =============================================================================

@router.get(
    "/skills",
    summary="List available skills",
    description="List all available Open Interpreter skills"
)
async def list_skills(
    _context: dict = Depends(setup_request_context)
) -> JSONResponse:
    """
    List available skills.
    
    Skills are Python modules that extend Open Interpreter's capabilities.
    
    Returns:
        List of skill names and metadata
    """
    try:
        # Ensure skills directory exists
        SKILLS_DIR.mkdir(parents=True, exist_ok=True)
        
        # Find skill files
        skills = []
        
        for skill_file in SKILLS_DIR.glob("*.py"):
            # Skip __init__ and hidden files
            if skill_file.name.startswith("_") or skill_file.name.startswith("."):
                continue
            
            skills.append({
                "name": skill_file.stem,
                "filename": skill_file.name,
                "path": str(skill_file),
                "size_bytes": skill_file.stat().st_size
            })
        
        # Sort by name
        skills.sort(key=lambda s: s["name"])
        
        logger.info(f"Listed {len(skills)} skills")
        
        return JSONResponse({
            "skills": skills,
            "count": len(skills)
        })
        
    except Exception as e:
        logger.error(f"Failed to list skills: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to list skills: {str(e)}"
        )


# =============================================================================
# Create New Skill
# =============================================================================

@router.post(
    "/skills/new",
    summary="Create new skill",
    description="Create a new skill from template or content"
)
async def new_skill(
    payload: Dict[str, Any] = Body(...),
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
        # Ensure skills directory exists
        SKILLS_DIR.mkdir(parents=True, exist_ok=True)
        
        # Extract skill name and content
        skill_name = payload.get("name", "").strip()
        content = payload.get("content", "")
        
        if not skill_name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Skill name is required"
            )
        
        # Validate skill name (alphanumeric + underscore only)
        if not skill_name.replace("_", "").isalnum():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Skill name must contain only alphanumeric characters and underscores"
            )
        
        # Create skill file
        skill_file = SKILLS_DIR / f"{skill_name}.py"
        
        if skill_file.exists():
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Skill '{skill_name}' already exists"
            )
        
        # Write content or use template
        if not content:
            content = f'''"""
{skill_name} skill

Description: Add skill description here
"""

def {skill_name}():
    """Skill function."""
    pass
'''
        
        skill_file.write_text(content, encoding="utf-8")
        
        logger.info(f"Created skill: {skill_name}")
        
        return JSONResponse({
            "success": True,
            "name": skill_name,
            "path": str(skill_file),
            "size_bytes": skill_file.stat().st_size
        })
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to create skill: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create skill: {str(e)}"
        )


# =============================================================================
# Import Skill
# =============================================================================

@router.post(
    "/skills/import",
    summary="Import skill",
    description="Import a skill from external source"
)
async def import_skill(
    payload: Dict[str, Any] = Body(...),
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
        # Ensure skills directory exists
        SKILLS_DIR.mkdir(parents=True, exist_ok=True)
        
        # Extract data
        skill_name = payload.get("name", "").strip()
        content = payload.get("content", "")
        
        if not skill_name or not content:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Skill name and content are required"
            )
        
        # Validate skill name
        if not skill_name.replace("_", "").isalnum():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Skill name must contain only alphanumeric characters and underscores"
            )
        
        # Size limit (1MB)
        if len(content) > 1024 * 1024:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail="Skill content too large (max 1MB)"
            )
        
        # Create skill file
        skill_file = SKILLS_DIR / f"{skill_name}.py"
        
        # Write content
        skill_file.write_text(content, encoding="utf-8")
        
        # Remove executable bits for security
        skill_file.chmod(0o644)
        
        logger.info(f"Imported skill: {skill_name}")
        
        return JSONResponse({
            "success": True,
            "name": skill_name,
            "path": str(skill_file),
            "size_bytes": skill_file.stat().st_size
        })
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to import skill: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to import skill: {str(e)}"
        )

