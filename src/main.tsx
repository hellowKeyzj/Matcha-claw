/**
 * React Application Entry Point
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import './i18n';
import './styles/globals.css';
import './plugins/files/monaco-diff.css';
import './plugins/message-rendering/markdown.css';
import './plugins/chat/pending.css';
import 'katex/dist/katex.min.css';
import { initializeDefaultTransports } from './lib/api-client';
import { isTraceEnabled, startupTrace } from './lib/trace-logger';
import { applicationPluginsHost, observeApplicationPluginPackages } from './app/plugins';
import { PluginHostProvider } from './plugin-host/react';

if (isTraceEnabled()) performance.mark('matchaclaw.renderer.module-body');
startupTrace('renderer.main', 'module.body', () => ({
  moduleWaitMs: Math.round(performance.now()
    - (performance.getEntriesByName('matchaclaw.html.module-tag.before')[0]?.startTime ?? 0)),
}));
const transportStartedAt = isTraceEnabled() ? performance.now() : 0;
startupTrace('renderer.main', 'transport.init.start');
initializeDefaultTransports();
startupTrace('renderer.main', 'transport.init.end', () => ({
  durationMs: Math.round(performance.now() - transportStartedAt),
}));

// Install observers before any page can acquire a runtime observation.
const stopBuiltinPlugins = applicationPluginsHost.start();
const stopPackages = observeApplicationPluginPackages();
const stopPlugins = () => {
  stopPackages();
  stopBuiltinPlugins();
};
const onPageHide = (event: PageTransitionEvent) => {
  if (!event.persisted) stopPlugins();
};
window.addEventListener('pagehide', onPageHide);

const createRootStartedAt = isTraceEnabled() ? performance.now() : 0;
startupTrace('renderer.main', 'root.create.start');
const root = ReactDOM.createRoot(document.getElementById('root')!);
startupTrace('renderer.main', 'root.create.end', () => ({
  durationMs: Math.round(performance.now() - createRootStartedAt),
}));
const renderStartedAt = isTraceEnabled() ? performance.now() : 0;
startupTrace('renderer.main', 'root.render.start');
root.render(
  <React.StrictMode>
    <PluginHostProvider host={applicationPluginsHost}>
      <HashRouter>
        <App />
      </HashRouter>
    </PluginHostProvider>
  </React.StrictMode>,
);
startupTrace('renderer.main', 'root.render.return', () => ({
  durationMs: Math.round(performance.now() - renderStartedAt),
}));

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount();
    window.removeEventListener('pagehide', onPageHide);
    stopPlugins();
  });
}
