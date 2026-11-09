import { create } from 'zustand';

export type Projection = 'perspective' | 'orthographic';

interface ViewportState {
  projection: Projection;
  /** Incremented to request a camera reset (frame the character from the front). */
  resetToken: number;
  showGrid: boolean;
  /** Skeleton overlay (the real bones of the rig). */
  showSkeleton: boolean;
  /** X-ray: draw the skeleton on top of the character instead of depth-tested inside it. */
  xray: boolean;
  setProjection: (projection: Projection) => void;
  toggleProjection: () => void;
  resetCamera: () => void;
  setShowGrid: (show: boolean) => void;
  setShowSkeleton: (show: boolean) => void;
  setXray: (xray: boolean) => void;
}

export const useViewport = create<ViewportState>(set => ({
  projection: 'perspective',
  resetToken: 0,
  showGrid: true,
  showSkeleton: false,
  xray: true,
  setProjection: projection => set({ projection }),
  toggleProjection: () => set(s => ({ projection: s.projection === 'perspective' ? 'orthographic' : 'perspective' })),
  resetCamera: () => set(s => ({ resetToken: s.resetToken + 1 })),
  setShowGrid: showGrid => set({ showGrid }),
  setShowSkeleton: showSkeleton => set({ showSkeleton }),
  setXray: xray => set({ xray }),
}));
