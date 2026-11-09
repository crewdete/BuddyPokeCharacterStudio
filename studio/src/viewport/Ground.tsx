import { useMemo } from 'react';
import * as THREE from 'three';

// Studio floor: a soft disc that fades into the background. It does not write depth, so the
// original drop shadow (drawn just above it) and the character always read cleanly on top.
export function Ground({ radius = 320 }: { radius?: number }) {
  const texture = useMemo(() => {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const g = canvas.getContext('2d')!;
    const gradient = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    // Flat neutral grey under the character so the original drop shadow (black, at most 25%
    // opacity by design) reads; a highlight at the centre would cancel it out. Fades at the rim.
    gradient.addColorStop(0, 'rgba(214, 214, 214, 1)');
    gradient.addColorStop(0.4, 'rgba(214, 214, 214, 1)');
    gradient.addColorStop(0.75, 'rgba(222, 222, 222, 0.7)');
    gradient.addColorStop(1, 'rgba(236, 236, 236, 0)');
    g.fillStyle = gradient;
    g.fillRect(0, 0, size, size);
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, []);
  return (
    <mesh rotation-x={-Math.PI / 2} position={[0, -0.2, 0]} renderOrder={-4} name="StudioGround">
      <circleGeometry args={[radius, 96]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} />
    </mesh>
  );
}
