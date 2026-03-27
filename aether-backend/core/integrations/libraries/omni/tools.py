"""
Omni Screen Tools - Layer 1 Implementation

Provides screenshot capture + screen analysis tools for agent consumption.

Features:
- Screenshot capture and analysis
- Screen analysis via vision models
- Workflow templates

Production-ready with:
- Error handling
- Vision model integration fallback

@.architecture
Incoming: api/v1/endpoints/omni.py, Open Interpreter computer --- {str save_path, str prompt}
Processing: screenshot(), analyze_screen(), workflows() --- {JOB_IO_SCREENSHOT, JOB_VISION_ANALYZE, JOB_TEMPLATE_LIST}
Outgoing: api/v1/endpoints/omni.py --- {Dict[str, Any] screenshot data, Dict[str, Any] analysis result}
"""

import base64
import io
import logging
import threading
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


class OmniParalegalTools:
    """
    High-level utilities for screen capture and screen analysis.
    
    Integrates with Open Interpreter computer instance for full capabilities.
    """
    
    def __init__(self, computer: Any):
        """
        Initialize Omni tools with computer instance.
        
        Args:
            computer: Open Interpreter computer instance
        """
        self._computer = computer
        self._lock = threading.RLock()
        logger.debug("Initialized OmniParalegalTools")
    
    def screenshot(self, save_path: Optional[str] = None) -> Dict[str, Any]:
        """
        Capture screenshot of current screen.
        
        Args:
            save_path: Optional path to save screenshot
            
        Returns:
            Dict with:
                - success: bool
                - path: str (if saved)
                - base64: str (if not saved)
                - error: str (if failed)
        """
        try:
            # Try using computer.display.screenshot if available
            if hasattr(self._computer, 'display') and hasattr(self._computer.display, 'screenshot'):
                result = self._computer.display.screenshot()
                
                if save_path:
                    # Save to file
                    from PIL import Image
                    img = Image.frombytes('RGB', result['size'], result['data'])
                    img.save(save_path)
                    logger.info("Screenshot saved to %s", save_path)
                    return {"success": True, "path": save_path}
                else:
                    # Return base64
                    buffer = io.BytesIO()
                    from PIL import Image
                    img = Image.frombytes('RGB', result['size'], result['data'])
                    img.save(buffer, format='PNG')
                    base64_data = base64.b64encode(buffer.getvalue()).decode()
                    return {"success": True, "base64": base64_data}
            else:
                # Fallback to platform-specific screenshot
                try:
                    from PIL import ImageGrab
                    img = ImageGrab.grab()
                    
                    if save_path:
                        img.save(save_path)
                        logger.info("Screenshot saved to %s", save_path)
                        return {"success": True, "path": save_path}
                    else:
                        buffer = io.BytesIO()
                        img.save(buffer, format='PNG')
                        base64_data = base64.b64encode(buffer.getvalue()).decode()
                        return {"success": True, "base64": base64_data}
                except ImportError:
                    return {"success": False, "error": "PIL/Pillow not available for screenshot"}
                    
        except Exception as e:
            error_msg = f"Screenshot failed: {str(e)}"
            logger.error(error_msg)
            return {"success": False, "error": error_msg}
    
    def analyze_screen(self, prompt: str = "Describe this screen.") -> Dict[str, Any]:
        """
        Analyze current screen using vision model.
        
        Args:
            prompt: Analysis prompt
            
        Returns:
            Dict with:
                - success: bool
                - analysis: str
                - error: str (if failed)
        """
        try:
            # Capture screenshot
            screenshot_result = self.screenshot()
            
            if not screenshot_result.get("success"):
                return {"success": False, "error": "Screenshot capture failed"}
            
            # Get base64 image
            base64_image = screenshot_result.get("base64")
            if not base64_image:
                return {"success": False, "error": "No image data"}
            
            # Try using vision agent if available
            if hasattr(self._computer, 'agents') and hasattr(self._computer.agents, 'vision'):
                analysis = self._computer.agents.vision.analyze(base64_image, prompt)
                logger.info("Screen analysis completed")
                return {"success": True, "analysis": analysis}
            else:
                # Fallback: use LLM with vision capability if available
                return {
                    "success": False,
                    "error": "Vision analysis not available. Requires vision agent or VLM."
                }
                
        except Exception as e:
            error_msg = f"Screen analysis failed: {str(e)}"
            logger.error(error_msg)
            return {"success": False, "error": error_msg}
    
    def workflows(self) -> Dict[str, Any]:
        """
        Get available paralegal workflows with examples.
        
        Returns:
            Dict with workflow templates
        """
        return {
            "screen_capture_analysis": {
                "description": "Capture and analyze screen content",
                "steps": [
                    "1. Capture current screen",
                    "2. Analyze with vision model",
                    "3. Extract relevant information",
                    "4. Return structured data"
                ],
                "example": "analyze_screen(prompt='Extract form fields from this screen')"
            },
        }


# Convenience wrapper functions for direct use

def omni_screenshot(save_path: Optional[str] = None) -> Dict[str, Any]:
    """
    Capture screenshot (convenience wrapper).
    
    Args:
        save_path: Optional path to save screenshot
        
    Returns:
        Dict with screenshot data
    """
    # This will be replaced by IntegrationLoader with proper computer instance
    return {"error": "Omni integration not loaded. Use via computer.omni.screenshot()"}


def omni_analyze_screen(prompt: str = "Describe this screen.") -> Dict[str, Any]:
    """
    Analyze screen (convenience wrapper).
    
    Args:
        prompt: Analysis prompt
        
    Returns:
        Dict with analysis
    """
    return {"error": "Omni integration not loaded. Use via computer.omni.analyze_screen()"}


def omni_workflows() -> Dict[str, Any]:
    """Get workflows (convenience wrapper)."""
    # This one can work without computer instance
    tools = OmniParalegalTools(None)
    return tools.workflows()

