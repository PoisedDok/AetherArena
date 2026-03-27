#!/bin/bash
# AGGRESSIVE stress test: simultaneous operations, edge cases

SAMPLE_DIR="/Volumes/Disk-D/Aether/Aether/AetherArena/sample"

echo "🔥 AGGRESSIVE STRESS TEST: Simultaneous operations..."

# Test 1: Create multiple NEW files simultaneously (parallel processes)
(
  cat > "$SAMPLE_DIR/bug_report_001.md" << 'EOF'
# BUG: OAuth token refresh broken
Users report frequent logouts every 30 minutes
EOF
) &

(
  cat > "$SAMPLE_DIR/bug_report_002.md" << 'EOF'
# BUG: Session timeout too aggressive
Multiple complaints about losing work
EOF
) &

(
  cat > "$SAMPLE_DIR/security_audit.txt" << 'EOF'
Security Issue: Token expiration causing UX problems
Need to review authentication flow
EOF
) &

(
  cat > "$SAMPLE_DIR/user_feedback.txt" << 'EOF'
User Complaint: Getting logged out constantly
Frustrating authentication experience
EOF
) &

wait # Wait for all parallel creates

sleep 0.5

# Test 2: Rapid modifications to existing files
for i in {1..5}; do
  echo "# Iteration $i: still debugging OAuth issue" >> "$SAMPLE_DIR/bug_report_001.md"
  sleep 0.1
done

sleep 0.5

# Test 3: Create-delete-recreate scenario (edge case)
cat > "$SAMPLE_DIR/temp_debug.log" << 'EOF'
Debug: investigating token lifetime issue
EOF
sleep 0.2
rm -f "$SAMPLE_DIR/temp_debug.log"
sleep 0.2
cat > "$SAMPLE_DIR/temp_debug.log" << 'EOF'
Debug: found root cause - token expiry misconfigured
EOF

sleep 0.5

# Test 4: Create many small files rapidly
for i in {1..8}; do
  cat > "$SAMPLE_DIR/note_$i.txt" << EOF
Note $i: OAuth investigation progress
Found issue in token refresh logic
EOF
  sleep 0.05
done

echo "✅ Aggressive stress test complete"
