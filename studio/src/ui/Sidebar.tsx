import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CharacterController } from '../character/controller';
import { MAX_FILE_BYTES, parsePresetFile, presetFileName, serializePresetFile, type Preset } from '../character/presets';
import type { AnimationEntry } from '../pose/catalog';
import type { AnimationPlayer } from '../pose/player';
import { usePresets } from '../state/presets';
import { AnimatePanel } from './AnimatePanel';
import { CustomizePanel } from './CustomizePanel';

type Feedback = { kind: 'ok' | 'error'; text: string } | null;

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

function useControllerVersion(controller: CharacterController) {
  return useSyncExternalStore(
    listener => controller.subscribe(listener),
    () => controller.version,
  );
}

function FeedbackLine({ feedback, id }: { feedback: Feedback; id: string }) {
  return (
    <p id={id} className={`feedback${feedback ? ` feedback-${feedback.kind}` : ''}`} role="status" aria-live="polite">
      {feedback?.text ?? ''}
    </p>
  );
}

function ActionBar({ controller }: { controller: CharacterController }) {
  useControllerVersion(controller);
  // Undo: Ctrl/Cmd+Z. Redo: Ctrl/Cmd+Shift+Z or Ctrl+Y. Text fields keep their own undo.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || typing(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) controller.undo();
      else if ((key === 'z' && event.shiftKey) || (key === 'y' && !event.shiftKey)) controller.redo();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controller]);

  return (
    <div className="action-bar" role="toolbar" aria-label="Character">
      <button type="button" onClick={() => controller.undo()} disabled={!controller.canUndo} title="Undo (Ctrl+Z)">
        Undo
      </button>
      <button type="button" onClick={() => controller.redo()} disabled={!controller.canRedo} title="Redo (Ctrl+Shift+Z)">
        Redo
      </button>
      <span className="action-gap" />
      <button type="button" onClick={() => controller.resetAll()} title="Original default character">
        Default
      </button>
      <button type="button" onClick={() => controller.randomize()} title="Random character (original wardrobe rules)">
        Random
      </button>
    </div>
  );
}

