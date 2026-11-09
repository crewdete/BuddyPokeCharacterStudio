// Typed entry point to the original BuddyRevival code in ../web/src.
// Everything here delegates to the original modules; nothing is re-implemented.
import { Buddy } from '@original/domain/buddy.js';
import { attr, fetchXml, isWorn, items } from '@original/domain/catalog.js';
import { TextureLibrary } from '@original/domain/textures.js';
import { DEFAULT_LOOK_CODE, Wardrobe, decodeLook, encodeLook } from '@original/domain/wardrobe.js';
import { describeScene, type SceneInfo } from './scene-info';

export { Buddy, TextureLibrary, Wardrobe, DEFAULT_LOOK_CODE, decodeLook, encodeLook, describeScene };
export type { SceneInfo };

/** Size the original Canvas renderer was built for. Buddy still constructs one; the studio never draws with it. */
const ORIGINAL_VIEWPORT = { width: 692, height: 520 };

export const assetUrl = (path: string) => `${import.meta.env.BASE_URL}${path}`;

export interface OriginalAssets {
  textures: TextureLibrary;
  chick: Uint8Array;
  catalog: string;
  wardrobe: Wardrobe;
  /** Original mood list (web/assets/moods.xml): name and clip. */
  moods: { name: string; a0: string }[];
  /** Original poke list (web/assets/pokes.xml): name, "you" clip and "friend" clip. */
  pokes: { name: string; a0: string; a1: string }[];
}

export async function loadOriginalAssets(): Promise<OriginalAssets> {
  const bytes = async (path: string) => new Uint8Array(await (await fetch(assetUrl(path))).arrayBuffer());
  const text = async (path: string) => (await fetch(assetUrl(path))).text();
  const [textures, chick, catalog, wardrobe, moodList, pokeList] = await Promise.all([
    TextureLibrary.load(assetUrl('chick/')),
    bytes('chick.bin'),
    text('chick/catalog.xml'),
    Wardrobe.load(assetUrl('wardrobe.xml')),
    fetchXml(assetUrl('moods.xml')),
    fetchXml(assetUrl('pokes.xml')),
  ]);
  // Same attributes the original main.js reads.
  const moods = [...moodList.children].map(m => ({ name: attr(m, 'name'), a0: attr(m, 'a0') }));
  const pokes = [...pokeList.children].map(p => ({ name: attr(p, 'name'), a0: attr(p, 'a0'), a1: attr(p, 'a1') }));
  return { textures, chick, catalog, wardrobe, moods, pokes };
}

/** Decode a fresh buddy and dress it with a look code (or the original default look). */
export async function createBuddy(assets: OriginalAssets, lookCode: string | null = null): Promise<Buddy> {
  const buddy = await Buddy.load(assets.chick, { ...ORIGINAL_VIEWPORT, textures: assets.textures, catalog: assets.catalog });
  await assets.wardrobe.wearCode(buddy, lookCode);
  return buddy;
}

export interface BuddyInfo extends SceneInfo {
  animations: number;
  wardrobeOptions: number;
  selectors: number;
  wornItems: number;
  lookCode: string;
}

export async function describeBuddy(buddy: Buddy, wardrobe: Wardrobe): Promise<BuddyInfo> {
  return {
    ...describeScene(buddy.scene),
    animations: buddy.animations.size,
    wardrobeOptions: wardrobe.options(buddy).length,
    selectors: wardrobe.selectors(buddy).length,
    wornItems: items(buddy.catalog).filter(isWorn).length,
    lookCode: await wardrobe.codeOf(buddy),
  };
}
