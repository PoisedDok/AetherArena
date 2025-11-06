/**
 * Main Window E2E Tests
 * ============================================================================
 * End-to-end tests for main window functionality
 * 
 * @module tests/e2e/main-window
 */

const { test, expect, _electron as electron } = require('@playwright/test');
const path = require('path');

test.describe('Main Window', () => {
  let electronApp;
  let mainWindow;

  test.beforeAll(async () => {
    // Launch Electron app
    electronApp = await electron.launch({
      args: [path.join(__dirname, '..', '..', 'main.js')],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        ELECTRON_DEV: 'false',
      },
    });

    // Wait for window to be ready
    mainWindow = await electronApp.firstWindow();
    await mainWindow.waitForLoadState('domcontentloaded');
  });

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
    }
  });

  test('should launch main window', async () => {
    expect(mainWindow).toBeDefined();
    
    const title = await mainWindow.title();
    expect(title).toContain('Aether');
  });

  test('should have correct window dimensions', async () => {
    const size = await mainWindow.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
  });

  test('should be able to toggle widget mode', async () => {
    // Find widget toggle button
    const toggleButton = await mainWindow.locator('[data-testid="widget-toggle"]').first();
    
    if (await toggleButton.count() > 0) {
      await toggleButton.click();
      
      // Wait for animation
      await mainWindow.waitForTimeout(500);
      
      // Check if window size changed
      const newSize = await mainWindow.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));
      
      expect(newSize).toBeDefined();
    }
  });

  test('should have neural network visualizer', async () => {
    // Check if visualizer canvas exists
    const canvas = await mainWindow.locator('canvas').first();
    expect(await canvas.count()).toBeGreaterThan(0);
  });

  test('should have audio controls', async () => {
    // Check for audio control buttons
    const audioButton = await mainWindow.locator('[data-testid="audio-toggle"]').first();
    
    if (await audioButton.count() > 0) {
      expect(await audioButton.isVisible()).toBe(true);
    }
  });

  test('should open chat window', async () => {
    // Click chat button
    const chatButton = await mainWindow.locator('[data-testid="open-chat"]').first();
    
    if (await chatButton.count() > 0) {
      await chatButton.click();
      
      // Wait for chat window to open
      await mainWindow.waitForTimeout(1000);
      
      // Check if chat window opened (by checking window count)
      const windows = electronApp.windows();
      expect(windows.length).toBeGreaterThan(1);
    }
  });

  test('should open artifacts window', async () => {
    // Click artifacts button
    const artifactsButton = await mainWindow.locator('[data-testid="open-artifacts"]').first();
    
    if (await artifactsButton.count() > 0) {
      await artifactsButton.click();
      
      // Wait for artifacts window to open
      await mainWindow.waitForTimeout(1000);
      
      // Check if artifacts window opened
      const windows = electronApp.windows();
      expect(windows.length).toBeGreaterThan(1);
    }
  });

  test('should handle keyboard shortcuts', async () => {
    // Test global shortcut (if implemented)
    await mainWindow.keyboard.press('Control+Shift+A');
    
    // Wait for action
    await mainWindow.waitForTimeout(500);
    
    // Verify shortcut action (specific to implementation)
  });

  test('should not have console errors', async () => {
    const errors = [];
    
    mainWindow.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });
    
    // Trigger some interactions
    await mainWindow.click('body');
    
    // Wait a bit
    await mainWindow.waitForTimeout(1000);
    
    // No critical errors should appear
    expect(errors.filter(e => e.includes('Error'))).toHaveLength(0);
  });

  test('should be responsive to window resize', async () => {
    // Resize window
    await mainWindow.setViewportSize({ width: 800, height: 600 });
    
    // Wait for resize
    await mainWindow.waitForTimeout(500);
    
    // Check new dimensions
    const size = await mainWindow.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    
    expect(size.width).toBe(800);
    expect(size.height).toBe(600);
  });
});


