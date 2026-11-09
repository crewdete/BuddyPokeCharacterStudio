// Binary FBX 7.4 encoder: node records with typed properties, the layout Autodesk's FBX SDK, Blender's importer and
// Three's FBXLoader read. (Blender does not import ASCII FBX, so the binary form is required.)
//
// Record (version < 7500): u32 endOffset, u32 propertyCount, u32 propertyListLength, u8 nameLength, name,
// properties, nested records, then a 13-byte null record if the node has children (or no properties).
// Property type codes: Y i16, C bool, I i32, F f32, D f64, L i64, S string, R raw bytes,
// f/d/l/i/b arrays (u32 length, u32 encoding 0 = uncompressed, u32 byteLength, data).

export type FbxValue =
  | { t: 'Y' | 'I' | 'F' | 'D'; v: number }
  | { t: 'C'; v: boolean }
  | { t: 'L'; v: bigint }
  | { t: 'S'; v: string }
  | { t: 'R'; v: Uint8Array }
  | { t: 'f' | 'd' | 'i'; v: ArrayLike<number> }
  | { t: 'l'; v: ArrayLike<bigint> };

export interface FbxNode {
  name: string;
  props: FbxValue[];
  children: FbxNode[];
}

// Shorthand constructors
export const I = (v: number): FbxValue => ({ t: 'I', v });
export const D = (v: number): FbxValue => ({ t: 'D', v });
export const F = (v: number): FbxValue => ({ t: 'F', v });
export const L = (v: bigint | number): FbxValue => ({ t: 'L', v: BigInt(v) });
export const S = (v: string): FbxValue => ({ t: 'S', v });
export const R = (v: Uint8Array): FbxValue => ({ t: 'R', v });
export const Y = (v: number): FbxValue => ({ t: 'Y', v });
export const C = (v: boolean): FbxValue => ({ t: 'C', v });
export const Ai = (v: ArrayLike<number>): FbxValue => ({ t: 'i', v });
export const Ad = (v: ArrayLike<number>): FbxValue => ({ t: 'd', v });
export const Af = (v: ArrayLike<number>): FbxValue => ({ t: 'f', v });
export const Al = (v: ArrayLike<bigint>): FbxValue => ({ t: 'l', v });

export const node = (name: string, props: FbxValue[] = [], children: FbxNode[] = []): FbxNode => ({ name, props, children });

/** "name\x00\x01Class": how binary FBX stores object names. */
export const objectName = (name: string, cls: string) => `${name}\u0000\u0001${cls}`;

class Writer {
  private chunks: Uint8Array[] = [];
  length = 0;
  private readonly enc = new TextEncoder();
  bytes(b: Uint8Array) {
    this.chunks.push(b);
    this.length += b.length;
  }
  private scalar(size: number, write: (v: DataView) => void) {
    const b = new Uint8Array(size);
    write(new DataView(b.buffer));
    this.bytes(b);
  }
  u8(v: number) { this.scalar(1, d => d.setUint8(0, v)); }
  u32(v: number) { this.scalar(4, d => d.setUint32(0, v, true)); }
  text(s: string) { this.bytes(this.enc.encode(s)); }
  encode(s: string) { return this.enc.encode(s); }
  /** Reserve 4 bytes to patch later. */
  placeholder() {
    const b = new Uint8Array(4);
    this.bytes(b);
    return b;
  }
  result() {
    const out = new Uint8Array(this.length);
    let p = 0;
    for (const c of this.chunks) {
      out.set(c, p);
      p += c.length;
    }
    return out;
  }
}

const setU32 = (b: Uint8Array, v: number) => new DataView(b.buffer, b.byteOffset, 4).setUint32(0, v, true);

function encodeProperty(w: Writer, p: FbxValue) {
  w.text(p.t);
  switch (p.t) {
    case 'Y': { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, p.v, true); w.bytes(b); break; }
    case 'C': w.u8(p.v ? 1 : 0); break;
    case 'I': { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, p.v, true); w.bytes(b); break; }
    case 'F': { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, p.v, true); w.bytes(b); break; }
    case 'D': { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, p.v, true); w.bytes(b); break; }
    case 'L': { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, p.v, true); w.bytes(b); break; }
    case 'S': { const s = w.encode(p.v); w.u32(s.length); w.bytes(s); break; }
    case 'R': w.u32(p.v.length); w.bytes(p.v); break;
    default: {
      const size = p.t === 'f' || p.t === 'i' ? 4 : 8;
      const n = p.v.length;
      const b = new Uint8Array(n * size);
      const d = new DataView(b.buffer);
      for (let i = 0; i < n; i++) {
        if (p.t === 'f') d.setFloat32(i * 4, p.v[i] as number, true);
        else if (p.t === 'i') d.setInt32(i * 4, p.v[i] as number, true);
        else if (p.t === 'd') d.setFloat64(i * 8, p.v[i] as number, true);
        else d.setBigInt64(i * 8, p.v[i] as bigint, true);
      }
      w.u32(n);
      w.u32(0); // not compressed
      w.u32(b.length);
      w.bytes(b);
    }
  }
}

