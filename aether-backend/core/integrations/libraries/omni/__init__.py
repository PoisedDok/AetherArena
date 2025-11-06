"""
OmniParser Integration - Layer 2 Exposure

Exports Omni vision and document parsing tools.
"""

from .tools import (
    OmniParalegalTools,
    omni_screenshot,
    omni_analyze_screen,
    omni_parse_document,
    omni_multi_ocr_parse,
    omni_find_and_parse_documents,
    omni_workflows
)

__all__ = [
    'OmniParalegalTools',
    'omni_screenshot',
    'omni_analyze_screen',
    'omni_parse_document',
    'omni_multi_ocr_parse',
    'omni_find_and_parse_documents',
    'omni_workflows'
]

