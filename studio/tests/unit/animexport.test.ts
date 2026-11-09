// M3C-2: prop visibility/rotation and face frames sampled for export, against the ORIGINAL engine (Node).
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { readPackage, type Package } from '@original/engine/package.js';
import { BindSnapshot } from '../../src/pose/bind';
import { faceNodeName, HIDDEN_SCALE, sampleClip, toAnimationClip } from '../../src/export/animation/sample';

const CHICK = new URL('../../../web/assets/chick.bin', import.meta.url);
const load = async () => readPackage(new Uint8Array(readFileSync(CHICK)));
const PROP_CLIPS = { Rose: ['mood_lookingForLove', 'rose1', 'rose2'], Sword: ['mood_swordTwirl', 'swordA1', 'swordA2'], Strat: ['jamA1', 'jamB1', 'jamB2'], Mic: ['jamA2'] };

/** The original Track.apply() index rule: past the end of a track's data it reads entry 0. */
const at = <T,>(values: ArrayLike<T>, f: number) => values[f < values.length ? f : 0];

describe('M3C-2 sampling of props and faces', () => {
  let pack: Package;
  const samples = new Map<string, ReturnType<typeof sampleClip>>();
  it('samples all 94 clips', async () => {
    pack = await load();
    // Node has no canvas, so the package is not dressed and `Head` has no Material. A stand-in with the
    // original Material frame bookkeeping (frame starts at -1, showFrame(f) sets it) records what the
    // original Track.apply() asks for; the browser suites check the real composed textures.
    const head = pack.scene.node('Head')!.mesh!;
    expect(head.material).toBeNull();
    head.material = { frame: -1, showFrame(this: { frame: number }, f: number) { this.frame = f; } } as unknown as typeof head.material;
    const bind = new BindSnapshot(pack.scene);
    for (const [name, clip] of pack.animations) samples.set(name, sampleClip(pack.scene, clip, bind, pack.scene.boneNames, 0.01));
    expect(samples.size).toBe(94);
  });

  it('face frame at every frame = the original track data (index rule incl. short tracks; -1 stored as 1)', () => {
    let frames = 0;
    const used = new Set<number>();
    for (const [name, s] of samples) {
      const track = pack.animations.get(name)!.tracks!.find(t => t.target === 'Head' && t.materialFrames)!;
      for (let f = 0; f < s.frameCount; f++) {
        const raw = at(track.materialFrames!, f);
        expect(s.faceFrames[f], `${name}@${f}`).toBe(raw === -1 ? 1 : raw);
        used.add(s.faceFrames[f]);
        frames++;
      }
    }
    expect(frames).toBe(11609);
    expect(used.size).toBe(32);
    expect([...used].includes(21)).toBe(false);
  });

  it('prop visibility at every frame = the original visibility tracks (hidden in clips without one)', () => {
    for (const [name, s] of samples) {
      const tracks = pack.animations.get(name)!.tracks!;
      for (const prop of Object.keys(s.props)) {
        const vis = tracks.find(t => t.target === prop && t.visibility);
        for (let f = 0; f < s.frameCount; f++) expect(s.props[prop].visible[f], `${name} ${prop}@${f}`).toBe(vis ? (at(vis.visibility!, f) === 1 ? 1 : 0) : 0);
      }
    }
    const shownIn = (prop: string) => [...samples].filter(([, s]) => s.props[prop]?.visible.some(v => v)).map(([n]) => n).sort();
    for (const [prop, clips] of Object.entries(PROP_CLIPS)) expect(shownIn(prop)).toEqual([...clips].sort());
    for (const prop of ['SpBalloon', 'Mallet', 'Ball']) expect(shownIn(prop)).toEqual([]);
  });

  it('prop rotation = the original track rotation (unit-axis quaternion) at every frame it is visible', () => {
    const q = new THREE.Quaternion();
    let checked = 0;
    for (const [prop, clips] of Object.entries(PROP_CLIPS)) {
      for (const name of clips) {
        const s = samples.get(name)!;
        const track = pack.animations.get(name)!.tracks!.find(t => t.target === prop && t.rotations)!;
        for (let f = 0; f < s.frameCount; f++) {
          if (!s.props[prop].visible[f]) continue;
          const i = (f * 4 < track.rotations!.length ? f : 0) * 4;
          const [x, y, z, angle] = track.rotations!.slice(i, i + 4);
          q.setFromAxisAngle(new THREE.Vector3(x, y, z).normalize(), angle);
          const got = new THREE.Quaternion().fromArray(s.props[prop].rotations, f * 4);
          expect(Math.abs(got.dot(q)), `${name} ${prop}@${f}`).toBeGreaterThan(1 - 1e-6);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(700);
  });

  it('clip tracks: STEP visibility keys reproduce every frame exactly; exactly one face node visible', () => {
    const faceNodes = new Map([...new Set([...samples.values()].flatMap(s => [...s.faceFrames]))].map(f => [f, faceNodeName(f)]));
    expect(faceNodes.get(1)).toBe('Head');
    expect(faceNodes.get(7)).toBe('Head_F07');
    for (const [name, s] of samples) {
      const clip = toAnimationClip(s, pack.scene.boneNames, { props: ['Rose', 'Sword', 'Strat', 'Mic'], faceNodes });
      const value = (node: string, f: number) => {
        const track = clip.tracks.find(t => t.name === `${node}.scale`)!;
        let k = 0;
        while (k + 1 < track.times.length && track.times[k + 1] <= f / 30) k++; // STEP
        return track.values[k * 3];
      };
      for (let f = 0; f < s.frameCount; f++) {
        const visible = [...faceNodes.values()].filter(n => value(n, f) === 1);
        expect(visible, `${name}@${f}`).toEqual([faceNodeName(s.faceFrames[f])]);
        for (const prop of ['Rose', 'Sword', 'Strat', 'Mic']) expect(value(prop, f), `${name} ${prop}@${f}`).toBe(s.props[prop].visible[f] ? 1 : Math.fround(HIDDEN_SCALE));
      }
    }
  });

  it('sampling leaves the engine as dressed: rest pose, no prop visible', () => {
    expect(pack.scene.props.every(p => !p.visible)).toBe(true);
  });
});
