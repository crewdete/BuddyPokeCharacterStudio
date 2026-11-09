// T-pose solved from the ORIGINAL rest pose (Node, original engine only).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readPackage, type Package } from '@original/engine/package.js';
import type { SceneNode } from '@original/engine/scene-graph.js';
import { BindSnapshot } from '../../src/pose/bind';
import { ARM_CHAIN, TPose, updateWorlds } from '../../src/pose/tpose';

const load = async () => readPackage(new Uint8Array(readFileSync(new URL('../../../web/assets/chick.bin', import.meta.url))));
const named = (pack: Package) => {
  const out: SceneNode[] = [];
  pack.scene.find(n => (n.name && out.push(n), false));
  return out;
};
const locals = (pack: Package) => Object.fromEntries(named(pack).map(n => [n.name, Array.from(n.local.e)]));
const pos = (pack: Package, name: string) => {
  const e = pack.scene.node(name)!.world.e;
  return [e[12], e[13], e[14]];
};
/** Normalised world direction of a bone's local +X axis. */
const axis = (pack: Package, name: string) => {
  const e = pack.scene.node(name)!.world.e;
  const l = Math.hypot(e[0], e[1], e[2]);
  return [e[0] / l, e[1] / l, e[2] / l];
};

async function setup() {
  const pack = await load();
  updateWorlds(pack.scene);
  const rest = locals(pack);
  const bind = new BindSnapshot(pack.scene);
  const tpose = new TPose(pack.scene, bind);
  return { pack, rest, bind, tpose };
}

describe('T-pose', () => {
  it('leaves the scene at the exact rest pose after solving', async () => {
    const { pack, rest } = await setup();
    updateWorlds(pack.scene);
    expect(locals(pack)).toEqual(rest);
  });

  it('turns exactly the six arm bones', async () => {
    const { tpose } = await setup();
    expect(tpose.bones()).toEqual(['Bip01_L_UpperArm', 'Bip01_L_Forearm', 'Bip01_L_Hand', 'Bip01_R_UpperArm', 'Bip01_R_Forearm', 'Bip01_R_Hand']);
  });

  it('every arm bone axis points exactly along world ±X (horizontal, straight arms)', async () => {
    const { pack, tpose } = await setup();
    tpose.apply();
    updateWorlds(pack.scene);
    let worstDegrees = 0;
    for (const [side, sign] of [['L', 1], ['R', -1]] as const) {
      for (const bone of ARM_CHAIN) {
        const [x, y, z] = axis(pack, `Bip01_${side}_${bone}`);
        const degrees = (Math.acos(Math.min(1, x * sign)) * 180) / Math.PI;
        worstDegrees = Math.max(worstDegrees, degrees);
        expect(Math.abs(y), `${side} ${bone} y`).toBeLessThan(1e-12);
        expect(Math.abs(z), `${side} ${bone} z`).toBeLessThan(1e-12);
      }
    }
    expect(worstDegrees).toBeLessThan(1e-6);
  });

  it('elbow and wrist sit on the horizontal line through the shoulder; arm segments are not stretched', async () => {
    const { pack, tpose } = await setup();
    updateWorlds(pack.scene);
    const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const restLength = Object.fromEntries(['L', 'R'].flatMap(side => [
      [`${side}u`, dist(pos(pack, `Bip01_${side}_UpperArm`), pos(pack, `Bip01_${side}_Forearm`))],
      [`${side}f`, dist(pos(pack, `Bip01_${side}_Forearm`), pos(pack, `Bip01_${side}_Hand`))],
    ]));
    tpose.apply();
    updateWorlds(pack.scene);
    for (const side of ['L', 'R']) {
      const s0 = pos(pack, `Bip01_${side}_UpperArm`);
      const e = pos(pack, `Bip01_${side}_Forearm`);
      const w = pos(pack, `Bip01_${side}_Hand`);
      for (const v of [e[1] - s0[1], e[2] - s0[2], w[1] - s0[1], w[2] - s0[2]]) expect(Math.abs(v)).toBeLessThan(1e-9);
      // Each segment = the original local offset x the scale inherited from the rest ancestors
      // (original non-unit rest axes, see M3A-1); no stretching is introduced.
      const scale = (name: string) => {
        const m = pack.scene.node(name)!.world.e;
        return Math.hypot(m[0], m[1], m[2]);
      };
      expect(dist(s0, e)).toBeCloseTo(pack.scene.node(`Bip01_${side}_Forearm`)!.position!.x * scale(`Bip01_${side}_UpperArm`), 9);
      expect(dist(e, w)).toBeCloseTo(pack.scene.node(`Bip01_${side}_Hand`)!.position!.x * scale(`Bip01_${side}_Forearm`), 9);
      expect(Math.abs(dist(s0, e) / restLength[`${side}u`] - 1)).toBeLessThan(0.002);
      expect(Math.abs(dist(e, w) / restLength[`${side}f`] - 1)).toBeLessThan(0.002);
    }
  });

  it('is mirror-symmetric up to the asymmetry already in the original shoulders (< 0.05 units)', async () => {
    const { pack, tpose } = await setup();
    updateWorlds(pack.scene);
    const shoulder = (p: number[], q: number[]) => Math.hypot(p[0] + q[0], p[1] - q[1], p[2] - q[2]);
    const restOffset = shoulder(pos(pack, 'Bip01_L_UpperArm'), pos(pack, 'Bip01_R_UpperArm'));
    tpose.apply();
    updateWorlds(pack.scene);
    for (const bone of ARM_CHAIN) {
      const offset = shoulder(pos(pack, `Bip01_L_${bone}`), pos(pack, `Bip01_R_${bone}`));
      expect(offset, bone).toBeLessThan(0.05);
      // Arms are mirrors; the offset is the original shoulder one, carried along (±0.00001 from the slightly
      // different inherited scales of the two original rest chains).
      expect(Math.abs(offset - restOffset), bone).toBeLessThan(1e-5);
    }
  });

  it('every non-arm bone is identical to the rest pose', async () => {
    const { pack, rest, tpose } = await setup();
    tpose.apply();
    updateWorlds(pack.scene);
    const now = locals(pack);
    const changed = Object.keys(rest).filter(k => JSON.stringify(rest[k]) !== JSON.stringify(now[k]));
    expect(changed.sort()).toEqual(['Bip01_L_Forearm', 'Bip01_L_Hand', 'Bip01_L_UpperArm', 'Bip01_R_Forearm', 'Bip01_R_Hand', 'Bip01_R_UpperArm']);
  });

  it('is deterministic: identical whether applied from rest or after any animation', async () => {
    const { pack, tpose } = await setup();
    tpose.apply();
    updateWorlds(pack.scene);
    const reference = locals(pack);
    for (const name of ['hug1', 'mood_flying', 'jamA1', 'holdHands2', 'mood_sleeping']) {
      const clip = pack.animations.get(name)!;
      clip.decode();
      clip.showFrame(pack.scene, Math.floor(clip.frameCount / 2));
      tpose.apply();
      updateWorlds(pack.scene);
      expect(locals(pack), name).toEqual(reference);
    }
  });

  it('never alters the original rest data (rest restores bit-for-bit after T-pose and animation)', async () => {
    const { pack, rest, bind, tpose } = await setup();
    tpose.apply();
    pack.animations.get('kick1')!.showFrame(pack.scene, 40);
    tpose.apply();
    bind.restore();
    updateWorlds(pack.scene);
    expect(locals(pack)).toEqual(rest);
  });
});
