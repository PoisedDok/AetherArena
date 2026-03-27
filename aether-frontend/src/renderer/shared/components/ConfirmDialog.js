 'use strict';
 
 /**
  * @.architecture
  * Incoming: UI actions requiring confirm/prompt --- {user_click, destructive_action, input_request}
  * Processing: Render glassmorphic modal, collect decision/input, resolve promise --- {3 jobs: JOB_CREATE_DOM_ELEMENT, JOB_RENDER, JOB_RESOLVE_PROMISE}
  * Outgoing: Promise resolution (boolean/string), DOM cleanup --- {user_choice, input_value}
  */
 
 class ConfirmDialog {
   static confirm(options = {}) {
     return new Promise((resolve) => {
       ConfirmDialog._renderDialog({
         ...options,
         mode: 'confirm',
         onResolve: (confirmed) => resolve(Boolean(confirmed))
       });
     });
   }
 
   static prompt(options = {}) {
     return new Promise((resolve) => {
       ConfirmDialog._renderDialog({
         ...options,
         mode: 'prompt',
         onResolve: (value) => resolve(value)
       });
     });
   }
 
   static _renderDialog(options) {
     ConfirmDialog._closeExisting();
 
     const {
       title = 'Confirm',
       message = '',
       confirmText = 'Confirm',
       cancelText = 'Cancel',
       variant = 'default',
       mode = 'confirm',
       placeholder = '',
       inputType = 'text',
       value = '',
       required = true,
       onResolve = () => {}
     } = options;
 
    const dialog = document.createElement('dialog');
    dialog.className = `confirm-dialog-card ${variant}`;
    dialog.setAttribute('aria-label', title);
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');

    // Test environment polyfill for jsdom
    if (!dialog.showModal) {
      dialog.showModal = function() { this.open = true; };
    }
    if (!dialog.close) {
      dialog.close = function(returnValue) { 
        this.open = false; 
        if (returnValue !== undefined) this.returnValue = returnValue;
        this.dispatchEvent(new Event('close'));
      };
    }
 
     const header = document.createElement('div');
     header.className = 'confirm-dialog-header';
 
     const titleEl = document.createElement('div');
     titleEl.className = 'confirm-dialog-title';
     titleEl.textContent = title;
 
     const closeBtn = document.createElement('button');
     closeBtn.className = 'confirm-dialog-close';
     closeBtn.type = 'button';
     closeBtn.innerHTML = '&times;';
     closeBtn.setAttribute('aria-label', 'Close');
 
     header.appendChild(titleEl);
     header.appendChild(closeBtn);
 
     const body = document.createElement('div');
     body.className = 'confirm-dialog-body';
 
     const messageEl = document.createElement('div');
     messageEl.className = 'confirm-dialog-message';
     messageEl.textContent = message;
 
     body.appendChild(messageEl);
 
     let inputEl = null;
     const errorEl = document.createElement('div');
     errorEl.className = 'confirm-dialog-error';
 
     if (mode === 'prompt') {
       inputEl = document.createElement('input');
       inputEl.className = 'confirm-dialog-input';
       inputEl.type = inputType;
       inputEl.placeholder = placeholder;
       inputEl.value = value;
       inputEl.autocomplete = 'off';
       body.appendChild(inputEl);
       body.appendChild(errorEl);
     }
 
     const footer = document.createElement('div');
     footer.className = 'confirm-dialog-footer';
 
     const cancelBtn = document.createElement('button');
     cancelBtn.className = 'confirm-dialog-btn cancel';
     cancelBtn.type = 'button';
     cancelBtn.textContent = cancelText;
 
     const confirmBtn = document.createElement('button');
     confirmBtn.className = 'confirm-dialog-btn confirm';
     confirmBtn.type = 'button';
     confirmBtn.textContent = confirmText;
 
     footer.appendChild(cancelBtn);
     footer.appendChild(confirmBtn);
 
    dialog.appendChild(header);
    dialog.appendChild(body);
    dialog.appendChild(footer);
    document.body.appendChild(dialog);

    const close = (result) => {
      dialog.close();
      setTimeout(() => dialog.remove(), 220);
      document.removeEventListener('keydown', onKeyDown);
      onResolve(result);
    };
 
     const validatePrompt = () => {
       if (!inputEl || !required) return true;
       const valueTrimmed = inputEl.value.trim();
       if (!valueTrimmed) {
         errorEl.textContent = 'This field is required.';
         return false;
       }
       errorEl.textContent = '';
       return true;
     };
 
     const onKeyDown = (event) => {
       if (event.key === 'Escape') {
         event.preventDefault();
         close(mode === 'prompt' ? null : false);
       }
       if (event.key === 'Enter') {
         if (mode === 'prompt') {
           if (!validatePrompt()) return;
           close(inputEl.value.trim());
         } else {
           close(true);
         }
       }
     };
 
     const onConfirm = () => {
       if (mode === 'prompt') {
         if (!validatePrompt()) return;
         close(inputEl.value.trim());
         return;
       }
       close(true);
     };
 
     const onCancel = () => close(mode === 'prompt' ? null : false);
 
    closeBtn.addEventListener('click', onCancel);
    cancelBtn.addEventListener('click', onCancel);
    confirmBtn.addEventListener('click', onConfirm);
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) onCancel();
    });
    
    // Prevent default escape behavior to use our custom onCancel which resolves the promise
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      onCancel();
    });

    if (inputEl) {
       inputEl.addEventListener('input', validatePrompt);
       setTimeout(() => inputEl.focus(), 0);
     } else {
       setTimeout(() => confirmBtn.focus(), 0);
     }
 
    document.addEventListener('keydown', onKeyDown);
    dialog.showModal();
  }

  static _closeExisting() {
    const existing = document.querySelector('dialog.confirm-dialog-card');
    if (existing) {
      existing.remove();
    }
  }
 
   static _ensureStyles() {
    // Styles are defined in `renderer/shared/styles/modal-base.css` to keep CSP strict
    // (no runtime `<style>` injection).
   }
 }
 
 module.exports = ConfirmDialog;
