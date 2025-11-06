import os
import sys
import requests
from typing import Dict, List, Optional, Any, Union

def store_to_agent_storage(
    content: str,
    output_type: str,
    filename: Optional[str] = None,
    api_base: str = "http://localhost:8765",
    chat_id: Optional[str] = None,
    message_id: Optional[str] = None
) -> Dict[str, Any]:
    """
    Store content as an artifact in the PostgreSQL storage system

    Args:
        content: Content to store
        output_type: Type of output (code, html, output, file, text, markdown, json)
        filename: Optional filename
        api_base: Base URL for the API
        chat_id: UUID of the chat (required for PostgreSQL storage)
        message_id: UUID of the message that created this artifact (optional)

    Returns:
        Dict with artifact information or None if storage failed
    """
    try:
        # Ensure API base doesn't end with slash
        api_base = api_base.rstrip("/")

        if not chat_id:
            print("Error: chat_id is required for PostgreSQL storage")
            return None

        # Map output_type to artifact type if needed
        artifact_type = output_type
        if output_type not in ('code', 'html', 'output', 'file', 'text', 'markdown', 'json'):
            # Default to 'output' for unknown types
            artifact_type = 'output'

        # Determine language for code artifacts
        language = None
        if output_type in ('python', 'javascript', 'typescript'):
            language = output_type

        # Make API request to create artifact
        response = requests.post(
            f"{api_base}/api/storage/chats/{chat_id}/artifacts",
            json={
                "type": artifact_type,
                "filename": filename,
                "content": content,
                "language": language,
                "message_id": message_id
            }
        )

        if response.status_code == 200:
            result = response.json()
            print(f"Content stored successfully as artifact: {result.get('filename') or result.get('id')}")
            return result
        else:
            print(f"Failed to store content as artifact. Status code: {response.status_code}")
            print(f"Response: {response.text}")
            return None
    except Exception as e:
        print(f"Error storing content as artifact: {str(e)}")
        return None

def write_to_storage_location(
    content: str,
    filename: str, 
    subdir: Optional[str] = None
) -> str:
    """
    Write content directly to the storage location
    
    Args:
        content: Content to write
        filename: Filename
        subdir: Optional subdirectory within the storage location
    
    Returns:
        Path to the file
    """
    try:
        # Determine base directory
        base_dir = os.path.abspath("./data/files")
        
        # Determine file directory based on subdir or file extension
        if subdir:
            file_dir = os.path.join(base_dir, subdir)
        else:
            # Determine directory based on file extension
            ext = os.path.splitext(filename)[1].lower().lstrip('.')
            
            if ext in ['html', 'htm']:
                file_dir = os.path.join(base_dir, "html")
            elif ext in ['py', 'js', 'ts', 'java', 'c', 'cpp', 'cs', 'go', 'rs', 'php']:
                file_dir = os.path.join(base_dir, "code")
            elif ext in ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg']:
                file_dir = os.path.join(base_dir, "images")
            elif ext in ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx']:
                file_dir = os.path.join(base_dir, "documents")
            else:
                file_dir = base_dir
        
        # Create directory if it doesn't exist
        os.makedirs(file_dir, exist_ok=True)
        
        # Create full file path
        file_path = os.path.join(file_dir, filename)
        
        # Write content to file
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(content)
        
        print(f"File written to: {file_path}")
        return file_path
    except Exception as e:
        print(f"Error writing to file: {str(e)}")
        return ""

def get_storage_path() -> str:
    """
    Get the path to the storage location
    
    Returns:
        Path to the storage location
    """
    return os.path.abspath("./data/files")

def list_stored_files(subdir: Optional[str] = None) -> List[Dict[str, str]]:
    """
    List files in the storage location
    
    Args:
        subdir: Optional subdirectory within the storage location
    
    Returns:
        List of file information dictionaries
    """
    try:
        base_dir = os.path.abspath("./data/files")
        target_dir = os.path.join(base_dir, subdir) if subdir else base_dir
        
        if not os.path.exists(target_dir):
            print(f"Directory does not exist: {target_dir}")
            return []
        
        files = []
        for root, _, filenames in os.walk(target_dir):
            for filename in filenames:
                file_path = os.path.join(root, filename)
                rel_path = os.path.relpath(file_path, base_dir)
                
                files.append({
                    "name": filename,
                    "path": file_path,
                    "relative_path": rel_path,
                    "type": os.path.splitext(filename)[1].lower().lstrip('.') or "unknown"
                })
        
        return files
    except Exception as e:
        print(f"Error listing files: {str(e)}")
        return []

def search_artifacts(query: str, chat_id: Optional[str] = None, api_base: str = "http://localhost:8765") -> List[Dict[str, Any]]:
    """
    Search for artifacts in the PostgreSQL storage system

    Args:
        query: Search query (full-text search on content)
        chat_id: Optional chat ID to filter results
        api_base: Base URL for the API

    Returns:
        List of artifact information dictionaries
    """
    try:
        api_base = api_base.rstrip("/")

        # For now, we'll search all chats since we don't have a global search endpoint
        # In the future, this could be enhanced with a global search endpoint
        if chat_id:
            # Search within a specific chat
            response = requests.get(
                f"{api_base}/api/storage/chats/{chat_id}/artifacts"
            )
            if response.status_code == 200:
                artifacts = response.json()
                # Filter by query (basic string matching since no full-text search endpoint yet)
                filtered = [a for a in artifacts if query.lower() in (a.get('content', '') + a.get('filename', '')).lower()]
                return filtered
            else:
                print(f"Failed to search artifacts. Status code: {response.status_code}")
                return []
        else:
            # For global search, we'd need a new endpoint - for now return empty
            print("Global artifact search not yet implemented. Please specify chat_id.")
            return []

    except Exception as e:
        print(f"Error searching for artifacts: {str(e)}")
        return []

# Deprecated functions - filesystem operations no longer relevant with PostgreSQL
def write_to_storage_location(content: str, filename: str, subdir: Optional[str] = None) -> str:
    """
    DEPRECATED: Filesystem operations are no longer used.
    Use store_to_agent_storage() to store content as artifacts instead.
    """
    print("WARNING: write_to_storage_location() is deprecated. Use store_to_agent_storage() instead.")
    return ""

def get_storage_path() -> str:
    """
    DEPRECATED: Storage is now in PostgreSQL database.
    """
    print("WARNING: get_storage_path() is deprecated. Storage is now in PostgreSQL database.")
    return ""

def list_stored_files(subdir: Optional[str] = None) -> List[Dict[str, str]]:
    """
    DEPRECATED: Use search_artifacts() or load artifacts via API instead.
    """
    print("WARNING: list_stored_files() is deprecated. Use search_artifacts() instead.")
    return []
