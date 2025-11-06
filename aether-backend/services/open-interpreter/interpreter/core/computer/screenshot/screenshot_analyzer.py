"""
Screenshot Analysis Tool for Open Interpreter

This module provides a robust screenshot tool that can:
- Take screenshots of full screen, active window, or specific windows/apps
- Analyze screenshots using OmniParser (Apple Vision + YOLO + Caption models)
- Fallback to InternVL 3.5-2B via LM Studio if OmniParser is unavailable
- Return structured UI element analysis to agents

Author: Open Interpreter Team
"""

import base64
import io
import os
import platform
import subprocess
import tempfile
import time
from typing import Optional, Dict, Any, List
from pathlib import Path

import pyautogui
from PIL import Image

try:
    import pywinctl
    HAS_PYWINCTL = True
except ImportError:
    HAS_PYWINCTL = False

try:
    import screeninfo
    HAS_SCREENINFO = True
except ImportError:
    HAS_SCREENINFO = False

try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False

# OmniParser imports
HAS_OMNIPARSER = False
try:
    import sys
    # Path from open-interpreter/interpreter/core/computer/screenshot/ to backend/OmniParser/
    # parents[5] resolves to the repository's backend directory; append OmniParser.
    omniparser_path = Path(__file__).resolve().parents[5] / "OmniParser"
    sys.path.insert(0, str(omniparser_path))

    # Import the utils module directly from the util package
    import importlib.util
    utils_path = omniparser_path / "util" / "utils.py"
    spec = importlib.util.spec_from_file_location("util.utils", str(utils_path))
    util_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(util_module)

    # Import specific functions
    check_ocr_box = util_module.check_ocr_box
    get_yolo_model = util_module.get_yolo_model
    get_caption_model_processor = util_module.get_caption_model_processor
    get_som_labeled_img = util_module.get_som_labeled_img

    HAS_OMNIPARSER = True
    print("✅ OmniParser imported successfully")
except ImportError as e:
    print(f"⚠️ OmniParser not available: {e}")
    HAS_OMNIPARSER = False
except Exception as e:
    print(f"⚠️ OmniParser initialization failed: {e}")
    HAS_OMNIPARSER = False


