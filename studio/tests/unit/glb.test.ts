// M3C-3: deterministic GLB output — image buffer views re-packed in image order (GLTFExporter writes them in the
// order their asynchronous PNG encoding finishes).
import { describe, expect, it } from 'vitest';
import { glbJson, orderImages } from '../../src/export/glb';

function makeGlb(json: object, bin: Uint8Array) {
  const enc = new TextEncoder();
  let text = JSON.stringify(json);
  while (enc.encode(text).length % 4) text += ' ';
  const j = enc.encode(text);
  const binPadded = new Uint8Array((bin.length + 3) & ~3);
  binPadded.set(bin);
  const out = new ArrayBuffer(28 + j.length + binPadded.length);
  const v = new DataView(out);
  v.setUint32(0, 0x46546c67, true); v.setUint32(4, 2, true); v.setUint32(8, out.byteLength, true);
  v.setUint32(12, j.length, true); v.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(out, 20).set(j);
  v.setUint32(20 + j.length, binPadded.length, true); v.setUint32(24 + j.length, 0x004e4942, true);
  new Uint8Array(out, 28 + j.length).set(binPadded);
  return out;
}
const viewBytes = (glb: ArrayBuffer, i: number) => {
  const json = glbJson(glb) as unknown as { bufferViews: { byteOffset?: number; byteLength: number }[] };
  const start = 28 + new DataView(glb).getUint32(12, true) + (json.bufferViews[i].byteOffset ?? 0);
  return Array.from(new Uint8Array(glb, start, json.bufferViews[i].byteLength));
};

describe('orderImages', () => {
  // view 0: mesh data (3 bytes); view 1: image B (5 bytes, finished first); view 2: image A (2 bytes).
  const bin = new Uint8Array([1, 2, 3, 0, 20, 21, 22, 23, 24, 0, 0, 0, 10, 11]);
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: 16 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 3 }, { buffer: 0, byteOffset: 4, byteLength: 5 }, { buffer: 0, byteOffset: 12, byteLength: 2 }],
    images: [{ mimeType: 'image/png', bufferView: 2 }, { mimeType: 'image/png', bufferView: 1 }],
  };
  it('puts image data in image order, keeps other data, realigns offsets', () => {
    const out = orderImages(makeGlb(json, bin));
    const j = glbJson(out) as unknown as typeof json;
    expect(j.images.map(i => i.bufferView)).toEqual([1, 2]);
    expect(viewBytes(out, 0)).toEqual([1, 2, 3]);
    expect(viewBytes(out, 1)).toEqual([10, 11]); // image A
    expect(viewBytes(out, 2)).toEqual([20, 21, 22, 23, 24]); // image B
    expect(j.bufferViews.map(v => v.byteOffset)).toEqual([0, 4, 8]);
    expect(j.buffers[0].byteLength).toBe(16);
    expect(new DataView(out).getUint32(8, true)).toBe(out.byteLength);
  });
  it('is the identity when images are already in order', () => {
    const glb = makeGlb({ ...json, images: [{ mimeType: 'image/png', bufferView: 1 }, { mimeType: 'image/png', bufferView: 2 }] }, bin);
    expect(orderImages(glb)).toBe(glb);
  });
});
