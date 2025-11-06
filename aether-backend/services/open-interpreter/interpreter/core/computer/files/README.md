# 🚀 Lightning File System

A powerful, standalone file access and search system that provides **lightning-fast file discovery** across your entire device with semantic search capabilities.

## ⚡ Key Features

- **System-Wide Search**: Find files anywhere on your device with one API call
- **Semantic Discovery**: Agent automatically discovers file tools through natural language
- **Multi-Format Support**: PDFs, Word docs, Excel, code files, images, and more
- **Intelligent Caching**: Fast repeated searches with smart file indexing
- **Content Extraction**: Automatic text extraction from binary formats
- **Timeout Protection**: Never waits forever - searches complete quickly

## 🔍 Quick Start

### Find Files
```python
# Fast file search with type filter
computer.files.find_file("budget", file_type=".pdf")

# Search content within files
computer.files.search_content("keyword", file_types=[".docx"])
```

### Read Any File Type
```python
# Read with automatic text extraction
result = computer.files.read_file("/path/to/document.pdf", extract_text=True)

# Read code or text files directly
result = computer.files.read_file("/path/to/script.py")

# Access extracted content
content = result['content']
file_info = result['size_bytes'], result['type']
```

### Browse Directories
```python
# List directory contents with metadata
listing = computer.files.list_directory("/Documents")

# See all files and folders with details
for item in listing['contents']:
    print(f"{item['name']} - {item['type']} ({item['size_bytes']} bytes)")
```

## 🤖 Agent Integration

The FileSystem is fully integrated with the semantic tool discovery system:

### Semantic Discovery
```python
# Agent finds file tools automatically
computer.tools.search("find files")        # Discovers all file search tools
computer.tools.search("read documents")    # Shows file reading capabilities
computer.tools.search("locate files")      # System-wide search tools
```

### Tool Categories
File tools are organized under the **"Files & Documents"** category:
```python
computer.tools.list_tools(category="Files & Documents")
```

## 📋 API Reference

### Core Methods

| Method | Description | Example |
|--------|-------------|---------|
| `find_file(query, file_type)` | Fast file search with filters | `computer.files.find_file("test", file_type=".py")` |
| `search_content(text, file_types)` | Search inside files | `computer.files.search_content("import", file_types=[".py"])` |
| `read_file(path, extract_text)` | Read file with extraction | `computer.files.read_file("doc.pdf", extract_text=True)` |
| `list_directory(path)` | Browse directory contents | `computer.files.list_directory("/home")` |
| `refresh_cache()` | Update file index | `computer.files.refresh_cache()` |

### Response Format

All methods return structured data:

```python
# File search results
{
    "path": "/full/path/to/file.pdf",
    "name": "file.pdf",
    "size_bytes": 1024000,
    "type": "PDF Document",
    "modified": "2024-01-15T10:30:00",
    "readable": true
}

# Directory listings
{
    "path": "/Documents",
    "contents": [
        {"name": "report.pdf", "is_file": true, "size_bytes": 2048000, ...},
        {"name": "images", "is_file": false, "item_count": 15, ...}
    ],
    "total_items": 25,
    "directories": 3,
    "files": 22
}

# File reading results
{
    "path": "/path/to/file.pdf",
    "content": "Extracted text content...",
    "size_bytes": 1024000,
    "type": "PDF Document",
    "extracted": true
}
```

## 🔧 Configuration

The FileSystem uses smart defaults but can be customized:

```python
# Custom configuration
from interpreter.core.computer.files import create_file_system

fs = create_file_system({
    "max_results": 50,
    "index_hidden_files": True,
    "cache_expiry_minutes": 30
})
```

## 🚀 Performance Tips

- **Use specific file types**: `file_type=".pdf"` speeds up searches
- **Limit search scope**: Use specific paths when possible
- **Cache awareness**: File index updates automatically
- **Timeout protection**: Searches never hang indefinitely

## 🛠️ Supported File Types

- **Documents**: PDF, DOCX, DOC, RTF, ODT
- **Spreadsheets**: XLSX, XLS, CSV
- **Code Files**: PY, JS, HTML, CSS, JAVA, C++, GO, RUST, etc.
- **Text Files**: TXT, MD, JSON, XML, YAML
- **Images**: PNG, JPG, GIF (with OCR support)
- **Archives**: ZIP, TAR, GZ (metadata only)

## 🔐 Security & Permissions

- Respects file system permissions
- Never accesses restricted system directories without explicit permission
- Safe handling of binary files and large documents
- Timeout protection prevents resource exhaustion

## 📚 Integration Examples

### With AI Agents
```python
# Agent workflow example
files = computer.files.find_file("report", file_type=".pdf")
if files:
    content = computer.files.read_file(files[0]['path'], extract_text=True)
    # Process content with AI...
```

### Batch Operations
```python
# Find all PDFs in project
pdfs = computer.files.find_file("", file_type=".pdf")
for pdf in pdfs:
    content = computer.files.read_file(pdf['path'], extract_text=True)
    # Process each PDF...
```

### Directory Analysis
```python
# Analyze directory structure
listing = computer.files.list_directory("/project")
total_size = sum(item['size_bytes'] for item in listing['contents'] if item['is_file'])
print(f"Total files: {listing['files']}, Size: {total_size} bytes")
```

---

The Lightning File System provides everything you need for comprehensive file access and search across your entire system! ⚡
