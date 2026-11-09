// Animation browser catalog, built from the ORIGINAL data:
//   moods  - web/assets/moods.xml  (<mood name a0>): one entry per mood
//   pokes  - web/assets/pokes.xml  (<poke name a0 a1>): two entries per poke, "you" (a0) and "friend" (a1)
//   idle   - every pose_* clip (the idle chain of web/src/domain/poses.js)
//   other  - clips referenced by none of the above
// Some clips appear under several entries (e.g. celebrate1 is the mood "excited" and the "you" half of the
// poke "celebrate"), exactly as in the original lists. Idle and other clips have no names in the original
// data, so their labels are derived from the clip id; every entry also shows its clip id.

export type AnimationGroup = 'mood' | 'poke' | 'idle' | 'other';
export const GROUPS: { id: AnimationGroup | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'mood', label: 'Moods' },
  { id: 'poke', label: 'Pokes' },
  { id: 'idle', label: 'Idle' },
  { id: 'other', label: 'Other' },
];

export interface AnimationEntry {
  /** Unique within the catalog (clips may repeat across entries). */
  id: string;
  group: AnimationGroup;
  /** Display name (original mood/poke name, or derived from the clip id). */
  name: string;
  /** Poke half, if any. */
  side?: 'you' | 'friend';
  clip: string;
  frameCount: number;
  fps: number;
}

export interface CatalogSource {
  clips: { name: string; frameCount: number; fps: number }[];
  moods: { name: string; a0: string }[];
  pokes: { name: string; a0: string; a1: string }[];
}

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "pose_stand_lookAround" -> "Stand · look around"; "mood_applause" -> "Applause"; "standBreathe" -> "Stand breathe". */
export function nameFromClip(clip: string): string {
  const words = (part: string) => part.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  const parts = clip.replace(/^(pose|mood)_/, '').split('_').map(words);
  return capitalize(parts.join(' · '));
}

export function buildCatalog({ clips, moods, pokes }: CatalogSource): { entries: AnimationEntry[]; missing: string[] } {
  const byName = new Map(clips.map(c => [c.name, c]));
  const entries: AnimationEntry[] = [];
  const missing: string[] = [];
  const used = new Set<string>();
  const add = (entry: Omit<AnimationEntry, 'frameCount' | 'fps'>) => {
    const clip = byName.get(entry.clip);
    if (!clip) return missing.push(`${entry.group}:${entry.name} -> ${entry.clip}`);
    used.add(entry.clip);
    entries.push({ ...entry, frameCount: clip.frameCount, fps: clip.fps });
  };
  for (const mood of moods) add({ id: `mood:${mood.a0}:${mood.name}`, group: 'mood', name: capitalize(mood.name), clip: mood.a0 });
  for (const poke of pokes) {
    add({ id: `poke:${poke.a0}:${poke.name}`, group: 'poke', name: capitalize(poke.name), side: 'you', clip: poke.a0 });
    add({ id: `poke:${poke.a1}:${poke.name}`, group: 'poke', name: capitalize(poke.name), side: 'friend', clip: poke.a1 });
  }
  for (const { name } of clips) if (name.startsWith('pose_')) add({ id: `idle:${name}`, group: 'idle', name: nameFromClip(name), clip: name });
  for (const { name } of clips) if (!used.has(name)) add({ id: `other:${name}`, group: 'other', name: nameFromClip(name), clip: name });
  return { entries, missing };
}

/** Group filter + case-insensitive search over name, poke side and clip id. */
export function filterCatalog(entries: AnimationEntry[], group: AnimationGroup | 'all', query: string): AnimationEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter(e => {
    if (group !== 'all' && e.group !== group) return false;
    const text = `${e.name} ${e.side ?? ''} ${e.clip}`.toLowerCase();
    return terms.every(t => text.includes(t));
  });
}

export const entryLabel = (e: AnimationEntry) => (e.side ? `${e.name} — ${e.side}` : e.name);
