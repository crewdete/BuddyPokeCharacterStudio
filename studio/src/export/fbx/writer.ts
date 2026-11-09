// FBX 7.4 (binary) from the prepared export scene: the SAME Three.js scene and clips the validated GLB export writes
// (prepare.ts: fresh original buddy with the current look, original skeleton, rest bind, sampled clips).
//
//  - Units: metres with UnitScaleFactor 100 (1 FBX unit = 1 m); Y up, as in the GLB.
//  - Bones: Model "LimbNode" + NodeAttribute; the root group becomes a Null ("BuddyPoke", the armature in Blender).
//  - Skinned meshes: Geometry + Deformer "Skin" with one "Cluster" per bone (Transform = mesh at bind,
//    TransformLink = bone at bind, i.e. the exported inverse bind matrices) + a BindPose.
//  - Rigid meshes (head, "keep parented" parts): Mesh models parented to their bone.
//  - ANIMATED rigid meshes (props and facial-expression nodes, which carry rotation/visibility tracks): Blender's FBX
//    importer drops animation on mesh objects parented to bones, so each gets a helper bone "Ctrl_<name>" (child of
//    its original bone, same local transform) and the mesh is skinned to it with weight 1. Its tracks drive the
//    helper bone; visibility is the helper's scale (1 shown, 1e-6 hidden). The 29 original bones are unchanged.
//  - Materials: Lambert with the original composed texture embedded (Video Content) on DiffuseColor; materials with
//    alpha also link it to TransparentColor.
//  - Animation: one AnimationStack per clip at 30 fps. FBX rotation curves are Euler angles: each key is converted
//    from the exact quaternion (order XYZ, unwrapped between keys). Keys are flagged CONSTANT (no interpolation),
//    and every change is preceded by a hold key on the previous frame, so importers that interpolate linearly
//    (Blender) still show the original value on every frame.
import * as THREE from 'three';
import type { PreparedExport } from '../prepare';
import { Ad, Af, Ai, Al, D, encodeFbx, I, L, node, objectName, R, S, type FbxNode, type FbxValue } from './binary';

const KTIME_PER_SECOND = 46186158000n;
const FPS = 30;
const ktime = (frame: number) => (BigInt(Math.round(frame)) * KTIME_PER_SECOND) / BigInt(FPS);
/** FBX key flags: eInterpolationConstant | eConstantStandard. */
const KEY_CONSTANT = 0x00000002;

type PValue = number | string | bigint | number[];
/** Properties70 "P" record. */
function P(name: string, type: string, label: string, flags: string, ...values: PValue[]): FbxNode {
  const props: FbxValue[] = [S(name), S(type), S(label), S(flags)];
  for (const v of values) {
    if (typeof v === 'string') props.push(S(v));
    else if (typeof v === 'bigint') props.push(L(v));
    else if (Array.isArray(v)) v.forEach(x => props.push(D(x)));
    else if (type === 'int' || type === 'enum' || type === 'bool' || type === 'Integer') props.push(I(v));
    else props.push(D(v));
  }
  return node('P', props);
}
const props70 = (...p: FbxNode[]) => node('Properties70', [], p);

/**
 * FBX rotation orders (Model property RotationOrder) and the matching Three.js Euler order: FBX "eEulerXYZ" applies X
 * first (R = Rz·Ry·Rx), which is Three's 'ZYX'.
 */
export const ORDERS: { fbx: number; three: THREE.EulerOrder }[] = [
  { fbx: 0, three: 'ZYX' }, { fbx: 1, three: 'YZX' }, { fbx: 2, three: 'XZY' },
  { fbx: 3, three: 'ZXY' }, { fbx: 4, three: 'YXZ' }, { fbx: 5, three: 'XYZ' },
];
const rotation = new THREE.Matrix4();
/**
 * Quaternion -> Euler degrees in the given (Three.js) order. Same formulas as THREE.Euler.setFromRotationMatrix, but
 * without its shortcut within ~0.03° of gimbal lock (|middle| > 0.9999999), which drops up to 0.03° there; the regular
 * atan2 formulas stay exact until the configuration is exactly singular.
 */
