"""
Terminal Service - Application Layer

@.architecture
Incoming: api/v1/endpoints/terminal.py --- {launch request}
Processing: enforce security configuration, orchestrate OS process gateway --- {JOB_EXECUTE}
Outgoing: core/system/process_gateway.py --- {launch OS terminal}
"""

import logging
from core.exceptions import DomainException
from core.system.interfaces import IProcessGateway
from core.system.models import TerminalInfo

logger = logging.getLogger(__name__)


class TerminalServiceDisabledError(DomainException):
    """Exception raised when terminal launch is disabled by configuration."""
    def __init__(self, message="Terminal launch disabled by configuration"):
        self.message = message
        self.error_code = "TERMINAL_DISABLED"
        super().__init__(self.message)


class TerminalService:
    """
    Application service for launching terminal applications.
    Encapsulates business rules regarding security settings and coordinates with the infrastructure gateway.
    """
    
    def __init__(self, gateway: IProcessGateway, allow_local_os_tools: bool):
        """
        Initialize TerminalService.
        
        Args:
            gateway: OS process gateway for launching applications.
            allow_local_os_tools: Security flag determining if local tools can be launched.
        """
        self._gateway = gateway
        self._allow_local_os_tools = allow_local_os_tools

    def launch_terminal(self) -> TerminalInfo:
        """
        Launch the local OS terminal if permitted by security settings.
        
        Returns:
            TerminalInfo containing launch status and terminal type.
            
        Raises:
            TerminalServiceDisabledError: If terminal launch is disabled by security configuration.
        """
        if not self._allow_local_os_tools:
            logger.warning("Terminal launch requested but denied by security configuration.")
            raise TerminalServiceDisabledError()
            
        return self._gateway.launch_terminal(self._allow_local_os_tools)
