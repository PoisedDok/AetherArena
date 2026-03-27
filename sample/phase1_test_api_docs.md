# API Endpoint Documentation

## Authentication Endpoints

### POST /api/auth/login
Authenticate user and return JWT tokens.

**Request:**
```json
{
  "email": "user@example.com",
  "password": "secure_password"
}
```

**Response:**
```json
{
  "access_token": "eyJ...",
  "refresh_token": "eyJ...",
  "expires_in": 900
}
```

### POST /api/auth/refresh
Refresh access token using refresh token.

**Headers:**
- Authorization: Bearer {refresh_token}

**Response:**
```json
{
  "access_token": "eyJ...",
  "expires_in": 900
}
```
