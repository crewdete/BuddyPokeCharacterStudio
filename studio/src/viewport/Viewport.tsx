import { Grid, OrbitControls } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';

// Scaffold viewport: real WebGL canvas, orbit camera and a ground grid sized for the
// character (original units ≈ cm, buddy ≈ 140 tall). The character is added in M1.
export function Viewport() {
  return (
    <Canvas camera={{ position: [0, 90, 330], fov: 35, near: 1, far: 5000 }} dpr={[1, 2]} data-testid="viewport">
      <color attach="background" args={['#17181b']} />
      <Grid
        args={[400, 400]}
        cellSize={10}
        sectionSize={50}
        cellColor="#2a2c31"
        sectionColor="#3a3d44"
        fadeDistance={900}
        infiniteGrid
      />
      <OrbitControls target={[0, 65, 0]} makeDefault enableDamping />
    </Canvas>
  );
}
