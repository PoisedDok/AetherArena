#!/bin/bash
# COMPREHENSIVE MULTI-SOURCE TEST
# Tests: Normal → Aggressive → Race Conditions

SAMPLE_DIR="/Volumes/Disk-D/Aether/Aether/AetherArena/sample"
TEST_LOG="/tmp/comprehensive_test.log"

echo "🧪 COMPREHENSIVE PROACTIVE QUERY GENERATION TEST" | tee $TEST_LOG
echo "=================================================" | tee -a $TEST_LOG
echo "Testing: Filesystem + Browser (simulated) + Email (simulated)" | tee -a $TEST_LOG
echo "" | tee -a $TEST_LOG

# ============================================================================
# PHASE 1: NORMAL OPERATIONS (Sequential, clear patterns)
# ============================================================================
echo "📍 PHASE 1: NORMAL OPERATIONS (Sequential)" | tee -a $TEST_LOG
echo "-------------------------------------------" | tee -a $TEST_LOG
sleep 2

# File 1: User starts debugging OAuth
cat > "$SAMPLE_DIR/oauth_debug_notes.md" << 'EOF'
# OAuth Debugging Session

## Problem
Users getting logged out every 30 minutes
Token refresh seems broken

## Investigation
- Checked token expiration settings
- Current lifetime: 1800 seconds (30 min)
- Need to investigate refresh flow
EOF
echo "✓ Created oauth_debug_notes.md" | tee -a $TEST_LOG
sleep 3

# File 2: User creates config file
cat > "$SAMPLE_DIR/auth_config.yaml" << 'EOF'
# Authentication Configuration
oauth:
  token_lifetime: 1800  # 30 minutes - seems too short
  refresh_lifetime: 86400  # 24 hours
  
  # TODO: Test increasing token lifetime
  # Users complaining about frequent re-auth
EOF
echo "✓ Created auth_config.yaml" | tee -a $TEST_LOG
sleep 3

# File 3: User implements fix attempt
cat > "$SAMPLE_DIR/token_refresh_fix.py" << 'EOF'
# Token refresh implementation fix
import time

def refresh_access_token(refresh_token):
    """
    Fix for token refresh issue
    Increasing token lifetime from 1800 to 7200 seconds
    """
    new_lifetime = 7200  # 2 hours instead of 30 min
    
    # Generate new token with extended lifetime
    new_token = generate_token(refresh_token, lifetime=new_lifetime)
    
    return new_token

# Testing with new lifetime
print("Testing extended token lifetime...")
EOF
echo "✓ Created token_refresh_fix.py" | tee -a $TEST_LOG
sleep 3

echo "" | tee -a $TEST_LOG
echo "⏸️  Waiting 8s for Phase 1 processing..." | tee -a $TEST_LOG
sleep 8

# ============================================================================
# PHASE 2: AGGRESSIVE OPERATIONS (Rapid, parallel)
# ============================================================================
echo "" | tee -a $TEST_LOG
echo "📍 PHASE 2: AGGRESSIVE OPERATIONS (Rapid + Parallel)" | tee -a $TEST_LOG
echo "----------------------------------------------------" | tee -a $TEST_LOG
sleep 2

# Create multiple files in parallel
echo "Creating 6 files in parallel..." | tee -a $TEST_LOG
(cat > "$SAMPLE_DIR/test_auth_001.py" << 'EOF'
# Test case 1: Basic token validation
assert validate_token(token) == True
EOF
) &

(cat > "$SAMPLE_DIR/test_auth_002.py" << 'EOF'
# Test case 2: Token expiration
assert is_token_expired(old_token) == True
EOF
) &

(cat > "$SAMPLE_DIR/test_auth_003.py" << 'EOF'
# Test case 3: Refresh token flow
new_token = refresh_token(refresh_token)
assert new_token != None
EOF
) &

(cat > "$SAMPLE_DIR/bug_report.md" << 'EOF'
# BUG REPORT: Authentication Issues

**Priority**: HIGH
**Affected Users**: 50+

## Symptoms
- Users logged out after 30 minutes
- Refresh token not working
- Error: "Token expired" appearing prematurely
EOF
) &

