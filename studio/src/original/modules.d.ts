// Type declarations for the original BuddyRevival modules in ../web/src (resolved via the `@original` alias).
// They describe the existing JavaScript API exactly as written; the JavaScript itself is not modified.
// Only the parts the studio uses are declared.

declare module '@original/engine/math.js' {
  export class Vector3 {
    constructor(x?: number, y?: number, z?: number);
    x: number;
    y: number;
    z: number;
  }
  export class AxisAngle {
    constructor(x?: number, y?: number, z?: number, angle?: number);
    x: number;
    y: number;
    z: number;
    angle: number;
  }
  /** Column-major 4×4 matrix (same layout as THREE.Matrix4.elements). */
  export class Matrix4 {
    e: Float64Array;
    identity(): this;
    copy(other: Matrix4): this;
    multiply(other: Matrix4): this;
    invertAffine(): this;
  }
  export const IDENTITY: Matrix4;
}

declare module '@original/engine/skin.js' {
  import type { Vector3 } from '@original/engine/math.js';
  export interface Influence {
    bones: number[];
    weights: number[];
  }
  export class Skin {
    influences: Influence[];
    bones: Map<number, unknown>;
    deform(vertices: Vector3[]): Vector3[];
  }
}

declare module '@original/engine/material.js' {
  export type Bitmap = OffscreenCanvas;
  export class Material {
    /** The catalog <material> element this bitmap is composed from (carries hasAlpha, clipRect). */
    description: Element;
    lightmap: string | null;
    readonly bitmap: Bitmap | null;
    frame: number;
    showFrame(frame: number): void;
  }
}

declare module '@original/engine/mesh.js' {
  import type { Vector3 } from '@original/engine/math.js';
  import type { Skin } from '@original/engine/skin.js';
  import type { Material } from '@original/engine/material.js';
  import type { Scene } from '@original/engine/scene-graph.js';
  export class Mesh {
    name: string;
    vertexCount: number;
    faceCount: number;
    dummyVertices: Set<number>;
    depthOffset: number;
    encoded: unknown;
    encodedSkin: unknown | null;
    material: Material | null;
    decoded: boolean;
    /** Available after decode(). */
    faces: number[];
    faceRegions: number[] | null;
    meshRegion: number;
    uvs: Float64Array;
    vertices: Vector3[];
    skin: Skin | null;
    decode(scene: Scene): void;
  }
}

declare module '@original/engine/scene-graph.js' {
  import type { AxisAngle, Matrix4, Vector3 } from '@original/engine/math.js';
  import type { Mesh } from '@original/engine/mesh.js';
  export class SceneNode {
    name: string | null;
    visible: boolean;
    position: Vector3 | null;
    rotation: AxisAngle | null;
    mesh: Mesh | null;
    children: SceneNode[];
    local: Matrix4;
    world: Matrix4;
    inverseBind: Matrix4;
    updateWorld(parentWorld: Matrix4): void;
    worldPosition(): Vector3;
    find(predicate: (node: SceneNode) => boolean): SceneNode | null;
  }
  export class Scene extends SceneNode {
    nodes: Map<string, SceneNode>;
    culled: Set<number>;
    props: SceneNode[];
    boneNames: string[];
    propNames: string[];
    regionNames: string[];
    node(name: string): SceneNode | null;
    boneAt(index: number): SceneNode | undefined;
    firstCamera(): Camera | null;
    isCulled(region: number): boolean;
    hideProps(): void;
  }
  export class Camera extends SceneNode {
    /** Horizontal field of view in radians (the original renderer scales both axes by the width). */
    fov: number;
    /** World-to-camera matrix, valid after update(). */
    view: Matrix4;
    update(viewport: { width: number; height: number }): void;
  }
  export function buildNode(raw: unknown): SceneNode;
}

