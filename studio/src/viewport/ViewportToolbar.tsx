import { useEffect } from 'react';
import { useViewport } from '../state/viewport';

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

export function ViewportToolbar() {
  const { projection, setProjection, resetCamera, showGrid, setShowGrid, toggleProjection } = useViewport();

  // Blender-style shortcuts: Numpad 5 / 5 toggles projection, Home / F frames the character, G grid.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (typing(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.code === 'Numpad5' || event.key === '5') toggleProjection();
      else if (event.key === 'Home' || event.key === 'f' || event.key === 'F') resetCamera();
      else if (event.key === 'g' || event.key === 'G') setShowGrid(!useViewport.getState().showGrid);
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleProjection, resetCamera, setShowGrid]);

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
    </div>
  );
}
