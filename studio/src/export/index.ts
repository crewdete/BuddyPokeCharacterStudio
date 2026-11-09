// Export workflow: prepare (fresh original buddy) -> write GLB -> verify by re-reading -> filename.
import type { OriginalAssets } from '../original';
import { checkGlb, writeGlb, type GlbCheck } from './glb';
import { prepareExport, type ExportManifest, type ExportOptions } from './prepare';

export type { ExportOptions, ExportManifest, GlbCheck };
export type { RootMotion } from './prepare';
export const DEFAULT_EXPORT: ExportOptions = { pose: 'tpose', skeleton: true, rigidParts: 'skin', material: 'unlit' };

/** Short stable id of a look code (FNV-1a), so file names tell looks apart. */
export function lookId(code: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) h = Math.imul(h ^ code.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

export const defaultFileName = (code: string, o: ExportOptions) =>
  o.animations !== undefined
    ? `buddypoke-animated-${o.animations.length}clip${o.animations.length === 1 ? '' : 's'}-${o.pose === 'tpose' ? 'tpose' : 'rest'}${o.rootMotion === 'inPlace' ? '-inplace' : ''}-${lookId(code)}.glb`
    : `buddypoke-${o.pose === 'tpose' ? 'tpose' : 'rest'}-${o.skeleton ? 'rigged' : 'static'}-${lookId(code)}.glb`;

export type ExportStep = 'preparing' | 'sampling' | 'writing' | 'verifying';

export interface ExportResult {
  glb: ArrayBuffer;
  manifest: ExportManifest;
  check: GlbCheck;
}

/** `onStep` also reports clip progress while animations are sampled ('sampling', done, total). */
export async function exportCharacter(assets: OriginalAssets, lookCode: string, options: ExportOptions, onStep: (step: ExportStep, done?: number, total?: number) => void = () => {}): Promise<ExportResult> {
  onStep('preparing');
  const prepared = await prepareExport(assets, lookCode, options, (done, total) => onStep('sampling', done, total));
  try {
    onStep('writing');
    const glb = await writeGlb(prepared);
    onStep('verifying');
    const check = await checkGlb(glb, prepared.manifest);
    return { glb, manifest: prepared.manifest, check };
  } finally {
    prepared.dispose();
  }
}
