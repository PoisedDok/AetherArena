#!/usr/bin/env node
'use strict';

/**
 * Security Audit Script
 * ============================================================================
 * Runs comprehensive security audit:
 * - npm audit (dependency vulnerabilities)
 * - electron-security-check
 * - CSP validation
 * - Sandbox verification
 * - License compliance check
 * 
 * Usage: node scripts/security-audit.js [--fix] [--json]
 */

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');

const execPromise = util.promisify(exec);

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  // Severity levels that fail the audit
  failOn: ['critical', 'high'],
  
  // Output file
  outputFile: path.join(__dirname, '..', 'security-audit-report.json'),
  
  // Package.json location
  packageJson: path.join(__dirname, '..', 'package.json'),
  
  // Maximum allowed vulnerabilities by severity
  maxVulnerabilities: {
    critical: 0,
    high: 0,
    moderate: 5,
    low: 10,
  },
};

// ============================================================================
// CLI Arguments
// ============================================================================

const args = process.argv.slice(2);
const shouldFix = args.includes('--fix');
const jsonOutput = args.includes('--json');
const verbose = args.includes('--verbose');

// ============================================================================
// Audit Functions
// ============================================================================

/**
 * Run npm audit
 */
async function runNpmAudit() {
  console.log('\n📦 Running npm audit...\n');
  
  try {
    const command = shouldFix ? 'npm audit fix' : 'npm audit --json';
    const { stdout, stderr } = await execPromise(command);
    
    if (!shouldFix) {
      const auditData = JSON.parse(stdout);
      
      const vulnerabilities = {
        critical: auditData.metadata?.vulnerabilities?.critical || 0,
        high: auditData.metadata?.vulnerabilities?.high || 0,
        moderate: auditData.metadata?.vulnerabilities?.moderate || 0,
        low: auditData.metadata?.vulnerabilities?.low || 0,
        total: auditData.metadata?.vulnerabilities?.total || 0,
      };
      
      return {
        passed: vulnerabilities.critical === 0 && vulnerabilities.high === 0,
        vulnerabilities,
        details: auditData.vulnerabilities || {},
        advisories: auditData.advisories || {},
      };
    } else {
      console.log(stdout);
      return {
        passed: true,
        fixed: true,
      };
    }
  } catch (error) {
    // npm audit returns non-zero exit code if vulnerabilities found
    if (error.stdout) {
      try {
        const auditData = JSON.parse(error.stdout);
        const vulnerabilities = {
          critical: auditData.metadata?.vulnerabilities?.critical || 0,
          high: auditData.metadata?.vulnerabilities?.high || 0,
          moderate: auditData.metadata?.vulnerabilities?.moderate || 0,
          low: auditData.metadata?.vulnerabilities?.low || 0,
          total: auditData.metadata?.vulnerabilities?.total || 0,
        };
        
        return {
          passed: false,
          vulnerabilities,
          details: auditData.vulnerabilities || {},
          advisories: auditData.advisories || {},
        };
      } catch (parseError) {
        return {
          passed: false,
          error: 'Failed to parse npm audit output',
          message: error.message,
        };
      }
    }
    
    return {
      passed: false,
      error: error.message,
    };
  }
}

/**
 * Check Electron security best practices
 */
async function checkElectronSecurity() {
  console.log('\n⚡ Checking Electron security...\n');
  
  const issues = [];
  
  try {
    // Read package.json
    const pkg = JSON.parse(fs.readFileSync(CONFIG.packageJson, 'utf8'));
    
    // Check Electron version
    const electronVersion = pkg.dependencies?.electron || pkg.devDependencies?.electron;
    if (electronVersion) {
      const version = electronVersion.replace(/[^0-9.]/g, '');
      const major = parseInt(version.split('.')[0]);
      
      if (major < 20) {
        issues.push({
          severity: 'high',
          category: 'electron-version',
          issue: 'Outdated Electron version',
          current: version,
          recommendation: 'Upgrade to Electron 20+ for security patches',
        });
      }
    }
    
    // Check for dangerous dependencies
    const dangerousDeps = [
      'eval',
      'node-eval',
      'vm2',
      'serialize-javascript',
    ];
    
    for (const dep of dangerousDeps) {
      if (pkg.dependencies?.[dep] || pkg.devDependencies?.[dep]) {
        issues.push({
          severity: 'high',
          category: 'dangerous-dependency',
          issue: `Potentially dangerous dependency: ${dep}`,
          recommendation: 'Review usage or find safer alternative',
        });
      }
    }
    
    return {
      passed: issues.length === 0,
      issues,
    };
  } catch (error) {
    return {
      passed: false,
      error: error.message,
    };
  }
}

