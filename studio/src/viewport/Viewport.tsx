import { Grid, OrbitControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { CharacterRig } from '../scene/CharacterRig';
import { FRONT, characterBounds, frameBox, orthoZoomFor } from '../scene/framing';
import { useViewport } from '../state/viewport';
import { Ground } from './Ground';
import { ViewportToolbar } from './ViewportToolbar';

const FOV = 35;

declare global {
  interface Window {
    /** Current camera and controls, read by the end-to-end tests. */
    __studioViewport?: { camera: THREE.Camera; controls: OrbitControlsImpl | null; size: { width: number; height: number } };
  }
}

/** A camera-independent description of the view, so it survives perspective <-> orthographic switches. */
interface View {
  target: THREE.Vector3;
  direction: THREE.Vector3;
  distance: number;
}

function Character({ rig }: { rig: CharacterRig }) {
  useFrame(() => rig.refreshTextures());
  return <primitive object={rig.root} />;
}

function StudioCamera({ rig }: { rig: CharacterRig | null }) {
  const projection = useViewport(s => s.projection);
  const resetToken = useViewport(s => s.resetToken);
  const { camera, controls, size } = useThree() as unknown as {
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
    controls: OrbitControlsImpl | null;
    size: { width: number; height: number };
  };
  const view = useRef<View | null>(null);
  const pending = useRef(false);

  // Frame the character from the front: on first load and on every reset request.
  useEffect(() => {
    if (!rig) return;
    const framing = frameBox(characterBounds(rig), FOV, size.width / size.height);
    view.current = { target: framing.target, direction: FRONT.clone(), distance: framing.distance };
    pending.current = true;
    // `size` is read at reset time only; resizing must not re-frame the user's view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rig, resetToken]);

  // When the projection changes, re-apply the last view to the new camera once its controls exist.
  useEffect(() => {
    pending.current = true;
  }, [projection]);

  useFrame(() => {
    window.__studioViewport = { camera, controls, size };
    if (!controls || controls.object !== camera) return;
    if (pending.current && view.current) {
      const { target, direction, distance } = view.current;
      camera.position.copy(target).addScaledVector(direction, distance);
      camera.lookAt(target);
      if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
        camera.zoom = orthoZoomFor(size.height, distance, FOV);
        camera.updateProjectionMatrix();
      }
      controls.target.copy(target);
      controls.update();
      pending.current = false;
      return;
    }
    // Track the current view so a projection switch keeps orientation and apparent size.
    const target = controls.target.clone();
    const offset = camera.position.clone().sub(target);
    const distance = (camera as THREE.OrthographicCamera).isOrthographicCamera
      ? size.height / (2 * camera.zoom * Math.tan(THREE.MathUtils.degToRad(FOV) / 2))
      : offset.length();
    view.current = { target, direction: offset.normalize(), distance };
  });

  return (
    <>
      <PerspectiveCamera makeDefault={projection === 'perspective'} fov={FOV} near={1} far={20000} position={[0, 80, 400]} />
      <OrthographicCamera makeDefault={projection === 'orthographic'} near={-20000} far={20000} position={[0, 80, 400]} />
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.12}
        minDistance={40}
        maxDistance={3000}
        minZoom={0.2}
        maxZoom={40}
        zoomToCursor={false}
      />
    </>
  );
}

function StudioScene({ rig }: { rig: CharacterRig | null }) {
  const showGrid = useViewport(s => s.showGrid);
  return (
    <>
      <StudioCamera rig={rig} />
      <Ground />
      {showGrid && (
        <Grid
          position={[0, -0.1, 0]}
          args={[600, 600]}
          cellSize={10}
          sectionSize={50}
          cellThickness={0.6}
          sectionThickness={1}
          cellColor="#c6c6c6"
          sectionColor="#a9a9a9"
          fadeDistance={700}
          fadeStrength={1.5}
          followCamera={false}
          infiniteGrid
          renderOrder={-3}
        />
      )}
      {rig && <Character rig={rig} />}
    </>
  );
}

export function Viewport({ rig }: { rig: CharacterRig | null }) {
  return (
    <div className="viewport-stage">
      <Canvas flat dpr={[1, 2]} gl={{ antialias: true, alpha: true }} data-testid="viewport" onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}>
        <StudioScene rig={rig} />
      </Canvas>
      <ViewportToolbar />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Comparison mode (?compare=1): the original renderer's exact camera and canvas size, transparent
// background, no ground or grid. Used by tests to compare against the original Canvas 2D renderer.

export const ORIGINAL_CANVAS = { width: 692, height: 520 };

function OriginalCamera({ rig }: { rig: CharacterRig }) {
  const set = useThree(s => s.set);
  const ref = useRef<THREE.PerspectiveCamera>(null);
  useEffect(() => {
    const camera = ref.current!;
    const original = rig.scene.node('Camera_Long2') as unknown as import('@original/engine/scene-graph.js').Camera;
    original.update(ORIGINAL_CANVAS);
    // The original fov spans the canvas width; Three's spans the height.
    const { width, height } = ORIGINAL_CANVAS;
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(original.fov / 2) * (height / width)));
    camera.aspect = width / height;
    camera.matrixAutoUpdate = false;
    camera.matrix.fromArray(Array.from(original.view.e)).invert();
    camera.matrixWorld.copy(camera.matrix);
    camera.matrixWorldInverse.copy(camera.matrix).invert();
    camera.updateProjectionMatrix();
    set({ camera });
  }, [rig, set]);
  return <perspectiveCamera ref={ref} near={1} far={20000} />;
}

export function ComparisonViewport({ rig }: { rig: CharacterRig }) {
  return (
    <div className="compare-stage" style={ORIGINAL_CANVAS}>
      <Canvas flat dpr={1} gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true }} data-testid="compare">
        <OriginalCamera rig={rig} />
        <Character rig={rig} />
      </Canvas>
    </div>
  );
}