class ScreenshotAnalyzer:
    """
    Robust screenshot analysis tool that integrates with OmniParser and InternVL vision models.

    Features:
    - Multiple screenshot targets (full screen, active window, specific windows)
    - Primary analysis via OmniParser (Apple Vision + YOLO + Caption models)
    - Fallback to InternVL 3.5-2B via LM Studio
    - Structured UI element analysis
    - Task completion analysis
    - Cross-platform support (macOS, Windows, Linux)
    """

    def __init__(self, computer=None, lm_studio_url: str = "http://localhost:1234/v1"):
        self.computer = computer
        self.lm_studio_url = lm_studio_url
        self.vision_model = "omniparser"  # Default to OmniParser
        self.fallback_model = "internvl3_5-2b"  # Fallback to InternVL 3.5-2B

        # OmniParser models
        self.yolo_model = None
        self.caption_model_processor = None
        self._omniparser_loaded = False

        # Configure pyautogui for better reliability
        pyautogui.FAILSAFE = True
        pyautogui.PAUSE = 0.5

        # Load OmniParser models if available
        if HAS_OMNIPARSER:
            self._load_omniparser_models()

    def _load_omniparser_models(self):
        """Load OmniParser models (YOLO and caption models)"""
        try:
            if not HAS_OMNIPARSER:
                print("OmniParser not available, skipping model loading")
                return

            # Load YOLO model for icon detection
            yolo_model_path = str(omniparser_path / "weights" / "icon_detect" / "model.pt")
            if os.path.exists(yolo_model_path):
                self.yolo_model = get_yolo_model(model_path=yolo_model_path)
                print("YOLO model loaded successfully")
            else:
                print(f"YOLO model not found at {yolo_model_path}")
                return

            # Disable caption model to avoid flash_attn issues (following gradio_demo.py)
            # caption_model_processor = get_caption_model_processor(model_name="florence2", model_name_or_path="weights/icon_caption_florence")
            # caption_model_processor = get_caption_model_processor(model_name="blip2", model_name_or_path="weights/icon_caption_blip2")
            self.caption_model_processor = None
            print("Caption model disabled - using Apple Vision OCR only (following gradio_demo.py approach)")

            self._omniparser_loaded = True
            print("OmniParser models loaded successfully")

        except Exception as e:
            print(f"Error loading OmniParser models: {e}")
            self._omniparser_loaded = False

    def take_and_analyze_screenshot(
        self,
        prompt: str = "Analyze this screenshot and determine if the task was completed successfully. Provide a detailed explanation of what you see and whether the expected outcome was achieved.",
        window_target: str = "active",
        model: str = "omniparser"
    ) -> Dict[str, Any]:
        """
        🤖 SCREENSHOT ANALYSIS TOOL - Take screenshot and analyze with OmniParser or AI vision

        PERFECT FOR:
        - Checking if your actions completed successfully
        - Analyzing what's visible on screen
        - Getting structured UI element analysis
        - Verifying application states and content

        Args:
            prompt: What to analyze in the screenshot (e.g., "Check if the download completed").
                   NOTE: Only used when falling back to InternVL. OmniParser provides
                   structured analysis and ignores custom prompts.
            window_target: Which window to screenshot - "active" (current window), "full" (entire screen), or app name (e.g., "Chrome", "Stremio")
            model: AI vision model to use (default: omniparser, fallback: internvl3_5-2b)

        Returns:
            Analysis results with detailed description and structured UI elements

        EXAMPLES:
        ```python
        # Analyze active window with OmniParser (structured analysis, no custom prompt needed)
        result = computer.screenshotanalyzer.take_and_analyze_screenshot()

        # Analyze Stremio with OmniParser (structured UI element analysis)
        result = computer.screenshotanalyzer.take_and_analyze_screenshot(
            window_target="Stremio"
        )

        # Full screen analysis with OmniParser
        result = computer.screenshotanalyzer.take_and_analyze_screenshot(
            window_target="full"
        )

        # Force InternVL with custom prompt (for specific analysis needs)
        result = computer.screenshotanalyzer.take_and_analyze_screenshot(
            prompt="Describe the movies and TV shows visible in Stremio",
            window_target="Stremio",
            model="internvl3_5-2b"
        )
        ```
        """

        try:
            # Take the screenshot
            screenshot_data = self._take_screenshot(window_target)

            if not screenshot_data:
                return {
                    "success": False,
                    "error": "Failed to take screenshot",
                    "analysis": "Screenshot capture failed"
                }

            # Try OmniParser first (PRIMARY) - NO FALLBACK FOR NOW
            if model == "omniparser" and self._omniparser_loaded:
                analysis_result = self._analyze_with_omniparser(screenshot_data)

                if analysis_result.get("success"):
                    return {
                        "success": True,
                        "screenshot_taken": True,
                        "target": window_target,
                        "model_used": "omniparser",
                        "analysis": analysis_result.get("analysis", "Analysis failed"),
                        "structured_elements": analysis_result.get("structured_elements", []),
                        "ui_elements": analysis_result.get("ui_elements", {}),
                        "raw_response": analysis_result,
                        "timestamp": time.time()
                    }
                else:
                    # Return error instead of falling back
                    return {
                        "success": False,
                        "error": f"OmniParser analysis failed: {analysis_result.get('error', 'Unknown error')}",
                        "model_used": "omniparser_failed",
                        "analysis": f"OmniParser failed: {analysis_result.get('error', 'Unknown error')}"
                    }

            # Only use InternVL if explicitly requested
            if model == "internvl3_5-2b":
                analysis_result = self._analyze_with_vision_model(
                    screenshot_data, prompt, self.fallback_model
                )
                return {
                    "success": True,
                    "screenshot_taken": True,
                    "target": window_target,
                    "model_used": self.fallback_model,
                    "analysis": analysis_result.get("analysis", "Analysis failed"),
                    "raw_response": analysis_result,
                    "timestamp": time.time()
                }

            # If OmniParser requested but not loaded, return error
            if model == "omniparser" and not self._omniparser_loaded:
                return {
                    "success": False,
                    "error": "OmniParser not available",
                    "model_used": "omniparser_unavailable"
                }

            # Unknown model
            return {
                "success": False,
                "error": f"Unknown model: {model}",
                "model_used": "unknown_model"
            }

        except Exception as e:
            return {
                "success": False,
                "error": f"Screenshot analysis failed: {str(e)}",
                "analysis": f"Error during analysis: {str(e)}"
            }

    def _analyze_with_omniparser(self, image_bytes: bytes) -> Dict[str, Any]:
        """
        Analyze screenshot using OmniParser (Apple Vision + YOLO + Caption models)

        This implementation follows the exact approach from gradio_demo.py:
        - Uses Apple Vision OCR for text detection
        - Uses YOLO for icon detection
        - Disables caption models (Florence/BLIP) to avoid issues
        - Provides structured UI element analysis

        Args:
            image_bytes: Screenshot image data

        Returns:
            Analysis results with structured UI elements
        """
        try:
            # Convert bytes to PIL Image
            image = Image.open(io.BytesIO(image_bytes))

            # Process with OmniParser
            box_threshold = 0.05
            iou_threshold = 0.1
            imgsz = 640

            # Calculate box overlay ratio for text scaling
            box_overlay_ratio = image.size[0] / 3200
            draw_bbox_config = {
                'text_scale': 0.8 * box_overlay_ratio,
                'text_thickness': max(int(2 * box_overlay_ratio), 1),
                'text_padding': max(int(3 * box_overlay_ratio), 1),
                'thickness': max(int(3 * box_overlay_ratio), 1),
            }

            # Perform OCR using Apple Vision
            ocr_bbox_rslt, is_goal_filtered = check_ocr_box(
                image,
                display_img=False,
                output_bb_format='xyxy',
                goal_filtering=None,
                easyocr_args={'text_threshold': 0.9}
            )
            text, ocr_bbox = ocr_bbox_rslt

            # Use local semantics only if caption model is available (following gradio_demo.py)
            use_local_semantics = self.caption_model_processor is not None

            # Process with OmniParser (following gradio_demo.py line 57 exactly)
            dino_labled_img, label_coordinates, parsed_content_list = get_som_labeled_img(
                image,
                self.yolo_model,
                BOX_TRESHOLD=box_threshold,
                output_coord_in_ratio=True,
                ocr_bbox=ocr_bbox,
                draw_bbox_config=draw_bbox_config,
                caption_model_processor=self.caption_model_processor,
                ocr_text=text,
                iou_threshold=iou_threshold,
                imgsz=imgsz,
                use_local_semantics=use_local_semantics
            )

            # Process results like gradio_demo.py (lines 58-61)
            try:
                image_with_labels = Image.open(io.BytesIO(base64.b64decode(dino_labled_img)))
                parsed_content_str = '\n'.join([f'icon {i}: ' + str(v) for i, v in enumerate(parsed_content_list)])
            except Exception as img_error:
                # Continue without image processing if it fails
                parsed_content_str = str(parsed_content_list)

            # Create structured response
            structured_elements = []
            ui_elements = {
                "text_elements": [],
                "interactive_elements": [],
                "icons": [],
                "buttons": [],
                "input_fields": [],
                "images": []
            }

            # Process parsed content list

            for i, element in enumerate(parsed_content_list):
                # Handle different element types
                if isinstance(element, dict):
                    # If element is a dict, extract text content
                    element_text = str(element.get('text', element.get('content', str(element))))
                elif isinstance(element, str):
                    element_text = element
                else:
                    element_text = str(element)

                # Safely get coordinates from dictionary
                coordinates = None
                if isinstance(label_coordinates, dict):
                    # label_coordinates is a dict with string keys like '0', '1', etc.
                    coordinates = label_coordinates.get(str(i), label_coordinates.get(i))

                element_info = {
                    "id": i,
                    "type": "unknown",
                    "text": element_text,
                    "coordinates": coordinates,
                    "raw_element": element  # Keep original for debugging
                }

                # Categorize elements based on content
                element_lower = element_text.lower()
                if any(keyword in element_lower for keyword in ["button", "click", "tap", "press"]):
                    element_info["type"] = "button"
                    ui_elements["buttons"].append(element_info)
                    ui_elements["interactive_elements"].append(element_info)
                elif any(keyword in element_lower for keyword in ["input", "text field", "textbox", "field"]):
                    element_info["type"] = "input_field"
                    ui_elements["input_fields"].append(element_info)
                    ui_elements["interactive_elements"].append(element_info)
                elif any(keyword in element_lower for keyword in ["icon", "logo", "symbol"]):
                    element_info["type"] = "icon"
                    ui_elements["icons"].append(element_info)
                elif any(keyword in element_lower for keyword in ["image", "photo", "picture"]):
                    element_info["type"] = "image"
                    ui_elements["images"].append(element_info)
                else:
                    # Check if it's text content
                    if len(element_text.strip()) > 3 and not element_lower.startswith("icon"):
                        element_info["type"] = "text"
                        ui_elements["text_elements"].append(element_info)

                structured_elements.append(element_info)

            # Create analysis summary
            analysis = f"Screen analysis complete using OmniParser (Apple Vision + YOLO):\n"
            analysis += f"Found {len(structured_elements)} UI elements:\n"
            analysis += f"- {len(ui_elements['interactive_elements'])} interactive elements\n"
            analysis += f"- {len(ui_elements['text_elements'])} text elements\n"
            analysis += f"- {len(ui_elements['buttons'])} buttons\n"
            analysis += f"- {len(ui_elements['input_fields'])} input fields\n"
            analysis += f"- {len(ui_elements['icons'])} icons\n\n"

            # Add OCR text summary
            if text:
                analysis += f"OCR Text detected: {text[:500]}{'...' if len(text) > 500 else ''}\n\n"

            # Add structured element details
            analysis += "Detailed UI Elements:\n"
            for element in structured_elements[:20]:  # Limit to first 20 for readability
                coords = element.get('coordinates', 'N/A')
                analysis += f"- {element['type']}: {element['text']} (coords: {coords})\n"

            if len(structured_elements) > 20:
                analysis += f"... and {len(structured_elements) - 20} more elements\n"

            return {
                "success": True,
                "analysis": analysis,
                "structured_elements": structured_elements,
                "ui_elements": ui_elements,
                "ocr_text": text,
                "total_elements": len(structured_elements),
                "labeled_image": dino_labled_img,  # Base64 encoded labeled image
                "parsed_content": parsed_content_str,  # Raw parsed content like gradio_demo.py
                "model_used": "omniparser"
            }

        except Exception as e:
            return {
                "success": False,
                "error": f"OmniParser analysis failed: {str(e)}",
                "analysis": f"Error during OmniParser analysis: {str(e)}"
            }

    def _take_screenshot(self, window_target: str) -> Optional[bytes]:
        """
        Take screenshot based on target specification.

        Args:
            window_target: "active" for active window, "full" for full screen,
                          or window/app name for specific window

        Returns:
            Screenshot image data as bytes, or None if failed
        """

        try:
            if window_target == "full":
                # Full screen screenshot
                screenshot = pyautogui.screenshot()
                return self._pil_to_bytes(screenshot)

            elif window_target == "active":
                # Active window screenshot
                if not HAS_PYWINCTL:
                    # Fallback to full screen if pywinctl not available
                    print("Warning: pywinctl not available, using full screen")
                    screenshot = pyautogui.screenshot()
                    return self._pil_to_bytes(screenshot)

                try:
                    active_window = pywinctl.getActiveWindow()
                    if active_window:
                        # Get window bounds
                        bbox = (
                            active_window.left,
                            active_window.top,
                            active_window.width,
                            active_window.height
                        )
                        screenshot = pyautogui.screenshot(region=bbox)
                        return self._pil_to_bytes(screenshot)
                    else:
                        print("Warning: No active window found, using full screen")
                        screenshot = pyautogui.screenshot()
                        return self._pil_to_bytes(screenshot)
                except Exception as e:
                    print(f"Warning: Active window capture failed: {e}, using full screen")
                    screenshot = pyautogui.screenshot()
                    return self._pil_to_bytes(screenshot)

            else:
                # Specific window by name
                if not HAS_PYWINCTL:
                    print("Warning: pywinctl required for window targeting, using full screen")
                    screenshot = pyautogui.screenshot()
                    return self._pil_to_bytes(screenshot)

                try:
                    # Find window by title/name (caseSensitive parameter not supported in some pywinctl versions)
                    try:
                        windows = pywinctl.getWindowsWithTitle(window_target, caseSensitive=False)
                    except TypeError:
                        # Fallback for older pywinctl versions
                        windows = pywinctl.getWindowsWithTitle(window_target)

                    if not windows:
                        # Try partial match
                        all_windows = pywinctl.getAllWindows()
                        windows = [w for w in all_windows if window_target.lower() in w.title.lower()]

                    if windows:
                        target_window = windows[0]  # Use first match
                        target_window.activate()  # Bring to front
                        time.sleep(0.5)  # Wait for activation

                        bbox = (
                            target_window.left,
                            target_window.top,
                            target_window.width,
                            target_window.height
                        )
                        screenshot = pyautogui.screenshot(region=bbox)
                        return self._pil_to_bytes(screenshot)
                    else:
                        print(f"Warning: Window '{window_target}' not found, using full screen")
                        screenshot = pyautogui.screenshot()
                        return self._pil_to_bytes(screenshot)
                except Exception as e:
                    print(f"Warning: Window targeting failed: {e}, using full screen")
                    screenshot = pyautogui.screenshot()
                    return self._pil_to_bytes(screenshot)

        except Exception as e:
            print(f"Screenshot capture error: {e}")
            return None

    def _pil_to_bytes(self, pil_image: Image.Image) -> bytes:
        """Convert PIL Image to bytes"""
        buffer = io.BytesIO()
        pil_image.save(buffer, format="PNG")
        return buffer.getvalue()

    def _analyze_with_vision_model(self, image_bytes: bytes, prompt: str, model: str) -> Dict[str, Any]:
        """
        Analyze screenshot using vision model via LM Studio.

        Args:
            image_bytes: Screenshot image data
            prompt: Analysis prompt
            model: Vision model name

        Returns:
            Analysis results from vision model
        """

        if not HAS_REQUESTS:
            return {
                "success": False,
                "error": "Requests library not available",
                "analysis": "Cannot analyze - requests library missing"
            }

        try:
            # Check if image_bytes is actually bytes
            if isinstance(image_bytes, dict):
                # Handle error case where screenshot failed
                error_msg = image_bytes.get('error', 'Screenshot failed')
                return {
                    "success": False,
                    "error": f"Screenshot error: {error_msg}",
                    "analysis": f"Failed to capture screenshot: {error_msg}"
                }

            # Convert image to base64
            image_base64 = base64.b64encode(image_bytes).decode('utf-8')

            # Prepare request for LM Studio
            url = f"{self.lm_studio_url}/chat/completions"

            headers = {
                "Content-Type": "application/json"
            }

            messages = [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/png;base64,{image_base64}"
                            }
                        }
                    ]
                }
            ]

            payload = {
                "model": model,
                "messages": messages,
                "temperature": 0.1,  # Low temperature for consistent analysis
                "max_tokens": 1000   # Sufficient for detailed analysis
            }

            # Make request to LM Studio
            response = requests.post(url, json=payload, headers=headers, timeout=60)

            if response.status_code == 200:
                result = response.json()
                if "choices" in result and len(result["choices"]) > 0:
                    analysis = result["choices"][0]["message"]["content"]
                    return {
                        "success": True,
                        "analysis": analysis,
                        "model": model,
                        "tokens_used": result.get("usage", {}).get("total_tokens", 0),
                        "raw_response": result
                    }
                else:
                    return {
                        "success": False,
                        "error": "No response from vision model",
                        "analysis": "Vision model returned no content"
                    }
            else:
                return {
                    "success": False,
                    "error": f"Vision API error: {response.status_code}",
                    "analysis": f"Vision model error: {response.status_code} - {response.text[:200]}"
                }

        except requests.exceptions.Timeout:
            return {
                "success": False,
                "error": "Vision model request timed out",
                "analysis": "Analysis timed out - model may be busy"
            }
        except Exception as e:
            return {
                "success": False,
                "error": f"Vision analysis failed: {str(e)}",
                "analysis": f"Error during vision analysis: {str(e)}"
            }

    def list_available_windows(self) -> List[Dict[str, Any]]:
        """
        List all available windows for targeting.

        Returns:
            List of window information dictionaries
        """
        if not HAS_PYWINCTL:
            return [{"error": "pywinctl not available for window listing"}]

        try:
            windows = pywinctl.getAllWindows()
            window_info = []

            for window in windows:
                if window.title:  # Only include windows with titles
                    window_info.append({
                        "title": window.title,
                        "size": f"{window.width}x{window.height}",
                        "position": f"{window.left},{window.top}",
                        "is_active": window.isActive
                    })

            return window_info

        except Exception as e:
            return [{"error": f"Failed to list windows: {str(e)}"}]

    def get_system_info(self) -> Dict[str, Any]:
        """
        Get system information for debugging and compatibility.

        Returns:
            System information dictionary
        """
        info = {
            "platform": platform.system(),
            "platform_version": platform.version(),
            "python_version": platform.python_version(),
            "has_pywinctl": HAS_PYWINCTL,
            "has_screeninfo": HAS_SCREENINFO,
            "has_requests": HAS_REQUESTS,
            "has_omniparser": HAS_OMNIPARSER,
            "omniparser_loaded": self._omniparser_loaded,
            "lm_studio_url": self.lm_studio_url,
            "vision_model": self.vision_model,
            "fallback_model": self.fallback_model
        }

        # Add screen info if available
        if HAS_SCREENINFO:
            try:
                monitors = screeninfo.get_monitors()
                info["screens"] = [
                    {
                        "name": monitor.name,
                        "resolution": f"{monitor.width}x{monitor.height}",
                        "position": f"{monitor.x},{monitor.y}"
                    }
                    for monitor in monitors
                ]
            except Exception as e:
                info["screens_error"] = str(e)

        return info


