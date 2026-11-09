// Skeleton overlay: the rig's real THREE.Bones (the 29 original bones, posed by the engine), redrawn from
// their world matrices on every rendered frame, so it follows Rest, T-pose and every animation frame.
// Real Biped bones: charcoal segments with a light halo and square joints. Helper bones (IG_* control
// bones for hair and the scooter root, Bip01_Footsteps): thinner, dashed, lighter grey.
// X-ray draws the overlay on top of the character; otherwise it is depth-tested (hidden inside the mesh).
import { useThree, useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { CharacterRig } from '../scene/CharacterRig';
import { useViewport } from '../state/viewport';

export const isHelperBone = (name: string) => name.startsWith('IG_') || name === 'Bip01_Footsteps';

const CHARCOAL = 0x2b2b2b;
const HALO = 0xf4f4f4;
const HELPER = 0x8a8a8a;
const ON_TOP = 1000;

declare global {
  interface Window {
    /** Read by the end-to-end tests. */
    __studioSkeleton?: SkeletonView;
  }
}

export class SkeletonView {
  readonly group = new THREE.Group();
  private readonly segments: { from: THREE.Bone; to: THREE.Bone; helper: boolean }[] = [];
  private readonly realGeometry = new LineSegmentsGeometry();
  private readonly helperGeometry = new LineSegmentsGeometry();
  private readonly realJoints = new THREE.BufferGeometry();
  private readonly helperJoints = new THREE.BufferGeometry();
  private readonly lineMaterials: LineMaterial[];
  private readonly pointMaterials: THREE.PointsMaterial[];
  private readonly helperLines: LineSegments2;
  private xray = true;

  constructor(readonly bones: THREE.Bone[]) {
    this.group.name = 'SkeletonOverlay';
    for (const bone of bones) {
      const parent = bone.parent as THREE.Bone | null;
      if (parent?.isBone) this.segments.push({ from: parent, to: bone, helper: isHelperBone(bone.name) || isHelperBone(parent.name) });
    }
    const halo = new LineMaterial({ color: HALO, linewidth: 4.5, transparent: true, opacity: 0.85 });
    const core = new LineMaterial({ color: CHARCOAL, linewidth: 2, transparent: true });
    const helper = new LineMaterial({ color: HELPER, linewidth: 1.5, transparent: true, dashed: true, dashSize: 2.5, gapSize: 2 });
    this.lineMaterials = [halo, core, helper];
    const jointHalo = new THREE.PointsMaterial({ color: HALO, size: 10, sizeAttenuation: false, transparent: true, opacity: 0.9 });
    const joint = new THREE.PointsMaterial({ color: CHARCOAL, size: 6, sizeAttenuation: false, transparent: true });
    const helperJoint = new THREE.PointsMaterial({ color: HELPER, size: 5, sizeAttenuation: false, transparent: true });
    this.pointMaterials = [jointHalo, joint, helperJoint];
    this.helperLines = new LineSegments2(this.helperGeometry, helper);
    const objects: [THREE.Object3D, number][] = [
      [new LineSegments2(this.realGeometry, halo), 0],
      [this.helperLines, 1],
      [new LineSegments2(this.realGeometry, core), 2],
      [new THREE.Points(this.realJoints, jointHalo), 3],
      [new THREE.Points(this.helperJoints, helperJoint), 3],
      [new THREE.Points(this.realJoints, joint), 4],
    ];
    for (const [object, order] of objects) {
      object.renderOrder = ON_TOP + order;
      object.frustumCulled = false;
      object.raycast = () => {}; // never interferes with picking / controls
      this.group.add(object);
    }
    this.setXray(true);
  }

  /** Counts for tests / UI. */
  get counts() {
    return { real: this.segments.filter(s => !s.helper).length, helper: this.segments.filter(s => s.helper).length };
  }

  setXray(on: boolean) {
    this.xray = on;
    for (const m of [...this.lineMaterials, ...this.pointMaterials]) {
      m.depthTest = !on;
      m.depthWrite = false;
      m.needsUpdate = true;
    }
  }

  get xrayOn() {
    return this.xray;
  }

  /** Rebuild positions from the bones' current world matrices. */
  update(width: number, height: number) {
    const p = new THREE.Vector3();
    const q = new THREE.Vector3();
    const real: number[] = [];
    const helper: number[] = [];
    for (const { from, to, helper: isHelper } of this.segments) {
      p.setFromMatrixPosition(from.matrixWorld);
      q.setFromMatrixPosition(to.matrixWorld);
      (isHelper ? helper : real).push(p.x, p.y, p.z, q.x, q.y, q.z);
    }
    this.realGeometry.setPositions(real);
    this.helperGeometry.setPositions(helper.length ? helper : [0, 0, 0, 0, 0, 0]);
    this.helperLines.computeLineDistances();
    const joints = (helperOnly: boolean) =>
      this.bones.filter(b => isHelperBone(b.name) === helperOnly).flatMap(b => p.setFromMatrixPosition(b.matrixWorld).toArray());
    this.realJoints.setAttribute('position', new THREE.Float32BufferAttribute(joints(false), 3));
    this.helperJoints.setAttribute('position', new THREE.Float32BufferAttribute(joints(true), 3));
    for (const m of this.lineMaterials) m.resolution.set(width, height);
  }

  /** Joint positions as drawn (tests compare them with the bones). */
  drawnJoints() {
    const read = (g: THREE.BufferGeometry) => Array.from((g.getAttribute('position')?.array as Float32Array) ?? []);
    return { real: read(this.realJoints), helper: read(this.helperJoints) };
  }

  dispose() {
    this.realGeometry.dispose();
    this.helperGeometry.dispose();
    this.realJoints.dispose();
    this.helperJoints.dispose();
    for (const m of [...this.lineMaterials, ...this.pointMaterials]) m.dispose();
  }
}

export function SkeletonOverlay({ rig }: { rig: CharacterRig }) {
  const showSkeleton = useViewport(s => s.showSkeleton);
  const xray = useViewport(s => s.xray);
  const size = useThree(s => s.size);
  const invalidate = useThree(s => s.invalidate);
  const view = useMemo(() => new SkeletonView(rig.bones), [rig]);

  useEffect(() => {
    window.__studioSkeleton = view;
    return () => {
      view.dispose();
      if (window.__studioSkeleton === view) delete window.__studioSkeleton;
    };
  }, [view]);

  useEffect(() => {
    view.setXray(xray);
    invalidate();
  }, [view, xray, invalidate]);

  useEffect(() => {
    view.group.visible = showSkeleton;
    if (showSkeleton) view.update(size.width, size.height);
    invalidate();
  }, [view, showSkeleton, size, invalidate]);

  // Runs before every render (on-demand: whenever the pose, camera or look changes).
  useFrame(() => {
    if (showSkeleton) view.update(size.width, size.height);
  });

  return <primitive object={view.group} />;
}
