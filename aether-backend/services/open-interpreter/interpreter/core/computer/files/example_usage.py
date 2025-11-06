"""
Example usage of the FileSystem module.

This script demonstrates how to use the FileSystem module and its APIs.
"""

import os
import json
from pathlib import Path
import sys
import time

# Add parent directory to path to allow importing
current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
if parent_dir not in sys.path:
    sys.path.append(parent_dir)

# Import the file system module
from files import (
    find_file,
    search_content,
    read_file,
    list_directory,
    create_file_system
)

def pretty_print(obj):
    """Pretty print an object."""
    print(json.dumps(obj, indent=2, default=str))

def demo_basic_search():
    """Demonstrate basic file searching."""
    print("\n=== Basic File Search ===")
    
    # Search for Python files with 'search' in the name
    print("\nSearching for Python files with 'search' in the name...")
    results = find_file("search", file_type="py")
    print(f"Found {len(results)} files:")
    for i, result in enumerate(results[:5]):  # Show first 5 results
        print(f"{i+1}. {result['name']} - {result['path']}")
    
    # Search for PDF files
    print("\nSearching for PDF files...")
    results = find_file("", file_type="pdf")
    print(f"Found {len(results)} PDF files")
    for i, result in enumerate(results[:5]):  # Show first 5 results
        print(f"{i+1}. {result['name']} - {result['path']}")

def demo_content_search():
    """Demonstrate content searching."""
    print("\n=== Content Search ===")
    
    # Search for 'import' in Python files
    print("\nSearching for 'import' in Python files...")
    results = search_content("import", file_types=["py"])
    print(f"Found {len(results)} files with matches")
    
    if results:
        print("\nFirst result:")
        result = results[0]
        print(f"File: {result['name']} - {result['path']}")
        print("Matches:")
        for match in result.get('content_matches', [])[:3]:  # Show first 3 matches
            print(f"  Line {match.get('line_number')}: {match.get('line_content')}")

def demo_file_reading():
    """Demonstrate file reading."""
    print("\n=== File Reading ===")
    
    # First find a Python file
    py_files = find_file("", file_type="py")
    if py_files:
        file_path = py_files[0]['path']
        print(f"\nReading file: {file_path}")
        
        # Read the file
        file_content = read_file(file_path)
        content = file_content.get('content', '')
        print(f"File size: {file_content.get('size_bytes', 0)} bytes")
        print(f"Preview (first 200 chars):\n{content[:200]}...")
    else:
        print("No Python files found to read.")
        
    # Try to read a PDF file if available
    pdf_files = find_file("", file_type="pdf")
    if pdf_files:
        file_path = pdf_files[0]['path']
        print(f"\nExtracting text from PDF: {file_path}")
        
        # Read the PDF
        file_content = read_file(file_path)
        content = file_content.get('content', '')
        print(f"Extracted text size: {len(content)} chars")
        print(f"Preview (first 200 chars):\n{content[:200]}...")

def demo_directory_listing():
    """Demonstrate directory listing."""
    print("\n=== Directory Listing ===")
    
    # List current directory
    dir_path = os.path.dirname(os.path.abspath(__file__))
    print(f"\nListing directory: {dir_path}")
    
    dir_contents = list_directory(dir_path)
    files = [item for item in dir_contents.get('contents', []) if item.get('is_file')]
    dirs = [item for item in dir_contents.get('contents', []) if item.get('is_directory')]
    
    print(f"Found {len(files)} files and {len(dirs)} directories")
    
    print("\nDirectories:")
    for i, dir_item in enumerate(dirs[:5]):  # Show first 5 directories
        print(f"{i+1}. {dir_item['name']}")
        
    print("\nFiles:")
    for i, file_item in enumerate(files[:5]):  # Show first 5 files
        print(f"{i+1}. {file_item['name']} ({file_item['type']})")

def demo_advanced_features():
    """Demonstrate advanced features."""
    print("\n=== Advanced Features ===")
    
    # Create a custom file system instance
    fs = create_file_system({
        "max_results": 50,
        "index_hidden_files": True
    })
    
    print("\nUsing custom file system to search for hidden files...")
    results = fs.find_file(".", max_results=10, include_hidden=True)
    print(f"Found {len(results)} hidden files")

if __name__ == "__main__":
    print("=== FileSystem Module Demo ===")
    print("This script demonstrates the capabilities of the FileSystem module.")
    
    try:
        demo_basic_search()
        demo_content_search()
        demo_file_reading()
        demo_directory_listing()
        demo_advanced_features()
        
        print("\n=== Demo Complete ===")
        print("The FileSystem module provides powerful file access and search capabilities.")
        print("See the documentation for more details on how to use it in your applications.")
        
    except Exception as e:
        print(f"Error during demo: {str(e)}")
        import traceback
        traceback.print_exc()
