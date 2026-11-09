// Transport bar under the viewport: drives the M3A-1 AnimationPlayer.
import { useEffect } from 'react';
import { entryLabel, type AnimationEntry } from '../pose/catalog';
import type { AnimationPlayer } from '../pose/player';
import { usePlaybackUi } from '../state/playback';
import { usePlayer } from '../ui/usePlayer';

export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

/** Controls whose own keyboard behaviour must win (typing, selecting, sliders). */
const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

const Icon = ({ kind }: { kind: 'play' | 'pause' | 'stop' }) => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
    {kind === 'play' && <path d="M2.5 1.5v9l8-4.5z" fill="currentColor" />}
    {kind === 'pause' && <path d="M2.5 1.5h2.5v9H2.5zM7 1.5h2.5v9H7z" fill="currentColor" />}
    {kind === 'stop' && <path d="M2 2h8v8H2z" fill="currentColor" />}
  </svg>
);

export function Transport({ player, entries }: { player: AnimationPlayer; entries: AnimationEntry[] }) {
  const s = usePlayer(player);
  const selectedEntry = usePlaybackUi(u => u.selectedEntry);
  const entry = entries.find(e => e.id === selectedEntry && e.clip === s.clip) ?? entries.find(e => e.clip === s.clip);
  const hasClip = s.clip !== null;
  const last = Math.max(0, s.frameCount - 1);

  // Space: play/pause. Comma / period: previous / next frame while paused.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (editable(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === ' ' || event.code === 'Space') {
        if (!player.snapshot().clip) return;
        event.preventDefault(); // also stops a focused button from being "clicked" by Space
        if (player.playing) player.pause();
        else player.play();
      } else if (event.key === ',' || event.key === '.') {
        if (player.playing || !player.snapshot().clip) return;
        event.preventDefault();
        player.step(event.key === ',' ? -1 : 1);
      }
    };
    // Space activates focused buttons on keyup; swallow that too so it cannot restart a clip.
    const onKeyUp = (event: KeyboardEvent) => {
      if ((event.key === ' ' || event.code === 'Space') && !editable(event.target) && player.snapshot().clip) event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [player]);

  return (
    <div className="transport" role="toolbar" aria-label="Animation playback">
      <div className="transport-row">
        <button
          type="button"
          className="icon-button"
          aria-label={s.state === 'playing' ? 'Pause' : 'Play'}
          title={s.state === 'playing' ? 'Pause (Space)' : 'Play (Space)'}
          disabled={!hasClip}
          onClick={() => (player.playing ? player.pause() : player.play())}
        >
          <Icon kind={s.state === 'playing' ? 'pause' : 'play'} />
        </button>
        <button type="button" className="icon-button" aria-label="Stop" title="Stop (rest pose)" disabled={!hasClip || s.state === 'rest'} onClick={() => player.stop()}>
          <Icon kind="stop" />
        </button>
        <span className="transport-name" title={entry ? `${entryLabel(entry)} (${entry.clip})` : undefined}>
          {entry ? entryLabel(entry) : 'No animation selected'}
        </span>
        <span className="transport-frame" aria-label="Frame">
          {hasClip ? `${String(s.frame).padStart(String(last).length, '0')} / ${last}` : '– / –'}
        </span>
      </div>
      <div className="transport-row">
        <label className="visually-hidden" htmlFor="frame-slider">Frame</label>
        <input
          id="frame-slider"
          className="frame-slider"
          type="range"
          min={0}
          max={last}
          step={1}
          value={hasClip ? s.frame : 0}
          disabled={!hasClip}
          onChange={e => player.seek(Number(e.target.value))}
        />
        <button type="button" className="tool" aria-pressed={s.loop} onClick={() => player.setLoop(!s.loop)} title="Loop">
          Loop
        </button>
        <label className="visually-hidden" htmlFor="speed">Playback speed</label>
        <select id="speed" className="speed" value={s.speed} onChange={e => player.setSpeed(Number(e.target.value))}>
          {SPEEDS.map(v => (
            <option key={v} value={v}>
              {v}×
            </option>
          ))}
        </select>
        <div className="segmented" role="radiogroup" aria-label="Pose">
          <button type="button" role="radio" aria-checked={s.mode === 'rest'} onClick={() => player.showRest()} title="Original rest pose">
            Rest
          </button>
          <button type="button" role="radio" aria-checked={s.mode === 'animation'} disabled={!hasClip} onClick={() => player.showAnimation()} title="Animation frame">
            Animation
          </button>
        </div>
      </div>
    </div>
  );
}
