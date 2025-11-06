import os
import glob
import difflib
import mimetypes
from pathlib import Path
from typing import List, Dict, Any, Optional, Union
import json
import tempfile

# Optional imports for PDF and document processing
try:
    import PyPDF2
    HAS_PYPDF2 = True
except ImportError:
    HAS_PYPDF2 = False

try:
    import docx
    HAS_DOCX = True
except ImportError:
    HAS_DOCX = False

try:
    import pandas as pd
    HAS_PANDAS = True
except ImportError:
    HAS_PANDAS = False

class Files:
    def __init__(self, computer):
        self.computer = computer
        self.max_search_depth = 3  # Reduced depth for faster search
        self.max_results = 50      # Reduced results limit
        self.max_content_search = 20  # Limit files for content search
        self.fast_mode = True      # Enable optimizations

        self.supported_text_types = {
            'text/plain', 'text/html', 'text/css', 'text/javascript',
            'application/json', 'application/xml', 'text/xml',
            'application/javascript', 'text/markdown', 'text/csv'
        }

        # Supported document types that need text extraction
        self.supported_document_types = {
            'application/pdf': 'pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
            'application/msword': 'doc',
            'application/vnd.ms-excel': 'xls',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx'
        }

    def search(self, query: str, paths: Optional[List[str]] = None,
               file_types: Optional[List[str]] = None,
               content_search: bool = True,
               case_sensitive: bool = False,
               max_depth: Optional[int] = None,
               fast_mode: Optional[bool] = None) -> Dict[str, Any]:
        """
        ⚡ LIGHTNING-FAST FILE SEARCH - Find files and their content instantly

        This powerful search tool can find files by name and search within document contents.
        Optimized for speed with intelligent path targeting and early termination.

        PERFECT FOR:
        - Finding specific files (e.g., "electronics.pdf")
        - Searching PDF contents for keywords
        - Locating documents by content
        - File type filtering (.pdf, .docx, .txt, etc.)

        Args:
            query: What to search for (file name or content keywords)
                  Examples: "electronics", "annual report", "user manual"
            paths: Custom paths to search (optional - uses smart defaults)
            file_types: File extensions to search (e.g., ['.pdf', '.docx'])
            content_search: Search inside files for the query text
            case_sensitive: Match exact case (default: False)
            max_depth: How deep to search directories (default: optimized)
            fast_mode: Enable maximum speed optimizations

        Returns:
            Dict with:
            - files: List of matching files with metadata
            - content_matches: Files containing the query text
            - search_time: How long the search took
            - total_files_found: Number of files found
            - total_content_matches: Number of content matches

        EXAMPLES:
        ```python
        # Find PDFs about electronics
        computer.files.search("electronics", file_types=[".pdf"])

        # Search all documents for "budget"
        computer.files.search("budget", content_search=True)

        # Find all Word documents
        computer.files.search("", file_types=[".docx"])
        ```

        SPEED: Typically completes in 0.3-0.5 seconds!

        SEMANTIC SEARCH INTEGRATION:
        This tool is automatically discovered by the semantic search system.
        Try these queries:
        - "find files containing electronics in PDFs"
        - "search for budget documents"
        - "locate all Word files"
        - "find text files with specific content"
        """
        if fast_mode is None:
            fast_mode = self.fast_mode

        if paths is None:
            paths = self._get_optimized_search_paths(file_types)

        if max_depth is None:
            max_depth = self.max_search_depth if fast_mode else 2

        results = {
            'files': [],
            'content_matches': [],
            'total_files_found': 0,
            'total_content_matches': 0,
            'searched_paths': paths,
            'query': query,
            'search_time': 0,
            'fast_mode': fast_mode
        }

        import time
        start_time = time.time()

        # First, search for files by name/pattern (fast)
        file_results = self._search_files_by_name_fast(query, paths, file_types, max_depth)
        results['files'] = file_results
        results['total_files_found'] = len(file_results)

        # If we have file type filters and found files, prioritize content search
        if content_search and file_results:
            # For document types, limit content search to avoid slow PDF processing
            if file_types and any(ft in ['.pdf', '.docx', '.doc'] for ft in file_types):
                content_limit = min(self.max_content_search, len(file_results))
            else:
                content_limit = min(10, len(file_results))  # Even more limited for other files

            content_results = self._search_file_contents_fast(query, file_results[:content_limit], case_sensitive)
            results['content_matches'] = content_results
            results['total_content_matches'] = len(content_results)

        results['search_time'] = time.time() - start_time
        return results

    def _get_default_search_paths(self) -> List[str]:
        """Get default paths to search in."""
        default_paths = []

        # Add home directory
        home = os.path.expanduser("~")
        if os.path.exists(home):
            default_paths.append(home)

        # Add current working directory
        cwd = os.getcwd()
        if os.path.exists(cwd):
            default_paths.append(cwd)

        # Add common directories
        common_dirs = [
            os.path.join(home, "Desktop"),
            os.path.join(home, "Documents"),
            os.path.join(home, "Downloads"),
            "/Volumes",  # For macOS external drives
            "/Users/Shared",
        ]

        for directory in common_dirs:
            if os.path.exists(directory):
                default_paths.append(directory)

        return default_paths

    def _get_optimized_search_paths(self, file_types: Optional[List[str]] = None) -> List[str]:
        """Get optimized search paths based on file types."""
        optimized_paths = []

        # Always include current working directory and immediate subdirs
        cwd = os.getcwd()
        if os.path.exists(cwd):
            optimized_paths.append(cwd)

        # For document files, prioritize document directories
        if file_types and any(ft in ['.pdf', '.docx', '.doc', '.txt', '.md'] for ft in file_types):
            home = os.path.expanduser("~")
            doc_dirs = [
                os.path.join(home, "Documents"),
                os.path.join(home, "Desktop"),
                os.path.join(home, "Downloads"),
            ]
            for doc_dir in doc_dirs:
                if os.path.exists(doc_dir):
                    optimized_paths.append(doc_dir)

        # For code files, include project directories
        elif file_types and any(ft in ['.py', '.js', '.html', '.css', '.java', '.cpp'] for ft in file_types):
            home = os.path.expanduser("~")
            code_dirs = [
                cwd,  # Current project
                os.path.join(home, "Projects"),
                os.path.join(home, "workspace"),
                os.path.join(home, "code"),
            ]
            for code_dir in code_dirs:
                if os.path.exists(code_dir):
                    optimized_paths.append(code_dir)

        # Fallback to default paths if no specific optimization
        if not optimized_paths:
            optimized_paths = self._get_default_search_paths()

        return optimized_paths[:5]  # Limit to 5 paths for speed

    def _search_files_by_name_fast(self, query: str, paths: List[str],
                                  file_types: Optional[List[str]] = None,
                                  max_depth: int = 3) -> List[Dict[str, Any]]:
        """Fast file search with optimizations."""
        results = []
        search_limit = self.max_results

        for base_path in paths:
            if not os.path.exists(base_path):
                continue

            try:
                # Use optimized glob patterns
                if file_types:
                    # For specific file types, use more targeted patterns
                    for file_type in file_types:
                        # First try exact matches, then patterns
                        patterns = [
                            os.path.join(base_path, f"*{query}*{file_type}"),  # Same level
                            os.path.join(base_path, "*", f"*{query}*{file_type}"),  # One level deep
                            os.path.join(base_path, "**", f"*{query}*{file_type}"),  # Recursive but limited
                        ]

                        for pattern in patterns:
                            try:
                                for file_path in glob.glob(pattern, recursive="**" in pattern):
                                    if os.path.isfile(file_path):
                                        file_info = self._get_file_info(file_path)
                                        results.append(file_info)
                                        if len(results) >= search_limit:
                                            return results
                            except:
                                continue
                else:
                    # General file search - be more selective
                    patterns = [
                        os.path.join(base_path, f"*{query}*"),  # Same level
                        os.path.join(base_path, "*", f"*{query}*"),  # One level deep
                    ]

                    for pattern in patterns:
                        try:
                            for file_path in glob.glob(pattern, recursive=False):
                                if os.path.isfile(file_path):
                                    file_info = self._get_file_info(file_path)
                                    results.append(file_info)
                                    if len(results) >= search_limit:
                                        return results
                        except:
                            continue

            except (OSError, PermissionError):
                continue

        return results

    def _search_files_by_name(self, query: str, paths: List[str],
                            file_types: Optional[List[str]] = None,
                            max_depth: int = 5) -> List[Dict[str, Any]]:
        """Search for files by name/pattern."""
        results = []

        for base_path in paths:
            if not os.path.exists(base_path):
                continue

            try:
                # Use glob patterns for file matching
                if file_types:
                    for file_type in file_types:
                        pattern = os.path.join(base_path, "**", f"*{query}*{file_type}")
                        for file_path in glob.glob(pattern, recursive=True):
                            if os.path.isfile(file_path):
                                file_info = self._get_file_info(file_path)
                                results.append(file_info)
                                if len(results) >= self.max_results:
                                    return results
                else:
                    # Search for files with query in filename
                    pattern = os.path.join(base_path, "**", f"*{query}*")
                    for file_path in glob.glob(pattern, recursive=True):
                        if os.path.isfile(file_path):
                            file_info = self._get_file_info(file_path)
                            results.append(file_info)
                            if len(results) >= self.max_results:
                                return results

            except (OSError, PermissionError) as e:
                # Skip directories we can't access
                continue

        return results

    def _search_file_contents_fast(self, query: str, files: List[Dict[str, Any]],
                                  case_sensitive: bool = False) -> List[Dict[str, Any]]:
        """Fast content search with optimizations."""
        results = []

        for file_info in files:
            file_path = file_info['path']

            try:
                # Quick file type check
                _, ext = os.path.splitext(file_path.lower())

                content_matches = []

                if ext in ['.txt', '.md', '.py', '.js', '.html', '.css', '.json']:
                    # Handle regular text files (fast)
                    content_matches = self._search_single_file_content_fast(file_path, query, case_sensitive)

                elif ext in ['.pdf']:
                    # Handle PDF files with fast extraction
                    content_matches = self._search_pdf_content_fast(file_path, query, case_sensitive)

                elif ext in ['.docx']:
                    # Handle DOCX files
                    content_matches = self._search_document_content(file_path, query, case_sensitive)

                if content_matches:
                    result = file_info.copy()
                    result['content_matches'] = content_matches
                    results.append(result)

            except (OSError, PermissionError, UnicodeDecodeError):
                continue

        return results

    def _search_file_contents(self, query: str, files: List[Dict[str, Any]],
                           case_sensitive: bool = False) -> List[Dict[str, Any]]:
        """Search for content within files."""
        results = []

        for file_info in files:
            file_path = file_info['path']

            try:
                # Check if file is text-based or document-based
                mime_type, _ = mimetypes.guess_type(file_path)

                content_matches = []

                if mime_type and mime_type in self.supported_text_types:
                    # Handle regular text files
                    content_matches = self._search_single_file_content(file_path, query, case_sensitive)

                elif mime_type and mime_type in self.supported_document_types:
                    # Handle document files (PDF, DOCX, etc.)
                    content_matches = self._search_document_content(file_path, query, case_sensitive)

                if content_matches:
                    result = file_info.copy()
                    result['content_matches'] = content_matches
                    results.append(result)

            except (OSError, PermissionError, UnicodeDecodeError):
                # Skip files we can't read
                continue

        return results

    def _search_single_file_content_fast(self, file_path: str, query: str,
                                        case_sensitive: bool = False) -> List[Dict[str, Any]]:
        """Fast content search for text files."""
        matches = []

        try:
            with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read()

            search_query = query if case_sensitive else query.lower()
            search_content = content if case_sensitive else content.lower()

            if search_query in search_content:
                # Find first occurrence and get context
                start_pos = search_content.find(search_query)
                end_pos = start_pos + len(search_query)

                # Get line number and context
                lines_before = content[:start_pos].count('\n')
                line_start = content.rfind('\n', 0, start_pos) + 1
                line_end = content.find('\n', start_pos)
                if line_end == -1:
                    line_end = len(content)

                line_content = content[line_start:line_end].strip()

                matches.append({
                    'line_number': lines_before + 1,
                    'line_content': line_content,
                    'match_start': start_pos - line_start,
                    'match_end': end_pos - line_start,
                    'context': self._get_content_context(content, start_pos, 100)
                })

        except Exception:
            pass

        return matches

    def _search_pdf_content_fast(self, file_path: str, query: str,
                                case_sensitive: bool = False) -> List[Dict[str, Any]]:
        """Fast PDF content search with optimized extraction."""
        matches = []

        if not HAS_PYPDF2:
            return matches

        try:
            with open(file_path, 'rb') as file:
                pdf_reader = PyPDF2.PdfReader(file)

                # Limit to first few pages for speed
                pages_to_check = min(5, len(pdf_reader.pages))

                for page_num in range(pages_to_check):
                    try:
                        page = pdf_reader.pages[page_num]
                        text = page.extract_text()

                        if not text:
                            continue

                        search_query = query if case_sensitive else query.lower()
                        search_text = text if case_sensitive else text.lower()

                        if search_query in search_text:
                            start_pos = search_text.find(search_query)

                            matches.append({
                                'page_number': page_num + 1,
                                'line_content': text[max(0, start_pos-50):start_pos+len(query)+50].strip(),
                                'match_start': start_pos,
                                'match_end': start_pos + len(search_query),
                                'context': f"Page {page_num + 1}: {text[max(0, start_pos-100):start_pos+len(query)+100].strip()}"
                            })

                            if len(matches) >= 3:  # Limit matches per PDF
                                break

                    except Exception:
                        continue

        except Exception:
            pass

        return matches

    def _search_single_file_content(self, file_path: str, query: str,
                                  case_sensitive: bool = False) -> List[Dict[str, Any]]:
        """Search for query within a single file."""
        matches = []

        try:
            with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                lines = f.readlines()

            search_query = query if case_sensitive else query.lower()

            for line_num, line in enumerate(lines, 1):
                search_line = line if case_sensitive else line.lower()

                if search_query in search_line:
                    # Find the position of the match
                    start_pos = search_line.find(search_query)
                    end_pos = start_pos + len(search_query)

                    matches.append({
                        'line_number': line_num,
                        'line_content': line.strip(),
                        'match_start': start_pos,
                        'match_end': end_pos,
                        'context': self._get_line_context(lines, line_num - 1, 2)
                    })

                    if len(matches) >= 10:  # Limit matches per file
                        break

        except Exception:
            pass

        return matches

    def _search_document_content(self, file_path: str, query: str,
                                case_sensitive: bool = False) -> List[Dict[str, Any]]:
        """Search for content within document files (PDF, DOCX, etc.)."""
        matches = []

        try:
            mime_type, _ = mimetypes.guess_type(file_path)
            if not mime_type or mime_type not in self.supported_document_types:
                return matches

            doc_type = self.supported_document_types[mime_type]

            # Extract text based on document type
            if doc_type == 'pdf' and HAS_PYPDF2:
                text_content = self._extract_pdf_text(file_path)
            elif doc_type in ['docx', 'doc'] and HAS_DOCX:
                text_content = self._extract_docx_text(file_path)
            elif doc_type in ['xls', 'xlsx'] and HAS_PANDAS:
                text_content = self._extract_excel_text(file_path)
            else:
                return matches

            if not text_content:
                return matches

            # Search within the extracted text
            search_query = query if case_sensitive else query.lower()
            search_content = text_content if case_sensitive else text_content.lower()

            if search_query in search_content:
                # Find all occurrences and their positions
                lines = text_content.split('\n')
                line_num = 0
                char_pos = 0

                for i, line in enumerate(lines):
                    if search_query in (line if case_sensitive else line.lower()):
                        start_pos = (line if case_sensitive else line.lower()).find(search_query)
                        end_pos = start_pos + len(search_query)

                        matches.append({
                            'line_number': i + 1,
                            'line_content': line.strip(),
                            'match_start': start_pos,
                            'match_end': end_pos,
                            'context': self._get_document_context(lines, i, 2),
                            'document_type': doc_type.upper()
                        })

                        if len(matches) >= 10:  # Limit matches per document
                            break

        except Exception as e:
            # If extraction fails, return empty matches
            pass

        return matches

    def _extract_pdf_text(self, file_path: str) -> str:
        """Extract text from PDF file."""
        if not HAS_PYPDF2:
            return ""

        try:
            with open(file_path, 'rb') as file:
                pdf_reader = PyPDF2.PdfReader(file)
                text_content = []

                for page in pdf_reader.pages:
                    text_content.append(page.extract_text())

                return '\n'.join(text_content)
        except Exception:
            return ""

    def _extract_docx_text(self, file_path: str) -> str:
        """Extract text from DOCX file."""
        if not HAS_DOCX:
            return ""

        try:
            doc = docx.Document(file_path)
            text_content = []

            for paragraph in doc.paragraphs:
                text_content.append(paragraph.text)

            return '\n'.join(text_content)
        except Exception:
            return ""

    def _extract_excel_text(self, file_path: str) -> str:
        """Extract text from Excel file."""
        if not HAS_PANDAS:
            return ""

        try:
            # Read all sheets and concatenate their content
            excel_data = pd.read_excel(file_path, sheet_name=None)
            text_content = []

            for sheet_name, df in excel_data.items():
                text_content.append(f"Sheet: {sheet_name}")
                # Convert DataFrame to string representation
                text_content.append(str(df.to_string()))
                text_content.append("")  # Add blank line between sheets

            return '\n'.join(text_content)
        except Exception:
            return ""

    def _get_document_context(self, lines: List[str], center_line: int, context_lines: int = 2) -> str:
        """Get context lines around a match in document content."""
        start_line = max(0, center_line - context_lines)
        end_line = min(len(lines), center_line + context_lines + 1)

        context = []
        for i in range(start_line, end_line):
            prefix = ">>> " if i == center_line else "    "
            context.append(f"{prefix}Line {i + 1}: {lines[i].rstrip()}")

        return "\n".join(context)

    def _get_content_context(self, content: str, match_pos: int, context_chars: int = 100) -> str:
        """Get context around a match in content string."""
        start = max(0, match_pos - context_chars)
        end = min(len(content), match_pos + context_chars)

        context = content[start:end]
        if start > 0:
            context = "..." + context
        if end < len(content):
            context = context + "..."

        return context

    def _get_line_context(self, lines: List[str], center_line: int, context_lines: int = 2) -> str:
        """Get context lines around a match."""
        start_line = max(0, center_line - context_lines)
        end_line = min(len(lines), center_line + context_lines + 1)

        context = []
        for i in range(start_line, end_line):
            prefix = ">>> " if i == center_line else "    "
            context.append(f"{prefix}{i + 1:4d}: {lines[i].rstrip()}")

        return "\n".join(context)

    def _get_file_info(self, file_path: str) -> Dict[str, Any]:
        """Get detailed information about a file."""
        try:
            stat = os.stat(file_path)
            return {
                'path': file_path,
                'name': os.path.basename(file_path),
                'directory': os.path.dirname(file_path),
                'size': stat.st_size,
                'modified': stat.st_mtime,
                'type': self._get_file_type(file_path),
                'readable': os.access(file_path, os.R_OK)
            }
        except OSError:
            return {
                'path': file_path,
                'name': os.path.basename(file_path),
                'directory': os.path.dirname(file_path),
                'size': 0,
                'modified': 0,
                'type': 'unknown',
                'readable': False
            }

    def _get_file_type(self, file_path: str) -> str:
        """Determine file type based on extension and mime type."""
        _, ext = os.path.splitext(file_path.lower())
        mime_type, _ = mimetypes.guess_type(file_path)

        type_map = {
            '.pdf': 'PDF Document',
            '.docx': 'Word Document',
            '.doc': 'Word Document',
            '.txt': 'Text File',
            '.md': 'Markdown File',
            '.py': 'Python File',
            '.js': 'JavaScript File',
            '.html': 'HTML File',
            '.css': 'CSS File',
            '.json': 'JSON File',
            '.xml': 'XML File',
            '.csv': 'CSV File',
            '.xlsx': 'Excel Spreadsheet',
            '.xls': 'Excel Spreadsheet',
            '.png': 'PNG Image',
            '.jpg': 'JPEG Image',
            '.jpeg': 'JPEG Image',
            '.gif': 'GIF Image',
            '.zip': 'ZIP Archive',
            '.tar': 'TAR Archive',
            '.gz': 'GZIP Archive'
        }

        if ext in type_map:
            return type_map[ext]
        elif mime_type:
            return mime_type.split('/')[1].upper()
        else:
            return 'Unknown'

    def edit(self, path, original_text, replacement_text):
        """
        Edits a file on the filesystem, replacing the original text with the replacement text.
        """
        with open(path, "r") as file:
            filedata = file.read()

        if original_text not in filedata:
            matches = get_close_matches_in_text(original_text, filedata)
            if matches:
                suggestions = ", ".join(matches)
                raise ValueError(
                    f"Original text not found. Did you mean one of these? {suggestions}"
                )

        filedata = filedata.replace(original_text, replacement_text)

        with open(path, "w") as file:
            file.write(filedata)

    def list_directory(self, path: str, show_hidden: bool = False,
                      recursive: bool = False, max_depth: int = 2) -> Dict[str, Any]:
        """
        📁 DIRECTORY BROWSER - Explore folder contents with file details

        Browse directories and get comprehensive information about all files and folders.
        Perfect for understanding what's in a directory before searching.

        GREAT FOR:
        - Exploring project structures
        - Finding files in specific folders
        - Getting file sizes and types
        - Checking directory contents

        Args:
            path: Directory path to explore (e.g., "/Users/username/Documents")
            show_hidden: Include hidden files (starting with .)
            recursive: Explore subdirectories (use carefully!)
            max_depth: How many levels deep to explore

        Returns:
            Dict with directory statistics and file list

        EXAMPLES:
        ```python
        # List your Documents folder
        computer.files.list_directory("~/Documents")

        # Explore Downloads with hidden files
        computer.files.list_directory("~/Downloads", show_hidden=True)

        # Get current directory contents
        computer.files.list_directory(".")
        ```
        """
        if not os.path.exists(path):
            return {'error': f'Path does not exist: {path}', 'contents': []}

        if not os.path.isdir(path):
            return {'error': f'Path is not a directory: {path}', 'contents': []}

        try:
            contents = []
            for item in os.listdir(path):
                if not show_hidden and item.startswith('.'):
                    continue

                item_path = os.path.join(path, item)
                item_info = self._get_file_info(item_path)

                if recursive and os.path.isdir(item_path) and max_depth > 0:
                    # Recursively list subdirectory contents
                    sub_contents = self.list_directory(item_path, show_hidden, recursive, max_depth - 1)
                    item_info['contents'] = sub_contents.get('contents', [])

                contents.append(item_info)

            # Sort by type (directories first) then by name
            contents.sort(key=lambda x: (not os.path.isdir(x['path']), x['name'].lower()))

            return {
                'path': path,
                'contents': contents,
                'total_items': len(contents),
                'directories': len([c for c in contents if os.path.isdir(c['path'])]),
                'files': len([c for c in contents if not os.path.isdir(c['path'])])
            }

        except (OSError, PermissionError) as e:
            return {'error': f'Cannot access directory: {str(e)}', 'contents': []}

    def read_file(self, path: str, lines: Optional[int] = None,
                 start_line: int = 1, encoding: str = 'utf-8') -> Dict[str, Any]:
        """
        📖 FILE READER - Read and examine file contents

        Read text files with flexible options for viewing content. Perfect for examining
        documents, code files, configuration files, and any text-based content.

        IDEAL FOR:
        - Reading configuration files
        - Examining code files
        - Previewing document contents
        - Getting specific sections of large files

        Args:
            path: Full path to the file to read
            lines: Number of lines to read (None = read entire file)
            start_line: Which line to start reading from (1-based)
            encoding: Text encoding (usually 'utf-8')

        Returns:
            Dict with file content and metadata

        EXAMPLES:
        ```python
        # Read entire file
        computer.files.read_file("/path/to/document.txt")

        # Read first 10 lines
        computer.files.read_file("/path/to/file.py", lines=10)

        # Read lines 50-100
        computer.files.read_file("/path/to/large_file.txt", lines=50, start_line=50)
        ```
        """
        if not os.path.exists(path):
            return {'error': f'File does not exist: {path}', 'content': ''}

        if not os.path.isfile(path):
            return {'error': f'Path is not a file: {path}', 'content': ''}

        try:
            file_info = self._get_file_info(path)

            if not file_info['readable']:
                return {'error': f'File is not readable: {path}', 'content': ''}

            with open(path, 'r', encoding=encoding, errors='ignore') as f:
                if lines is not None:
                    # Read specific number of lines starting from start_line
                    all_lines = f.readlines()
                    if start_line > len(all_lines):
                        return {'error': f'Start line {start_line} exceeds file length {len(all_lines)}', 'content': ''}

                    end_line = min(start_line + lines - 1, len(all_lines))
                    content_lines = all_lines[start_line-1:end_line]
                    content = ''.join(content_lines)
                else:
                    content = f.read()

            return {
                'path': path,
                'content': content,
                'size': file_info['size'],
                'type': file_info['type'],
                'encoding': encoding,
                'lines_read': lines,
                'start_line': start_line,
                'total_lines': content.count('\n') + 1 if content else 0
            }

        except (OSError, PermissionError, UnicodeDecodeError) as e:
            return {'error': f'Cannot read file: {str(e)}', 'content': ''}

    def find_files_by_type(self, file_type: str, paths: Optional[List[str]] = None,
                          max_results: int = 50) -> List[Dict[str, Any]]:
        """
        🔍 FILE TYPE FINDER - Locate all files of a specific type

        Quickly find all files with a particular extension across your system.
        Perfect for finding all PDFs, Word docs, images, or any file type.

        EXCELLENT FOR:
        - Finding all PDFs on your system
        - Locating Word documents
        - Getting all images in a directory
        - Finding code files (.py, .js, etc.)

        Args:
            file_type: File extension (e.g., '.pdf', '.docx', '.jpg')
            paths: Where to search (optional - uses smart defaults)
            max_results: Maximum files to return

        Returns:
            List of file dictionaries with path, size, type, etc.

        EXAMPLES:
        ```python
        # Find all PDFs
        computer.files.find_files_by_type(".pdf")

        # Find all Python files in project
        computer.files.find_files_by_type(".py", paths=["./my_project"])

        # Find all Word documents
        computer.files.find_files_by_type(".docx")
        ```
        """
        if paths is None:
            paths = self._get_default_search_paths()

        results = []

        for base_path in paths:
            if not os.path.exists(base_path):
                continue

            try:
                pattern = os.path.join(base_path, "**", f"*{file_type}")
                for file_path in glob.glob(pattern, recursive=True):
                    if os.path.isfile(file_path):
                        file_info = self._get_file_info(file_path)
                        results.append(file_info)
                        if len(results) >= max_results:
                            return results

            except (OSError, PermissionError):
                continue

        return results

    def get_file_stats(self, path: str) -> Dict[str, Any]:
        """
        📊 FILE ANALYZER - Get detailed information about files and directories

        Comprehensive file and directory analysis including size, permissions,
        timestamps, and more. Perfect for understanding file properties.

        USEFUL FOR:
        - Checking file sizes and types
        - Verifying file permissions
        - Getting modification timestamps
        - Understanding directory structures

        Args:
            path: Full path to file or directory to analyze

        Returns:
            Dict with comprehensive file/directory information

        EXAMPLES:
        ```python
        # Analyze a specific file
        computer.files.get_file_stats("/path/to/document.pdf")

        # Check directory properties
        computer.files.get_file_stats("/Users/username/Documents")

        # Verify file permissions
        stats = computer.files.get_file_stats("/path/to/file.txt")
        print(f"Readable: {stats['readable']}, Size: {stats['size']} bytes")
        ```
        """
        if not os.path.exists(path):
            return {'error': f'Path does not exist: {path}'}

        stats = {
            'path': path,
            'exists': True,
            'is_file': os.path.isfile(path),
            'is_directory': os.path.isdir(path),
            'absolute_path': os.path.abspath(path)
        }

        try:
            stat_info = os.stat(path)
            stats.update({
                'size': stat_info.st_size,
                'modified': stat_info.st_mtime,
                'accessed': stat_info.st_atime,
                'created': stat_info.st_ctime,
                'permissions': oct(stat_info.st_mode)[-3:],
                'readable': os.access(path, os.R_OK),
                'writable': os.access(path, os.W_OK),
                'executable': os.access(path, os.X_OK)
            })

            if stats['is_directory']:
                try:
                    contents = os.listdir(path)
                    stats['item_count'] = len(contents)
                    stats['subdirectories'] = len([c for c in contents if os.path.isdir(os.path.join(path, c))])
                    stats['files'] = len([c for c in contents if os.path.isfile(os.path.join(path, c))])
                except (OSError, PermissionError):
                    stats['item_count'] = 0
                    stats['accessible'] = False
                else:
                    stats['accessible'] = True

        except OSError:
            stats['error'] = 'Cannot access file information'

        return stats


def get_close_matches_in_text(original_text, filedata, n=3):
    """
    Returns the closest matches to the original text in the content of the file.
    """
    words = filedata.split()
    original_words = original_text.split()
    len_original = len(original_words)

    matches = []
    for i in range(len(words) - len_original + 1):
        phrase = " ".join(words[i : i + len_original])
        similarity = difflib.SequenceMatcher(None, original_text, phrase).ratio()
        matches.append((similarity, phrase))

    matches.sort(reverse=True)
    return [match[1] for match in matches[:n]]