const unit = new THREE.Quaternion();
export function toEulerDegrees(q: THREE.Quaternion, order: THREE.EulerOrder = 'ZYX'): [number, number, number] {
  const te = rotation.makeRotationFromQuaternion(unit.copy(q).normalize()).elements;
  const [m11, m12, m13, m21, m22, m23, m31, m32, m33] = [te[0], te[4], te[8], te[1], te[5], te[9], te[2], te[6], te[10]];
  const c = THREE.MathUtils.clamp;
  const SINGULAR = 1 - 1e-14;
  let x = 0, y = 0, z = 0;
  switch (order) {
    case 'XYZ': y = Math.asin(c(m13, -1, 1)); if (Math.abs(m13) < SINGULAR) { x = Math.atan2(-m23, m33); z = Math.atan2(-m12, m11); } else { x = Math.atan2(m32, m22); } break;
    case 'YXZ': x = Math.asin(-c(m23, -1, 1)); if (Math.abs(m23) < SINGULAR) { y = Math.atan2(m13, m33); z = Math.atan2(m21, m22); } else { y = Math.atan2(-m31, m11); } break;
    case 'ZXY': x = Math.asin(c(m32, -1, 1)); if (Math.abs(m32) < SINGULAR) { y = Math.atan2(-m31, m33); z = Math.atan2(-m12, m22); } else { z = Math.atan2(m21, m11); } break;
    case 'ZYX': y = Math.asin(-c(m31, -1, 1)); if (Math.abs(m31) < SINGULAR) { x = Math.atan2(m32, m33); z = Math.atan2(m21, m11); } else { z = Math.atan2(-m12, m22); } break;
    case 'YZX': z = Math.asin(c(m21, -1, 1)); if (Math.abs(m21) < SINGULAR) { x = Math.atan2(-m23, m22); y = Math.atan2(-m31, m11); } else { y = Math.atan2(m13, m33); } break;
    case 'XZY': z = Math.asin(-c(m12, -1, 1)); if (Math.abs(m12) < SINGULAR) { x = Math.atan2(m32, m22); y = Math.atan2(m13, m11); } else { x = Math.atan2(-m23, m33); } break;
  }
  return [THREE.MathUtils.radToDeg(x), THREE.MathUtils.radToDeg(y), THREE.MathUtils.radToDeg(z)];
}
/** Rotation error (radians) after converting to Euler degrees stored as float32 (FBX KeyValueFloat) and back. */
const back = new THREE.Quaternion();
function eulerRoundTripError(q: THREE.Quaternion, order: THREE.EulerOrder) {
  const [x, y, z] = toEulerDegrees(q, order).map(Math.fround);
  back.setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(x), THREE.MathUtils.degToRad(y), THREE.MathUtils.degToRad(z), order));
  return 2 * Math.acos(Math.min(1, Math.abs(back.dot(unit.copy(q).normalize()))));
}
/**
 * Per node, the rotation order whose Euler angles reproduce every key best. One fixed order would pass near its
 * gimbal configuration for some bones (the middle angle near ±90°), where float32 Euler angles lose precision.
 */
function bestOrders(root: THREE.Object3D, clips: THREE.AnimationClip[]) {
  const quats = new Map<string, THREE.Quaternion[]>();
  root.traverse(o => o.name && quats.set(o.name, [o.quaternion.clone()]));
  for (const clip of clips) for (const t of clip.tracks) {
    const [target, path] = t.name.split('.');
    if (path !== 'quaternion') continue;
    const list = quats.get(target) ?? [];
    for (let k = 0; k < t.times.length; k++) list.push(new THREE.Quaternion().fromArray(t.values as unknown as number[], k * 4));
    quats.set(target, list);
  }
  const result = new Map<string, { fbx: number; three: THREE.EulerOrder; error: number }>();
  for (const [name, list] of quats) {
    let best = { ...ORDERS[0], error: Infinity };
    for (const order of ORDERS) {
      let error = 0;
      for (const q of list) error = Math.max(error, eulerRoundTripError(q, order.three));
      if (error < best.error - 1e-12) best = { ...order, error };
    }
    result.set(name, best);
  }
  return result;
}

