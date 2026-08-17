import { Suspense, lazy, useEffect } from 'react';
import { ErrorBoundary } from '@/components/error-boundary';
import I18nProvider from '@/components/I18nProvider';

// The editor relies on browser-only APIs (Workers, WebAssembly, WebGPU),
// so lazy-load it so the loading spinner can render first.
const Editor = lazy(() => import('@/components/Editor'));

function LoadingSpinner() {
  return (
    <div className="flex h-dvh items-center justify-center bg-zinc-50 dark:bg-zinc-950">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-500 border-t-transparent dark:border-neutral-400" />
    </div>
  );
}

function App() {
  // Apply stored appearance before first paint (belt-and-suspenders: the
  // inline boot script in index.html handles the real flash prevention).
  useEffect(() => {
    try {
      if (localStorage.getItem('rescript.appearance') === 'dark') {
        document.documentElement.classList.add('dark');
      }
    } catch {
      // Private mode / storage blocked
    }
  }, []);

  return (
    <ErrorBoundary>
      <I18nProvider>
        <Suspense fallback={<LoadingSpinner />}>
          <Editor />
        </Suspense>
      </I18nProvider>
    </ErrorBoundary>
  );
}

export default App;
