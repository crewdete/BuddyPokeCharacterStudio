import { useEffect, useState } from 'react';
import { createBuddy, describeBuddy, loadOriginalAssets, type BuddyInfo } from './original';
import { DataPanel } from './ui/DataPanel';
import { Viewport } from './viewport/Viewport';

export type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; info: BuddyInfo; ms: number }
  | { status: 'error'; message: string };

declare global {
  interface Window {
    /** Read by the end-to-end smoke test. */
    __studio?: LoadState;
  }
}

export function App() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const started = performance.now();
    (async () => {
      const assets = await loadOriginalAssets();
      const buddy = await createBuddy(assets);
      const info = await describeBuddy(buddy, assets.wardrobe);
      return { status: 'ready', info, ms: Math.round(performance.now() - started) } as const;
    })()
      .catch((error: unknown) => ({ status: 'error', message: String(error instanceof Error ? error.message : error) }) as const)
      .then(next => {
        if (cancelled) return;
        window.__studio = next;
        setState(next);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="studio">
      <header className="topbar">
        <span className="brand">BuddyPoke Studio</span>
        <span className="badge">M0 · scaffold</span>
        <span className="spacer" />
        <span className={`status status-${state.status}`}>
          {state.status === 'loading' && 'Loading original assets…'}
          {state.status === 'ready' && `Original data loaded in ${state.ms} ms`}
          {state.status === 'error' && 'Failed to load original assets'}
        </span>
      </header>
      <main className="viewport">
        <Viewport />
        <p className="viewport-note">Empty viewport. The character arrives in M1.</p>
      </main>
      <aside className="panel">
        <DataPanel state={state} />
      </aside>
    </div>
  );
}
