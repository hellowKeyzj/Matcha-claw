/**
 * React Application Entry Point
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import './i18n';
import './styles/globals.css';
import { initializeDefaultTransports } from './lib/api-client';

initializeDefaultTransports();

if (import.meta.env.DEV) {
  void import('./lib/chat-memory-diagnostics').then(({ installChatMemoryDiagnosticsDebugApi }) => {
    installChatMemoryDiagnosticsDebugApi(window);
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
);
