import { Component, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Editor } from './Editor';
import { app, connectApp, errorMessage } from './api';
import { startLocaleSync, useTranslation } from './i18n';
import './editor.css';

function EditorError({ error }: { error: string }) {
  const { t } = useTranslation();
  return <main className="document-start"><h1>{t('设计界面无法加载')}</h1><p className="inline-error" role="alert">{error}</p><button onClick={() => window.location.reload()}>{t('重新加载界面')}</button></main>;
}

class EditorBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' };

  static getDerivedStateFromError(error: Error) { return { error: error.message }; }

  componentDidCatch(error: Error, info: ErrorInfo) { console.error('Design editor failed', error, info.componentStack); }

  render() {
    return this.state.error ? <EditorError error={this.state.error} /> : this.props.children;
  }
}

function ConnectionStatus(props: { error?: unknown }) {
  const { t } = useTranslation();
  return 'error' in props ? <main className="document-start"><h1>{t('无法连接设计工作台')}</h1><p className="inline-error" role="alert">{errorMessage(props.error)}</p><button onClick={() => window.location.reload()}>{t('重新连接')}</button></main>
    : <main className="document-start"><h1>{t('正在连接设计工作台')}</h1><p className="quiet">{t('等待宿主连接…')}</p></main>;
}

const root = createRoot(document.getElementById('root')!);
root.render(<ConnectionStatus />);
void connectApp().then(() => {
  const stopLocaleSync = startLocaleSync(app());
  window.addEventListener('pagehide', stopLocaleSync, { once: true });
  root.render(<EditorBoundary><Editor /></EditorBoundary>);
}).catch((error: unknown) => {
  root.render(<ConnectionStatus error={error} />);
});
