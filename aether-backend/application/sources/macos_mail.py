"""
macOS Mail.app email reader using AppleScript.

@.architecture
Incoming: Daemon requests --- {max_items: int}
Processing: Execute AppleScript to query Mail.app, parse results --- {JOB_EXECUTE_SCRIPT, JOB_PARSE_EMAIL}
Outgoing: Email daemon --- {List[Dict] email data}
"""
import subprocess
import logging
from typing import List, Dict, Any
from datetime import datetime

logger = logging.getLogger(__name__)


def get_recent_emails_via_applescript(max_items: int = 100, hours_back: int = 24) -> List[Dict[str, Any]]:
    """
    Get recent emails from macOS Mail.app using AppleScript.
    
    Args:
        max_items: Maximum number of emails to retrieve
        hours_back: How many hours back to fetch (default: 24)
    
    Returns:
        List of email dictionaries with subject, sender, date, content
    """
    # Calculate cutoff date for recent emails
    from datetime import timedelta
    cutoff_date = datetime.now() - timedelta(hours=hours_back)
    cutoff_str = cutoff_date.strftime("%Y-%m-%d %H:%M:%S")
    
    applescript = f'''
    tell application "Mail"
        set allMessages to {{}}
        
        -- Calculate cutoff date (only fetch last {hours_back} hours)
        set cutoffDate to current date
        set cutoffDate to cutoffDate - ({hours_back} * hours)
        
        -- Check all accounts' inboxes
        try
            repeat with acc in accounts
                try
                    -- Find inbox by iterating mailboxes (correct syntax for Mail.app)
                    repeat with mbox in mailboxes of acc
                        if name of mbox is "INBOX" or name of mbox is "Inbox" then
                            try
                                -- CRITICAL FIX: Filter by date BEFORE loading into memory
                                -- Get only messages received after cutoff (sorted by date, newest first)
                                set recentMsgs to (messages of mbox whose date received > cutoffDate)
                                set allMessages to allMessages & recentMsgs
                            end try
                            exit repeat
                        end if
                    end repeat
                end try
            end repeat
        end try
        
        set msgCount to count of allMessages
        if msgCount = 0 then return ""
        
        -- Limit to max_items (take most recent)
        set limitCount to msgCount
        if limitCount > {max_items} then set limitCount to {max_items}
        
        set outputText to ""
        repeat with i from 1 to limitCount
            set msg to item i of allMessages
            
            try
                set subj to subject of msg
            on error
                set subj to ""
            end try
            
            try
                set sndr to sender of msg
            on error
                set sndr to ""
            end try
            
            try
                set dateRcvd to (date received of msg) as string
            on error
                set dateRcvd to ""
            end try
            
            try
                set cnt to content of msg as string
                if (count of cnt) > 500 then
                    set cnt to text 1 thru 500 of cnt
                end if
            on error
                set cnt to ""
            end try
            
            set outputText to outputText & "EMAILSTART|subject:" & subj & "|sender:" & sndr & "|dateReceived:" & dateRcvd & "|content:" & cnt & "|EMAILEND" & linefeed
        end repeat
        
        return outputText
    end tell
    '''
    
    try:
        result = subprocess.run(
            ['osascript', '-e', applescript],
            capture_output=True,
            text=True,
            timeout=15  # Reduced from 30s since we're only querying Inbox now
        )
        
        if result.returncode != 0:
            logger.error("AppleScript failed: %s", result.stderr)
            return []
        
        # Parse AppleScript output (returns AppleScript list format)
        output = result.stdout.strip()
        if not output or output == "{}":
            logger.info("No emails found in last %d hours", hours_back)
            return []
        
        # Parse the AppleScript record format
        emails = _parse_applescript_output(output)
        logger.info("Retrieved %d emails from last %d hours", len(emails), hours_back)
        return emails
        
    except subprocess.TimeoutExpired:
        logger.error("AppleScript timeout after 30s - Mail.app may be unresponsive (filtering last %d hours)", hours_back)
        return []
    except Exception as e:
        logger.error("Failed to get emails via AppleScript: %s", e, exc_info=True)
        return []


def _parse_applescript_output(output: str) -> List[Dict[str, Any]]:
    """
    Parse custom delimited AppleScript output.
    
    Format: EMAILSTART|subject:...|sender:...|dateReceived:...|content:...|EMAILEND, ...
    """
    emails = []
    
    try:
        if not output or output.strip() == "":
            return []
        
        # Split by EMAILEND delimiter
        email_blocks = output.split('|EMAILEND')
        
        for block in email_blocks:
            if 'EMAILSTART|' not in block:
                continue
            
            # Remove EMAILSTART prefix
            block = block.replace('EMAILSTART|', '')
            
            email_data = {}
            
            # Extract fields
            parts = block.split('|')
            for part in parts:
                if ':' in part:
                    key, _, value = part.partition(':')
                    email_data[key.strip()] = value.strip()
            
            if email_data.get('subject') or email_data.get('sender'):
                emails.append(email_data)
        
        return emails
        
    except Exception as e:
        logger.error("Failed to parse AppleScript output: %s", e)
        return []


def test_mail_access() -> bool:
    """Test if Mail.app is accessible."""
    try:
        result = subprocess.run(
            ['osascript', '-e', 'tell application "Mail" to get name'],
            capture_output=True,
            text=True,
            timeout=5
        )
        return result.returncode == 0
    except Exception:
        return False
