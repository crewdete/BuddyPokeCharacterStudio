// Verifies that the studio reaches the original decoder through the @original alias and that the
// facts later milestones rely on (rig, skinning, bind pose, look codes) hold for the shipped data.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { readPackage, type Package } from '@original/engine/package.js';
import { DEFAULT_LOOK_CODE, decodeLook, encodeLook } from '@original/domain/wardrobe.js';
import { describeScene } from '../../src/original/scene-info';

const CHICK = new URL('../../../web/assets/chick.bin', import.meta.url);
let pack: Package;

beforeAll(async () => {
  pack = await readPackage(new Uint8Array(readFileSync(CHICK)));
});

describe('original package through the studio alias', () => {
  it('decodes the scene graph', () => {
    const info = describeScene(pack.scene);
    expect(info).toMatchObject({ bones: 29, meshes: 58, skinnedMeshes: 32, rigidMeshes: 26, props: 14, cameras: 10, cullRegions: 22 });
    expect(pack.animations.size).toBe(94);
  });

  it('exposes the 3ds Max Biped rig with every bone parented to a bone or the root', () => {
    const { scene } = pack;
    expect(scene.boneNames.slice(0, 5)).toEqual(['IG_Root', 'Bip01', 'Bip01_Footsteps', 'Bip01_Pelvis', 'Bip01_Spine']);
    const bones = new Set(scene.boneNames);
    const parentOf = new Map<string, string | null>();
    const walk = (node: typeof scene, parent: string | null) => {
      if (node.name && bones.has(node.name)) parentOf.set(node.name, parent);
      for (const child of node.children) walk(child as typeof scene, node.name && bones.has(node.name) ? node.name : parent);
    };
    walk(scene, null);
    expect(parentOf.size).toBe(29);
    expect(parentOf.get('Bip01_L_Forearm')).toBe('Bip01_L_UpperArm');
    expect(parentOf.get('Bip01_Head')).toBe('Bip01_Neck');
    expect([...parentOf].filter(([, p]) => p === null).map(([name]) => name).sort()).toEqual(['Bip01', 'IG_Root']);
  });

  it('has at most 3 normalised influences per vertex (fits glTF JOINTS_0/WEIGHTS_0)', () => {
    let maxInfluences = 0;
    let worstSum = 0;
    pack.scene.find(node => {
      if (!node.mesh?.encodedSkin) return false;
      node.mesh.decode(pack.scene);
      for (const { bones, weights } of node.mesh.skin!.influences) {
        maxInfluences = Math.max(maxInfluences, bones.length);
        worstSum = Math.max(worstSum, Math.abs(weights.reduce((a, b) => a + b, 0) - 1));
      }
      return false;
    });
    expect(maxInfluences).toBe(3);
    expect(worstSum).toBeLessThan(0.02);
  });

  it('has an arms-down bind pose (so a T-pose must be reconstructed)', () => {
    const at = (name: string) => pack.scene.node(name)!.worldPosition();
    const shoulder = at('Bip01_L_UpperArm');
    const hand = at('Bip01_L_Hand');
    const drop = Math.atan2(shoulder.y - hand.y, hand.x - shoulder.x) * (180 / Math.PI);
    expect(drop).toBeGreaterThan(60);
    expect(drop).toBeLessThan(80);
  });
});

describe('original look codes', () => {
  it('decodes the default code and round-trips', async () => {
    const look = await decodeLook(DEFAULT_LOOK_CODE);
    expect(Object.keys(look)).toHaveLength(76);
    const changed = { ...look, hrt: 7 };
    expect(await decodeLook(await encodeLook(changed))).toEqual(changed);
  });
});
