import asyncio
import sys
from pathlib import Path

# Add proactive_simulations directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from runner import SimulationRunner, SimulationScenario

async def run_proactive_simulation():
    workspace_root = Path(__file__).resolve().parents[3]
    runner = SimulationRunner(workspace_root)
    
    # 1. Dissertation Submission Scenario
    dissertation_scenario = SimulationScenario(
        name="Dissertation Submission Phase",
        description="User is finalizing their dissertation and researching submission guidelines while communicating with their supervisor.",
        emails=[
            {
                "subject": "Dissertation Deadline Update - EXTENSION GRANTED",
                "sender": "supervisor@university.example.com",
                "body": "Dear Student, the committee has decided to extend the submission deadline by 48 hours for all final year students. Please ensure your evaluations are complete by Friday."
            }
        ],
        browser_logs=[
            {
                "url": "https://university.ac.uk/dissertation/formatting-guidelines-2026",
                "title": "Dissertation Formatting Guidelines - University of Glasgow"
            },
            {
                "url": "https://overleaf.com/project/65d123456789/dissertation",
                "title": "Dissertation Main - Overleaf, Online LaTeX Editor"
            }
        ],
        fs_logs=[
            {
                "file_path": "docs/dissertation/l4_overleaf/main.tex",
                "action": "modified"
            },
            {
                "file_path": "docs/dissertation/l4_overleaf/chapters/06-evaluation.tex",
                "action": "modified"
            },
            {
                "file_path": "docs/dissertation/status_update_18feb2026.tex",
                "action": "modified"
            }
        ]
    )

    # 2. Critical Security Incident Scenario
    security_scenario = SimulationScenario(
        name="Critical Security Incident Response",
        description="A major zero-day vulnerability has been disclosed. The user is researching the impact and reviewing internal logs.",
        emails=[
            {
                "subject": "URGENT: Suspicious activity detected in production server logs - RESPONSE REQUIRED",
                "sender": "sec-ops@techcorp.example.com",
                "body": "We have detected multiple attempts to exploit the recent Node.js zero-day vulnerability in our API gateway. Please review the attached log snippet and update the middleware ASAP."
            }
        ],
        browser_logs=[
            {
                "url": "https://github.com/nodejs/node/security/advisories/GHSA-xxx",
                "title": "Node.js Security Advisory: Critical Zero-Day Vulnerability in HTTP Parser"
            },
            {
                "url": "https://www.zdnet.com/article/new-nodejs-vulnerability-allows-remote-code-execution/",
                "title": "New Node.js vulnerability allows remote code execution | ZDNET"
            }
        ],
        fs_logs=[
            {
                "file_path": "sample/urgent_security_breach.txt",
                "action": "modified"
            },
            {
                "file_path": "sample/nodejs_critical_zero_day.txt",
                "action": "modified"
            }
        ]
    )

    # 3. Project Funding & Compliance Scenario
    funding_scenario = SimulationScenario(
        name="Aether Arena Funding & Compliance",
        description="The user is preparing for an investment pitch and needs to ensure compliance with data processing agreements.",
        emails=[
            {
                "subject": "Re: Investment Pitch - Term Sheet for Review",
                "sender": "vc-investor@venturepartners.example.com",
                "body": "We were very impressed by the Aether Arena pitch. We've attached a draft term sheet for your review. Please pay close attention to Section 4 on data sovereignty and BM25 indexing compliance."
            }
        ],
        browser_logs=[
            {
                "url": "https://crunchbase.com/organization/aether-inc/funding_rounds",
                "title": "Aether Inc - Funding Rounds - Crunchbase"
            }
        ],
        fs_logs=[
            {
                "file_path": "sample/AetherInc_AI_Paralegal_Pitch.pptx",
                "action": "modified"
            },
            {
                "file_path": "sample/equity_investment_slip-1.pdf",
                "action": "modified"
            }
        ]
    )

    # Run the simulation
    await runner.run_scenarios([dissertation_scenario, security_scenario, funding_scenario])

if __name__ == "__main__":
    asyncio.run(run_proactive_simulation())
