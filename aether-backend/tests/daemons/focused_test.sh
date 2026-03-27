#!/bin/bash
# Focused test: clear pattern for LLM analysis

SAMPLE_DIR="/Volumes/Disk-D/Aether/Aether/AetherArena/sample"

echo "🔬 FOCUSED TEST: Creating clear OAuth debugging pattern..."

# Create 3 files showing clear debugging pattern
cat > "$SAMPLE_DIR/auth_error.txt" << 'EOF'
ERROR: OAuth token refresh failing constantly
Users being logged out every 30 minutes
Need to investigate token expiration settings
EOF

sleep 1

cat > "$SAMPLE_DIR/config_review.yaml" << 'EOF'
# Token configuration review
token_lifetime: 1800  # 30 minutes - too short?
refresh_lifetime: 3600
# TODO: Increase token lifetime to prevent frequent logouts
EOF

sleep 1

cat > "$SAMPLE_DIR/fix_attempt.py" << 'EOF'
# Attempting to fix OAuth token refresh issue
def refresh_token(user_id):
    # Increasing token lifetime from 1800 to 7200 seconds
    new_token = generate_token(user_id, lifetime=7200)
    return new_token
EOF

echo "✅ Created 3 files with clear OAuth debugging pattern"
