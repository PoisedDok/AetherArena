#!/usr/bin/env python3
"""
TTS Integration Testing Script

Tests RealtimeTTS integration and API endpoints.
"""

import httpx
import json
import sys
from pathlib import Path

BASE_URL = "http://127.0.0.1:5002"
TIMEOUT = 60.0

class Colors:
    GREEN = '\033[92m'
    RED = '\033[91m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    RESET = '\033[0m'

def test_tts_health():
    """Test TTS health endpoint."""
    print(f"\n{Colors.BLUE}Testing TTS Health...{Colors.RESET}")
    
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            response = client.get(f"{BASE_URL}/v1/tts/health")
            print(f"Status: {response.status_code}")
            data = response.json()
            print(f"Response: {json.dumps(data, indent=2)}")
            
            if response.status_code == 200:
                print(f"{Colors.GREEN}✓ TTS Health Check Passed{Colors.RESET}")
                return True
            else:
                print(f"{Colors.RED}✗ TTS Health Check Failed{Colors.RESET}")
                return False
    except Exception as e:
        print(f"{Colors.RED}✗ Error: {e}{Colors.RESET}")
        return False

def test_list_engines():
    """Test listing TTS engines."""
    print(f"\n{Colors.BLUE}Testing List TTS Engines...{Colors.RESET}")
    
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            response = client.get(f"{BASE_URL}/v1/tts/engines")
            print(f"Status: {response.status_code}")
            data = response.json()
            print(f"Response: {json.dumps(data, indent=2)}")
            
            if response.status_code == 200 and "engines" in data:
                print(f"{Colors.GREEN}✓ List Engines Passed{Colors.RESET}")
                print(f"Available Engines: {', '.join(data['engines'])}")
                return True, data['engines']
            else:
                print(f"{Colors.RED}✗ List Engines Failed{Colors.RESET}")
                return False, []
    except Exception as e:
        print(f"{Colors.RED}✗ Error: {e}{Colors.RESET}")
        return False, []

def test_initialize_engine(engine="system"):
    """Test initializing TTS engine."""
    print(f"\n{Colors.BLUE}Testing Initialize {engine} Engine...{Colors.RESET}")
    
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            response = client.post(
                f"{BASE_URL}/v1/tts/initialize",
                json={"engine": engine}
            )
            print(f"Status: {response.status_code}")
            data = response.json()
            print(f"Response: {json.dumps(data, indent=2)}")
            
            if response.status_code == 200:
                print(f"{Colors.GREEN}✓ Initialize Engine Passed{Colors.RESET}")
                return True
            else:
                print(f"{Colors.RED}✗ Initialize Engine Failed{Colors.RESET}")
                return False
    except Exception as e:
        print(f"{Colors.RED}✗ Error: {e}{Colors.RESET}")
        return False

def test_synthesize_text(engine="system", save_file=False):
    """Test text-to-speech synthesis."""
    print(f"\n{Colors.BLUE}Testing Text Synthesis with {engine}...{Colors.RESET}")
    
    test_text = "Hello, this is a test of the text to speech integration in Aether Backend."
    
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            response = client.post(
                f"{BASE_URL}/v1/tts/synthesize",
                json={
                    "text": test_text,
                    "engine": engine
                }
            )
            print(f"Status: {response.status_code}")
            
            if response.status_code == 200:
                audio_size = len(response.content)
                print(f"Audio Size: {audio_size} bytes")
                print(f"Content-Type: {response.headers.get('content-type')}")
                
                if save_file:
                    output_file = Path(f"/tmp/tts_test_{engine}.wav")
                    output_file.write_bytes(response.content)
                    print(f"Saved to: {output_file}")
                
                print(f"{Colors.GREEN}✓ Synthesis Passed{Colors.RESET}")
                return True
            else:
                print(f"Error: {response.text}")
                print(f"{Colors.RED}✗ Synthesis Failed{Colors.RESET}")
                return False
    except Exception as e:
        print(f"{Colors.RED}✗ Error: {e}{Colors.RESET}")
        return False

def test_stream_synthesis(engine="system"):
    """Test streaming TTS synthesis."""
    print(f"\n{Colors.BLUE}Testing Streaming Synthesis with {engine}...{Colors.RESET}")
    
    test_text = "This is a streaming test."
    
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            with client.stream(
                "POST",
                f"{BASE_URL}/v1/tts/stream",
                json={
                    "text": test_text,
                    "engine": engine
                }
            ) as response:
                print(f"Status: {response.status_code}")
                
                if response.status_code == 200:
                    total_size = 0
                    chunk_count = 0
                    
                    for chunk in response.iter_bytes():
                        total_size += len(chunk)
                        chunk_count += 1
                    
                    print(f"Received {chunk_count} chunks, total {total_size} bytes")
                    print(f"{Colors.GREEN}✓ Streaming Passed{Colors.RESET}")
                    return True
                else:
                    print(f"{Colors.RED}✗ Streaming Failed{Colors.RESET}")
                    return False
    except Exception as e:
        print(f"{Colors.RED}✗ Error: {e}{Colors.RESET}")
        return False

def main():
    """Run all TTS tests."""
    print(f"{Colors.BLUE}{'='*80}{Colors.RESET}")
    print(f"{Colors.BLUE}RealtimeTTS Integration Testing{Colors.RESET}")
    print(f"{Colors.BLUE}{'='*80}{Colors.RESET}")
    print(f"Base URL: {BASE_URL}")
    
    results = {}
    
    # Test 1: Health Check
    results['health'] = test_tts_health()
    
    # Test 2: List Engines
    success, engines = test_list_engines()
    results['list_engines'] = success
    
    if not engines:
        print(f"\n{Colors.YELLOW}⚠ No engines available, cannot proceed with synthesis tests{Colors.RESET}")
        engines = ["system"]  # Try system as fallback
    
    # Test 3: Initialize Engine
    for engine in engines[:2]:  # Test first 2 engines
        results[f'init_{engine}'] = test_initialize_engine(engine)
    
    # Test 4: Synthesize Text
    for engine in engines[:2]:
        results[f'synth_{engine}'] = test_synthesize_text(engine, save_file=True)
    
    # Test 5: Stream Synthesis
    results['stream'] = test_stream_synthesis(engines[0] if engines else "system")
    
    # Summary
    print(f"\n{Colors.BLUE}{'='*80}{Colors.RESET}")
    print(f"{Colors.BLUE}Test Summary{Colors.RESET}")
    print(f"{Colors.BLUE}{'='*80}{Colors.RESET}")
    
    passed = sum(1 for v in results.values() if v)
    total = len(results)
    
    for test, result in results.items():
        status = f"{Colors.GREEN}PASS{Colors.RESET}" if result else f"{Colors.RED}FAIL{Colors.RESET}"
        print(f"{status} | {test}")
    
    print(f"\nTotal: {passed}/{total} passed ({passed/total*100:.1f}%)")
    
    if passed == total:
        print(f"\n{Colors.GREEN}✓ All tests passed!{Colors.RESET}")
        sys.exit(0)
    else:
        print(f"\n{Colors.RED}✗ Some tests failed{Colors.RESET}")
        sys.exit(1)

if __name__ == "__main__":
    main()


