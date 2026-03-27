#!/bin/bash
# Stress test: rapid file changes

SAMPLE_DIR="/Volumes/Disk-D/Aether/Aether/AetherArena/sample"

echo "🔥 STRESS TEST: Creating 10 rapid file changes..."

# Change 1: Create file with auth error
cat > "$SAMPLE_DIR/auth_service.py" << 'EOF'
# OAuth2 authentication service
def login():
    # ERROR: token validation failing
    pass
EOF
sleep 0.2

# Change 2: Modify with debugging
cat > "$SAMPLE_DIR/auth_service.py" << 'EOF'
# OAuth2 authentication service
def login():
    # ERROR: token validation failing
    # Added debug logging
    print("Debug: checking token")
    pass
EOF
sleep 0.2

# Change 3: Add error handling
cat > "$SAMPLE_DIR/auth_service.py" << 'EOF'
# OAuth2 authentication service
def login():
    # ERROR: token validation failing
    # Added debug logging
    try:
        print("Debug: checking token")
        validate_token()
    except Exception as e:
        print(f"Token error: {e}")
EOF
sleep 0.2

# Change 4: Create database migration file
cat > "$SAMPLE_DIR/migration_001.sql" << 'EOF'
-- Migration: Add user sessions table
CREATE TABLE user_sessions (
    id INT PRIMARY KEY,
    user_id INT,
    token TEXT,
    expires_at TIMESTAMP
);
EOF
sleep 0.2

# Change 5: Update migration
cat > "$SAMPLE_DIR/migration_001.sql" << 'EOF'
-- Migration: Add user sessions table
-- BUG: expires_at should be NOT NULL
CREATE TABLE user_sessions (
    id INT PRIMARY KEY,
    user_id INT,
    token TEXT NOT NULL,
    expires_at TIMESTAMP NOT NULL
);
EOF
sleep 0.2

# Change 6: Create API endpoint
cat > "$SAMPLE_DIR/api_endpoint.py" << 'EOF'
# API endpoint for refresh token
def refresh_token():
    # TODO: implement token refresh logic
    return {"error": "not implemented"}
EOF
sleep 0.2

# Change 7: Implement refresh logic
cat > "$SAMPLE_DIR/api_endpoint.py" << 'EOF'
# API endpoint for refresh token
def refresh_token(old_token):
    # BUG: refresh tokens keep expiring too fast
    new_token = generate_token(old_token)
    return {"token": new_token}
EOF
sleep 0.2

# Change 8: Add config file
cat > "$SAMPLE_DIR/config.yaml" << 'EOF'
auth:
  token_lifetime: 3600
  refresh_lifetime: 86400
  # ISSUE: users complaining about frequent re-login
EOF
sleep 0.2

# Change 9: Update config
cat > "$SAMPLE_DIR/config.yaml" << 'EOF'
auth:
  token_lifetime: 7200  # Increased from 3600
  refresh_lifetime: 86400
  # Trying to fix frequent re-login issue
  # Users report OAuth flow breaking after 1 hour
EOF
sleep 0.2

# Change 10: Create test file
cat > "$SAMPLE_DIR/test_auth.py" << 'EOF'
# Tests for authentication
# All tests failing with token expiration errors
def test_login():
    # FAILING: tokens expire during test execution
    assert False, "token expired"
EOF

echo "✅ Created 10 rapid file changes"
