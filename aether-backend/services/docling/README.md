# Docling API Server

A comprehensive document processing service that provides OCR, VLM integration with SmolDocling, and ASR capabilities through a FastAPI server.

## Overview

Docling API Server acts as the centralized document processing service for the Aether platform. It handles:

- Document conversion with multiple OCR engines
- Vision-language model processing via SmolDocling
- Audio transcription via ASR
- Structured JSON output for LLM processing

## Quick Start

1. **Start the API server:**

```bash
cd docling
python docling_api_server.py
```

2. **Configure LM Studio:**
   - Download the SmolDocling model: `ds4sd/SmolDocling-256M-preview-mlx-bf16`
   - Load in LM Studio with name: `smoldocling-256m-preview-mlx-docling-snap`
   - Start server on `http://localhost:1234`

3. **Test with the Gradio UI:**

```bash
cd docling
python docling_gradio_app.py
```

Then navigate to http://localhost:7860 in your browser.

## API Endpoints

- `GET /`: API information
- `GET /health`: Server health check
- `GET /engines`: Available OCR engines
- `GET /vlm-models`: Available VLM models
- `GET /options`: Available pipelines, formats, and defaults
- `POST /convert`: Convert file with multipart form
- `POST /convert-json`: Convert file with JSON options

## Processing Pipelines

Docling supports three main pipelines:

1. **Standard Pipeline**: General-purpose document processing with OCR
   - Recommended for most documents
   - Multiple OCR engines available (EasyOCR, OcrMac, Tesseract, RapidOCR)
   - Optional enrichments for code, formulas, and images

2. **VLM Pipeline**: Vision-Language Model processing
   - Uses SmolDocling for intelligent document understanding
   - Best for complex layouts, images with text, and mixed content
   - Always produces structured JSON output

3. **ASR Pipeline**: Audio transcription
   - Converts audio files to text
   - Supports various audio formats (MP3, WAV, M4A)

## Integration with Aether

Docling is integrated with Aether platform via:

1. **Backend API**: `backend/routes/file_chat.py` handles file uploads
2. **Runtime Processing**: `backend/runtime/oi_runtime.py` processes files through Docling
3. **Vision-Docling Bridge**: `backend/runtime/vision_docling_bridge.py` routes vision calls through Docling
4. **Docling Client**: `open-interpreter/interpreter/core/computer/docling/docling.py` provides client functions

## Configuration

Docling API Server uses sensible defaults but can be customized:

```python
# OCR Configuration
ocr_engine = "easyocr"  # Options: easyocr, ocrmac, tesseracr, rapidocr
ocr_languages = "en,es,fr"  # Comma-separated language codes

# VLM Configuration
lm_studio_url = "http://localhost:1234/v1/chat/completions"
lm_studio_model = "smoldocling-256m-preview-mlx-docling-snap"

# Output Format
output_format = "json"  # Options: markdown, json, html, text, doctags
```

## Supported File Types

- **Documents**: PDF, DOCX, PPTX, HTML, Markdown
- **Images**: JPEG, PNG, TIFF, BMP, GIF
- **Text**: TXT, CSV, JSON, code files
- **Audio**: WAV, MP3, M4A

## Engine Recommendations

| Use Case | Recommended Engine | Why |
|----------|-------------------|------|
| Fast processing on macOS | OcrMac | Native Apple Vision framework |
| Multi-language documents | EasyOCR | 80+ languages, GPU accelerated |
| Complex layouts | Tesseract | Most mature, highly customizable |
| Batch processing | RapidOCR | Fastest CPU-based processing |
| Document understanding | VLM + SmolDocling | AI-powered structure recognition |

## Troubleshooting

- **API Server Not Responding**: Check if `docling_api_server.py` is running
- **VLM Processing Fails**: Verify LM Studio is running with the SmolDocling model
- **OCR Quality Issues**: Try different engines based on document type
- **Processing Takes Too Long**: Consider reducing enrichment options or changing OCR engine

## API Usage Example

```python
import requests

# Process a file
with open("document.pdf", "rb") as f:
    files = {"file": ("document.pdf", f)}
    data = {
        "pipeline": "standard",
        "ocr_engine": "easyocr",
        "output_format": "json"
    }
    response = requests.post("http://localhost:8000/convert", files=files, data=data)
    result = response.json()
    print(result["content"])
```

For a user-friendly interface, use the included Gradio app at `docling_gradio_app.py`.