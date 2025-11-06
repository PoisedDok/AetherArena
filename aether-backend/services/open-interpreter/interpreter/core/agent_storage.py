import json
import os
import requests
from typing import Dict, List, Optional, Any, Union

class AgentStorage:
    """
    Interface to the Aether PostgreSQL storage system for agents
    Allows agents to store and retrieve outputs, code, and other files as artifacts

    NOTE: This now works with chat-based storage. Agents must specify chat_id for operations.
    """

    def __init__(self, api_base: str = "http://localhost:8765", chat_id: Optional[str] = None):
        """
        Initialize the agent storage interface

        Args:
            api_base: Base URL for the storage API
            chat_id: UUID of the chat to store artifacts in (required for operations)
        """
        self.api_base = api_base.rstrip("/")
        self.chat_id = chat_id
        self.ensure_storage_api()

    def ensure_storage_api(self):
        """Check if storage API is available"""
        try:
            response = requests.get(f"{self.api_base}/")
            if response.status_code == 200:
                return True
        except:
            pass

        return False

    def set_chat_id(self, chat_id: str):
        """Set the chat ID for subsequent operations"""
        self.chat_id = chat_id
    
    def create_chat(self, title: str = "Agent Generated Content") -> str:
        """Create a new chat for agent storage (replaces start_session)"""
        try:
            response = requests.post(
                f"{self.api_base}/api/storage/chats",
                json={"title": title}
            )
            if response.status_code == 200:
                data = response.json()
                self.chat_id = data.get("id")
                return self.chat_id
        except Exception as e:
            print(f"Error creating chat: {e}")
        return None
    
    def store_file(
        self,
        content: str,
        output_type: str,
        filename: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        message_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Store content as an artifact in the PostgreSQL storage system

        Args:
            content: Content to store
            output_type: Type of output (code, html, output, file, text, markdown, json)
            filename: Optional filename
            metadata: Optional metadata dictionary
            message_id: Optional UUID of message that created this artifact

        Returns:
            Dictionary with artifact information including ID
        """
        if not self.chat_id:
            print("Error: chat_id must be set before storing artifacts")
            return None

        try:
            # Map output_type to artifact type
            artifact_type = output_type
            if output_type not in ('code', 'html', 'output', 'file', 'text', 'markdown', 'json'):
                artifact_type = 'output'  # default

            # Determine language for code artifacts
            language = None
            if output_type in ('python', 'javascript', 'typescript'):
                language = output_type

            response = requests.post(
                f"{self.api_base}/api/storage/chats/{self.chat_id}/artifacts",
                json={
                    "type": artifact_type,
                    "filename": filename,
                    "content": content,
                    "language": language,
                    "metadata": metadata,
                    "message_id": message_id
                }
            )
            if response.status_code == 200:
                return response.json()
            else:
                print(f"Failed to store artifact: {response.status_code} - {response.text}")
        except Exception as e:
            print(f"Error storing artifact: {e}")
        return None
    
    def get_artifacts(
        self,
        artifact_type: Optional[str] = None,
        limit: int = 10
    ) -> List[Dict[str, Any]]:
        """Get artifacts for the current chat"""
        if not self.chat_id:
            print("Error: chat_id must be set before getting artifacts")
            return []

        try:
            response = requests.get(
                f"{self.api_base}/api/storage/chats/{self.chat_id}/artifacts"
            )
            if response.status_code == 200:
                artifacts = response.json()
                # Filter by type if specified
                if artifact_type:
                    artifacts = [a for a in artifacts if a.get('type') == artifact_type]
                # Sort by created_at desc and limit
                artifacts.sort(key=lambda x: x.get('created_at', ''), reverse=True)
                return artifacts[:limit]
            else:
                print(f"Failed to get artifacts: {response.status_code} - {response.text}")
        except Exception as e:
            print(f"Error getting artifacts: {e}")
        return []

    def get_artifact_content(self, artifact_id: str) -> str:
        """Get content of a specific artifact"""
        try:
            response = requests.get(f"{self.api_base}/api/storage/artifacts/{artifact_id}")
            if response.status_code == 200:
                data = response.json()
                return data.get("content", "")
            else:
                print(f"Failed to get artifact content: {response.status_code}")
        except Exception as e:
            print(f"Error getting artifact content: {e}")
        return ""

    def search_artifacts(
        self,
        query: str,
        artifact_type: Optional[str] = None,
        limit: int = 10
    ) -> List[Dict[str, Any]]:
        """Search for artifacts in the current chat"""
        if not self.chat_id:
            print("Error: chat_id must be set before searching artifacts")
            return []

        try:
            # Get all artifacts for the chat and filter by query
            artifacts = self.get_artifacts(artifact_type, limit=1000)  # Get more to filter

            # Filter by query (basic string matching)
            filtered = []
            query_lower = query.lower()
            for artifact in artifacts:
                content = artifact.get('content', '')
                filename = artifact.get('filename', '')
                if query_lower in content.lower() or query_lower in filename.lower():
                    filtered.append(artifact)

            return filtered[:limit]
        except Exception as e:
            print(f"Error searching artifacts: {e}")
            return []

    # Deprecated methods - no longer supported in PostgreSQL system
    def store_code_execution(self, *args, **kwargs):
        """DEPRECATED: Code execution tracking not implemented in PostgreSQL artifacts"""
        print("WARNING: store_code_execution() is deprecated")
        return None

    def get_recent_files(self, *args, **kwargs):
        """DEPRECATED: Use get_artifacts() instead"""
        print("WARNING: get_recent_files() is deprecated. Use get_artifacts() instead")
        return []

    def get_file_content(self, *args, **kwargs):
        """DEPRECATED: Use get_artifact_content() instead"""
        print("WARNING: get_file_content() is deprecated. Use get_artifact_content() instead")
        return ""

    def get_file_path(self, *args, **kwargs):
        """DEPRECATED: Artifacts are stored in database, not filesystem"""
        print("WARNING: get_file_path() is deprecated. Artifacts are stored in database")
        return None
