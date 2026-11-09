// T-pose computed from the ORIGINAL rest pose and skeleton hierarchy.
//
// For each arm the Biped chain UpperArm -> Forearm -> Hand is turned so that each bone's axis (its
// local +X, which points at its child) points along world +X (left arm) / -X (right arm). Each bone gets
// the smallest rotation away from its own rest rotation (so the rest twist / palm orientation is kept),
// solved in the parent's actual world space, so the result is exactly horizontal even though the
// original rest matrices are slightly scaled (see M3A-1: non-unit stored axes). Every other bone stays
// at rest; thumbs, props and rigid parts follow their parents. The original rest data is never changed:
// the T-pose is a set of rotations written in place on top of an exact bind restore, like an animation.
//
// The original engine's rotate(angle, axis) equals THREE.Matrix4.makeRotationAxis(axis, +angle), so
// rotations are solved with Three's quaternions and stored back as original axis-angle values.
import * as THREE from 'three';
import { IDENTITY, type Matrix4 } from '@original/engine/math.js';
import { Camera, type Scene, type SceneNode } from '@original/engine/scene-graph.js';
import type { BindSnapshot } from './bind';

export const ARM_CHAIN = ['UpperArm', 'Forearm', 'Hand'] as const;
export const SIDES = [
  { side: 'L', direction: new THREE.Vector3(1, 0, 0) }, // the character's left is +X
  { side: 'R', direction: new THREE.Vector3(-1, 0, 0) },
] as const;

/** Rebuild local/world matrices exactly like the original draw traversal (cameras untouched). */
export function updateWorlds(scene: Scene) {
  const walk = (node: SceneNode, parent: Matrix4) => {
    if (node instanceof Camera) return;
    node.updateWorld(parent);
    for (const child of node.children) walk(child, node.world);
  };
  walk(scene, IDENTITY);
}

export class TPose {
  private readonly rotations: { node: SceneNode; value: [number, number, number, number] }[] = [];

  /** Solves the T-pose from the exact bind pose (restored first), then leaves the scene at bind again. */
  constructor(
    private readonly scene: Scene,
    private readonly bind: BindSnapshot,
  ) {
    const parents = new Map<SceneNode, SceneNode>();
    scene.find(node => {
      for (const child of node.children) parents.set(child, node);
      return false;
    });
    bind.restore();
    updateWorlds(scene);
    const parentWorld = new THREE.Matrix4();
    const inverse = new THREE.Matrix3();
    const xAxis = new THREE.Vector3(1, 0, 0);
    for (const { side, direction } of SIDES) {
      for (const bone of ARM_CHAIN) {
        const node = scene.node(`Bip01_${side}_${bone}`);
        const parent = node && parents.get(node);
        if (!node?.rotation || !parent) throw new Error(`T-pose: missing Bip01_${side}_${bone}`);
        // Direction the bone axis must have in its parent's space so that the world axis is `direction`.
        inverse.setFromMatrix4(parentWorld.fromArray(Array.from(parent.world.e))).invert();
        const wanted = direction.clone().applyMatrix3(inverse).normalize();
        // Rest rotation (unit axis) and the minimal turn from its axis to the wanted one.
        const r = node.rotation;
        const rest = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(r.x, r.y, r.z).normalize(), r.angle);
        const turn = new THREE.Quaternion().setFromUnitVectors(xAxis.clone().applyQuaternion(rest), wanted);
        const q = new THREE.Quaternion().multiplyQuaternions(turn, rest).normalize();
        if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
        const s = Math.sqrt(Math.max(0, 1 - q.w * q.w));
        const value: [number, number, number, number] = s < 1e-12 ? [1, 0, 0, 0] : [q.x / s, q.y / s, q.z / s, 2 * Math.acos(Math.min(1, q.w))];
        [r.x, r.y, r.z, r.angle] = value;
        this.rotations.push({ node, value });
        updateWorlds(scene); // the next bone in the chain is solved against this one
      }
    }
    bind.restore();
    updateWorlds(scene);
  }

  /** Show the T-pose: exact bind restore, then the solved arm rotations written in place. Deterministic. */
  apply() {
    this.bind.restore();
    for (const { node, value } of this.rotations) {
      const r = node.rotation!;
      [r.x, r.y, r.z, r.angle] = value;
    }
  }

  /** Names of the bones the T-pose changes. */
  bones() {
    return this.rotations.map(r => r.node.name!);
  }
}
