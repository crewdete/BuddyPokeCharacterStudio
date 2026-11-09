// OBJ export: the customized character as static geometry (Rest or T-pose, exact posed vertices from the same
// preparation as the static GLB), one object per mesh part, with an MTL file and the original composed textures as
// PNG files. OBJ has no skeleton, skin weights or animation. Delivered as one ZIP: <name>.obj, <name>.mtl, textures.
import * as THREE from 'three';
import type { PreparedExport } from './prepare';
import { writeZip } from './zip';

const fmt = (n: number) => {
  const s = n.toFixed(6);
  return s === '-0.000000' ? '0.000000' : s;
};
const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, '_');

async function png(image: unknown): Promise<Uint8Array> {
  const img = image as CanvasImageSource & { width: number; height: number };
  const canvas = new OffscreenCanvas(img.width, img.height);
  canvas.getContext('2d')!.drawImage(img, 0, 0);
  return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

export interface ObjSummary {
  objects: number;
  vertices: number;
  triangles: number;
  textures: number;
  transparent: number;
}

export async function writeObjZip(prepared: PreparedExport, baseName: string): Promise<{ zip: Uint8Array; obj: string; mtl: string; summary: ObjSummary }> {
  const name = safe(baseName.replace(/\.(obj|zip)$/i, ''));
  const root = prepared.root;
  root.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  root.traverse(o => (o as THREE.Mesh).isMesh && meshes.push(o as THREE.Mesh));
  if (meshes.some(m => (m as THREE.SkinnedMesh).isSkinnedMesh)) throw new Error('OBJ export expects static (baked) geometry');

  const obj: string[] = [
    '# BuddyPoke Studio: customized character from the original BuddyRevival data',
    `# ${prepared.manifest.pose === 'tpose' ? 'T-pose' : 'Rest pose'}, units: metres (1 original unit = 1 cm), Y up`,
    `mtllib ${name}.mtl`,
  ];
  const mtl: string[] = ['# BuddyPoke Studio materials (original composed textures)'];
  const files: { name: string; data: Uint8Array }[] = [];
  const textureFiles = new Map<THREE.Texture, string>();
  const summary: ObjSummary = { objects: 0, vertices: 0, triangles: 0, textures: 0, transparent: 0 };
  let base = 1;
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
  for (const mesh of meshes) {
    const g = mesh.geometry;
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    const index = g.index!;
    const material = mesh.material as THREE.MeshBasicMaterial;
    const materialName = safe(mesh.name);
    normalMatrix.getNormalMatrix(mesh.matrixWorld);
    obj.push(`o ${safe(mesh.name)}`);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      obj.push(`v ${fmt(v.x)} ${fmt(v.y)} ${fmt(v.z)}`);
    }
    for (let i = 0; i < uv.count; i++) obj.push(`vt ${fmt(uv.getX(i))} ${fmt(uv.getY(i))}`);
    for (let i = 0; i < nor.count; i++) {
      n.fromBufferAttribute(nor, i).applyMatrix3(normalMatrix).normalize();
      obj.push(`vn ${fmt(n.x)} ${fmt(n.y)} ${fmt(n.z)}`);
    }
    obj.push(`usemtl ${materialName}`, 's off');
    for (let k = 0; k < index.count; k += 3) {
      const [a, b, c] = [index.getX(k) + base, index.getX(k + 1) + base, index.getX(k + 2) + base];
      obj.push(`f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}`);
    }
    base += pos.count;
    summary.objects++;
    summary.vertices += pos.count;
    summary.triangles += index.count / 3;

    mtl.push('', `newmtl ${materialName}`, 'Ka 0.000000 0.000000 0.000000', 'Kd 1.000000 1.000000 1.000000', 'Ks 0.000000 0.000000 0.000000', 'd 1.000000', 'illum 1');
    if (material.map) {
      let file = textureFiles.get(material.map);
      if (!file) {
        file = `${name}_${safe(material.map.name || mesh.name)}_${textureFiles.size}.png`;
        textureFiles.set(material.map, file);
        files.push({ name: file, data: await png(material.map.image) });
        summary.textures++;
      }
      mtl.push(`map_Kd ${file}`);
      if (material.transparent) {
        mtl.push(`map_d ${file}`);
        summary.transparent++;
      }
    }
  }
  const objText = obj.join('\n') + '\n';
  const mtlText = mtl.join('\n') + '\n';
  const enc = new TextEncoder();
  const zip = writeZip([{ name: `${name}.obj`, data: enc.encode(objText) }, { name: `${name}.mtl`, data: enc.encode(mtlText) }, ...files]);
  return { zip, obj: objText, mtl: mtlText, summary };
}