/** PNG bytes of a texture image (the original composed canvas). */
async function pngOf(image: unknown): Promise<Uint8Array> {
  const img = image as CanvasImageSource & { width: number; height: number };
  const canvas = new OffscreenCanvas(img.width, img.height);
  canvas.getContext('2d')!.drawImage(img, 0, 0);
  return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

export interface FbxSummary {
  /** Largest rotation error from storing rotations as float32 Euler angles (radians). */
  maxEulerError?: number;
  maxEulerErrorNode?: string;
  /** Helper bones driving animated props / facial-expression nodes. */
  helpers?: number;
  models: number;
  bones: number;
  meshes: number;
  skinnedMeshes: number;
  textures: number;
  stacks: number;
}

export async function writeFbx(prepared: PreparedExport): Promise<{ fbx: Uint8Array; summary: FbxSummary }> {
  let nextId = 1_000_000n;
  const newId = () => nextId++;
  const objects: FbxNode[] = [];
  const connections: FbxNode[] = [];
  const counts = new Map<string, number>();
  const count = (type: string) => counts.set(type, (counts.get(type) ?? 0) + 1);
  const OO = (child: bigint, parent: bigint) => connections.push(node('C', [S('OO'), L(child), L(parent)]));
  const OP = (child: bigint, parent: bigint, property: string) => connections.push(node('C', [S('OP'), L(child), L(parent), S(property)]));

  const root = prepared.root;
  root.updateMatrixWorld(true);
  const modelIds = new Map<THREE.Object3D, bigint>();
  const byName = new Map<string, bigint>();
  const summary: FbxSummary = { models: 0, bones: 0, meshes: 0, skinnedMeshes: 0, textures: 0, stacks: 0 };

  const orders = bestOrders(root, prepared.animations);
  const orderOf = (name: string) => orders.get(name) ?? { ...ORDERS[0], error: 0 };
  const transformProps = (o: THREE.Object3D, name = o.name) => {
    const order = orderOf(name);
    const r = toEulerDegrees(o.quaternion, order.three);
    return [
      P('RotationActive', 'bool', '', '', 1), // importers apply RotationOrder only when RotationActive is set
      P('RotationOrder', 'enum', '', '', order.fbx),
      P('InheritType', 'enum', '', '', 1),
      P('Lcl Translation', 'Lcl Translation', '', 'A', [o.position.x, o.position.y, o.position.z]),
      P('Lcl Rotation', 'Lcl Rotation', '', 'A', r),
      P('Lcl Scaling', 'Lcl Scaling', '', 'A', [o.scale.x, o.scale.y, o.scale.z]),
    ];
  };

  // ---- models (depth-first, parents before children)
  // Bone transforms at bind (world), from the skeleton's inverse bind matrices (the original rest pose).
  const bindWorld = new Map<THREE.Object3D, THREE.Matrix4>();
  root.traverse(o => {
    const sm = o as THREE.SkinnedMesh;
    if (!sm.isSkinnedMesh) return;
    const meshWorld = sm.matrixWorld.clone().multiply(sm.bindMatrix);
    sm.skeleton.bones.forEach((bone, b) => bindWorld.set(bone, meshWorld.clone().multiply(sm.skeleton.boneInverses[b].clone().invert())));
  });
  // Rigid meshes driven by animation tracks (props, face nodes): exported with a helper bone.
  const animatedTargets = new Set(prepared.animations.flatMap(c => c.tracks.map(t => t.name.split('.')[0])));
  const helpers: { mesh: THREE.Mesh; meshId: bigint; geometryId: bigint; helperId: bigint; bind: THREE.Matrix4 }[] = [];
  const materials = new Map<THREE.Material, bigint>();
  const textureIds = new Map<THREE.Texture, bigint>();
  const skinned: THREE.SkinnedMesh[] = [];

  const addModel = async (o: THREE.Object3D, parentId: bigint) => {
    if ((o as THREE.Mesh).isMesh && !(o as THREE.SkinnedMesh).isSkinnedMesh && animatedTargets.has(o.name) && o.parent && bindWorld.has(o.parent)) {
      await addHelperDriven(o as THREE.Mesh, parentId);
      return;
    }
    const id = newId();
    modelIds.set(o, id);
    byName.set(o.name, id);
    const bone = (o as THREE.Bone).isBone === true;
    const mesh = (o as THREE.Mesh).isMesh === true;
    const type = bone ? 'LimbNode' : mesh ? 'Mesh' : 'Null';
    const extra = mesh ? [P('DefaultAttributeIndex', 'int', 'Integer', '', 0)] : [];
    objects.push(node('Model', [L(id), S(objectName(o.name, 'Model')), S(type)], [
      node('Version', [I(232)]),
      props70(...transformProps(o), ...extra),
      node('Shading', [{ t: 'C', v: true }]),
      node('Culling', [S('CullingOff')]),
    ]));
    count('Model');
    summary.models++;
    OO(id, parentId);
    if (bone) {
      const attr = newId();
      objects.push(node('NodeAttribute', [L(attr), S(objectName(o.name, 'NodeAttribute')), S('LimbNode')], [props70(P('Size', 'double', 'Number', '', 1)), node('TypeFlags', [S('Skeleton')])]));
      count('NodeAttribute');
      OO(attr, id);
      summary.bones++;
    } else if (!mesh) {
      const attr = newId();
      objects.push(node('NodeAttribute', [L(attr), S(objectName(o.name, 'NodeAttribute')), S('Null')], [node('TypeFlags', [S('Null')])]));
      count('NodeAttribute');
      OO(attr, id);
    }
    if (mesh) {
      summary.meshes++;
      await addGeometry(o as THREE.Mesh, id);
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(o as THREE.SkinnedMesh);
    }
    for (const child of o.children) await addModel(child, id);
  };

  /** Animated rigid mesh: helper bone (child of the original bone) + mesh at the root, skinned to the helper. */
  const addHelperDriven = async (mesh: THREE.Mesh, parentBoneId: bigint) => {
    const helperId = newId();
    const helperName = `Ctrl_${mesh.name}`;
    // At bind the helper has its local transform with scale 1 (a hidden node's 1e-6 scale is display state only).
    const bind = bindWorld.get(mesh.parent!)!.clone().multiply(new THREE.Matrix4().compose(mesh.position, mesh.quaternion, new THREE.Vector3(1, 1, 1)));
    objects.push(node('Model', [L(helperId), S(objectName(helperName, 'Model')), S('LimbNode')], [
      node('Version', [I(232)]),
      props70(...transformProps(mesh, mesh.name)),
      node('Shading', [{ t: 'C', v: true }]),
      node('Culling', [S('CullingOff')]),
    ]));
    count('Model');
    summary.models++;
    summary.bones++;
    OO(helperId, parentBoneId);
    const attr = newId();
    objects.push(node('NodeAttribute', [L(attr), S(objectName(helperName, 'NodeAttribute')), S('LimbNode')], [props70(P('Size', 'double', 'Number', '', 1)), node('TypeFlags', [S('Skeleton')])]));
    count('NodeAttribute');
    OO(attr, helperId);
    byName.set(mesh.name, helperId); // the mesh's tracks drive its helper bone
    const meshId = newId();
    const rootId = modelIds.get(root)!;
    objects.push(node('Model', [L(meshId), S(objectName(mesh.name, 'Model')), S('Mesh')], [
      node('Version', [I(232)]),
      props70(...transformProps(new THREE.Object3D()), P('DefaultAttributeIndex', 'int', 'Integer', '', 0)),
      node('Shading', [{ t: 'C', v: true }]),
      node('Culling', [S('CullingOff')]),
    ]));
    count('Model');
    summary.models++;
    summary.meshes++;
    summary.skinnedMeshes++;
    OO(meshId, rootId);
    const geometryId = await addGeometry(mesh, meshId, bind);
    helpers.push({ mesh, meshId, geometryId, helperId, bind });
  };

  const addGeometry = async (mesh: THREE.Mesh, modelId: bigint, transform?: THREE.Matrix4) => {
    const g = mesh.geometry.clone();
    if (transform) g.applyMatrix4(transform);
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    const index = g.index!;
    const vertices = new Float64Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      vertices[i * 3] = pos.getX(i);
      vertices[i * 3 + 1] = pos.getY(i);
      vertices[i * 3 + 2] = pos.getZ(i);
    }
    const polygon = new Int32Array(index.count);
    const normals = new Float64Array(index.count * 3);
    for (let k = 0; k < index.count; k++) {
      const v = index.getX(k);
      polygon[k] = k % 3 === 2 ? ~v : v; // last corner of each triangle is stored as -(index + 1)
      if (nor) {
        normals[k * 3] = nor.getX(v);
        normals[k * 3 + 1] = nor.getY(v);
        normals[k * 3 + 2] = nor.getZ(v);
      }
    }
    const uvs = new Float64Array(uv.count * 2);
    for (let i = 0; i < uv.count; i++) {
      uvs[i * 2] = uv.getX(i);
      uvs[i * 2 + 1] = uv.getY(i);
    }
    const uvIndex = Int32Array.from(index.array as ArrayLike<number>);
    const geometryId = newId();
    objects.push(node('Geometry', [L(geometryId), S(objectName(mesh.name, 'Geometry')), S('Mesh')], [
      node('Vertices', [Ad(vertices)]),
      node('PolygonVertexIndex', [Ai(polygon)]),
      node('GeometryVersion', [I(124)]),
      node('LayerElementNormal', [I(0)], [
        node('Version', [I(101)]), node('Name', [S('')]),
        node('MappingInformationType', [S('ByPolygonVertex')]), node('ReferenceInformationType', [S('Direct')]),
        node('Normals', [Ad(normals)]),
      ]),
      node('LayerElementUV', [I(0)], [
        node('Version', [I(101)]), node('Name', [S('UVMap')]),
        node('MappingInformationType', [S('ByPolygonVertex')]), node('ReferenceInformationType', [S('IndexToDirect')]),
        node('UV', [Ad(uvs)]), node('UVIndex', [Ai(uvIndex)]),
      ]),
      node('LayerElementMaterial', [I(0)], [
        node('Version', [I(101)]), node('Name', [S('')]),
        node('MappingInformationType', [S('AllSame')]), node('ReferenceInformationType', [S('IndexToDirect')]),
        node('Materials', [Ai([0])]),
      ]),
      node('Layer', [I(0)], [
        node('Version', [I(100)]),
        ...['LayerElementNormal', 'LayerElementUV', 'LayerElementMaterial'].map(t => node('LayerElement', [], [node('Type', [S(t)]), node('TypedIndex', [I(0)])])),
      ]),
    ]));
    count('Geometry');
    OO(geometryId, modelId);
    g.dispose();
    const material = mesh.material as THREE.MeshBasicMaterial;
    OO(await addMaterial(material), modelId);
    return geometryId;
  };

  const addMaterial = async (material: THREE.MeshBasicMaterial) => {
    const known = materials.get(material);
    if (known) return known;
    const id = newId();
    materials.set(material, id);
    objects.push(node('Material', [L(id), S(objectName(material.name, 'Material')), S('')], [
      node('Version', [I(102)]),
      node('ShadingModel', [S('lambert')]),
      node('MultiLayer', [I(0)]),
      props70(
        P('DiffuseColor', 'Color', '', 'A', [1, 1, 1]),
        P('DiffuseFactor', 'Number', '', 'A', 1),
        P('AmbientColor', 'Color', '', 'A', [0, 0, 0]),
        P('EmissiveColor', 'Color', '', 'A', [0, 0, 0]),
        P('Opacity', 'double', 'Number', '', 1),
      ),
    ]));
    count('Material');
    if (material.map) {
      const texture = await addTexture(material.map);
      OP(texture, id, 'DiffuseColor');
      if (material.transparent) OP(texture, id, 'TransparentColor');
    }
    return id;
  };

  const addTexture = async (map: THREE.Texture) => {
    const known = textureIds.get(map);
    if (known) return known;
    const png = await pngOf(map.image);
    const file = `${map.name || 'texture'}_${textureIds.size}.png`;
    const video = newId();
    objects.push(node('Video', [L(video), S(objectName(file, 'Video')), S('Clip')], [
      node('Type', [S('Clip')]),
      props70(P('Path', 'KString', 'XRefUrl', '', file)),
      node('UseMipMap', [I(0)]),
      node('Filename', [S(file)]),
      node('RelativeFilename', [S(file)]),
      node('Content', [R(png)]),
    ]));
    count('Video');
    const id = newId();
    textureIds.set(map, id);
    objects.push(node('Texture', [L(id), S(objectName(file, 'Texture')), S('')], [
      node('Type', [S('TextureVideoClip')]),
      node('Version', [I(202)]),
      node('TextureName', [S(objectName(file, 'Texture'))]),
      props70(P('UseMaterial', 'bool', '', '', 1)),
      node('Media', [S(objectName(file, 'Video'))]),
      node('FileName', [S(file)]),
      node('RelativeFilename', [S(file)]),
      node('ModelUVTranslation', [D(0), D(0)]),
      node('ModelUVScaling', [D(1), D(1)]),
      node('Texture_Alpha_Source', [S('None')]),
      node('Cropping', [I(0), I(0), I(0), I(0)]),
    ]));
    count('Texture');
    OO(video, id);
    summary.textures++;
    return id;
  };

  await addModel(root, 0n);

  // ---- skin: one Skin deformer per skinned mesh, one Cluster per influencing bone, and the bind pose
  const poseNodes: FbxNode[] = [];
  const posed = new Set<bigint>();
  const pose = (id: bigint, m: THREE.Matrix4) => {
    if (posed.has(id)) return;
    posed.add(id);
    poseNodes.push(node('PoseNode', [], [node('Node', [L(id)]), node('Matrix', [Ad(m.elements)])]));
  };
  for (const mesh of skinned) {
    summary.skinnedMeshes++;
    const meshId = modelIds.get(mesh)!;
    const geometryId = objects.find(o => o.name === 'Geometry' && (o.props[1] as { v: string }).v === objectName(mesh.name, 'Geometry'));
    const geometry = (geometryId!.props[0] as { v: bigint }).v;
    const skin = newId();
    objects.push(node('Deformer', [L(skin), S(objectName(mesh.name, 'Deformer')), S('Skin')], [node('Version', [I(101)]), node('Link_DeformAcuracy', [D(50)])]));
    count('Deformer');
    OO(skin, geometry);
    const meshWorld = mesh.matrixWorld.clone().multiply(mesh.bindMatrix);
    pose(meshId, meshWorld);
    const index = mesh.geometry.getAttribute('skinIndex');
    const weight = mesh.geometry.getAttribute('skinWeight');
    const influences = new Map<number, { indexes: number[]; weights: number[] }>();
    for (let v = 0; v < index.count; v++) {
      for (let k = 0; k < 4; k++) {
        const w = weight.getComponent(v, k);
        if (!w) continue;
        const b = index.getComponent(v, k);
        if (!influences.has(b)) influences.set(b, { indexes: [], weights: [] });
        influences.get(b)!.indexes.push(v);
        influences.get(b)!.weights.push(w);
      }
    }
    mesh.skeleton.bones.forEach((bone, b) => {
      const link = meshWorld.clone().multiply(mesh.skeleton.boneInverses[b].clone().invert()); // bone at bind (world)
      pose(modelIds.get(bone)!, link);
      const inf = influences.get(b);
      if (!inf) return;
      const cluster = newId();
      objects.push(node('Deformer', [L(cluster), S(objectName(`${mesh.name}_${bone.name}`, 'SubDeformer')), S('Cluster')], [
        node('Version', [I(100)]),
        node('UserData', [S(''), S('')]),
        node('Indexes', [Ai(inf.indexes)]),
        node('Weights', [Ad(inf.weights)]),
        node('Transform', [Ad(meshWorld.clone().invert().multiply(link).invert().elements)]),
        node('TransformLink', [Ad(link.elements)]),
      ]));
      count('Deformer');
      OO(cluster, skin);
      OO(modelIds.get(bone)!, cluster);
    });
  }
  for (const h of helpers) {
    const skin = newId();
    objects.push(node('Deformer', [L(skin), S(objectName(h.mesh.name, 'Deformer')), S('Skin')], [node('Version', [I(101)]), node('Link_DeformAcuracy', [D(50)])]));
    count('Deformer');
    OO(skin, h.geometryId);
    pose(h.meshId, new THREE.Matrix4());
    pose(h.helperId, h.bind);
    const cluster = newId();
    const n = h.mesh.geometry.getAttribute('position').count;
    objects.push(node('Deformer', [L(cluster), S(objectName(`${h.mesh.name}_Ctrl`, 'SubDeformer')), S('Cluster')], [
      node('Version', [I(100)]),
      node('UserData', [S(''), S('')]),
      node('Indexes', [Ai(Array.from({ length: n }, (_, i) => i))]),
      node('Weights', [Ad(new Float64Array(n).fill(1))]),
      node('Transform', [Ad(h.bind.clone().invert().elements)]),
      node('TransformLink', [Ad(h.bind.elements)]),
    ]));
    count('Deformer');
    OO(cluster, skin);
    OO(h.helperId, cluster);
  }
  if (poseNodes.length) {
    const id = newId();
    objects.push(node('Pose', [L(id), S(objectName('BindPose', 'Pose')), S('BindPose')], [node('Type', [S('BindPose')]), node('Version', [I(100)]), node('NbPoseNodes', [I(poseNodes.length)]), ...poseNodes]));
    count('Pose');
  }

  // ---- animation: one stack per clip
  for (const clip of prepared.animations) {
    const frames = Math.round(clip.duration * FPS);
    const stack = newId();
    objects.push(node('AnimationStack', [L(stack), S(objectName(clip.name, 'AnimStack')), S('')], [props70(
      P('LocalStart', 'KTime', 'Time', '', 0n), P('LocalStop', 'KTime', 'Time', '', ktime(frames)),
      P('ReferenceStart', 'KTime', 'Time', '', 0n), P('ReferenceStop', 'KTime', 'Time', '', ktime(frames)),
    )]));
    count('AnimationStack');
    const layer = newId();
    objects.push(node('AnimationLayer', [L(layer), S(objectName(clip.name, 'AnimLayer')), S('')], []));
    count('AnimationLayer');
    OO(layer, stack);
    summary.stacks++;
    for (const track of clip.tracks) {
      const [target, path] = track.name.split('.');
      const model = byName.get(target);
      if (!model) throw new Error(`FBX: animated node ${target} not found`);
      const n = track.times.length;
      const keyFrames = Array.from(track.times, t => Math.round(t * FPS));
      const values: number[][] = [];
      if (path === 'quaternion') {
        const q = new THREE.Quaternion();
        let prev: number[] | null = null;
        for (let k = 0; k < n; k++) {
          q.fromArray(track.values as ArrayLike<number> as number[], k * 4);
          const e = toEulerDegrees(q, orderOf(target).three);
          if (prev) for (let c = 0; c < 3; c++) while (e[c] - prev[c] > 180) e[c] -= 360; // unwrap: nearest equivalent angle
          if (prev) for (let c = 0; c < 3; c++) while (e[c] - prev[c] < -180) e[c] += 360;
          values.push(e);
          prev = e;
        }
      } else {
        for (let k = 0; k < n; k++) values.push(Array.from(track.values.slice(k * 3, k * 3 + 3)));
      }
      // Hold keys: value k-1 repeated on the frame before key k, so linear interpolation never blends two frames.
      const frames: number[] = [];
      const vals: number[][] = [];
      for (let k = 0; k < n; k++) {
        if (k > 0 && keyFrames[k] - 1 > keyFrames[k - 1]) {
          frames.push(keyFrames[k] - 1);
          vals.push(values[k - 1]);
        }
        frames.push(keyFrames[k]);
        vals.push(values[k]);
      }
      const kind = path === 'quaternion' ? 'R' : path === 'position' ? 'T' : 'S';
      const property = path === 'quaternion' ? 'Lcl Rotation' : path === 'position' ? 'Lcl Translation' : 'Lcl Scaling';
      const curveNode = newId();
      objects.push(node('AnimationCurveNode', [L(curveNode), S(objectName(kind, 'AnimCurveNode')), S('')], [props70(
        P('d|X', 'Number', '', 'A', vals[0][0]), P('d|Y', 'Number', '', 'A', vals[0][1]), P('d|Z', 'Number', '', 'A', vals[0][2]),
      )]));
      count('AnimationCurveNode');
      OO(curveNode, layer);
      OP(curveNode, model, property);
      ['X', 'Y', 'Z'].forEach((axis, c) => {
        const curve = newId();
        objects.push(node('AnimationCurve', [L(curve), S(objectName('', 'AnimCurve')), S('')], [
          node('Default', [D(vals[0][c])]),
          node('KeyVer', [I(4008)]),
          node('KeyTime', [Al(frames.map(ktime))]),
          node('KeyValueFloat', [Af(vals.map(v => v[c]))]),
          node('KeyAttrFlags', [Ai([KEY_CONSTANT])]),
          node('KeyAttrDataFloat', [Af([0, 0, 0, 0])]),
          node('KeyAttrRefCount', [Ai([frames.length])]),
        ]));
        count('AnimationCurve');
        OP(curve, curveNode, `d|${axis}`);
      });
    }
  }

  // ---- document
  const totalFrames = Math.max(0, ...prepared.animations.map(c => Math.round(c.duration * FPS)));
  const definitions = node('Definitions', [], [
    node('Version', [I(100)]),
    node('Count', [I([...counts.values()].reduce((a, b) => a + b, 0) + 1)]),
    node('ObjectType', [S('GlobalSettings')], [node('Count', [I(1)])]),
    ...[...counts].map(([type, n]) => node('ObjectType', [S(type)], [node('Count', [I(n)])])),
  ]);
  const doc: FbxNode[] = [
    node('FBXHeaderExtension', [], [
      node('FBXHeaderVersion', [I(1003)]),
      node('FBXVersion', [I(7400)]),
      node('EncryptionType', [I(0)]),
      node('CreationTimeStamp', [], [node('Version', [I(1000)]), node('Year', [I(2000)]), node('Month', [I(1)]), node('Day', [I(1)]), node('Hour', [I(0)]), node('Minute', [I(0)]), node('Second', [I(0)]), node('Millisecond', [I(0)])]),
      node('Creator', [S('BuddyPoke Studio (original BuddyRevival data)')]),
    ]),
    node('FileId', [R(new Uint8Array([0x28, 0xb3, 0x2a, 0xeb, 0xb6, 0x24, 0xcc, 0xc2, 0xbf, 0xc8, 0xb0, 0x2a, 0xa9, 0x2b, 0xfc, 0xf1]))]),
    node('CreationTime', [S('2000-01-01 00:00:00:000')]),
    node('Creator', [S('BuddyPoke Studio (original BuddyRevival data)')]),
    node('GlobalSettings', [], [node('Version', [I(1000)]), props70(
      P('UpAxis', 'int', 'Integer', '', 1), P('UpAxisSign', 'int', 'Integer', '', 1),
      P('FrontAxis', 'int', 'Integer', '', 2), P('FrontAxisSign', 'int', 'Integer', '', 1),
      P('CoordAxis', 'int', 'Integer', '', 0), P('CoordAxisSign', 'int', 'Integer', '', 1),
      P('OriginalUpAxis', 'int', 'Integer', '', 1), P('OriginalUpAxisSign', 'int', 'Integer', '', 1),
      P('UnitScaleFactor', 'double', 'Number', '', 100), P('OriginalUnitScaleFactor', 'double', 'Number', '', 100),
      P('TimeMode', 'enum', '', '', 6), P('CustomFrameRate', 'double', 'Number', '', FPS),
      P('TimeSpanStart', 'KTime', 'Time', '', 0n), P('TimeSpanStop', 'KTime', 'Time', '', ktime(totalFrames)),
    )]),
    node('Documents', [], [node('Count', [I(1)]), node('Document', [L(newId()), S(''), S('Scene')], [
      props70(P('SourceObject', 'object', '', ''), P('ActiveAnimStackName', 'KString', '', '', prepared.animations[0]?.name ?? '')),
      node('RootNode', [L(0n)]),
    ])]),
    node('References'),
    definitions,
    node('Objects', [], objects),
    node('Connections', [], connections),
    node('Takes', [], [node('Current', [S('')])]),
  ];
  summary.helpers = helpers.length;
  summary.maxEulerError = Math.max(0, ...[...orders.values()].map(o => o.error));
  summary.maxEulerErrorNode = [...orders].sort((a, b) => b[1].error - a[1].error)[0]?.[0];
  return { fbx: encodeFbx(doc), summary };
}
