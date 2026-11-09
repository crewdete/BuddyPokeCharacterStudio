// Read-only summaries of an original (decoded) scene graph. Pure: no DOM, safe in Node tests.
import { Camera, type Scene, type SceneNode } from '@original/engine/scene-graph.js';

export interface SceneInfo {
  nodes: number;
  bones: number;
  boneNames: string[];
  meshes: number;
  skinnedMeshes: number;
  rigidMeshes: number;
  props: number;
  cameras: number;
  cullRegions: number;
}

export function describeScene(scene: Scene): SceneInfo {
  let nodes = 0;
  let meshes = 0;
  let skinnedMeshes = 0;
  let cameras = 0;
  scene.find((node: SceneNode) => {
    nodes++;
    if (node instanceof Camera) cameras++;
    if (node.mesh) {
      meshes++;
      if (node.mesh.encodedSkin) skinnedMeshes++;
    }
    return false;
  });
  return {
    nodes,
    bones: scene.boneNames.length,
    boneNames: [...scene.boneNames],
    meshes,
    skinnedMeshes,
    rigidMeshes: meshes - skinnedMeshes,
    props: scene.propNames.length,
    cameras,
    cullRegions: scene.regionNames.length,
  };
}
