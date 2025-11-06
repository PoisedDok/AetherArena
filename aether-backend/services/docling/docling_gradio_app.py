#!/usr/bin/env python3
"""
Docling Gradio Web Interface
============================

A comprehensive web interface for testing the Docling API server.
Provides easy access to all conversion options with explanations.
"""

import json
import requests
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import gradio as gr


# API Configuration
API_BASE_URL = "http://localhost:8000"


def get_engine_recommendations() -> Dict:
    """Fetch engine recommendations from the API."""
    try:
        response = requests.get(f"{API_BASE_URL}/engines")
        if response.status_code == 200:
            return response.json()
        else:
            return {}
    except Exception as e:
        print(f"Failed to get engine recommendations: {e}")
        return {}


def get_vlm_models() -> Dict:
    """Fetch VLM model information from the API."""
    try:
        response = requests.get(f"{API_BASE_URL}/vlm-models")
        if response.status_code == 200:
            return response.json()
        else:
            return {}
    except Exception as e:
        print(f"Failed to get VLM models: {e}")
        return {}


def format_engine_info(engine_name: str, engine_data: Dict) -> str:
    """Format engine information for display."""
    if not engine_data:
        return "Engine information not available"
    
    info = f"## {engine_data.get('engine', engine_name)}\n\n"
    info += f"**Use Case:** {engine_data.get('use_case', 'N/A')}\n\n"
    info += f"**Performance:** {engine_data.get('performance', 'N/A')}\n\n"
    
    if engine_data.get('pros'):
        info += "**Pros:**\n"
        for pro in engine_data['pros']:
            info += f"- {pro}\n"
        info += "\n"
    
    if engine_data.get('cons'):
        info += "**Cons:**\n"
        for con in engine_data['cons']:
            info += f"- {con}\n"
        info += "\n"
    
    if engine_data.get('best_for'):
        info += "**Best For:**\n"
        for use_case in engine_data['best_for']:
            info += f"- {use_case}\n"
        info += "\n"
    
    return info


def format_vlm_info(model_name: str, model_data: Dict) -> str:
    """Format VLM model information for display."""
    if not model_data:
        return "Model information not available"
    
    info = f"## {model_data.get('name', model_name)}\n\n"
    info += f"**Description:** {model_data.get('description', 'N/A')}\n\n"
    
    if model_data.get('strengths'):
        info += "**Strengths:**\n"
        for strength in model_data['strengths']:
            info += f"- {strength}\n"
        info += "\n"
    
    if model_data.get('use_cases'):
        info += "**Use Cases:**\n"
        for use_case in model_data['use_cases']:
            info += f"- {use_case}\n"
        info += "\n"
    
    info += f"**LM Studio Model:** `{model_data.get('lm_studio_model', 'N/A')}`\n\n"
    
    return info


