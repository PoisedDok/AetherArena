"""
File content extraction module.

This module provides utilities for extracting text content from various file types,
including PDFs, Word documents, Excel files, and more.
"""

import os
import logging
import mimetypes
from typing import Optional, Dict, Any, List

logger = logging.getLogger("ContentExtractor")

class ContentExtractor:
    """
    Content extraction from various file types.
    
    This class handles extracting text content from different file types,
    including binary formats like PDFs and Word documents.
    """
    
    def __init__(self):
        """Initialize the content extractor."""
        # Initialize extraction components lazily
        self._pdf_extractor = None
        self._docx_extractor = None
        self._excel_extractor = None
        self._image_extractor = None
        
        # Register mime types
        self._init_mime_types()
    
    def extract(self, file_path: str, max_size: int = 10 * 1024 * 1024) -> str:
        """
        Extract text content from a file.
        
        Args:
            file_path: Path to the file
            max_size: Maximum file size to extract (in bytes)
            
        Returns:
            Extracted text content
        """
        if not os.path.exists(file_path):
            return ""
            
        try:
            # Check file size
            if os.path.getsize(file_path) > max_size:
                logger.warning(f"File too large to extract: {file_path}")
                return f"[File too large to extract: {os.path.basename(file_path)}]"
                
            # Get mime type
            mime_type, _ = mimetypes.guess_type(file_path)
            ext = os.path.splitext(file_path)[1].lower()
            
            # Extract based on file type
            if mime_type == 'application/pdf' or ext == '.pdf':
                return self._extract_pdf(file_path)
                
            elif mime_type in ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 
                            'application/msword'] or ext in ['.docx', '.doc']:
                return self._extract_docx(file_path)
                
            elif mime_type in ['application/vnd.ms-excel',
                             'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] or ext in ['.xlsx', '.xls']:
                return self._extract_excel(file_path)
                
            elif mime_type and mime_type.startswith('image/') or ext in ['.png', '.jpg', '.jpeg', '.gif', '.bmp']:
                return self._extract_image(file_path)
                
            elif self._is_text_file(file_path):
                return self._extract_text(file_path)
                
            else:
                logger.debug(f"Unsupported file type for extraction: {file_path}")
                return f"[Unsupported file type: {os.path.basename(file_path)}]"
                
        except Exception as e:
            logger.error(f"Error extracting content from {file_path}: {str(e)}")
            return f"[Error extracting content: {str(e)}]"
    
    def _extract_pdf(self, file_path: str) -> str:
        """
        Extract text from a PDF file.
        
        Args:
            file_path: Path to the PDF file
            
        Returns:
            Extracted text
        """
        try:
            # Lazy import PyPDF2
            import PyPDF2
            
            with open(file_path, 'rb') as file:
                pdf_reader = PyPDF2.PdfReader(file)
                text_content = []
                
                for page_num, page in enumerate(pdf_reader.pages):
                    page_text = page.extract_text()
                    if page_text:
                        text_content.append(f"--- Page {page_num + 1} ---")
                        text_content.append(page_text)
                
                return "\n".join(text_content)
                
        except ImportError:
            logger.warning("PyPDF2 not installed, cannot extract PDF content")
            return f"[PDF extraction not available: {os.path.basename(file_path)}]"
        except Exception as e:
            logger.error(f"Error extracting PDF: {str(e)}")
            return f"[Error extracting PDF: {str(e)}]"
    
    def _extract_docx(self, file_path: str) -> str:
        """
        Extract text from a Word document.
        
        Args:
            file_path: Path to the Word document
            
        Returns:
            Extracted text
        """
        try:
            # Lazy import docx
            import docx
            
            doc = docx.Document(file_path)
            text_content = []
            
            for para in doc.paragraphs:
                if para.text:
                    text_content.append(para.text)
                    
            return "\n".join(text_content)
            
        except ImportError:
            logger.warning("python-docx not installed, cannot extract DOCX content")
            return f"[DOCX extraction not available: {os.path.basename(file_path)}]"
        except Exception as e:
            logger.error(f"Error extracting DOCX: {str(e)}")
            return f"[Error extracting DOCX: {str(e)}]"
    
    def _extract_excel(self, file_path: str) -> str:
        """
        Extract text from an Excel file.
        
        Args:
            file_path: Path to the Excel file
            
        Returns:
            Extracted text
        """
        try:
            # Lazy import pandas
            import pandas as pd
            
            excel_data = pd.read_excel(file_path, sheet_name=None)
            text_content = []
            
            for sheet_name, df in excel_data.items():
                text_content.append(f"--- Sheet: {sheet_name} ---")
                text_content.append(df.to_string(index=True, max_rows=100, max_cols=20))
                text_content.append("")
                
            return "\n".join(text_content)
            
        except ImportError:
            logger.warning("pandas not installed, cannot extract Excel content")
            return f"[Excel extraction not available: {os.path.basename(file_path)}]"
        except Exception as e:
            logger.error(f"Error extracting Excel: {str(e)}")
            return f"[Error extracting Excel: {str(e)}]"
    
    def _extract_image(self, file_path: str) -> str:
        """
        Extract text from an image using OCR.
        
        Args:
            file_path: Path to the image file
            
        Returns:
            Extracted text
        """
        try:
            # Lazy import tesseract
            import pytesseract
            from PIL import Image
            
            img = Image.open(file_path)
            text = pytesseract.image_to_string(img)
            
            if text.strip():
                return text
            else:
                return f"[No text detected in image: {os.path.basename(file_path)}]"
                
        except ImportError:
            logger.warning("pytesseract not installed, cannot extract image content")
            return f"[Image OCR not available: {os.path.basename(file_path)}]"
        except Exception as e:
            logger.error(f"Error extracting image: {str(e)}")
            return f"[Error extracting image: {str(e)}]"
    
    def _extract_text(self, file_path: str) -> str:
        """
        Extract text from a text file.
        
        Args:
            file_path: Path to the text file
            
        Returns:
            File content
        """
        try:
            encodings = ['utf-8', 'latin-1', 'cp1252', 'ascii']
            
            for encoding in encodings:
                try:
                    with open(file_path, 'r', encoding=encoding) as file:
                        return file.read()
                except UnicodeDecodeError:
                    continue
                    
            # If all encodings fail, use binary mode with error replacement
            with open(file_path, 'r', encoding='utf-8', errors='replace') as file:
                return file.read()
                
        except Exception as e:
            logger.error(f"Error reading text file: {str(e)}")
            return f"[Error reading file: {str(e)}]"
    
    def _is_text_file(self, file_path: str) -> bool:
        """
        Check if a file is a text file.
        
        Args:
            file_path: Path to the file
            
        Returns:
            True if the file is a text file, False otherwise
        """
        # Get file extension
        ext = os.path.splitext(file_path)[1].lower()
        
        # Common text file extensions
        text_extensions = {
            '.txt', '.md', '.py', '.js', '.html', '.css', '.json', '.xml',
            '.csv', '.log', '.ini', '.cfg', '.conf', '.yml', '.yaml',
            '.sh', '.bat', '.c', '.cpp', '.h', '.java', '.rb', '.php'
        }
        
        if ext in text_extensions:
            return True
            
        # Try to guess MIME type
        mime_type, _ = mimetypes.guess_type(file_path)
        if mime_type and mime_type.startswith('text/'):
            return True
            
        # Try to check the content for binary data
        try:
            with open(file_path, 'rb') as file:
                chunk = file.read(1024)
                if b'\x00' in chunk:
                    return False
                    
                # Check if mostly ASCII
                text_chars = bytes(range(32, 127)) + b'\r\n\t\b'
                return all(c in text_chars for c in chunk)
                
        except Exception:
            return False
    
    def _init_mime_types(self):
        """Initialize additional MIME types that might be missing."""
        mimetypes.add_type('application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx')
        mimetypes.add_type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx')
        mimetypes.add_type('text/markdown', '.md')
        mimetypes.add_type('text/x-python', '.py')
        mimetypes.add_type('application/javascript', '.js')
        mimetypes.add_type('application/json', '.json')
        mimetypes.add_type('text/yaml', '.yml')
        mimetypes.add_type('text/yaml', '.yaml')