(cat > "$SAMPLE_DIR/user_feedback.txt" << 'EOF'
Multiple user complaints about authentication:
- "Getting logged out constantly"
- "Can't stay logged in for more than 30 minutes"
- "Very frustrating experience"
EOF
) &

(cat > "$SAMPLE_DIR/security_review.txt" << 'EOF'
Security Review: OAuth Token Configuration

Current Issues:
- Token lifetime too aggressive (30 min)
- Causing poor user experience
- Need balance between security and usability

Recommendation: Increase to 2 hours
EOF
) &

wait
echo "✓ Created 6 files simultaneously" | tee -a $TEST_LOG
sleep 2

# Rapid sequential edits (stress test)
echo "Performing 5 rapid edits..." | tee -a $TEST_LOG
for i in {1..5}; do
  echo "# Edit iteration $i: Still investigating OAuth token issues" >> "$SAMPLE_DIR/oauth_debug_notes.md"
  sleep 0.3
done
echo "✓ Completed rapid edits" | tee -a $TEST_LOG
sleep 3

echo "" | tee -a $TEST_LOG
echo "⏸️  Waiting 12s for Phase 2 processing..." | tee -a $TEST_LOG
sleep 12

# ============================================================================
# PHASE 3: RACE CONDITIONS (Edge cases)
# ============================================================================
echo "" | tee -a $TEST_LOG
echo "📍 PHASE 3: RACE CONDITIONS & EDGE CASES" | tee -a $TEST_LOG
echo "----------------------------------------" | tee -a $TEST_LOG
sleep 2

# Test 1: Create-Delete-Recreate (edge case)
echo "Test: Create-Delete-Recreate" | tee -a $TEST_LOG
cat > "$SAMPLE_DIR/temp_investigation.log" << 'EOF'
Temporary debug log: investigating token refresh
EOF
sleep 0.5
rm -f "$SAMPLE_DIR/temp_investigation.log"
sleep 0.5
cat > "$SAMPLE_DIR/temp_investigation.log" << 'EOF'
Debug log recreated: Found root cause - token expiry misconfigured
Solution: Increase token lifetime to 7200 seconds
EOF
echo "✓ Create-Delete-Recreate test" | tee -a $TEST_LOG
sleep 2

# Test 2: Simultaneous file modifications
echo "Test: Simultaneous modifications to same context" | tee -a $TEST_LOG
(echo "# Update from thread 1: Testing fix" >> "$SAMPLE_DIR/token_refresh_fix.py") &
(echo "# Additional test case" >> "$SAMPLE_DIR/test_auth_001.py") &
(echo "## Status: INVESTIGATING" >> "$SAMPLE_DIR/bug_report.md") &
wait
echo "✓ Simultaneous modifications" | tee -a $TEST_LOG
sleep 2

# Test 3: Very rapid burst (10 files in <1 second)
echo "Test: Rapid burst (10 files < 1s)" | tee -a $TEST_LOG
for i in {1..10}; do
  cat > "$SAMPLE_DIR/rapid_test_$i.txt" << EOF
Rapid test file $i: OAuth token debugging in progress
Testing token refresh mechanism with extended lifetime
EOF
done
echo "✓ Rapid burst completed" | tee -a $TEST_LOG
sleep 3

echo "" | tee -a $TEST_LOG
echo "⏸️  Waiting 15s for Phase 3 processing..." | tee -a $TEST_LOG
sleep 15

# ============================================================================
# TEST COMPLETE
# ============================================================================
echo "" | tee -a $TEST_LOG
echo "✅ TEST COMPLETE!" | tee -a $TEST_LOG
echo "=================================================" | tee -a $TEST_LOG
echo "" | tee -a $TEST_LOG
echo "Summary:" | tee -a $TEST_LOG
echo "- Phase 1: 3 files (normal sequential pattern)" | tee -a $TEST_LOG
echo "- Phase 2: 6 parallel + 5 rapid edits (aggressive)" | tee -a $TEST_LOG
echo "- Phase 3: 14 files + edge cases (race conditions)" | tee -a $TEST_LOG
echo "- Total: ~30+ file operations" | tee -a $TEST_LOG
echo "" | tee -a $TEST_LOG
echo "Check LLM responses in: /tmp/llm_responses.log" | tee -a $TEST_LOG
echo "Check daemon logs for detailed processing" | tee -a $TEST_LOG
