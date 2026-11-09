// Exact snapshot of the original bind (rest) pose, and restore.
//
// The original animation tracks write straight into the scene nodes' `position` / `rotation` objects
// (web/src/engine/animation.js, Track.apply). A track looks its node up once, creates any missing
// object once (`node.position ??= new Vector3()`) and from then on writes into that same object.
// So a restore must write values back IN PLACE, never replace or null the objects.
// Nodes that had no bind position/rotation get (0,0,0) / angle 0, which the original
// SceneNode.updateWorld() turns into exactly the same local matrix as "none" (translation(0,0,0) is
// the identity; Matrix4.rotateBy skips angle 0).
import type { Scene, SceneNode } from '@original/engine/scene-graph.js';

interface NodeBind {
  node: SceneNode;
  position: [number, number, number] | null;
  rotation: [number, number, number, number] | null;
}

export class BindSnapshot {
  private readonly entries: NodeBind[] = [];

  /** Capture the current (freshly loaded, never animated) pose of every node. */
  constructor(readonly scene: Scene) {
    scene.find(node => {
      const p = node.position;
      const r = node.rotation;
      this.entries.push({ node, position: p ? [p.x, p.y, p.z] : null, rotation: r ? [r.x, r.y, r.z, r.angle] : null });
      return false;
    });
  }

  /** Write the bind values back into the scene, in place. Exact: the resulting local matrices equal the bind ones bit for bit. */
  restore() {
    for (const { node, position, rotation } of this.entries) {
      if (node.position) {
        const [x, y, z] = position ?? [0, 0, 0];
        node.position.x = x;
        node.position.y = y;
        node.position.z = z;
      }
      if (node.rotation) {
        const [x, y, z, angle] = rotation ?? [0, 1, 0, 0];
        node.rotation.x = x;
        node.rotation.y = y;
        node.rotation.z = z;
        node.rotation.angle = angle;
      }
    }
  }
}
