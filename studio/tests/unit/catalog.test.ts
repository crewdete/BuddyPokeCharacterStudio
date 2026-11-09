import { describe, expect, it } from 'vitest';
import { buildCatalog, entryLabel, filterCatalog, nameFromClip } from '../../src/pose/catalog';

const clip = (name: string) => ({ name, frameCount: 31, fps: 30 });
const source = {
  clips: ['mood_happy', 'hug1', 'hug2', 'celebrate1', 'celebrate2', 'pose_stand', 'pose_stand_lookAround', 'standBreathe', 'mood_applause'].map(clip),
  moods: [{ name: 'happy', a0: 'mood_happy' }, { name: 'excited', a0: 'celebrate1' }, { name: 'ghost', a0: 'mood_missing' }],
  pokes: [{ name: 'hug', a0: 'hug1', a1: 'hug2' }, { name: 'celebrate', a0: 'celebrate1', a1: 'celebrate2' }],
};

describe('animation catalog', () => {
  const { entries, missing } = buildCatalog(source);

  it('builds moods, both poke halves, idle and other from the original lists', () => {
    expect(entries.map(e => [e.group, entryLabel(e), e.clip])).toEqual([
      ['mood', 'Happy', 'mood_happy'],
      ['mood', 'Excited', 'celebrate1'],
      ['poke', 'Hug — you', 'hug1'],
      ['poke', 'Hug — friend', 'hug2'],
      ['poke', 'Celebrate — you', 'celebrate1'],
      ['poke', 'Celebrate — friend', 'celebrate2'],
      ['idle', 'Stand', 'pose_stand'],
      ['idle', 'Stand · look around', 'pose_stand_lookAround'],
      ['other', 'Stand breathe', 'standBreathe'],
      ['other', 'Applause', 'mood_applause'],
    ]);
  });

  it('covers every clip, keeps ids unique and reports listed clips missing from the package', () => {
    expect(new Set(entries.map(e => e.clip))).toEqual(new Set(source.clips.map(c => c.name)));
    expect(new Set(entries.map(e => e.id)).size).toBe(entries.length);
    expect(missing).toEqual(['mood:Ghost -> mood_missing']);
  });

  it('filters by group and searches name, side and clip id (case-insensitive, all terms)', () => {
    expect(filterCatalog(entries, 'poke', '').length).toBe(4);
    expect(filterCatalog(entries, 'all', 'HUG').map(entryLabel)).toEqual(['Hug — you', 'Hug — friend']);
    expect(filterCatalog(entries, 'all', 'hug friend').map(entryLabel)).toEqual(['Hug — friend']);
    expect(filterCatalog(entries, 'all', 'celebrate1').map(entryLabel)).toEqual(['Excited', 'Celebrate — you']);
    expect(filterCatalog(entries, 'idle', 'look').map(e => e.clip)).toEqual(['pose_stand_lookAround']);
    expect(filterCatalog(entries, 'mood', 'zzz')).toEqual([]);
  });

  it('derives readable names from clip ids', () => {
    expect(nameFromClip('pose_contra_canCan')).toBe('Contra · can can');
    expect(nameFromClip('mood_gonnaSoarNow')).toBe('Gonna soar now');
    expect(nameFromClip('pose_joinNow')).toBe('Join now');
  });
});
