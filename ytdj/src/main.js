/** Entry point: mount the console. */

import { render } from 'preact';
import { App } from './ui/app.js';
import { html } from './ui/components.js';

const root = document.getElementById('app');

if (root) {
  root.removeAttribute('aria-busy');
  root.textContent = '';
  try {
    render(html`<${App} />`, root);
  } catch (error) {
    root.innerHTML = '';
    const message = document.createElement('p');
    message.className = 'boot';
    message.setAttribute('role', 'alert');
    message.textContent = `The console failed to start: ${
      error instanceof Error ? error.message : String(error)
    }`;
    root.append(message);
    throw error;
  }
}
