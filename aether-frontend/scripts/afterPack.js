/**
 * @.architecture
 * Incoming: electron-builder afterPack hook --- {BuildResult context}
 * Processing: Strip macOS quarantine attributes, ad-hoc code sign --- {JOB_STRIP_QUARANTINE, JOB_CODESIGN}
 * Outgoing: Signed .app bundle ready for distribution --- {xattr clean, codesign applied}
 *
 * WHY: macOS Gatekeeper blocks unsigned/quarantined apps with a "verifying" spinner
 * that never resolves. Without Apple Developer ID ($99/year), ad-hoc signing + quarantine
 * strip is the only way to let users open the app via right-click → Open.
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * electron-builder afterPack hook.
 * Called after the app is packed but before it's compressed into DMG/ZIP.
 */
exports.default = async function afterPack(context) {
  // Only run on macOS builds
  if (process.platform !== 'darwin' || context.electronPlatformName !== 'darwin') {
    console.log('[afterPack] Skipping: not a macOS build');
    return;
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  if (!fs.existsSync(appPath)) {
    console.warn(`[afterPack] App bundle not found: ${appPath}`);
    return;
  }

  console.log(`[afterPack] Processing: ${appPath}`);

  // Step 1: Strip quarantine attributes recursively
  // This removes the com.apple.quarantine xattr that triggers Gatekeeper's
  // "verifying" dialog and potential blocking.
  try {
    execSync(`xattr -cr "${appPath}"`, { stdio: 'pipe' });
    console.log('[afterPack] Quarantine attributes stripped');
  } catch (err) {
    console.warn('[afterPack] xattr strip failed (non-critical):', err.message);
  }

  // Step 2: Make shell scripts executable in Resources
  const resourcesDir = path.join(appPath, 'Contents', 'Resources');
  const shellScripts = [
    'bin/start_production.sh',
    'bin/stop_backend.sh'
  ];

  for (const script of shellScripts) {
    const scriptPath = path.join(resourcesDir, script);
    if (fs.existsSync(scriptPath)) {
      try {
        fs.chmodSync(scriptPath, 0o755);
        console.log(`[afterPack] Made executable: ${script}`);
      } catch (err) {
        console.warn(`[afterPack] chmod failed for ${script}:`, err.message);
      }
    }
  }

  // Step 3: Make the backend binary executable
  const binaryPath = path.join(resourcesDir, 'bin', 'aether-hub', 'aether-hub');
  if (fs.existsSync(binaryPath)) {
    try {
      fs.chmodSync(binaryPath, 0o755);
      console.log('[afterPack] Backend binary made executable');
    } catch (err) {
      console.warn('[afterPack] chmod failed for backend binary:', err.message);
    }
  }

  // Step 4: Ad-hoc code sign (CRITICAL: Must happen LAST, after all modifications)
  // Without Apple Developer ID, ad-hoc signing (identity '-') allows the app
  // to pass basic Gatekeeper checks. Users still need right-click → Open on
  // first launch, but the "verifying" spinner won't hang.
  try {
    execSync(
      `codesign --force --deep --sign - "${appPath}"`,
      { stdio: 'pipe' }
    );
    console.log('[afterPack] Ad-hoc code signing applied');
  } catch (err) {
    console.warn('[afterPack] codesign failed (non-critical):', err.message);
  }

  console.log('[afterPack] macOS post-processing complete');
};
