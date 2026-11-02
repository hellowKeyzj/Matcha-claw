import type { AppReaderInput } from '@matcha/app-plugins-sdk';

const api = window.matchaReader;
const unsubscribe = api?.onInput((input: AppReaderInput) => {
  const content = document.querySelector('#content');
  if (!content || input.source !== 'text') { api.error('Expected text input.'); return; }
  content.textContent = input.text;
  api.ready();
});
window.addEventListener('pagehide', () => unsubscribe?.(), { once: true });