def convert_document(
    file,
    pipeline: str,
    ocr_engine: str,
    vlm_model: str,
    output_format: str,
    lm_studio_url: str,
    lm_studio_model: str,
    enable_code: bool,
    enable_formula: bool,
    enable_picture_class: bool,
    enable_picture_desc: bool,
    ocr_languages: str,
    progress=gr.Progress()
) -> Tuple[str, str, str]:
    """Convert document using the API."""
    
    if file is None:
        return "❌ No file provided", "", ""
    
    progress(0.1, desc="Preparing request...")
    
    try:
        # Prepare form data
        files = {"file": (Path(file.name).name, open(file.name, "rb"))}
        
        data = {
            "pipeline": pipeline,
            "ocr_engine": ocr_engine,
            "vlm_model": vlm_model if vlm_model != "None" else None,
            "output_format": output_format,
            "lm_studio_url": lm_studio_url,
            "lm_studio_model": lm_studio_model,
            "enable_code_enrichment": enable_code,
            "enable_formula_enrichment": enable_formula,
            "enable_picture_classification": enable_picture_class,
            "enable_picture_description": enable_picture_desc,
            "ocr_languages": ocr_languages if ocr_languages.strip() else None
        }
        
        progress(0.3, desc="Sending to API...")
        
        # Make API request
        response = requests.post(
            f"{API_BASE_URL}/convert",
            files=files,
            data=data,
            timeout=300  # 5 minutes timeout
        )
        
        files["file"][1].close()  # Close file
        
        progress(0.9, desc="Processing response...")
        
        if response.status_code == 200:
            result = response.json()
            
            if result["success"]:
                # Success response
                status = f"✅ **Conversion Successful**\n\n"
                status += f"- **Engine Used:** {result['engine_used']}\n"
                status += f"- **Processing Time:** {result['processing_time']:.2f} seconds\n"
                status += f"- **Pages Processed:** {result['pages_processed']}\n"
                status += f"- **Output Format:** {result['format']}\n"
                
                content = result["content"]
                
                # Metadata
                metadata = json.dumps({
                    "success": result["success"],
                    "engine_used": result["engine_used"],
                    "processing_time": result["processing_time"],
                    "pages_processed": result["pages_processed"],
                    "format": result["format"]
                }, indent=2)
                
                progress(1.0, desc="Complete!")
                return status, content, metadata
            else:
                # API returned error
                status = f"❌ **Conversion Failed**\n\n"
                status += f"- **Error:** {result.get('error', 'Unknown error')}\n"
                status += f"- **Processing Time:** {result.get('processing_time', 0):.2f} seconds\n"
                
                return status, "", json.dumps(result, indent=2)
        else:
            # HTTP error
            status = f"❌ **API Error**\n\n"
            status += f"- **Status Code:** {response.status_code}\n"
            status += f"- **Error:** {response.text}\n"
            
            return status, "", ""
            
    except requests.exceptions.Timeout:
        return "❌ **Request Timeout** - The conversion took too long", "", ""
    except Exception as e:
        return f"❌ **Error:** {str(e)}", "", ""


def update_engine_info(engine: str) -> str:
    """Update engine information display."""
    engine_data = get_engine_recommendations()
    return format_engine_info(engine, engine_data.get(engine, {}))


def update_vlm_info(model: str) -> str:
    """Update VLM model information display."""
    if model == "None":
        return "No VLM model selected"
    
    vlm_data = get_vlm_models()
    return format_vlm_info(model, vlm_data.get(model, {}))


def update_lm_studio_model(vlm_model: str) -> str:
    """Update LM Studio model name based on VLM selection."""
    vlm_data = get_vlm_models()
    model_info = vlm_data.get(vlm_model, {})
    return model_info.get("lm_studio_model", "smoldocling-256m-preview-mlx-docling-snap")


def check_api_status() -> str:
    """Check if the API server is running."""
    try:
        response = requests.get(f"{API_BASE_URL}/health", timeout=5)
        if response.status_code == 200:
            return "🟢 **API Server Online**"
        else:
            return "🔴 **API Server Error**"
    except Exception:
        return "🔴 **API Server Offline** - Please start the server with `python docling_api_server.py`"