declare module '@original/engine/animation.js' {
  import type { Scene } from '@original/engine/scene-graph.js';
  /** One decoded original track (per-frame data for one target node). */
  export interface AnimationTrack {
    target: string;
    materialFrames: number[] | null;
    positions: number[] | null;
    visibility: Uint8Array | number[] | null;
    rotations: number[] | null;
  }
  export class Animation {
    /** Decoded tracks, available after decode(). */
    tracks: AnimationTrack[] | null;
    name: string;
    start: number;
    end: number;
    fps: number;
    loop: boolean;
    current: number;
    readonly frameCount: number;
    decode(): void;
    reset(): void;
    step(scene: Scene, advance?: boolean): boolean;
    showFrame(scene: Scene, frame: number): void;
  }
}

declare module '@original/engine/package.js' {
  import type { Scene } from '@original/engine/scene-graph.js';
  import type { Animation } from '@original/engine/animation.js';
  export interface Package {
    descriptor: string;
    catalog: string;
    scene: Scene;
    animations: Map<string, Animation>;
    textureMovie: Uint8Array | null;
  }
  export function readPackage(bytes: Uint8Array): Promise<Package>;
}

declare module '@original/domain/catalog.js' {
  export function parseXml(text: string): Element;
  export function fetchXml(url: string): Promise<Element>;
  export function attr(element: Element | null | undefined, name: string): string;
  export function items(catalog: Element): Element[];
  export function isWorn(item: Element): boolean;
}

declare module '@original/domain/textures.js' {
  export class TextureLibrary {
    static load(base: string): Promise<TextureLibrary>;
    preload(catalog: Element): Promise<void>;
    colors(colorOption: string): number[] | null;
    icons(): Promise<Record<string, { url: string; x: number; y: number }>>;
  }
}

declare module '@original/domain/buddy.js' {
  import type { Scene, Camera } from '@original/engine/scene-graph.js';
  import type { Animation } from '@original/engine/animation.js';
  import type { TextureLibrary } from '@original/domain/textures.js';
  export interface BuddyLoadOptions {
    width: number;
    height: number;
    textures?: TextureLibrary | null;
    catalog?: string | null;
  }
  export class Buddy {
    static load(bytes: Uint8Array, options: BuddyLoadOptions): Promise<Buddy>;
    scene: Scene;
    animations: Map<string, Animation>;
    textures: TextureLibrary | null;
    /** The live catalog XML: the buddy's customization state. */
    catalog: Element;
    animation: Animation | null;
    camera: Camera;
    readonly animationName: string | null;
    play(name: string, options?: { loop?: boolean }): void;
    step(advance?: boolean): boolean;
    showFrame(frame: number): void;
    dress(): Promise<void>;
  }
}

declare module '@original/domain/wardrobe.js' {
  import type { Buddy } from '@original/domain/buddy.js';
  export type Look = Record<string, number>;
  export interface ColorSelector {
    id: string;
    kind: 'color';
    colors: number[];
    get(): number;
    set(index: number): void;
  }
  export interface IconSelector {
    id: string;
    kind: 'texture' | 'itemGroup';
    icons: string[];
    get(): number;
    set(index: number): void;
  }
  export type Selector = ColorSelector | IconSelector;
  export interface WardrobeOption {
    name: string;
    selectors: Selector[];
  }
  export const DEFAULT_LOOK_CODE: string;
  export function encodeLook(look: Look): Promise<string>;
  export function decodeLook(code: string): Promise<Look>;
  export class Wardrobe {
    static load(url: string): Promise<Wardrobe>;
    options(buddy: Buddy): WardrobeOption[];
    selectors(buddy: Buddy): Selector[];
    lookOf(buddy: Buddy): Look;
    visibleOptions(buddy: Buddy): WardrobeOption[];
    choose(buddy: Buddy, selector: Selector, index: number): Promise<void>;
    wear(buddy: Buddy, ...looks: Look[]): Promise<void>;
    wearCode(buddy: Buddy, code: string | null | undefined): Promise<void>;
    wearOverDefault(buddy: Buddy, look: Look): Promise<void>;
    randomize(buddy: Buddy): Promise<void>;
    codeOf(buddy: Buddy): Promise<string>;
  }
}

declare module '@original/engine/amf3.js' {
  export function writeAmf3String(s: string): Uint8Array;
}

declare module '@original/engine/binary.js' {
  export function deflate(bytes: Uint8Array): Promise<Uint8Array>;
}