function CodePanel({ controller }: { controller: CharacterController }) {
  useControllerVersion(controller);
  const [input, setInput] = useState('');
  const [feedback, setFeedback] = useState<Feedback>(null);
  const current = useRef<HTMLTextAreaElement>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(controller.currentCode);
    } catch {
      current.current?.select();
      if (!document.execCommand('copy')) return setFeedback({ kind: 'error', text: 'Could not copy. Select the code and copy it manually.' });
    }
    setFeedback({ kind: 'ok', text: 'Look code copied.' });
  };

  const apply = async () => {
    const result = await controller.applyCode(input);
    if (!result.ok) return setFeedback({ kind: 'error', text: result.error });
    setInput('');
    setFeedback({ kind: 'ok', text: 'Look code applied.' });
  };

  return (
    <section className="tab-body" aria-label="Look code">
      <label className="field-label" htmlFor="current-code">Current look code</label>
      <textarea id="current-code" ref={current} className="code-field" readOnly rows={5} value={controller.currentCode} spellCheck={false} />
      <div className="row-actions">
        <button type="button" onClick={copy}>Copy</button>
      </div>
      <label className="field-label" htmlFor="paste-code">Apply a look code</label>
      <textarea
        id="paste-code"
        className="code-field"
        rows={4}
        value={input}
        placeholder="Paste a BuddyPoke or BuddyRevival look code"
        spellCheck={false}
        aria-describedby="code-feedback"
        onChange={event => setInput(event.target.value)}
      />
      <div className="row-actions">
        <button type="button" onClick={apply}>Apply</button>
      </div>
      <FeedbackLine feedback={feedback} id="code-feedback" />
      <p className="hint">Codes use the original BuddyPoke format and work in BuddyRevival (?buddy=&lt;code&gt;).</p>
    </section>
  );
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function PresetsPanel({ controller }: { controller: CharacterController }) {
  useControllerVersion(controller);
  const { presets, persisted, save, add, remove } = usePresets();
  const [name, setName] = useState('');
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const onSave = () => {
    const { preset, created } = save(name, controller.currentCode);
    setName('');
    setFeedback({ kind: 'ok', text: created ? `Saved "${preset.name}".` : `Updated "${preset.name}".` });
  };

  const onLoad = async (preset: Preset) => {
    const result = await controller.applyCode(preset.code);
    setFeedback(result.ok ? { kind: 'ok', text: `Loaded "${preset.name}".` } : { kind: 'error', text: `"${preset.name}" could not be loaded. ${result.error}` });
  };

  const onImport = async (input: HTMLInputElement) => {
    const chosen = input.files?.[0];
    input.value = '';
    if (!chosen) return;
    if (chosen.size > MAX_FILE_BYTES) return setFeedback({ kind: 'error', text: 'The file is too large to be a preset.' });
    const result = await parsePresetFile(await chosen.text(), chosen.size, controller.knownIds);
    if (!result.ok) return setFeedback({ kind: 'error', text: result.error });
    const preset = add(result.value.name, result.value.code);
    setFeedback({ kind: 'ok', text: `Imported "${preset.name}".` });
  };

  return (
    <section className="tab-body" aria-label="Presets">
      <form
        className="save-row"
        onSubmit={event => {
          event.preventDefault();
          onSave();
        }}
      >
        <label className="visually-hidden" htmlFor="preset-name">Preset name</label>
        <input id="preset-name" value={name} maxLength={60} placeholder="Preset name" onChange={event => setName(event.target.value)} />
        <button type="submit">Save</button>
      </form>
      <FeedbackLine feedback={feedback} id="preset-feedback" />
      {!persisted && <p className="hint">Browser storage is unavailable: presets last only for this session. Export them to keep them.</p>}
      {presets.length === 0 ? (
        <p className="hint">No presets yet. Save the current character, or import a preset file.</p>
      ) : (
        <ul className="preset-list" aria-label="Saved presets">
          {presets.map(preset => (
            <li key={preset.id} className="preset" data-preset={preset.name}>
              <span className="preset-name" title={preset.name}>{preset.name}</span>
              <span className="preset-actions">
                <button type="button" onClick={() => onLoad(preset)} aria-label={`Load ${preset.name}`}>Load</button>
                <button type="button" onClick={() => download(presetFileName(preset.name), serializePresetFile(preset))} aria-label={`Export ${preset.name}`}>
                  Export
                </button>
                <button
                  type="button"
                  className={confirming === preset.id ? 'danger' : undefined}
                  aria-label={confirming === preset.id ? `Confirm delete ${preset.name}` : `Delete ${preset.name}`}
                  onBlur={() => setConfirming(null)}
                  onClick={() => {
                    if (confirming !== preset.id) return setConfirming(preset.id);
                    remove(preset.id);
                    setConfirming(null);
                    setFeedback({ kind: 'ok', text: `Deleted "${preset.name}".` });
                  }}
                >
                  {confirming === preset.id ? 'Confirm' : 'Delete'}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="row-actions">
        <button type="button" onClick={() => file.current?.click()}>Import preset file…</button>
        <input ref={file} type="file" accept=".json,application/json" hidden data-testid="preset-file" onChange={event => onImport(event.currentTarget)} />
      </div>
    </section>
  );
}

const TABS = ['Customize', 'Animate', 'Presets', 'Code'] as const;
type Tab = (typeof TABS)[number];

export function Sidebar({ controller, player, entries }: { controller: CharacterController; player: AnimationPlayer; entries: AnimationEntry[] }) {
  const [tab, setTab] = useState<Tab>('Customize');
  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <ActionBar controller={controller} />
        <div className="tabs" role="tablist" aria-label="Sidebar">
          {TABS.map(name => (
            <button key={name} type="button" role="tab" id={`tab-${name}`} aria-selected={tab === name} aria-controls={`panel-${name}`} onClick={() => setTab(name)}>
              {name}
            </button>
          ))}
        </div>
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'Customize' && <CustomizePanel controller={controller} />}
        {tab === 'Animate' && <AnimatePanel player={player} entries={entries} />}
        {tab === 'Presets' && <PresetsPanel controller={controller} />}
        {tab === 'Code' && <CodePanel controller={controller} />}
      </div>
    </div>
  );
}