# Create Gradio interface
def create_interface():
    """Create the main Gradio interface."""
    
    with gr.Blocks(
        title="Docling Document Converter",
        theme=gr.themes.Soft(),
        css="""
        .status-box { 
            padding: 10px; 
            border-radius: 8px; 
            margin: 10px 0; 
        }
        .engine-info {
            background-color: #f0f8ff;
            padding: 15px;
            border-radius: 8px;
            border-left: 4px solid #4285f4;
        }
        """
    ) as interface:
        
        gr.Markdown("""
        # 🚀 Docling Document Converter
        
        Convert documents using multiple engines and AI models with LM Studio integration.
        
        **Features:**
        - 📄 Multiple OCR engines (EasyOCR, OcrMac, Tesseract, RapidOCR)
        - 🧠 VLM models via LM Studio (SmolDocling, Granite Vision)
        - 🎵 Audio processing with Whisper ASR
        - ⚙️ Flexible pipeline options and enrichments
        """)
        
        # API Status
        with gr.Row():
            api_status = gr.Markdown(check_api_status(), elem_classes=["status-box"])
            refresh_btn = gr.Button("🔄 Refresh Status", size="sm")
            refresh_btn.click(check_api_status, outputs=[api_status])
        
        with gr.Tabs():
            # Main Conversion Tab
            with gr.Tab("🔄 Convert Document"):
                with gr.Row():
                    with gr.Column(scale=1):
                        gr.Markdown("### 📁 Upload & Options")
                        
                        file_input = gr.File(
                            label="Upload Document",
                            file_types=[".pdf", ".docx", ".pptx", ".html", ".md", ".jpg", ".jpeg", ".png", ".wav", ".mp3"],
                            type="filepath"
                        )
                        
                        pipeline = gr.Radio(
                            choices=["standard", "vlm", "asr"],
                            value="standard",
                            label="Pipeline",
                            info="Choose processing pipeline"
                        )
                        
                        with gr.Group():
                            gr.Markdown("#### OCR Options (Standard Pipeline)")
                            ocr_engine = gr.Radio(
                                choices=["easyocr", "ocrmac", "tesseracr", "rapidocr"],
                                value="easyocr",
                                label="OCR Engine"
                            )
                            ocr_languages = gr.Textbox(
                                label="OCR Languages",
                                placeholder="en,es,fr (comma-separated)",
                                info="Language codes for OCR (optional)"
                            )
                        
                        with gr.Group():
                            gr.Markdown("#### VLM Options (VLM Pipeline)")
                            vlm_model = gr.Radio(
                                choices=["smoldocling", "granite_vision"],
                                value="smoldocling",
                                label="VLM Model"
                            )
                            lm_studio_url = gr.Textbox(
                                value="http://localhost:1234/v1/chat/completions",
                                label="LM Studio URL"
                            )
                            lm_studio_model = gr.Textbox(
                                value="smoldocling-256m-preview-mlx-docling-snap",
                                label="LM Studio Model Name"
                            )
                        
                        output_format = gr.Radio(
                            choices=["markdown", "json", "html", "text", "doctags"],
                            value="markdown",
                            label="Output Format"
                        )
                        
                        with gr.Accordion("🔧 Advanced Options", open=False):
                            enable_code = gr.Checkbox(label="Enable Code Enrichment")
                            enable_formula = gr.Checkbox(label="Enable Formula Enrichment")
                            enable_picture_class = gr.Checkbox(label="Enable Picture Classification")
                            enable_picture_desc = gr.Checkbox(label="Enable Picture Description")
                        
                        convert_btn = gr.Button("🚀 Convert Document", variant="primary", size="lg")
                    
                    with gr.Column(scale=2):
                        gr.Markdown("### 📊 Results")
                        
                        status_output = gr.Markdown(label="Status")
                        
                        with gr.Tabs():
                            with gr.Tab("📄 Content"):
                                content_output = gr.Textbox(
                                    label="Converted Content",
                                    lines=20,
                                    max_lines=50,
                                    show_copy_button=True
                                )
                            
                            with gr.Tab("📋 Metadata"):
                                metadata_output = gr.Code(
                                    label="Conversion Metadata",
                                    language="json"
                                )
                
                # Auto-update LM Studio model name based on VLM selection
                vlm_model.change(
                    update_lm_studio_model,
                    inputs=[vlm_model],
                    outputs=[lm_studio_model]
                )
                
                # Convert button action
                convert_btn.click(
                    convert_document,
                    inputs=[
                        file_input, pipeline, ocr_engine, vlm_model, output_format,
                        lm_studio_url, lm_studio_model, enable_code, enable_formula,
                        enable_picture_class, enable_picture_desc, ocr_languages
                    ],
                    outputs=[status_output, content_output, metadata_output]
                )
            
            # Engine Information Tab
            with gr.Tab("ℹ️ Engine Guide"):
                with gr.Row():
                    with gr.Column():
                        gr.Markdown("### 🔍 OCR Engine Selector")
                        engine_selector = gr.Radio(
                            choices=["easyocr", "ocrmac", "tesseracr", "rapidocr"],
                            value="easyocr",
                            label="Select Engine for Details"
                        )
                        
                        engine_info = gr.Markdown(
                            update_engine_info("easyocr"),
                            elem_classes=["engine-info"]
                        )
                        
                        engine_selector.change(
                            update_engine_info,
                            inputs=[engine_selector],
                            outputs=[engine_info]
                        )
                    
                    with gr.Column():
                        gr.Markdown("### 🧠 VLM Model Selector")
                        vlm_selector = gr.Radio(
                            choices=["smoldocling", "granite_vision"],
                            value="smoldocling",
                            label="Select Model for Details"
                        )
                        
                        vlm_info = gr.Markdown(
                            update_vlm_info("smoldocling"),
                            elem_classes=["engine-info"]
                        )
                        
                        vlm_selector.change(
                            update_vlm_info,
                            inputs=[vlm_selector],
                            outputs=[vlm_info]
                        )
            
            # Setup & Documentation Tab
            with gr.Tab("📚 Setup Guide"):
                gr.Markdown("""
                ## 🛠️ Setup Instructions
                
                ### 1. Start the API Server
                ```bash
                cd /path/to/docling
                python docling_api_server.py
                ```
                
                ### 2. Configure LM Studio
                
                #### For SmolDocling:
                1. Download model: `ds4sd/SmolDocling-256M-preview-mlx-bf16`
                2. Load in LM Studio with name: `smoldocling-256m-preview-mlx-docling-snap`
                3. Start server on `http://localhost:1234`
                
                #### For Granite Vision:
                1. Download model: `ibm/granite-vision-3.2-2b`
                2. Load in LM Studio with name: `granite-vision-3.2-2b`
                3. Start server on `http://localhost:1234`
                
                ### 3. Engine Recommendations
                
                | **Use Case** | **Recommended Engine** | **Why** |
                |--------------|----------------------|---------|
                | **Fast processing on macOS** | OcrMac | Native Apple Vision framework |
                | **Multi-language documents** | EasyOCR | 80+ languages, GPU accelerated |
                | **Complex layouts** | Tesseract | Most mature, highly customizable |
                | **Batch processing** | RapidOCR | Fastest CPU-based processing |
                | **Document understanding** | VLM + SmolDocling | AI-powered structure recognition |
                | **General OCR** | VLM + Granite Vision | Good balance for mixed content |
                
                ### 4. Supported File Types
                
                - **Documents:** PDF, DOCX, PPTX, HTML, Markdown
                - **Images:** JPEG, PNG, TIFF, BMP
                - **Audio:** WAV, MP3, M4A (ASR pipeline)
                
                ### 5. Troubleshooting
                
                - **API Offline:** Check if `docling_api_server.py` is running
                - **LM Studio Error:** Ensure model is loaded and server is running
                - **Slow Processing:** Try different engines or reduce enrichments
                - **OCR Accuracy:** Try Tesseract for complex layouts, OcrMac for clean docs
                """)
        
        # Footer
        gr.Markdown("""
        ---
        **Powered by:** [Docling](https://github.com/docling-project/docling) | 
        **LM Studio Integration** | **MLX Acceleration** on Apple Silicon
        """)
    
    return interface


if __name__ == "__main__":
    # Create and launch the interface
    interface = create_interface()
    interface.launch(
        server_name="0.0.0.0",
        server_port=7860,
        share=False,
        show_error=True,
        quiet=False
    )
