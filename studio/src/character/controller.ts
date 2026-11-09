// Customization controller: the studio's single entry point for changing the character.
// It drives the ORIGINAL Wardrobe (visibleOptions, choose, wear, codeOf) and then re-syncs the 3D rig.
// Edits are serialized so a fast sequence of clicks never overlaps an in-flight buddy.dress().
import type { Buddy } from '@original/domain/buddy.js';
import { DEFAULT_LOOK_CODE, decodeLook, type Look, type Selector, type WardrobeOption } from '@original/domain/wardrobe.js';
import type { OriginalAssets } from '../original';
import type { CharacterRig } from '../scene/CharacterRig';

export type Icons = Record<string, { url: string; x: number; y: number }>;

export class CharacterController {
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  /** Incremented after every applied change; UI subscribes to it. */
  version = 0;

  private constructor(
    readonly assets: OriginalAssets,
    readonly buddy: Buddy,
    readonly rig: CharacterRig,
    readonly defaultLook: Look,
    readonly icons: Icons,
  ) {}

  static async create(assets: OriginalAssets, buddy: Buddy, rig: CharacterRig) {
    const [defaultLook, icons] = await Promise.all([decodeLook(DEFAULT_LOOK_CODE), assets.textures.icons()]);
    return new CharacterController(assets, buddy, rig, defaultLook, icons);
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

  /** Run an edit after any pending one, then refresh the rig and notify the UI. */
  edit<T>(change: () => Promise<T>): Promise<T> {
    const run = this.queue.then(change).then(result => {
      this.rig.update();
      this.version++;
      for (const listener of this.listeners) listener();
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
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
