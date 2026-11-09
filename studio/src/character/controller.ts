// Customization controller: the studio's single entry point for changing the character.
// It drives the ORIGINAL Wardrobe (visibleOptions, choose, wear, codeOf) and then re-syncs the 3D rig.
// Edits are serialized so a fast sequence of clicks never overlaps an in-flight buddy.dress().
import type { Buddy } from '@original/domain/buddy.js';
import { DEFAULT_LOOK_CODE, decodeLook, type Look, type Selector, type WardrobeOption } from '@original/domain/wardrobe.js';
import type { OriginalAssets } from '../original';
import type { CharacterRig } from '../scene/CharacterRig';
import { validateLookCode, type Result } from './presets';

/** Maximum undo steps kept. */
export const HISTORY_LIMIT = 100;

export type Icons = Record<string, { url: string; x: number; y: number }>;

export class CharacterController {
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  /** Incremented after every applied change; UI subscribes to it. */
  version = 0;

  /** Undo history: look codes (original format) after each change; `historyIndex` is the current one. */
  private history: string[] = [];
  private historyIndex = 0;
  /** Current look code, kept in sync after every change. */
  currentCode = '';
  readonly knownIds: ReadonlySet<string>;

  private constructor(
    readonly assets: OriginalAssets,
    readonly buddy: Buddy,
    readonly rig: CharacterRig,
    readonly defaultLook: Look,
    readonly icons: Icons,
  ) {
    this.knownIds = new Set(assets.wardrobe.selectors(buddy).map(s => s.id));
  }

  static async create(assets: OriginalAssets, buddy: Buddy, rig: CharacterRig) {
    const [defaultLook, icons] = await Promise.all([decodeLook(DEFAULT_LOOK_CODE), assets.textures.icons()]);
    const controller = new CharacterController(assets, buddy, rig, defaultLook, icons);
    controller.currentCode = await controller.code();
    controller.history = [controller.currentCode];
    return controller;
  }

  get canUndo() {
    return this.historyIndex > 0;
  }

  get canRedo() {
    return this.historyIndex < this.history.length - 1;
  }

  historyCodes() {
    return [...this.history];
  }

  /** Number of entries and current position (for tests and diagnostics). */
  historyState() {
    return { length: this.history.length, index: this.historyIndex };
  }

  get wardrobe() {
    return this.assets.wardrobe;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Options shown for the current look (original OPTION_RULES applied by the original Wardrobe). */
  visibleOptions(): WardrobeOption[] {
    return this.wardrobe.visibleOptions(this.buddy);
  }

  look(): Look {
    return this.wardrobe.lookOf(this.buddy);
  }

  code(): Promise<string> {
    return this.wardrobe.codeOf(this.buddy);
  }

  isDefault(option: WardrobeOption) {
    return option.selectors.every(s => s.get() === (this.defaultLook[s.id] ?? 0));
  }

  /**
   * Run an edit after any pending one, then refresh the rig, record the resulting look in the undo
   * history (unless it is an undo/redo step or nothing changed) and notify the UI.
   */
  edit<T>(change: () => Promise<T>, { record = true } = {}): Promise<T> {
    const run = this.queue.then(change).then(async result => {
      this.rig.update();
      this.currentCode = await this.code();
      if (record && this.currentCode !== this.history[this.historyIndex]) {
        this.history = this.history.slice(0, this.historyIndex + 1);
        this.history.push(this.currentCode);
        if (this.history.length > HISTORY_LIMIT) this.history.shift();
        this.historyIndex = this.history.length - 1;
      }
      this.version++;
      for (const listener of this.listeners) listener();
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Step through history. Queued like any edit, so it applies after pending changes. */
  private step(delta: -1 | 1) {
    return this.edit(async () => {
      const target = this.historyIndex + delta;
      if (target < 0 || target >= this.history.length) return false;
      this.historyIndex = target;
      await this.wardrobe.wearCode(this.buddy, this.history[target]);
      return true;
    }, { record: false });
  }

  undo() {
    return this.step(-1);
  }

  redo() {
    return this.step(1);
  }

  /** Original default character (same as BuddyRevival's Default button). */
  resetAll() {
    return this.edit(() => this.wardrobe.wearCode(this.buddy, null));
  }

  /** Original random character (same as BuddyRevival's Random button: Wardrobe.randomize). */
  randomize() {
    return this.edit(() => this.wardrobe.randomize(this.buddy));
  }

  /** Validate a pasted look code with the original decoder, then wear it. Nothing changes if invalid. */
  async applyCode(input: string): Promise<Result<string>> {
    // Validation runs inside the queue, so the code takes its place in line at click time:
    // a Random/Default/choice clicked while it decodes cannot overtake it.
    let checked: Result<unknown> = { ok: false, error: '' };
    await this.edit(async () => {
      checked = await validateLookCode(input, this.knownIds);
      if (checked.ok) await this.wardrobe.wearCode(this.buddy, (checked.value as { code: string }).code);
    });
    return checked.ok ? { ok: true, value: this.currentCode } : checked;
  }

  private selector(id: string): Selector {
    const selector = this.wardrobe.selectors(this.buddy).find(s => s.id === id);
    if (!selector) throw new Error(`Unknown selector ${id}`);
    return selector;
  }

  /** Same as clicking a choice in the original panel: original resets, then dress(). */
  choose(selectorId: string, index: number) {
    return this.edit(() => this.wardrobe.choose(this.buddy, this.selector(selectorId), index));
  }

  /** Put one category back to the original default look. Uses choose() so original resets still apply. */
  resetOption(optionName: string) {
    return this.edit(async () => {
      const option = this.wardrobe.options(this.buddy).find(o => o.name === optionName);
      if (!option) return;
      for (const { id } of option.selectors) {
        const target = this.defaultLook[id] ?? 0;
        const selector = this.selector(id);
        if (selector.get() !== target) await this.wardrobe.choose(this.buddy, selector, target);
      }
    });
  }

  wearCode(code: string | null) {
    return this.edit(() => this.wardrobe.wearCode(this.buddy, code));
  }

  wearLook(look: Look) {
    return this.edit(() => this.wardrobe.wearOverDefault(this.buddy, look));
  }
}
