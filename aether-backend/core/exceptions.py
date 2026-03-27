"""
Domain Exceptions - Core Layer

@.architecture
Incoming: All layers --- {Exception}
Processing: Defines core domain exceptions for uniform error handling --- {JOB_ERROR_DEFINITION}
Outgoing: All layers --- {Exception}
"""

class DomainException(Exception):
    """Base exception for all custom domain errors."""
    pass

class NetworkTimeoutError(DomainException):
    """Raised when an upstream service or network call times out."""
    def __init__(self, message: str = "Network request timed out"):
        self.message = message
        super().__init__(self.message)

class UpstreamServiceError(DomainException):
    """Raised when an upstream service returns a non-success HTTP status or invalid data."""
    def __init__(self, message: str = "Upstream service error", status_code: int = 502):
        self.message = message
        self.status_code = status_code
        super().__init__(self.message)

class InvalidRequestError(DomainException):
    """Raised when a request payload is invalid."""
    def __init__(self, message: str = "Invalid request"):
        self.message = message
        self.status_code = 400
        super().__init__(self.message)

class ResourceNotFoundError(DomainException):
    """Raised when a requested resource is not found."""
    def __init__(self, message: str = "Resource not found"):
        self.message = message
        self.status_code = 404
        super().__init__(self.message)

class NetworkConnectionError(DomainException):
    """Raised when an underlying connection error occurs."""
    def __init__(self, message: str = "Failed to connect to upstream service"):
        self.message = message
        super().__init__(self.message)

class DaemonControlError(DomainException):
    """Raised when a daemon fails to start, stop, or reload."""
    pass

class ProcessLookupDomainError(DaemonControlError):
    """Raised when a requested process PID cannot be found."""
    pass

class PermissionDomainError(DaemonControlError):
    """Raised when the process lacks permission to control a daemon or process."""
    pass
