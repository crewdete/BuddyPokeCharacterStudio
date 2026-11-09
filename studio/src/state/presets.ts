import { create } from 'zustand';
import { cleanName, readPresets, uniqueName, writePresets, type Preset } from '../character/presets';

const storage = (() => {
  try {
    return window.localStorage;
  } catch {
    return null; // blocked (privacy mode, sandbox): presets then live for this session only
  }
})();

interface PresetState {
  presets: Preset[];
  /** False when presets could not be written to browser storage. */
  persisted: boolean;
  /** Save under `name`; an existing preset with the same name is updated. Returns the saved preset and whether it was new. */
  save: (name: string, code: string) => { preset: Preset; created: boolean };
  /** Add an imported preset, renaming it if the name is taken. */
  add: (name: string, code: string) => Preset;
  remove: (id: string) => void;
}

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const usePresets = create<PresetState>((set, get) => {
  const commit = (presets: Preset[]) => set({ presets, persisted: writePresets(storage, presets) });
  return {
    presets: readPresets(storage),
    persisted: storage !== null,
    save(name, code) {
      const clean = cleanName(name) || uniqueName('Preset', get().presets);
      const existing = get().presets.find(p => p.name === clean);
      const preset: Preset = { id: existing?.id ?? newId(), name: clean, code, savedAt: new Date().toISOString() };
      commit(existing ? get().presets.map(p => (p.id === existing.id ? preset : p)) : [...get().presets, preset]);
      return { preset, created: !existing };
    },
    add(name, code) {
      const preset: Preset = { id: newId(), name: uniqueName(cleanName(name) || 'Imported preset', get().presets), code, savedAt: new Date().toISOString() };
      commit([...get().presets, preset]);
      return preset;
    },
    remove(id) {
      commit(get().presets.filter(p => p.id !== id));
    },
  };
});
