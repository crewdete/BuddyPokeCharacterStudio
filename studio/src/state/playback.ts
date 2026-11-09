import { create } from 'zustand';
import type { AnimationGroup } from '../pose/catalog';

interface PlaybackUiState {
  group: AnimationGroup | 'all';
  query: string;
  /** Catalog entry the user picked (clips can be listed under several entries). */
  selectedEntry: string | null;
  setGroup: (group: AnimationGroup | 'all') => void;
  setQuery: (query: string) => void;
  setSelectedEntry: (id: string | null) => void;
}

export const usePlaybackUi = create<PlaybackUiState>(set => ({
  group: 'all',
  query: '',
  selectedEntry: null,
  setGroup: group => set({ group }),
  setQuery: query => set({ query }),
  setSelectedEntry: selectedEntry => set({ selectedEntry }),
}));
