// Export tab: GLB (rigged or static), Rest or T-pose, built from a fresh original buddy with the current look.
import { useState } from 'react';
import type { CharacterController } from '../character/controller';
import { DEFAULT_EXPORT, defaultFileName, exportCharacter, type ExportOptions, type ExportStep } from '../export';
import { downloadFile } from '../export/glb';

type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; step: ExportStep }
  | { kind: 'done'; text: string; detail: string }
  | { kind: 'error'; text: string };

const STEP_TEXT: Record<ExportStep, string> = {
  preparing: 'Preparing the character (fresh copy of the original data)…',
  writing: 'Writing GLB…',
  verifying: 'Verifying the file…',
};

const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

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

export function ExportPanel({ controller }: { controller: CharacterController }) {
  const [options, setOptions] = useState<ExportOptions>(DEFAULT_EXPORT);
  const [fileName, setFileName] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const set = (patch: Partial<ExportOptions>) => setOptions(o => ({ ...o, ...patch }));
  const suggested = defaultFileName(controller.currentCode, options);
  const name = (fileName.trim() || suggested).replace(/[\\/:*?"<>|]+/g, '-').replace(/(\.glb)?$/i, '.glb');

  const run = async () => {
    try {
      const result = await exportCharacter(controller.assets, controller.currentCode, options, step => setStatus({ kind: 'busy', step }));
      if (!result.check.ok) {
        setStatus({ kind: 'error', text: `Export failed verification: ${result.check.problems.join('; ')}` });
        return;
      }
      downloadFile(name, result.glb);
      const s = result.check.summary;
      setStatus({
        kind: 'done',
        text: `Saved ${name}`,
        detail: `${kb(s.bytes)} · ${s.meshes} meshes${options.skeleton ? ` · ${s.joints} bones` : ''} · ${s.textures} embedded textures · ${s.transparent} transparent materials · verified`,
      });
    } catch (error) {
      setStatus({ kind: 'error', text: `Export failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  };

  const busy = status.kind === 'busy';
  return (
    <section className="tab-body export" aria-label="Export">
      <Choice
        label="Format"
        value={options.skeleton ? 'rigged' : 'static'}
        options={[['rigged', 'GLB · rigged'], ['static', 'GLB · static mesh']]}
        onChange={v => set({ skeleton: v === 'rigged' })}
        disabled={busy}
      />
      <p className="hint">
        {options.skeleton
          ? 'Binary glTF 2.0 with the original 29-bone skeleton (original names and hierarchy), skin weights and embedded textures. Opens in Blender, Unity, Unreal, Godot and three.js.'
          : 'Binary glTF 2.0 with the posed meshes and embedded textures, no skeleton. For static renders and 3D printing previews.'}
      </p>
      <Choice label="Pose" value={options.pose} options={[['rest', 'Rest'], ['tpose', 'T-pose']]} onChange={pose => set({ pose })} disabled={busy} />
      {options.skeleton && (
        <Choice
          label="Head and short hair"
          value={options.rigidParts}
          options={[['skin', 'Skin to bone'], ['parent', 'Keep parented']]}
          onChange={rigidParts => set({ rigidParts })}
          disabled={busy}
        />
      )}
      <Choice label="Material" value={options.material} options={[['unlit', 'Unlit (original look)'], ['lit', 'Lit (PBR)']]} onChange={material => set({ material })} disabled={busy} />
      <label className="field-label" htmlFor="export-name">File name</label>
      <input id="export-name" className="code-field" value={fileName} placeholder={suggested} spellCheck={false} onChange={e => setFileName(e.target.value)} disabled={busy} />
      <div className="row-actions">
        <button type="button" className="primary" onClick={run} disabled={busy}>
          {busy ? 'Exporting…' : 'Export GLB'}
        </button>
      </div>
      <p className={`feedback${status.kind === 'error' ? ' feedback-error' : ''}`} role="status" aria-live="polite" id="export-status">
        {status.kind === 'busy' && STEP_TEXT[status.step]}
        {status.kind === 'done' && status.text}
        {status.kind === 'error' && status.text}
      </p>
      {status.kind === 'done' && <p className="hint" id="export-detail">{status.detail}</p>}
      <p className="hint">
        Exports the current look as dressed, never the live animation frame. Props and the ground shadow are not included.
        Units are metres (1 original unit = 1 cm). FBX and OBJ are not offered yet: see the README for why.
      </p>
    </section>
  );
}
