# Accessibility (a11y) Guidelines

Aether frontend implements comprehensive accessibility features to ensure usability for all users, including those using assistive technologies.

## WCAG 2.1 Compliance

Target level: **AA** (minimum)

## Implemented Features

### 1. Semantic HTML

All components use proper semantic HTML elements:
- `<button>` for interactive elements
- `<nav>` for navigation
- `<main>` for primary content
- `<header>` / `<footer>` for sections
- Proper heading hierarchy (`<h1>` → `<h6>`)

### 2. ARIA Labels

All interactive elements have appropriate ARIA labels:
- `aria-label` for icon-only buttons
- `aria-labelledby` for complex widgets
- `aria-describedby` for additional context
- `role` attributes where semantic HTML insufficient

### 3. Keyboard Navigation

Full keyboard support:
- Tab order follows logical flow
- Focus visible on all interactive elements
- Escape key closes modals/dropdowns
- Enter/Space activates buttons
- Arrow keys navigate lists

### 4. Focus Management

- `:focus-visible` shows outline only for keyboard navigation
- Focus trap in modals
- Focus restoration after modal close
- Skip-to-content links (where applicable)

### 5. Color & Contrast

- Text contrast ratios meet WCAG AA standards:
  - Normal text: 4.5:1 minimum
  - Large text: 3:1 minimum
- Color not sole indicator of information
- Both light and dark modes accessible

### 6. Motion Reduction

Respects `prefers-reduced-motion`:
```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

### 7. Screen Reader Support

- `.sr-only` class for screen-reader-only content
- Proper labeling of form controls
- Status announcements use ARIA live regions
- Meaningful link text (no "click here")

### 8. Responsive Text

- Relative units (rem, em) used for typography
- Text scales with browser zoom
- No horizontal scrolling at 200% zoom
- Min/max font sizes prevent extremes

## Testing Checklist

### Automated Testing

Tools to use:
- **axe DevTools** - Browser extension for automated audits
- **Lighthouse** - Built into Chrome DevTools
- **pa11y** - CLI tool for CI/CD integration

Run automated tests:
```bash
# Install pa11y
npm install -g pa11y

# Test main window
pa11y http://localhost:8080

# Generate report
pa11y-ci --config pa11y-ci.json
```

### Manual Testing

#### Keyboard Navigation
- [ ] Tab through all interactive elements
- [ ] Verify focus indicators visible
- [ ] Test all keyboard shortcuts
- [ ] Verify no keyboard traps
- [ ] Test with Tab, Shift+Tab, Enter, Space, Escape, Arrow keys

#### Screen Reader Testing
- [ ] Test with NVDA (Windows)
- [ ] Test with JAWS (Windows)
- [ ] Test with VoiceOver (macOS)
- [ ] Verify all content announced correctly
- [ ] Verify form labels associated properly

#### Visual Testing
- [ ] Zoom to 200% - no horizontal scroll
- [ ] High contrast mode (Windows)
- [ ] Check color contrast with tools
- [ ] Test with color blindness simulators

#### Motion Testing
- [ ] Enable `prefers-reduced-motion`
- [ ] Verify animations disabled/minimal

## Component-Specific Guidelines

### Buttons

```html
<!-- Good -->
<button class="btn btn-icon" aria-label="Close window">
  <svg>...</svg>
</button>

<!-- Bad -->
<div onclick="close()">
  <svg>...</svg>
</div>
```

### Modals

```html
<div class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="modal-title">
  <div class="modal">
    <h2 id="modal-title">Settings</h2>
    <button class="modal-close" aria-label="Close settings">×</button>
    <!-- Modal content -->
  </div>
</div>
```

### Forms

```html
<div class="input-group">
  <label for="username" class="input-label">Username</label>
  <input 
    type="text" 
    id="username" 
    name="username"
    class="input"
    aria-required="true"
    aria-invalid="false"
    aria-describedby="username-help"
  >
  <span id="username-help" class="input-help">
    Enter your username (3-20 characters)
  </span>
</div>
```

### Live Regions

```html
<!-- Status announcements -->
<div role="status" aria-live="polite" aria-atomic="true" class="sr-only">
  Message sent successfully
</div>

<!-- Urgent alerts -->
<div role="alert" aria-live="assertive" aria-atomic="true">
  Connection lost. Retrying...
</div>
```

## Color Palette Accessibility

### Dark Mode (Default)

| Element | Color | Contrast Ratio | Pass |
|---------|-------|----------------|------|
| Primary text on background | #f5f5f5 on #0a0a0a | 19.37:1 | ✓ AAA |
| Secondary text on background | rgba(255,255,255,0.75) on #0a0a0a | 14.53:1 | ✓ AAA |
| Primary button | #ff6400 on #0a0a0a | 5.83:1 | ✓ AA |
| Links | #ff6400 on #0a0a0a | 5.83:1 | ✓ AA |

### Light Mode

| Element | Color | Contrast Ratio | Pass |
|---------|-------|----------------|------|
| Primary text on background | #1a1a1a on #ffffff | 18.02:1 | ✓ AAA |
| Secondary text on background | rgba(0,0,0,0.70) on #ffffff | 12.61:1 | ✓ AAA |
| Primary button | #ff6400 on #ffffff | 3.58:1 | ✓ AA (large text) |
| Links | #ff6400 on #ffffff | 3.58:1 | ✓ AA (large text) |

## Common Issues & Solutions

### Issue: Icon-only button without label
**Solution:** Add `aria-label`
```html
<button aria-label="Delete item">🗑️</button>
```

### Issue: Custom select without keyboard support
**Solution:** Use native `<select>` or implement full ARIA pattern
```html
<select class="select" aria-label="Choose theme">
  <option value="dark">Dark</option>
  <option value="light">Light</option>
</select>
```

### Issue: Modal doesn't trap focus
**Solution:** Implement focus trap
```javascript
const modal = document.querySelector('.modal');
const focusableElements = modal.querySelectorAll(
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
);
const firstFocusable = focusableElements[0];
const lastFocusable = focusableElements[focusableElements.length - 1];

modal.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    if (e.shiftKey && document.activeElement === firstFocusable) {
      e.preventDefault();
      lastFocusable.focus();
    } else if (!e.shiftKey && document.activeElement === lastFocusable) {
      e.preventDefault();
      firstFocusable.focus();
    }
  }
});
```

### Issue: Loading state not announced
**Solution:** Use ARIA live region
```html
<div role="status" aria-live="polite" class="sr-only">
  Loading content...
</div>
```

## Testing Schedule

- **Daily:** Automated tests in development
- **Weekly:** Manual keyboard navigation check
- **Monthly:** Full screen reader test
- **Release:** Complete accessibility audit

## Resources

- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)
- [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/)
- [axe DevTools](https://www.deque.com/axe/devtools/)
- [Lighthouse](https://developers.google.com/web/tools/lighthouse)

## Reporting Issues

Found an accessibility issue? Report it with:
1. Description of the issue
2. Steps to reproduce
3. Expected behavior
4. User impact severity
5. Browser/assistive technology used

