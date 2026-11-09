// Animation browser: every original clip, named from the original moods.xml / pokes.xml.
import { useMemo } from 'react';
import { GROUPS, entryLabel, filterCatalog, type AnimationEntry } from '../pose/catalog';
import type { AnimationPlayer } from '../pose/player';
import { usePlaybackUi } from '../state/playback';
import { usePlayer } from './usePlayer';

const seconds = (e: AnimationEntry) => `${((e.frameCount - 1) / e.fps).toFixed(1)} s`;

export function AnimatePanel({ player, entries }: { player: AnimationPlayer; entries: AnimationEntry[] }) {
  const { group, query, selectedEntry, setGroup, setQuery, setSelectedEntry } = usePlaybackUi();
  const { clip } = usePlayer(player);
  const shown = useMemo(() => filterCatalog(entries, group, query), [entries, group, query]);
  // The picked entry, or (if the clip was started some other way) the first entry for the playing clip.
  const current = entries.find(e => e.id === selectedEntry && e.clip === clip) ?? entries.find(e => e.clip === clip) ?? null;
  const counts = useMemo(() => Object.fromEntries(GROUPS.map(g => [g.id, filterCatalog(entries, g.id, '').length])), [entries]);

  const start = (entry: AnimationEntry) => {
    setSelectedEntry(entry.id);
    player.select(entry.clip); // always from frame 0, from the exact bind pose
    player.play();
  };

  return (
    <section className="tab-body animate" aria-label="Animate">
      <div className="group-filter" role="radiogroup" aria-label="Animation group">
        {GROUPS.map(g => (
          <button key={g.id} type="button" role="radio" aria-checked={group === g.id} onClick={() => setGroup(g.id)}>
            {g.label} <span className="count">{counts[g.id]}</span>
          </button>
        ))}
      </div>
      <label className="visually-hidden" htmlFor="animation-search">Search animations</label>
      <input id="animation-search" type="search" className="search-field" placeholder="Search animations" value={query} onChange={e => setQuery(e.target.value)} />
      <p className="hint" aria-live="polite">
        {shown.length} of {entries.length} entries · {new Set(entries.map(e => e.clip)).size} clips
      </p>
      <ul className="animation-list" role="listbox" aria-label="Animations">
        {shown.map(entry => (
          <li key={entry.id}>
            <button
              type="button"
              role="option"
              aria-selected={current?.id === entry.id}
              data-entry={entry.id}
              data-clip={entry.clip}
              onClick={() => start(entry)}
            >
              <span className="anim-name">
                {entry.name}
                {entry.side && <span className={`side side-${entry.side}`}>{entry.side}</span>}
              </span>
              <span className="anim-meta">
                {entry.clip} · {seconds(entry)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {shown.length === 0 && <p className="hint">No animations match “{query}”.</p>}
      <p className="hint">Pokes are two-character animations; each half plays alone here.</p>
    </section>
  );
}

export { entryLabel };