# Convenience function for agent use
def analyze_screenshot(
    prompt: str = "Analyze this screenshot and determine if the task was completed successfully. Provide a detailed explanation of what you see and whether the expected outcome was achieved.",
    window: str = "active",
    model: str = "omniparser"
) -> str:
    """
    Simple agent interface for screenshot analysis.

    This is the main function agents should use for screenshot analysis.
    Uses OmniParser by default with InternVL fallback for structured UI analysis.

    Args:
        prompt: Analysis prompt for the vision model (optional).
                NOTE: Only used when falling back to InternVL. OmniParser provides
                structured analysis and ignores custom prompts.
        window: Window target - "active" for active window, "full" for full screen,
               or specific window/app name (optional, defaults to "active")
        model: Vision model to use (optional, defaults to "omniparser")

    Returns:
        Analysis result as string - contains structured UI analysis with element breakdown
        and whether the task was completed successfully

    Examples:
        # Analyze active window with OmniParser (structured analysis)
        result = analyze_screenshot()

        # Analyze specific window
        result = analyze_screenshot(window="Chrome")

        # Custom analysis prompt (only used with InternVL fallback)
        result = analyze_screenshot(
            prompt="Check if the login form is filled correctly and submit button is visible",
            model="internvl3_5-2b"  # Force InternVL to use custom prompt
        )

        # Full screen analysis
        result = analyze_screenshot(window="full")
    """

    analyzer = ScreenshotAnalyzer()
    result = analyzer.take_and_analyze_screenshot(
        prompt=prompt,
        window_target=window,
        model=model
    )

    if result["success"]:
        return result["analysis"]
    else:
        return f"Analysis failed: {result.get('error', 'Unknown error')}"


# Agent-friendly alias
def screenshot_analysis(
    prompt: str = "Analyze this screenshot and determine if the task was completed successfully. Provide a detailed explanation of what you see and whether the expected outcome was achieved.",
    window: str = "active",
    model: str = "omniparser"
) -> str:
    """
    Alias for analyze_screenshot - same functionality with a more descriptive name.
    Uses OmniParser for structured UI element analysis (custom prompts ignored).
    """
    return analyze_screenshot(prompt=prompt, window=window, model=model)


# Export the main classes and functions
__all__ = ["ScreenshotAnalyzer", "analyze_screenshot", "screenshot_analysis"]
