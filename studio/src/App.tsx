import { useEffect, useState } from 'react';
import { CharacterController } from './character/controller';
import { buildCatalog, type AnimationEntry } from './pose/catalog';
import { AnimationPlayer } from './pose/player';
import { createDebug, type StudioDebug } from './debug';
import { createBuddy, describeBuddy, loadOriginalAssets, type BuddyInfo } from './original';
import { CharacterRig } from './scene/CharacterRig';
import { characterBounds } from './scene/framing';
import { Sidebar } from './ui/Sidebar';
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
  const [player, setPlayer] = useState<AnimationPlayer | null>(null);
  const [entries, setEntries] = useState<AnimationEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    let built: CharacterRig | null = null;
    const started = performance.now();
    (async () => {
      const assets = await loadOriginalAssets();
      const buddy = await createBuddy(assets, LOOK);
      built = new CharacterRig(buddy);
      // Created before any animation runs, so it snapshots the untouched original bind pose.
      const animation = new AnimationPlayer(buddy.scene, buddy.animations, built);
      // Re-dressing hides props and rebuilds materials: show the current animation frame again.
      built.subscribe(() => animation.reapply());
      // Measure the T-pose once (before the first frame) so the default framing fits every mode.
      animation.showTPose();
      built.framingExtra = characterBounds(built);
      animation.showRest();
      const control = await CharacterController.create(assets, buddy, built);
      const info = await describeBuddy(buddy, assets.wardrobe);
      const catalog = buildCatalog({
        clips: animation.clipNames().map(name => ({ name, frameCount: buddy.animations.get(name)!.frameCount, fps: buddy.animations.get(name)!.fps })),
        moods: assets.moods,
        pokes: assets.pokes,
      });
      if (catalog.missing.length) console.warn('Animations listed in the original XML but missing from the package:', catalog.missing);
      return { next: { status: 'ready', info, ms: Math.round(performance.now() - started) } as const, control, animation, catalog: catalog.entries };
    })()
      .then(({ next, control, animation, catalog }) => {
        if (cancelled) return;
        window.__studio = { ...next, debug: createDebug(control, animation, catalog) };
        setEntries(catalog);
        setRig(built);
        setController(control);
        setPlayer(animation);
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

  if (COMPARE) return rig ? <ComparisonViewport rig={rig} player={player} /> : null;

  return (
    <div className="studio">
      <header className="topbar">
        <span className="brand">BuddyPoke Studio</span>
        <span className="badge">M3B · export</span>
        <span className="spacer" />
        <span className={`status status-${state.status}`}>
          {state.status === 'loading' && 'Loading original assets…'}
          {state.status === 'ready' && `Original data loaded in ${state.ms} ms`}
          {state.status === 'error' && 'Failed to load original assets'}
        </span>
      </header>
      <main className="viewport">
        <Viewport rig={rig} player={player} entries={entries} />
      </main>
      <aside className="panel">
        {controller && player ? <Sidebar controller={controller} player={player} entries={entries} /> : <DataPanel state={state} />}
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