const NULL_RECORD = new Uint8Array(13);

function encodeNode(w: Writer, n: FbxNode) {
  const end = w.placeholder();
  w.u32(n.props.length);
  const propLength = w.placeholder();
  const name = w.encode(n.name);
  w.u8(name.length);
  w.bytes(name);
  const start = w.length;
  for (const p of n.props) encodeProperty(w, p);
  setU32(propLength, w.length - start);
  if (n.children.length || !n.props.length) {
    for (const c of n.children) encodeNode(w, c);
    w.bytes(NULL_RECORD);
  }
  setU32(end, w.length);
}

const HEADER = 'Kaydara FBX Binary  \u0000';
const FOOTER_ID = [0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66, 0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e];
const FOOTER_MAGIC = [0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b];
export const FBX_VERSION = 7400;

/** Encode top-level nodes as a binary FBX 7.4 file (header, records, null record, standard footer). */
export function encodeFbx(nodes: FbxNode[]): Uint8Array {
  const w = new Writer();
  w.text(HEADER);
  w.bytes(new Uint8Array([0x1a, 0x00]));
  w.u32(FBX_VERSION);
  for (const n of nodes) encodeNode(w, n);
  w.bytes(NULL_RECORD);
  w.bytes(new Uint8Array(FOOTER_ID));
  w.bytes(new Uint8Array(4));
  let pad = ((w.length + 15) & ~15) - w.length;
  if (pad === 0) pad = 16;
  w.bytes(new Uint8Array(pad));
  w.u32(FBX_VERSION);
  w.bytes(new Uint8Array(120));
  w.bytes(new Uint8Array(FOOTER_MAGIC));
  return w.result();
}

// ---------------------------------------------------------------- reader (self-check and tests)

export interface ParsedNode {
  name: string;
  props: (number | bigint | boolean | string | Uint8Array | number[] | bigint[])[];
  children: ParsedNode[];
}

/** Parse a binary FBX produced by encodeFbx (uncompressed arrays). Throws on any structural error. */
export function parseFbx(bytes: Uint8Array): { version: number; nodes: ParsedNode[] } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  if (dec.decode(bytes.subarray(0, 21)) !== HEADER) throw new Error('Not a binary FBX file');
  const version = v.getUint32(23, true);
  let p = 27;
  const readNode = (): ParsedNode | null => {
    const end = v.getUint32(p, true);
    const count = v.getUint32(p + 4, true);
    const nameLength = v.getUint8(p + 12);
    if (end === 0) {
      p += 13;
      return null;
    }
    if (end > bytes.length || end <= p) throw new Error(`Bad node end offset at ${p}`);
    const name = dec.decode(bytes.subarray(p + 13, p + 13 + nameLength));
    p += 13 + nameLength;
    const props: ParsedNode['props'] = [];
    for (let i = 0; i < count; i++) {
      const t = String.fromCharCode(bytes[p++]);
      switch (t) {
        case 'Y': props.push(v.getInt16(p, true)); p += 2; break;
        case 'C': props.push(bytes[p] !== 0); p += 1; break;
        case 'I': props.push(v.getInt32(p, true)); p += 4; break;
        case 'F': props.push(v.getFloat32(p, true)); p += 4; break;
        case 'D': props.push(v.getFloat64(p, true)); p += 8; break;
        case 'L': props.push(v.getBigInt64(p, true)); p += 8; break;
        case 'S': case 'R': {
          const n = v.getUint32(p, true);
          const data = bytes.subarray(p + 4, p + 4 + n);
          props.push(t === 'S' ? dec.decode(data) : data.slice());
          p += 4 + n;
          break;
        }
        case 'f': case 'd': case 'i': case 'l': {
          const n = v.getUint32(p, true);
          const encoding = v.getUint32(p + 4, true);
          const length = v.getUint32(p + 8, true);
          if (encoding !== 0) throw new Error('Compressed arrays are not expected');
          const size = t === 'f' || t === 'i' ? 4 : 8;
          if (length !== n * size) throw new Error(`Bad array length in ${name}`);
          const out: (number | bigint)[] = [];
          for (let k = 0; k < n; k++) {
            const o = p + 12 + k * size;
            out.push(t === 'f' ? v.getFloat32(o, true) : t === 'i' ? v.getInt32(o, true) : t === 'd' ? v.getFloat64(o, true) : v.getBigInt64(o, true));
          }
          props.push(out as number[] | bigint[]);
          p += 12 + length;
          break;
        }
        default:
          throw new Error(`Unknown property type "${t}" in ${name}`);
      }
    }
    const children: ParsedNode[] = [];
    while (p < end) {
      const child = readNode();
      if (!child) break;
      children.push(child);
    }
    if (p !== end) throw new Error(`Node ${name} ends at ${p}, expected ${end}`);
    return { name, props, children };
  };
  const nodes: ParsedNode[] = [];
  for (;;) {
    const n = readNode();
    if (!n) break;
    nodes.push(n);
  }
  return { version, nodes };
}
