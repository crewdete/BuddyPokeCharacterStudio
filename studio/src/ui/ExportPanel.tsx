// Export tab: GLB static, rigged or animated (M3B, M3C-3). Every export is built from a fresh original buddy with
// the current look; the live character, its pose and its playback are never touched.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CharacterController } from '../character/controller';
import { defaultFileName, exportCharacter, type ExportOptions, type ExportStep } from '../export';
import { estimateAnimated, lookStats, type LookStats } from '../export/estimate';
import { downloadFile } from '../export/glb';
import { GROUPS, filterCatalog, type AnimationEntry, type AnimationGroup } from '../pose/catalog';
import { useExportUi, type ExportFormat } from '../state/export';

type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; step: ExportStep; done?: number; total?: number }
  | { kind: 'done'; text: string; detail: string }
  | { kind: 'error'; text: string };

const STEP_TEXT: Record<ExportStep, string> = {
  preparing: 'Preparing the character (fresh copy of the original data)…',
  sampling: 'Sampling animations from the original engine',
  writing: 'Writing GLB…',
  verifying: 'Verifying the file…',
};

export const formatBytes = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const seconds = (e: AnimationEntry) => `${((e.frameCount - 1) / e.fps).toFixed(1)} s`;
const CATEGORIES = GROUPS.filter((g): g is { id: AnimationGroup; label: string } => g.id !== 'all');

