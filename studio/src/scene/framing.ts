// Camera framing for the character: fit the visible body (not the ground shadow) in view.
import * as THREE from 'three';
import type { CharacterRig } from './CharacterRig';

/** Default view direction: from the front, slightly above (target -> camera). */
export const FRONT = new THREE.Vector3(0, 0.12, 1).normalize();
/** Breathing room around the character (also keeps it clear of the viewport toolbar). */
const MARGIN = 1.32;

export function characterBounds(rig: CharacterRig): THREE.Box3 {
  rig.root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  for (const mesh of rig.visibleParts()) box.expandByObject(mesh, true);
  // Also fit the T-pose (wider than the rest pose), so switching modes never needs a camera change.
  if (rig.framingExtra) box.union(rig.framingExtra);
  return box;
}

export interface Framing {
  target: THREE.Vector3;
  /** Perspective camera distance from target. */
  distance: number;
  /** World-space height and width the view must show. */
  height: number;
  width: number;
}

export function frameBox(box: THREE.Box3, fovDeg: number, aspect: number): Framing {
  const size = box.getSize(new THREE.Vector3());
  const target = box.getCenter(new THREE.Vector3());
  const height = size.y * MARGIN;
  const width = Math.max(size.x, size.z) * MARGIN;
  const tan = Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2);
  const distance = Math.max(height / 2 / tan, width / 2 / (tan * aspect)) + size.z / 2;
  return { target, distance, height, width };
}

/** Orthographic zoom that shows the same world height a perspective camera shows at `distance`. */
export function orthoZoomFor(viewportHeight: number, distance: number, fovDeg: number) {
  const visible = 2 * distance * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2);
  return viewportHeight / visible;
}