/**
 * Validate Content Security Policy
 */
async function validateCSP() {
  console.log('\n🛡️  Validating CSP configuration...\n');
  
  try {
    const cspPath = path.join(__dirname, '..', 'src', 'core', 'security', 'CspManager.js');
    
    if (!fs.existsSync(cspPath)) {
      return {
        passed: false,
        error: 'CspManager.js not found',
      };
    }
    
    const cspContent = fs.readFileSync(cspPath, 'utf8');
    const issues = [];
    
    // Check for unsafe directives in production policy
    const unsafePatterns = [
      /'unsafe-inline'/g,
      /'unsafe-eval'/g,
    ];
    
    for (const pattern of unsafePatterns) {
      if (cspContent.match(pattern)) {
        // Check if it's in production policy
        const productionMatch = cspContent.match(/production:[\s\S]*?'unsafe-(inline|eval)'/);
        if (productionMatch) {
          issues.push({
            severity: 'critical',
            category: 'csp',
            issue: `Unsafe CSP directive in production: ${productionMatch[1]}`,
            recommendation: 'Remove unsafe-inline and unsafe-eval from production CSP',
          });
        }
      }
    }
    
    // Check for missing security directives
    const requiredDirectives = [
      'default-src',
      'script-src',
      'object-src',
      'base-uri',
      'frame-ancestors',
    ];
    
    for (const directive of requiredDirectives) {
      if (!cspContent.includes(`'${directive}'`)) {
        issues.push({
          severity: 'high',
          category: 'csp',
          issue: `Missing required CSP directive: ${directive}`,
          recommendation: `Add ${directive} directive to CSP policy`,
        });
      }
    }
    
    return {
      passed: issues.length === 0,
      issues,
    };
  } catch (error) {
    return {
      passed: false,
      error: error.message,
    };
  }
}

/**
 * Verify sandbox configuration
 */
async function verifySandbox() {
  console.log('\n📦 Verifying sandbox configuration...\n');
  
  try {
    const issues = [];
    
    // Check main window configuration
    const windowFiles = [
      'src/main/windows/MainWindow.js',
      'src/main/windows/ChatWindow.js',
      'src/main/windows/ArtifactsWindow.js',
    ];
    
    for (const windowFile of windowFiles) {
      const filePath = path.join(__dirname, '..', windowFile);
      
      if (!fs.existsSync(filePath)) {
        issues.push({
          severity: 'medium',
          category: 'sandbox',
          issue: `Window file not found: ${windowFile}`,
          recommendation: 'Ensure all window files exist and are properly configured',
        });
        continue;
      }
      
      const content = fs.readFileSync(filePath, 'utf8');
      
      // Check for nodeIntegration: true
      if (/nodeIntegration:\s*true/.test(content)) {
        issues.push({
          severity: 'critical',
          category: 'sandbox',
          issue: `nodeIntegration enabled in ${windowFile}`,
          recommendation: 'Disable nodeIntegration for security',
        });
      }
      
      // Check for contextIsolation: false
      if (/contextIsolation:\s*false/.test(content)) {
        issues.push({
          severity: 'critical',
          category: 'sandbox',
          issue: `contextIsolation disabled in ${windowFile}`,
          recommendation: 'Enable contextIsolation for security',
        });
      }
      
      // Check for sandbox: false
      if (/sandbox:\s*false/.test(content)) {
        issues.push({
          severity: 'critical',
          category: 'sandbox',
          issue: `Sandbox disabled in ${windowFile}`,
          recommendation: 'Enable sandbox for all renderers',
        });
      }
    }
    
    return {
      passed: issues.length === 0,
      issues,
    };
  } catch (error) {
    return {
      passed: false,
      error: error.message,
    };
  }
}