function Choice<T extends string>({ label, value, options, onChange, disabled }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <fieldset className="choice" disabled={disabled}>
      <legend className="field-label">{label}</legend>
      <div className="segmented-row" role="radiogroup" aria-label={label}>
        {options.map(([id, text]) => (
          <button key={id} type="button" role="radio" aria-checked={value === id} onClick={() => onChange(id)}>
            {text}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** Checkbox that can show "some selected". */
function Check({ checked, mixed, onChange, label, disabled, testId }: { checked: boolean; mixed?: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean; testId?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!mixed;
  }, [mixed]);
  return <input ref={ref} type="checkbox" aria-label={label} checked={checked} disabled={disabled} data-testid={testId} onChange={e => onChange(e.target.checked)} />;
}

// One look-stats computation at a time, reused while the look stays the same.
let statsCache: { code: string; promise: Promise<LookStats> } | null = null;

export function ExportPanel({ controller, entries }: { controller: CharacterController; entries: AnimationEntry[] }) {
  const ui = useExportUi();
  const code = useSyncExternalStore(listener => controller.subscribe(listener), () => controller.currentCode);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [base, setBase] = useState<{ key: string; bytes: number } | null>(null);
  const [stats, setStats] = useState<LookStats | null>(null);
  const animated = ui.format === 'animated';

  // Clips in the original package order (the order of the exported Actions), as listed by the catalog.
  const allClips = useMemo(() => {
    const listed = new Set(entries.map(e => e.clip));
    return [...controller.buddy.animations.keys()].filter(c => listed.has(c));
  }, [entries, controller.buddy]);
  const selected = useMemo(() => {
    const set = new Set(ui.clips);
    return allClips.filter(c => set.has(c));
  }, [ui.clips, allClips]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const shown = useMemo(() => filterCatalog(entries, 'all', ui.query), [entries, ui.query]);

  const options: ExportOptions = {
    pose: ui.pose,
    skeleton: ui.format !== 'static',
    rigidParts: ui.rigidParts,
    material: ui.material,
    ...(animated ? { animations: selected, rootMotion: ui.rootMotion } : {}),
  };
  const suggested = defaultFileName(code, options);
  const name = (ui.fileName.trim() || suggested).replace(/[\\/:*?"<>|]+/g, '-').replace(/(\.glb)?$/i, '.glb');

  // Exact size of the same export without clips (the whole file for static/rigged), recomputed after changes.
  const baseKey = JSON.stringify([code, ui.format, ui.pose, ui.rigidParts, ui.material]);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const result = await exportCharacter(controller.assets, code, { ...options, animations: animated ? [] : undefined, rootMotion: undefined });
        if (!cancelled) setBase({ key: baseKey, bytes: result.glb.byteLength });
      } catch {
        if (!cancelled) setBase(null);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseKey]);
  useEffect(() => {
    if (!animated) return;
    let cancelled = false;
    if (statsCache?.code !== code) statsCache = { code, promise: lookStats(controller.assets, code) };
    statsCache.promise.then(s => !cancelled && setStats(s)).catch(() => !cancelled && setStats(null));
    return () => {
      cancelled = true;
    };
  }, [animated, code, controller.assets]);

  const estimate = useMemo(() => {
    if (!base || base.key !== baseKey) return null;
    if (!animated) return { bytes: base.bytes, text: `${formatBytes(base.bytes)}` };
    if (!stats || stats.lookCode !== code) return null;
    const e = estimateAnimated(stats, base.bytes, selected, ui.rootMotion);
    return { bytes: e.bytes, text: `≈ ${formatBytes(e.bytes)} · ${e.clips} clip${e.clips === 1 ? '' : 's'} · ${e.props.length ? `props: ${e.props.join(', ')}` : 'no props'} · ${e.faces} facial expression${e.faces === 1 ? '' : 's'}` };
  }, [base, baseKey, animated, stats, code, selected, ui.rootMotion]);
  const propsOf = (clip: string) => stats?.clips.get(clip)?.shows ?? [];

  const busy = status.kind === 'busy';
  const blocked = animated && selected.length === 0;
  const run = async () => {
    if (blocked) return;
    const started = performance.now();
    try {
      const result = await exportCharacter(controller.assets, code, options, (step, done, total) => setStatus({ kind: 'busy', step, done, total }));
      if (!result.check.ok) {
        setStatus({ kind: 'error', text: `The file failed verification and was not saved: ${result.check.problems.slice(0, 3).join('; ')}` });
        return;
      }
      downloadFile(name, result.glb);
      const s = result.check.summary;
      const m = result.manifest;
      setStatus({
        kind: 'done',
        text: `Saved ${name} (${formatBytes(s.bytes)}) in ${((performance.now() - started) / 1000).toFixed(1)} s`,
        detail: [
          `${s.meshes} meshes`,
          options.skeleton ? `${s.joints} bones` : null,
          animated ? `${m.animations.length} animation${m.animations.length === 1 ? '' : 's'} (30 fps, ${m.rootMotion === 'inPlace' ? 'in place' : 'root motion kept'})` : null,
          animated ? `${m.props.length ? `props: ${m.props.map(p => p.name).join(', ')}` : 'no props'}` : null,
          animated ? `${m.faces.length} facial expressions` : null,
          `${s.textures} embedded textures`,
          `${s.transparent} transparent materials`,
          'verified',
        ].filter(Boolean).join(' · '),
      });
    } catch (error) {
      setStatus({ kind: 'error', text: `Export failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  };

  const groupState = (group: AnimationGroup) => {
    const clips = [...new Set(entries.filter(e => e.group === group).map(e => e.clip))];
    const n = clips.filter(c => selectedSet.has(c)).length;
    return { clips, n };
  };

  return (
    <section className="tab-body export" aria-label="Export">
      <Choice<ExportFormat>
        label="Format"
        value={ui.format}
        options={[['static', 'GLB · static mesh'], ['rigged', 'GLB · rigged'], ['animated', 'GLB · animated']]}
        onChange={format => ui.set({ format })}
        disabled={busy}
      />
      <p className="hint">
        {ui.format === 'static' && 'Binary glTF 2.0 with the posed meshes and embedded textures, no skeleton. For static renders and 3D printing previews.'}
        {ui.format === 'rigged' && 'Binary glTF 2.0 with the original 29-bone skeleton (original names and hierarchy), skin weights and embedded textures. Opens in Blender, Unity, Unreal, Godot and three.js.'}
        {animated && 'The rigged character plus the original animations: one action per clip, every frame of the original at 30 fps without interpolation, with the props and facial expressions each clip uses.'}
      </p>
      <Choice label={animated ? 'Initial pose' : 'Pose'} value={ui.pose} options={[['rest', 'Rest'], ['tpose', 'T-pose']]} onChange={pose => ui.set({ pose })} disabled={busy} />
      {animated && <p className="hint">The pose the file opens in. The skin is always bound to the original Rest pose, so every animation plays exactly as in the original.</p>}
      {animated && (
        <>
          <Choice label="Root motion" value={ui.rootMotion} options={[['keep', 'Keep root motion'], ['inPlace', 'In place']]} onChange={rootMotion => ui.set({ rootMotion })} disabled={busy} />
          <p className="hint">
            {ui.rootMotion === 'keep'
              ? 'The character travels as in the original (pokes walk toward the partner, flying rises).'
              : 'Horizontal movement of the root (Bip01) is removed; vertical movement and all rotations are kept. For game-engine locomotion.'}
          </p>
          <fieldset className="clip-picker" disabled={busy}>
            <legend className="field-label">Animations</legend>
            <div className="clip-summary">
              <span id="export-clip-count" aria-live="polite">{selected.length} of {allClips.length} clips selected</span>
              <span className="clip-bulk">
                <button type="button" onClick={() => ui.setClips(allClips, true)}>Select all</button>
                <button type="button" onClick={() => ui.setClips(allClips, false)}>Deselect all</button>
              </span>
            </div>
            <div className="clip-categories" role="group" aria-label="Select by category">
              {CATEGORIES.map(g => {
                const { clips, n } = groupState(g.id);
                return (
                  <label key={g.id} className="clip-category">
                    <Check label={`All ${g.label}`} checked={n === clips.length && n > 0} mixed={n > 0 && n < clips.length} onChange={on => ui.setClips(clips, on)} testId={`export-group-${g.id}`} />
                    {g.label} <span className="count">{n}/{clips.length}</span>
                  </label>
                );
              })}
            </div>
            <label className="visually-hidden" htmlFor="export-clip-search">Search animations</label>
            <input id="export-clip-search" type="search" className="search-field" placeholder="Search animations" value={ui.query} onChange={e => ui.set({ query: e.target.value })} />
            <div className="export-clip-list" role="group" aria-label="Animations to export">
              {CATEGORIES.map(g => {
                const list = shown.filter(e => e.group === g.id);
                if (!list.length) return null;
                return (
                  <div key={g.id}>
                    <p className="clip-group-head">{g.label}</p>
                    {list.map(entry => (
                      <label key={entry.id} className="clip-row" data-entry={entry.id} data-clip={entry.clip}>
                        <Check label={`${entry.name}${entry.side ? ` (${entry.side})` : ''} · ${entry.clip}`} checked={selectedSet.has(entry.clip)} onChange={on => ui.setClips([entry.clip], on)} />
                        <span className="clip-text">
                          <span className="anim-name">
                            {entry.name}
                            {entry.side && <span className={`side side-${entry.side}`}>{entry.side}</span>}
                            {propsOf(entry.clip).map(p => <span key={p} className="side prop-tag">{p === 'Strat' ? 'Guitar' : p}</span>)}
                          </span>
                          <span className="anim-meta">{entry.clip} · {seconds(entry)}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                );
              })}
              {shown.length === 0 && <p className="hint">No animations match “{ui.query}”.</p>}
            </div>
            <p className="hint">A clip listed under several names (e.g. a mood that is also half of a poke) is exported once, under its original id.</p>
          </fieldset>
        </>
      )}
      {ui.format !== 'static' && (
        <Choice label="Head and short hair" value={ui.rigidParts} options={[['skin', 'Skin to bone'], ['parent', 'Keep parented']]} onChange={rigidParts => ui.set({ rigidParts })} disabled={busy} />
      )}
      <Choice label="Material" value={ui.material} options={[['unlit', 'Unlit (original look)'], ['lit', 'Lit (PBR)']]} onChange={material => ui.set({ material })} disabled={busy} />
      <label className="field-label" htmlFor="export-name">File name</label>
      <input id="export-name" className="code-field" value={ui.fileName} placeholder={suggested} spellCheck={false} onChange={e => ui.set({ fileName: e.target.value })} disabled={busy} />
      <p className="hint" id="export-estimate" aria-live="polite">
        {blocked ? 'Select at least one animation to export.' : estimate ? `${animated ? 'Estimated size' : 'Size'}: ${estimate.text}` : 'Estimating size…'}
      </p>
      <div className="row-actions">
        <button type="button" className="primary" onClick={run} disabled={busy || blocked}>
          {busy ? 'Exporting…' : 'Export GLB'}
        </button>
      </div>
      {busy && status.step === 'sampling' && status.total ? <progress className="export-progress" value={status.done} max={status.total} aria-label="Export progress" /> : null}
      <p className={`feedback${status.kind === 'error' ? ' feedback-error' : ''}`} role="status" aria-live="polite" id="export-status">
        {status.kind === 'busy' && (status.step === 'sampling' && status.total ? `${STEP_TEXT.sampling}: ${status.done} of ${status.total}…` : STEP_TEXT[status.step])}
        {status.kind === 'done' && status.text}
        {status.kind === 'error' && status.text}
      </p>
      {status.kind === 'done' && <p className="hint" id="export-detail">{status.detail}</p>}
      {animated && (
        <p className="hint export-note" id="export-blender-note">
          <strong>Blender:</strong> set the scene frame rate to <strong>30 fps</strong> (Output Properties → Format → Frame Rate) <em>before</em> File → Import → glTF 2.0;
          Blender converts the file's seconds to frames at the scene rate. Each clip becomes an Action with its original name. Props and facial expressions are separate
          objects with their own slot in each Action: assign the Action to the armature and to them (see the README).
        </p>
      )}
      <p className="hint">
        Exports the current look as dressed, never the live animation frame. {animated ? 'The ground shadow is not included.' : 'Props and the ground shadow are not included.'} Units are metres (1 original unit = 1 cm). FBX and OBJ are not offered: see the README for why.
      </p>
    </section>
  );
}
