// OBJ/FBX building blocks (Node): ZIP writer, binary FBX encoder/parser, exact Euler conversion, FBX key counts.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Ad, Af, Ai, Al, D, encodeFbx, I, L, node, objectName, parseFbx, R, S } from '../../src/export/fbx/binary';
import { ORDERS, toEulerDegrees } from '../../src/export/fbx/writer';
import { fbxKeys } from '../../src/export/estimate';
import { crc32, readZip, writeZip } from '../../src/export/zip';

describe('ZIP', () => {
  it('crc32 matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
  it('round-trips entries (names, bytes, CRC) and is deterministic', () => {
    const entries = [{ name: 'a.obj', data: new TextEncoder().encode('v 0 0 0\n') }, { name: 'tex.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) }];
    const zip = writeZip(entries);
    expect(readZip(zip).map(e => [e.name, Array.from(e.data)])).toEqual(entries.map(e => [e.name, Array.from(e.data)]));
    expect(writeZip(entries)).toEqual(zip);
    expect(new DataView(zip.buffer).getUint32(0, true)).toBe(0x04034b50);
  });
  it('detects corruption', () => {
    const zip = writeZip([{ name: 'x.txt', data: new TextEncoder().encode('hello') }]);
    zip[30 + 5] ^= 0xff; // flip a data byte
    expect(() => readZip(zip)).toThrow(/CRC/);
  });
});

describe('binary FBX encoder', () => {
  const doc = [
    node('FBXHeaderExtension', [], [node('FBXVersion', [I(7400)])]),
    node('Objects', [], [
      node('Model', [L(1000001n), S(objectName('Bip01', 'Model')), S('LimbNode')], [node('Version', [I(232)])]),
      node('Geometry', [L(1000002n), S(objectName('Body', 'Geometry')), S('Mesh')], [node('Vertices', [Ad([0.5, -1, 2])]), node('PolygonVertexIndex', [Ai([0, 1, ~2])])]),
      node('AnimationCurve', [L(1000003n), S(''), S('')], [node('KeyTime', [Al([0n, 1539538600n])]), node('KeyValueFloat', [Af([1.5, -2])]), node('Default', [D(0.25)])]),
      node('Video', [L(1000004n), S('v'), S('Clip')], [node('Content', [R(new Uint8Array([0x89, 0x50, 9]))])]),
    ]),
    node('Takes'),
  ];
  const bytes = encodeFbx(doc);
  it('writes the binary header, version 7400 and the standard footer', () => {
    expect(new TextDecoder().decode(bytes.subarray(0, 20))).toBe('Kaydara FBX Binary  ');
    expect(new DataView(bytes.buffer).getUint32(23, true)).toBe(7400);
    expect(Array.from(bytes.subarray(bytes.length - 16))).toEqual([0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b]);
  });
  it('round-trips every property type through the parser (end offsets, nesting, arrays)', () => {
    const { version, nodes } = parseFbx(bytes);
    expect(version).toBe(7400);
    expect(nodes.map(n => n.name)).toEqual(['FBXHeaderExtension', 'Objects', 'Takes']);
    const objects = nodes[1].children;
    expect(objects[0].props).toEqual([1000001n, 'Bip01\u0000\u0001Model', 'LimbNode']);
    expect(objects[1].children[0].props[0]).toEqual([0.5, -1, 2]);
    expect(objects[1].children[1].props[0]).toEqual([0, 1, -3]);
    expect(objects[2].children.map(c => c.props[0])).toEqual([[0n, 1539538600n], [1.5, -2], 0.25]);
    expect(Array.from(objects[3].children[0].props[0] as Uint8Array)).toEqual([0x89, 0x50, 9]);
  });
  it('rejects a truncated file', () => {
    expect(() => parseFbx(bytes.subarray(0, 120))).toThrow();
  });
});

describe('Euler conversion for FBX rotation curves', () => {
  const random = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const rnd = random(7);
  const quats = Array.from({ length: 2000 }, () => new THREE.Quaternion(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize());
  // Near-gimbal cases for every order: middle angle within 0.01° of ±90°.
  for (const { three } of ORDERS) for (const sign of [1, -1]) {
    const e = new THREE.Euler(0.3, 0.2, -0.4, three);
    const middle = three[1].toLowerCase() as 'x' | 'y' | 'z';
    e[middle] = sign * (Math.PI / 2 - 1e-4);
    quats.push(new THREE.Quaternion().setFromEuler(e));
  }
  it.each(ORDERS.map(o => o.three))('order %s reproduces every rotation (incl. near gimbal lock) to < 1e-9 rad', order => {
    let worst = 0;
    for (const q of quats) {
      const [x, y, z] = toEulerDegrees(q, order).map(THREE.MathUtils.degToRad);
      const back = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, order));
      const d = q.clone().invert().multiply(back); // exact small-angle measure (acos cannot resolve < ~6e-8 rad)
      worst = Math.max(worst, 2 * Math.asin(Math.min(1, Math.hypot(d.x, d.y, d.z))));
    }
    expect(worst).toBeLessThan(1e-9);
  });
});

describe('FBX key counts (STEP keys + hold keys)', () => {
  it('counts a hold key before each change that follows a gap', () => {
    // frames: 0..5 = a a a b b c  -> STEP keys at 0, 3, 5 ; hold keys at 2 (before 3) and 4 (before 5) -> 5
    const v = new Float32Array([1, 1, 1, 2, 2, 3]);
    expect(fbxKeys(v, 1, 30)).toBe(5);
    expect(fbxKeys(new Float32Array([4, 4, 4, 4]), 1, 30)).toBe(3); // first + hold + last (the writer does the same)
    expect(fbxKeys(new Float32Array([1, 2, 3]), 1, 30)).toBe(3); // every frame changes: no holds
  });
});
