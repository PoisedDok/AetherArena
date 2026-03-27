"""
Skill Service

Domain service for managing Open Interpreter skills.
Orchestrates validation, listing, and storage via dependency injection.
"""

import os
from typing import List, Dict, Any

from data.infrastructure.file_storage_gateway import FileStorageGateway

class SkillServiceError(Exception):
    """Base exception for skill service errors."""
    pass

class SkillExistsError(SkillServiceError):
    """Raised when trying to create a skill that already exists."""
    pass

class SkillValidationError(SkillServiceError):
    """Raised when skill validation fails."""
    pass

class SkillSizeError(SkillServiceError):
    """Raised when a skill exceeds maximum size."""
    pass

class SkillService:
    def __init__(self, settings: Any, file_gateway: FileStorageGateway):
        self.settings = settings
        self.gateway = file_gateway
        
    def _get_skills_dir(self) -> str:
        """Resolve the configured skills directory path."""
        path_str = self.settings.interpreter.computer.skills_path
        return os.path.expanduser(path_str)
        
    def list_skills(self) -> List[Dict[str, Any]]:
        """
        List all available skills.
        
        Returns:
            List of dictionaries containing skill metadata.
        """
        skills_dir = self._get_skills_dir()
        self.gateway.ensure_directory(skills_dir)
        
        skills = self.gateway.list_files(skills_dir, "*.py")
        
        # Filter out hidden and init files
        valid_skills = [
            s for s in skills 
            if not s["filename"].startswith("_") and not s["filename"].startswith(".")
        ]
        
        valid_skills.sort(key=lambda s: s["name"])
        return valid_skills
        
    def create_skill(self, name: str, content: str = "") -> Dict[str, Any]:
        """
        Create a new skill from template or content.
        
        Args:
            name: Name of the skill
            content: Optional skill content. If empty, uses template.
            
        Returns:
            Dict containing created skill info
            
        Raises:
            SkillValidationError: If name is invalid or missing
            SkillExistsError: If skill already exists
        """
        skills_dir = self._get_skills_dir()
        self.gateway.ensure_directory(skills_dir)
        
        if not name:
            raise SkillValidationError("Skill name is required")
            
        if not name.replace("_", "").isalnum():
            raise SkillValidationError("Skill name must contain only alphanumeric characters and underscores")
            
        skill_path = os.path.join(skills_dir, f"{name}.py")
        
        if self.gateway.file_exists(skill_path):
            raise SkillExistsError(f"Skill '{name}' already exists")
            
        if not content:
            content = f'\"\"\"\n{name} skill\n\nDescription: Add skill description here\n\"\"\"\n\ndef {name}():\n    \"\"\"Skill function.\"\"\"\n    pass\n'
            
        self.gateway.write_text(skill_path, content)
        
        size_bytes = len(content.encode("utf-8"))
        
        return {
            "name": name,
            "path": skill_path,
            "size_bytes": size_bytes
        }
        
    def import_skill(self, name: str, content: str) -> Dict[str, Any]:
        """
        Import a skill from external source with security checks.
        
        Args:
            name: Skill name
            content: Skill content
            
        Raises:
            SkillValidationError: If name/content missing or invalid
            SkillSizeError: If content > 1MB
        """
        skills_dir = self._get_skills_dir()
        self.gateway.ensure_directory(skills_dir)
        
        if not name or not content:
            raise SkillValidationError("Skill name and content are required")
            
        if not name.replace("_", "").isalnum():
            raise SkillValidationError("Skill name must contain only alphanumeric characters and underscores")
            
        content_bytes = content.encode("utf-8")
        if len(content_bytes) > 1024 * 1024:
            raise SkillSizeError("Skill content too large (max 1MB)")
            
        skill_path = os.path.join(skills_dir, f"{name}.py")
        
        self.gateway.write_text(skill_path, content)
        self.gateway.set_permissions(skill_path, 0o644)
        
        return {
            "name": name,
            "path": skill_path,
            "size_bytes": len(content_bytes)
        }


    def dispose(self) -> None:
        """Clean up resources held by this service."""
        pass
