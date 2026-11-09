// Export tab settings (M3C-3). Kept in a store so the clip selection survives switching tabs.
import { create } from 'zustand';
import type { ExportPose, MaterialMode, RigidParts, RootMotion } from '../export/prepare';

export type ExportFormat = 'static' | 'rigged' | 'animated';

interface ExportUiState {
  format: ExportFormat;
  pose: ExportPose;
  rigidParts: RigidParts;
  material: MaterialMode;
  rootMotion: RootMotion;
  /** Selected original clip ids (a clip listed under several catalog entries is selected once). */
  clips: string[];
  query: string;
  fileName: string;
  set: (patch: Partial<Omit<ExportUiState, 'set' | 'toggle' | 'setClips'>>) => void;
  /** Select (on) or deselect (off) the given clips. */
  setClips: (clips: string[], on: boolean) => void;
}

export const useExportUi = create<ExportUiState>(set => ({
  format: 'rigged',
  pose: 'tpose',
  rigidParts: 'skin',
  material: 'unlit',
  rootMotion: 'keep',
  clips: [],
  query: '',
  fileName: '',
  set: patch => set(patch),
  setClips: (clips, on) =>
    set(state => {
      const next = new Set(state.clips);
      for (const c of clips) (on ? next.add(c) : next.delete(c));
      return { clips: [...next] };
    }),
}));
