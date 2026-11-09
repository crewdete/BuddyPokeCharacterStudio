import { useEffect, useState } from 'react';
import { CharacterController } from './character/controller';
import { createDebug, type StudioDebug } from './debug';
import { createBuddy, describeBuddy, loadOriginalAssets, type BuddyInfo } from './original';
import { CharacterRig } from './scene/CharacterRig';
import { CustomizePanel } from './ui/CustomizePanel';
import { DataPanel } from './ui/DataPanel';
import { ComparisonViewport, Viewport } from './viewport/Viewport';

export type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; info: BuddyInfo; ms: number }
  | { status: 'error'; message: string };

declare global {
  interface Window {
    /** Read by the end-to-end tests. */
    __studio?: LoadState & { debug?: StudioDebug };
  }
}

const params = new URLSearchParams(location.search);
/** ?compare=1 renders with the original camera and canvas size for renderer comparison tests. */
const COMPARE = params.get('compare') === '1';
/** ?buddy=<look code> wears a look on load, like the original Flash embed and BuddyRevival. */
const LOOK = params.get('buddy');
if (COMPARE) document.documentElement.classList.add('compare');

export function App() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [rig, setRig] = useState<CharacterRig | null>(null);
  const [controller, setController] = useState<CharacterController | null>(null);

  useEffect(() => {
    let cancelled = false;
    let built: CharacterRig | null = null;
    const started = performance.now();
    (async () => {
      const assets = await loadOriginalAssets();
      const buddy = await createBuddy(assets, LOOK);
      built = new CharacterRig(buddy);
      const control = await CharacterController.create(assets, buddy, built);
      const info = await describeBuddy(buddy, assets.wardrobe);
      return { next: { status: 'ready', info, ms: Math.round(performance.now() - started) } as const, control };
    })()
      .then(({ next, control }) => {
        if (cancelled) return;
        window.__studio = { ...next, debug: createDebug(control) };
        setRig(built);
        setController(control);
        setState(next);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const next = { status: 'error', message: String(error instanceof Error ? error.message : error) } as const;
        window.__studio = next;
        setState(next);
      });
    return () => {
      cancelled = true;
      built?.dispose();
    };
  }, []);

  if (COMPARE) return rig ? <ComparisonViewport rig={rig} /> : null;

  return (
    <div className="studio">
      <header className="topbar">
        <span className="brand">BuddyPoke Studio</span>
        <span className="badge">M2A · customize</span>
        <span className="spacer" />
        <span className={`status status-${state.status}`}>
          {state.status === 'loading' && 'Loading original assets…'}
          {state.status === 'ready' && `Original data loaded in ${state.ms} ms`}
          {state.status === 'error' && 'Failed to load original assets'}
        </span>
      </header>
      <main className="viewport">
        <Viewport rig={rig} />
        <p className="viewport-note">Drag to orbit · scroll to zoom · right-drag to pan</p>
      </main>
      <aside className="panel">
        {controller ? <CustomizePanel controller={controller} /> : <DataPanel state={state} />}
        {controller && (
          <details className="data">
            <summary>Original data</summary>
            <DataPanel state={state} />
          </details>
        )}
      </aside>
    </div>
  );
}
