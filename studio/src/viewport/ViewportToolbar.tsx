import { useEffect } from 'react';
import { useViewport } from '../state/viewport';

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

export function ViewportToolbar() {
  const { projection, setProjection, resetCamera, showGrid, setShowGrid, toggleProjection, showSkeleton, setShowSkeleton, xray, setXray } = useViewport();

  // Shortcuts: Numpad 5 / 5 projection, Home / F frame the character, G grid, B skeleton (bones), X X-ray.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (typing(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key.toLowerCase();
      const state = useViewport.getState();
      if (event.code === 'Numpad5' || event.key === '5') toggleProjection();
      else if (event.key === 'Home' || key === 'f') resetCamera();
      else if (key === 'g') setShowGrid(!state.showGrid);
      else if (key === 'b') setShowSkeleton(!state.showSkeleton);
      else if (key === 'x') setXray(!state.xray);
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleProjection, resetCamera, setShowGrid, setShowSkeleton, setXray]);

  return (
    <div className="viewport-toolbar" role="toolbar" aria-label="Viewport">
      <div className="segmented" role="group" aria-label="Projection">
        <button type="button" aria-pressed={projection === 'perspective'} onClick={() => setProjection('perspective')} title="Perspective (5)">
          Persp
        </button>
        <button type="button" aria-pressed={projection === 'orthographic'} onClick={() => setProjection('orthographic')} title="Orthographic (5)">
          Ortho
        </button>
      </div>
      <button type="button" className="tool" onClick={resetCamera} title="Reset view (Home / F)">
        Reset view
      </button>
      <button type="button" className="tool" aria-pressed={showGrid} onClick={() => setShowGrid(!showGrid)} title="Grid (G)">
        Grid
      </button>
      <button type="button" className="tool" aria-pressed={showSkeleton} onClick={() => setShowSkeleton(!showSkeleton)} title="Skeleton overlay (B)">
        Skeleton
      </button>
      <button type="button" className="tool" aria-pressed={xray} disabled={!showSkeleton} onClick={() => setXray(!xray)} title="X-ray: bones drawn through the character (X)">
        X-ray
      </button>
    </div>
  );
}
