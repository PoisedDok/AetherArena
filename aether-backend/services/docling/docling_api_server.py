#!/usr/bin/env python3
"""
Docling API Server with LM Studio Integration
============================================

A comprehensive FastAPI server that provides document conversion services
using Docling with multiple OCR engines and VLM models via LM Studio.

Features:
- Multiple OCR engines (EasyOCR, OcrMac, Tesseract, RapidOCR)
- VLM integration via LM Studio (SmolDocling, Granite Vision)
- ASR support for audio files
- Flexible pipeline options
- Detailed engine recommendations
"""

import asyncio
import io
import logging
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Union
from enum import Enum

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import VlmPipelineOptions, PdfPipelineOptions
from docling.datamodel.pipeline_options_vlm_model import ApiVlmOptions, ResponseFormat
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling.pipeline.vlm_pipeline import VlmPipeline
from docling.pipeline.standard_pdf_pipeline import StandardPdfPipeline
from docling.pipeline.asr_pipeline import AsrPipeline

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize FastAPI app
app = FastAPI(
    title="Docling API Server",
    description="Document conversion API with multiple engines and LM Studio integration",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc"
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Engine configurations
class OCREngine(str, Enum):
    EASYOCR = "easyocr"
    OCRMAC = "ocrmac"
    TESSERACT = "tesseracr"
    RAPIDOCR = "rapidocr"

class VLMModel(str, Enum):
    SMOLDOCLING = "smoldocling"
    INTERNVL = "internvl"

class Pipeline(str, Enum):
    STANDARD = "standard"
    VLM = "vlm"
    ASR = "asr"

class OutputFormat(str, Enum):
    MARKDOWN = "markdown"
    JSON = "json"
    HTML = "html"
    TEXT = "text"
    DOCTAGS = "doctags"

# Pydantic models
class EngineRecommendation(BaseModel):
    engine: str
    use_case: str
    pros: List[str]
    cons: List[str]
    best_for: List[str]
    performance: str

class ConversionRequest(BaseModel):
    pipeline: Pipeline = Pipeline.STANDARD
    ocr_engine: OCREngine = OCREngine.EASYOCR
    vlm_model: Optional[VLMModel] = VLMModel.SMOLDOCLING
    output_format: OutputFormat = OutputFormat.MARKDOWN
    lm_studio_url: str = "http://localhost:1234/v1/chat/completions"
    lm_studio_model: str = "smoldocling-256m-preview-mlx"
    enable_code_enrichment: bool = False
    enable_formula_enrichment: bool = False
    enable_picture_classification: bool = False
    enable_picture_description: bool = False
    ocr_languages: Optional[str] = None

class OptionsResponse(BaseModel):
    pipelines: List[str]
    ocr_engines: List[str]
    vlm_models: List[str]
    output_formats: List[str]
    defaults: Dict[str, Optional[Union[str, bool]]]

class ConversionResponse(BaseModel):
    success: bool
    content: str
    format: str
    processing_time: float
    engine_used: str
    pages_processed: int
    extracted_assets: Optional[Dict[str, Any]] = None
    error: Optional[str] = None

# Engine recommendations database
ENGINE_RECOMMENDATIONS = {
    "easyocr": EngineRecommendation(
        engine="EasyOCR",
        use_case="General purpose OCR with GPU acceleration",
        pros=[
            "Good balance of speed and accuracy",
            "Supports 80+ languages",
            "GPU accelerated",
            "Good for multi-language documents"
        ],
        cons=[
            "Slower than native solutions on macOS",
            "Requires more memory"
        ],
        best_for=[
            "Multi-language documents",
            "General document processing",
            "When GPU acceleration is available"
        ],
        performance="Medium-High accuracy, Medium speed"
    ),
    "ocrmac": EngineRecommendation(
        engine="OcrMac",
        use_case="Apple's native Vision framework (macOS only)",
        pros=[
            "Fastest on macOS",
            "Native Apple integration",
            "Excellent for modern, clean documents",
            "No additional dependencies"
        ],
        cons=[
            "macOS only",
            "Less accurate with complex layouts",
            "Limited language support"
        ],
        best_for=[
            "Modern PDFs on macOS",
            "Fast batch processing",
            "Clean, well-formatted documents"
        ],
        performance="High speed, Good accuracy for clean docs"
    ),
    "tesseracr": EngineRecommendation(
        engine="Tesseract",
        use_case="Most mature OCR engine with high customization",
        pros=[
            "Most mature and tested",
            "Highly customizable",
            "Best for complex layouts",
            "Excellent for historical documents",
            "100+ languages supported"
        ],
        cons=[
            "Slower processing",
            "Requires system installation",
            "More configuration needed"
        ],
        best_for=[
            "Complex document layouts",
            "Historical documents",
            "High accuracy requirements",
            "Specific language needs"
        ],
        performance="High accuracy, Lower speed"
    ),
    "rapidocr": EngineRecommendation(
        engine="RapidOCR",
        use_case="Fastest CPU-based OCR for batch processing",
        pros=[
            "Fastest CPU-based processing",
            "Lightweight",
            "Good for batch processing",
            "ONNX optimized"
        ],
        cons=[
            "Lower accuracy than others",
            "Limited language support",
            "Less robust with complex layouts"
        ],
        best_for=[
            "High-volume batch processing",
            "Speed over accuracy scenarios",
            "Simple document layouts"
        ],
        performance="High speed, Medium accuracy"
    )
}

VLM_RECOMMENDATIONS = {
    "smoldocling": {
        "name": "SmolDocling",
        "description": "Specialized document understanding model (256M parameters) with high accuracy for image/diagram extraction",
        "strengths": [
            "Best for document structure understanding",
            "Preserves formatting and layout",
            "6x faster with MLX on Apple Silicon",
            "Outputs structured DocTags format",
            "Excellent at extracting images and diagrams",
            "High accuracy for complex documents",
            "Advanced PDF analysis with OCR"
        ],
        "use_cases": [
            "Complex document layouts",
            "Table and form processing",
            "Scientific papers",
            "Documents with mixed content",
            "PDFs with images and diagrams",
            "Technical documentation"
        ],
        "lm_studio_model": "smoldocling-256m-preview-mlx"
    },
    "internvl": {
        "name": "InternVL 3.5",
        "description": "Advanced vision-language model (2B parameters) for high-quality image understanding",
        "strengths": [
            "Excellent image and diagram understanding",
            "High accuracy for visual content analysis",
            "Strong performance on charts and technical diagrams",
            "Better than SmolDocling for pure image analysis"
        ],
        "use_cases": [
            "Image files (.jpg, .png, .tiff)",
            "Complex diagrams and charts",
            "Technical drawings",
            "Scientific figures",
            "Visual content analysis"
        ],
        "lm_studio_model": "internvl3_5-2b"
    },
    "granite_vision": {
        "name": "Granite Vision",
        "description": "IBM's vision-language model for document OCR",
        "strengths": [
            "Good general vision understanding",
            "Reliable markdown output",
            "Good with natural images in documents"
        ],
        "use_cases": [
            "Documents with images",
            "General OCR tasks",
            "Mixed content documents"
        ],
        "lm_studio_model": "granite-vision-3.2-2b"
    }
}

def extract_images_and_diagrams(result, filename: str) -> Dict[str, Any]:
    """Extract and analyze images and diagrams from processed document."""
    extracted_assets = {
        "images": [],
        "diagrams": [],
        "charts": [],
        "tables": []
    }

    try:
        # Check if the document has pages with images
        if hasattr(result.document, 'pages'):
            for page_idx, page in enumerate(result.document.pages):
                if hasattr(page, 'images') and page.images:
                    for img_idx, image in enumerate(page.images):
                        image_info = {
                            "page": page_idx + 1,
                            "index": img_idx,
                            "position": getattr(image, 'position', {}),
                            "size": getattr(image, 'size', {}),
                            "type": "image"
                        }

                        # Try to classify the image type
                        if hasattr(image, 'image_info'):
                            img_info = image.image_info
                            if hasattr(img_info, 'image_type'):
                                image_type = img_info.image_type.lower()
                                if 'diagram' in image_type or 'chart' in image_type:
                                    extracted_assets["diagrams"].append(image_info)
                                elif 'chart' in image_type or 'graph' in image_type:
                                    extracted_assets["charts"].append(image_info)
                                else:
                                    extracted_assets["images"].append(image_info)
                            else:
                                extracted_assets["images"].append(image_info)
                        else:
                            extracted_assets["images"].append(image_info)

                # Extract tables
                if hasattr(page, 'tables') and page.tables:
                    for table_idx, table in enumerate(page.tables):
                        table_info = {
                            "page": page_idx + 1,
                            "index": table_idx,
                            "content": getattr(table, 'content', ''),
                            "position": getattr(table, 'position', {}),
                            "type": "table"
                        }
                        extracted_assets["tables"].append(table_info)

    except Exception as e:
        logger.warning(f"Error extracting images/diagrams from {filename}: {e}")

    return extracted_assets

def clean_vlm_output(content: str, model: str) -> str:
    """Clean up VLM output to remove corrupted or repetitive content."""
    
    if not content:
        return content
    
    # Remove fake tokens and corrupted sequences
    content = content.replace("<fake_token_around_image>", "")
    content = content.replace("<end_of_utterance>", "")
    
    # For SmolDocling, extract only the first doctag block
    if "smoldocling" in model.lower() and "<doctag>" in content:
        # Find first doctag block
        start = content.find("<doctag>")
        if start != -1:
            # Look for end or reasonable stopping point
            end = content.find("</doctag>", start)
            if end == -1:
                # If no proper end tag, look for other stopping indicators
                end = content.find("\nUser:", start)
                if end == -1:
                    end = content.find("Assistant:", start)
                if end == -1:
                    end = content.find("<doctag>", start + 8)  # Find next doctag
                if end == -1:
                    # Take only first reasonable chunk (up to 2000 chars)
                    end = min(start + 2000, len(content))
            else:
                end += 9  # Include </doctag>
            
            content = content[start:end]
    
    # Remove excessive repetition (more than 3 consecutive identical lines)
    lines = content.split('\n')
    cleaned_lines = []
    last_line = None
    repeat_count = 0
    
    for line in lines:
        if line == last_line:
            repeat_count += 1
            if repeat_count < 3:  # Allow up to 2 repetitions
                cleaned_lines.append(line)
        else:
            repeat_count = 0
            cleaned_lines.append(line)
            last_line = line
    
    content = '\n'.join(cleaned_lines)
    
    # Truncate if still too long (safety measure)
    if len(content) > 10000:
        content = content[:10000] + "\n[Content truncated due to length]"
    
    return content.strip()

def get_lm_studio_vlm_options(model: str, lm_studio_url: str, format: ResponseFormat) -> ApiVlmOptions:
    """Create LM Studio VLM options for the specified model."""
    
    if "smoldocling" in model.lower():
        prompt = "Convert this document page to structured DocTags format. Focus on extracting text, tables, and document structure. Be concise and accurate."
        response_format = ResponseFormat.DOCTAGS
        # Shorter timeout for SmolDocling to prevent infinite generation
        timeout = 60
    else:
        prompt = "OCR the full page to markdown. Preserve all structure and formatting. Be concise and accurate."
        response_format = ResponseFormat.MARKDOWN
        timeout = 120
    
    if format != ResponseFormat.DOCTAGS:
        response_format = format
    
    # Additional parameters to control generation
    params = {
        "model": model,
        "max_tokens": 4096,  # Limit max tokens to prevent runaway generation
        "temperature": 0.1,  # Lower temperature for more focused output
        "stop": ["<end_of_utterance>", "</doctag>", "\n\nUser:", "Assistant:", "<fake_token_around_image>"],  # Stop sequences
    }
    
    return ApiVlmOptions(
        url=lm_studio_url,
        params=params,
        prompt=prompt,
        timeout=timeout,
        scale=1.0,
        response_format=response_format,
    )

async def convert_document(
    file_content: bytes,
    filename: str,
    request: ConversionRequest
) -> ConversionResponse:
    """Convert a document using the specified pipeline and options."""
    
    import time
    start_time = time.time()
    result_content = ""  # Placeholder for output
    
    try:
        # Create temporary file
        with tempfile.NamedTemporaryFile(suffix=Path(filename).suffix, delete=False) as tmp_file:
            tmp_file.write(file_content)
            tmp_file.flush()
            input_path = Path(tmp_file.name)
        
        # Determine input format
        file_extension = Path(filename).suffix.lower()
        input_format = None
        
        if file_extension in ['.pdf']:
            input_format = InputFormat.PDF
        elif file_extension in ['.docx']:
            input_format = InputFormat.DOCX
        elif file_extension in ['.pptx']:
            input_format = InputFormat.PPTX
        elif file_extension in ['.html']:
            input_format = InputFormat.HTML
        elif file_extension in ['.md']:
            input_format = InputFormat.MD
        elif file_extension in ['.wav', '.mp3', '.m4a']:
            input_format = InputFormat.AUDIO
        elif file_extension in ['.jpg', '.jpeg', '.png', '.tiff', '.bmp']:
            input_format = InputFormat.IMAGE
        elif file_extension in ['.xlsx', '.xls']:
            # Excel files - convert to CSV first, then process as text
            logger.info(f"Processing Excel file: {filename}")
            return await process_excel_file(file_content, filename, request)
        elif file_extension in ['.py', '.js', '.ts', '.java', '.cpp', '.c', '.cs', '.php', '.rb', '.go', '.rs', '.swift', '.kt']:
            # Code files - process as plain text
            logger.info(f"Processing code file: {filename}")
            return await process_code_file(file_content, filename, request)
        elif file_extension in ['.txt', '.csv', '.json', '.xml', '.yaml', '.yml', '.log', '.sql']:
            # Text-based files - process directly as text
            logger.info(f"Processing text file: {filename}")
            return await process_text_file(file_content, filename, request)
        else:
            # Try to process as text if it's a readable file
            logger.warning(f"Unknown file extension {file_extension}, attempting text processing")
            try:
                return await process_text_file(file_content, filename, request)
            except Exception as text_err:
                logger.error(f"Failed to process as text: {text_err}")
                raise HTTPException(status_code=400, detail=f"Unsupported file format: {file_extension}. Supported formats: PDF, DOCX, PPTX, HTML, MD, TXT, CSV, JSON, XML, YAML, Excel (.xlsx/.xls), Code files (.py/.js/.ts/etc), Images, Audio")
        
        # Configure pipeline options
        format_options = {}
        engine_used = f"{request.pipeline.value}"

        # AUTO-DETECT: Force SmolDocling for PDFs and InternVL for images for high accuracy
        if input_format == InputFormat.PDF and file_extension == '.pdf':
            logger.info(f"🔍 Auto-detecting PDF {filename}, forcing SmolDocling for advanced PDF analysis with OCR")
            request.pipeline = Pipeline.VLM
            request.vlm_model = VLMModel.SMOLDOCLING
            request.lm_studio_model = "smoldocling-256m-preview-mlx"
            request.enable_picture_classification = True
            request.enable_picture_description = True
            request.enable_code_enrichment = True
            request.enable_formula_enrichment = True
            request.ocr_engine = OCREngine.OCRMAC  # Use best OCR with SmolDocling
            request.output_format = OutputFormat.DOCTAGS  # Structured output for better analysis

        elif input_format == InputFormat.IMAGE and file_extension in ['.jpg', '.jpeg', '.png', '.tiff', '.bmp']:
            logger.info(f"🔍 Auto-detecting image {filename}, forcing InternVL for high-quality visual analysis")
            request.pipeline = Pipeline.VLM
            request.vlm_model = VLMModel.INTERNVL
            request.lm_studio_model = "internvl3_5-2b"
            request.enable_picture_classification = True
            request.enable_picture_description = True
            request.output_format = OutputFormat.MARKDOWN  # Good format for image descriptions
        
        if request.pipeline == Pipeline.STANDARD:
            # Standard pipeline with OCR options
            pipeline_options = PdfPipelineOptions()
            pipeline_options.do_ocr = True

            # Map selected engine to correct OcrOptions subclass
            from docling.datamodel.pipeline_options import (
                EasyOcrOptions,
                RapidOcrOptions,
                TesseractCliOcrOptions,
                OcrMacOptions,
            )

            ocr_map = {
                'easyocr': EasyOcrOptions,
                'rapidocr': RapidOcrOptions,
                'tesseracr': TesseractCliOcrOptions,
                'ocrmac': OcrMacOptions,
            }

            OptCls = ocr_map.get(request.ocr_engine.value, EasyOcrOptions)
            pipeline_options.ocr_options = OptCls()
            
            if request.ocr_languages:
                pipeline_options.ocr_options.lang = request.ocr_languages.split(',')
            
            # Enrichment options
            pipeline_options.do_code_enrichment = request.enable_code_enrichment
            pipeline_options.do_formula_enrichment = request.enable_formula_enrichment
            pipeline_options.do_picture_classification = request.enable_picture_classification
            
            format_options[input_format] = PdfFormatOption(
                pipeline_options=pipeline_options,
                pipeline_cls=StandardPdfPipeline
            )
            engine_used = f"standard/{request.ocr_engine.value}"
            
        elif request.pipeline == Pipeline.VLM:
            # VLM pipeline with LM Studio
            vlm_options = VlmPipelineOptions(enable_remote_services=True)
            
            # Configure VLM model
            if request.vlm_model:
                model_name = request.lm_studio_model
                output_format = ResponseFormat.MARKDOWN
                
                if request.output_format == OutputFormat.DOCTAGS:
                    output_format = ResponseFormat.DOCTAGS
                elif request.output_format == OutputFormat.HTML:
                    output_format = ResponseFormat.HTML
                
                vlm_options.vlm_options = get_lm_studio_vlm_options(
                    model_name, 
                    request.lm_studio_url,
                    output_format
                )
            
            format_options[input_format] = PdfFormatOption(
                pipeline_options=vlm_options,
                pipeline_cls=VlmPipeline
            )
            engine_used = f"vlm/{request.vlm_model.value if request.vlm_model else 'default'}"
            
        elif request.pipeline == Pipeline.ASR:
            # ASR pipeline for audio
            if input_format != InputFormat.AUDIO:
                raise HTTPException(status_code=400, detail="ASR pipeline only supports audio files")
            
            # ASR doesn't use format options the same way
            engine_used = "asr/whisper"
        
        # Create converter
        if request.pipeline == Pipeline.ASR:
            # For ASR, we need a different approach
            converter = DocumentConverter()
        else:
            converter = DocumentConverter(format_options=format_options)
        
        # Convert document with double-checking for high accuracy processing
        logger.info(f"Converting {filename} using {engine_used}")

        # Double-check: If this is a PDF and we're not using SmolDocling, log a warning
        if input_format == InputFormat.PDF and request.pipeline != Pipeline.VLM:
            logger.warning(f"⚠️  PDF {filename} is being processed with {engine_used} instead of SmolDocling VLM pipeline")
            logger.warning("This may result in lower accuracy for image/diagram extraction and OCR")

        result = converter.convert(input_path)
        
        # Export to requested format
        if request.output_format == OutputFormat.MARKDOWN:
            result_content = result.document.export_to_markdown()
        elif request.output_format == OutputFormat.JSON:
            result_content = result.document.export_to_json()
        elif request.output_format == OutputFormat.HTML:
            result_content = result.document.export_to_html()
        elif request.output_format == OutputFormat.TEXT:
            result_content = result.document.export_to_text()
        elif request.output_format == OutputFormat.DOCTAGS:
            result_content = result.document.export_to_doctags()
        else:
            result_content = result.document.export_to_markdown()

        # Extract images, diagrams, and other assets for enhanced processing
        extracted_assets = extract_images_and_diagrams(result, filename)

        # Add detailed asset information to the result for high-accuracy processing
        if extracted_assets["images"] or extracted_assets["diagrams"] or extracted_assets["charts"] or extracted_assets["tables"]:
            asset_summary = f"\n\n--- Document Assets Extracted (SmolDocling Analysis) ---\n"

            if extracted_assets["images"]:
                asset_summary += f"📸 Images found: {len(extracted_assets['images'])}\n"
                for i, img in enumerate(extracted_assets["images"][:5]):  # Show first 5
                    asset_summary += f"  • Page {img['page']}, Position: {img['position']}\n"

            if extracted_assets["diagrams"]:
                asset_summary += f"📊 Diagrams found: {len(extracted_assets['diagrams'])}\n"
                for i, diag in enumerate(extracted_assets["diagrams"][:5]):  # Show first 5
                    asset_summary += f"  • Page {diag['page']}, Position: {diag['position']}\n"

            if extracted_assets["charts"]:
                asset_summary += f"📈 Charts found: {len(extracted_assets['charts'])}\n"
                for i, chart in enumerate(extracted_assets["charts"][:5]):  # Show first 5
                    asset_summary += f"  • Page {chart['page']}, Position: {chart['position']}\n"

            if extracted_assets["tables"]:
                asset_summary += f"📋 Tables found: {len(extracted_assets['tables'])}\n"
                for i, table in enumerate(extracted_assets["tables"][:5]):  # Show first 5
                    asset_summary += f"  • Page {table['page']}, Position: {table['position']}\n"

            asset_summary += "\n--- SmolDocling OCR + Vision Analysis Complete ---\n"
            result_content += asset_summary
        
        # Clean VLM output if using VLM pipeline
        if request.pipeline == Pipeline.VLM and request.vlm_model:
            result_content = clean_vlm_output(result_content, request.lm_studio_model)
        
        processing_time = time.time() - start_time
        pages_processed = len(result.document.pages) if hasattr(result.document, 'pages') else 1
        
        # Clean up
        input_path.unlink()
        
        return ConversionResponse(
            success=True,
            content=result_content,
            format=request.output_format.value,
            processing_time=processing_time,
            engine_used=engine_used,
            pages_processed=pages_processed,
            extracted_assets=extracted_assets
        )
        
    except Exception as e:
        logger.error(f"Conversion failed: {str(e)}")
        processing_time = time.time() - start_time
        # Ensure engine_used is defined
        if 'engine_used' not in locals():
            engine_used = "unknown"
        return ConversionResponse(
            success=False,
            content="",
            format=request.output_format.value,
            processing_time=processing_time,
            engine_used=engine_used,
            pages_processed=0,
            error=str(e)
        )

async def process_excel_file(content: bytes, filename: str, request: ConversionRequest) -> ConversionResponse:
    """Process Excel files by converting to CSV/text format"""
    import io
    import pandas as pd
    
    start_time = time.time()
    logger.info(f"Processing Excel file: {filename}")
    
    try:
        # Read Excel file with pandas
        excel_data = io.BytesIO(content)
        
        # Try to read all sheets
        try:
            sheets_dict = pd.read_excel(excel_data, sheet_name=None, engine='openpyxl')
            logger.info(f"Found {len(sheets_dict)} sheets in Excel file")
        except Exception as read_err:
            logger.warning(f"Failed to read with openpyxl, trying xlrd: {read_err}")
            excel_data.seek(0)
            sheets_dict = pd.read_excel(excel_data, sheet_name=None, engine='xlrd')
        
        # Convert all sheets to text
        text_content = []
        total_rows = 0
        
        for sheet_name, df in sheets_dict.items():
            text_content.append(f"=== Sheet: {sheet_name} ===")
            
            # Convert DataFrame to CSV-like text
            if not df.empty:
                csv_text = df.to_csv(index=False, na_rep='')
                text_content.append(csv_text)
                total_rows += len(df)
                logger.info(f"Sheet '{sheet_name}': {len(df)} rows, {len(df.columns)} columns")
            else:
                text_content.append("(Empty sheet)")
            
            text_content.append("")  # Add blank line between sheets
        
        final_content = "\n".join(text_content)
        processing_time = time.time() - start_time
        
        logger.info(f"Excel processing completed: {total_rows} total rows, {processing_time:.2f}s")
        
        return ConversionResponse(
            success=True,
            content=final_content,
            format="text",
            processing_time=processing_time,
            engine_used="pandas_excel",
            pages_processed=len(sheets_dict)
        )
        
    except Exception as e:
        logger.error(f"Excel processing failed: {str(e)}")
        processing_time = time.time() - start_time
        return ConversionResponse(
            success=False,
            content="",
            format="text",
            processing_time=processing_time,
            engine_used="pandas_excel",
            pages_processed=0,
            error=f"Excel processing failed: {str(e)}"
        )

async def process_code_file(content: bytes, filename: str, request: ConversionRequest) -> ConversionResponse:
    """Process code files as text with syntax highlighting information"""
    start_time = time.time()
    logger.info(f"Processing code file: {filename}")
    
    try:
        # Decode text content
        try:
            text_content = content.decode('utf-8')
        except UnicodeDecodeError:
            try:
                text_content = content.decode('latin-1')
                logger.warning(f"Used latin-1 encoding for {filename}")
            except UnicodeDecodeError as decode_err:
                logger.error(f"Failed to decode {filename}: {decode_err}")
                raise HTTPException(status_code=400, detail=f"Cannot decode file {filename}: {str(decode_err)}")
        
        # Add file type information
        file_ext = filename.lower().split('.')[-1] if '.' in filename else 'unknown'
        
        formatted_content = f"=== Code File: {filename} ===\n"
        formatted_content += f"File Type: {file_ext}\n"
        formatted_content += f"Lines: {len(text_content.splitlines())}\n"
        formatted_content += f"Size: {len(content)} bytes\n\n"
        formatted_content += "=== Content ===\n"
        formatted_content += text_content
        
        processing_time = time.time() - start_time
        lines_count = len(text_content.splitlines())
        
        logger.info(f"Code file processed: {lines_count} lines, {processing_time:.2f}s")
        
        return ConversionResponse(
            success=True,
            content=formatted_content,
            format="text",
            processing_time=processing_time,
            engine_used="text_processor",
            pages_processed=1
        )
        
    except Exception as e:
        logger.error(f"Code file processing failed: {str(e)}")
        processing_time = time.time() - start_time
        return ConversionResponse(
            success=False,
            content="",
            format="text",
            processing_time=processing_time,
            engine_used="text_processor",
            pages_processed=0,
            error=f"Code processing failed: {str(e)}"
        )

async def process_text_file(content: bytes, filename: str, request: ConversionRequest) -> ConversionResponse:
    """Process text-based files (TXT, CSV, JSON, XML, etc.)"""
    start_time = time.time()
    logger.info(f"Processing text file: {filename}")
    
    try:
        # Decode text content
        try:
            text_content = content.decode('utf-8')
        except UnicodeDecodeError:
            try:
                text_content = content.decode('latin-1')
                logger.warning(f"Used latin-1 encoding for {filename}")
            except UnicodeDecodeError as decode_err:
                logger.error(f"Failed to decode {filename}: {decode_err}")
                raise HTTPException(status_code=400, detail=f"Cannot decode file {filename}: {str(decode_err)}")
        
        # Add file metadata
        file_ext = filename.lower().split('.')[-1] if '.' in filename else 'unknown'
        lines_count = len(text_content.splitlines())
        
        # For structured files, add format information
        formatted_content = f"=== File: {filename} ===\n"
        formatted_content += f"Format: {file_ext.upper()}\n"
        formatted_content += f"Lines: {lines_count}\n"
        formatted_content += f"Size: {len(content)} bytes\n\n"
        
        # Special handling for different text formats
        if file_ext in ['json']:
            try:
                import json
                parsed = json.loads(text_content)
                formatted_content += "=== Parsed JSON Structure ===\n"
                formatted_content += f"Type: {type(parsed).__name__}\n"
                if isinstance(parsed, dict):
                    formatted_content += f"Keys: {list(parsed.keys())}\n"
                elif isinstance(parsed, list):
                    formatted_content += f"Items: {len(parsed)}\n"
                formatted_content += "\n"
            except json.JSONDecodeError:
                formatted_content += "=== JSON Parse Warning ===\nFile appears to be malformed JSON\n\n"
        
        elif file_ext in ['csv']:
            lines = text_content.splitlines()
            if lines:
                formatted_content += "=== CSV Structure ===\n"
                formatted_content += f"Estimated columns: {len(lines[0].split(',')) if lines else 0}\n"
                formatted_content += f"Data rows: {len(lines) - 1 if len(lines) > 1 else 0}\n\n"
        
        formatted_content += "=== Content ===\n"
        formatted_content += text_content
        
        processing_time = time.time() - start_time
        
        logger.info(f"Text file processed: {lines_count} lines, {processing_time:.2f}s")
        
        return ConversionResponse(
            success=True,
            content=formatted_content,
            format="text",
            processing_time=processing_time,
            engine_used="text_processor",
            pages_processed=1
        )
        
    except Exception as e:
        logger.error(f"Text file processing failed: {str(e)}")
        processing_time = time.time() - start_time
        return ConversionResponse(
            success=False,
            content="",
            format="text",
            processing_time=processing_time,
            engine_used="text_processor",
            pages_processed=0,
            error=f"Text processing failed: {str(e)}"
        )

# API Endpoints
@app.get("/")
async def root():
    """Root endpoint with API information."""
    return {
        "message": "Docling API Server",
        "version": "1.0.0",
        "docs": "/docs",
        "engines": list(ENGINE_RECOMMENDATIONS.keys()),
        "vlm_models": list(VLM_RECOMMENDATIONS.keys())
    }

@app.get("/engines", response_model=Dict[str, EngineRecommendation])
async def get_engines():
    """Get information about available OCR engines and their recommendations."""
    return ENGINE_RECOMMENDATIONS

@app.get("/vlm-models")
async def get_vlm_models():
    """Get information about available VLM models."""
    return VLM_RECOMMENDATIONS

@app.get("/options", response_model=OptionsResponse)
async def get_options():
    """List available pipelines, engines, formats, and defaults for clients."""
    return OptionsResponse(
        pipelines=[p.value for p in Pipeline],
        ocr_engines=[e.value for e in OCREngine],
        vlm_models=[m.value for m in VLMModel],
        output_formats=[f.value for f in OutputFormat],
        defaults={
            "lm_studio_url": "http://localhost:1234/v1/chat/completions",
            "lm_studio_model": "smoldocling-256m-preview-mlx",
            "enable_code_enrichment": False,
            "enable_formula_enrichment": False,
            "enable_picture_classification": False,
            "enable_picture_description": False,
            "ocr_languages": None,
        },
    )

@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy", "timestamp": str(time.time())}

@app.post("/convert", response_model=ConversionResponse)
async def convert_file(
    file: UploadFile = File(...),
    pipeline: Pipeline = Form(Pipeline.STANDARD),
    ocr_engine: OCREngine = Form(OCREngine.EASYOCR),
    vlm_model: Optional[VLMModel] = Form(None),
    output_format: OutputFormat = Form(OutputFormat.MARKDOWN),
    lm_studio_url: str = Form("http://localhost:1234/v1/chat/completions"),
    lm_studio_model: str = Form("smoldocling-256m-preview-mlx-docling-snap"),
    enable_code_enrichment: bool = Form(False),
    enable_formula_enrichment: bool = Form(False),
    enable_picture_classification: bool = Form(False),
    enable_picture_description: bool = Form(False),
    ocr_languages: Optional[str] = Form(None)
):
    """
    Convert a document using the specified pipeline and options.
    
    - **file**: Document file to convert (PDF, DOCX, PPTX, HTML, images, audio)
    - **pipeline**: Processing pipeline (standard, vlm, asr)
    - **ocr_engine**: OCR engine for standard pipeline
    - **vlm_model**: VLM model for vlm pipeline
    - **output_format**: Output format (markdown, json, html, text, doctags)
    - **lm_studio_url**: LM Studio server URL
    - **lm_studio_model**: Model name in LM Studio
    - **enable_***: Various enrichment options
    - **ocr_languages**: Comma-separated language codes for OCR
    """
    
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")
    
    # Read file content
    content = await file.read()
    
    # Create request object
    request = ConversionRequest(
        pipeline=pipeline,
        ocr_engine=ocr_engine,
        vlm_model=vlm_model,
        output_format=output_format,
        lm_studio_url=lm_studio_url,
        lm_studio_model=lm_studio_model,
        enable_code_enrichment=enable_code_enrichment,
        enable_formula_enrichment=enable_formula_enrichment,
        enable_picture_classification=enable_picture_classification,
        enable_picture_description=enable_picture_description,
        ocr_languages=ocr_languages
    )
    
    return await convert_document(content, file.filename, request)

@app.post("/convert-json", response_model=ConversionResponse)
async def convert_file_json(
    file: UploadFile = File(...),
    options: str = Form(...)
):
    """
    Convert a document using JSON options.
    
    - **file**: Document file to convert
    - **options**: JSON string with conversion options
    """
    
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")
    
    try:
        import json
        options_dict = json.loads(options)
        request = ConversionRequest(**options_dict)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid options JSON: {str(e)}")
    
    content = await file.read()
    return await convert_document(content, file.filename, request)

if __name__ == "__main__":
    uvicorn.run(
        "docling_api_server:app",
        host="0.0.0.0",
        port=8000,
        reload=False,
        log_level="info"
    )