/**
 * Check license compliance
 */
async function checkLicenses() {
  console.log('\n📄 Checking license compliance...\n');
  
  try {
    // Run license-checker if available
    try {
      const { stdout } = await execPromise('npx license-checker --json --onlyAllow="MIT;Apache-2.0;BSD;ISC;CC0-1.0;Unlicense"');
      return {
        passed: true,
        licenses: JSON.parse(stdout),
      };
    } catch (error) {
      // License checker not available or found issues
      return {
        passed: false,
        warning: 'Install license-checker: npm install -g license-checker',
      };
    }
  } catch (error) {
    return {
      passed: false,
      error: error.message,
    };
  }
}

/**
 * Generate security report
 */
function generateReport(results) {
  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      passed: Object.values(results).every(r => r.passed),
      totalIssues: 0,
      criticalIssues: 0,
      highIssues: 0,
    },
    results,
  };
  
  // Count issues
  for (const result of Object.values(results)) {
    if (result.issues) {
      report.summary.totalIssues += result.issues.length;
      report.summary.criticalIssues += result.issues.filter(i => i.severity === 'critical').length;
      report.summary.highIssues += result.issues.filter(i => i.severity === 'high').length;
    }
    if (result.vulnerabilities) {
      report.summary.totalIssues += result.vulnerabilities.total || 0;
      report.summary.criticalIssues += result.vulnerabilities.critical || 0;
      report.summary.highIssues += result.vulnerabilities.high || 0;
    }
  }
  
  return report;
}

/**
 * Display report
 */
function displayReport(report) {
  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  
  console.log('\n' + '='.repeat(80));
  console.log('SECURITY AUDIT REPORT');
  console.log('='.repeat(80));
  console.log();
  console.log(`Status: ${report.summary.passed ? '✅ PASSED' : '❌ FAILED'}`);
  console.log(`Timestamp: ${report.timestamp}`);
  console.log(`Total Issues: ${report.summary.totalIssues}`);
  console.log(`Critical: ${report.summary.criticalIssues}`);
  console.log(`High: ${report.summary.highIssues}`);
  console.log();
  
  // Display each category
  for (const [category, result] of Object.entries(report.results)) {
    console.log(`${category.toUpperCase()}: ${result.passed ? '✅ PASS' : '❌ FAIL'}`);
    
    if (verbose && result.issues && result.issues.length > 0) {
      for (const issue of result.issues) {
        console.log(`  [${issue.severity}] ${issue.issue}`);
        console.log(`    → ${issue.recommendation}`);
      }
    }
    
    if (verbose && result.vulnerabilities) {
      const vuln = result.vulnerabilities;
      if (vuln.total > 0) {
        console.log(`  Critical: ${vuln.critical}, High: ${vuln.high}, Moderate: ${vuln.moderate}, Low: ${vuln.low}`);
      }
    }
  }
  
  console.log();
  console.log('='.repeat(80));
  console.log(`Report saved to: ${CONFIG.outputFile}`);
  console.log('='.repeat(80));
  console.log();
}

/**
 * Main audit function
 */
async function runAudit() {
  console.log('🔒 Starting Security Audit...');
  
  const results = {
    npmAudit: await runNpmAudit(),
    electronSecurity: await checkElectronSecurity(),
    csp: await validateCSP(),
    sandbox: await verifySandbox(),
    licenses: await checkLicenses(),
  };
  
  const report = generateReport(results);
  
  // Save report
  fs.writeFileSync(CONFIG.outputFile, JSON.stringify(report, null, 2));
  
  // Display report
  displayReport(report);
  
  // Exit with appropriate code
  process.exit(report.summary.passed ? 0 : 1);
}

// ============================================================================
// Run Audit
// ============================================================================

runAudit().catch(error => {
  console.error('❌ Audit failed:', error);
  process.exit(1);
});


