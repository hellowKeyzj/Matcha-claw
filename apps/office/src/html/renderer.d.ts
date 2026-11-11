declare module '@matcha/html-app' {
  import type { ComponentType } from 'react';
  const App: ComponentType<{ onOpenExternal?: (url: string) => Promise<void>; onDocumentAction?: (handler: (action: string, input: Record<string, unknown>) => Promise<unknown>) => () => void }>;
  export default App;
}
