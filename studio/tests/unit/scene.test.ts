import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { applyDepthOffset } from '../../src/scene/depthOffset';
import { frameBox, orthoZoomFor } from '../../src/scene/framing';

describe('framing', () => {
  const box = new THREE.Box3(new THREE.Vector3(-30, 0, -20), new THREE.Vector3(30, 140, 20));

  it('centres on the box and fits its height', () => {
    const f = frameBox(box, 35, 16 / 9);
    expect(f.target.toArray()).toEqual([0, 70, 0]);
    const visible = 2 * (f.distance - 20) * Math.tan(THREE.MathUtils.degToRad(35) / 2);
    expect(visible).toBeGreaterThanOrEqual(140);
  });

  it('backs off further for narrow (phone) viewports', () => {
    // At aspect 0.25 the character's width, not its height, limits the fit.
    expect(frameBox(box, 35, 0.25).distance).toBeGreaterThan(frameBox(box, 35, 16 / 9).distance);
  });

  it('gives orthographic zoom matching the perspective view height at the target', () => {
    const distance = 300;
    const zoom = orthoZoomFor(800, distance, 35);
    expect(800 / zoom).toBeCloseTo(2 * distance * Math.tan(THREE.MathUtils.degToRad(35) / 2), 6);
  });
});

describe('depth offset (original screenZDepthOffset)', () => {
  it('leaves materials without an offset untouched', () => {
    const material = new THREE.MeshBasicMaterial();
    applyDepthOffset(material, 0);
    expect(material.userData.depthOffset).toBeUndefined();
  });

  it('biases depth only, after the standard projection', () => {
    const material = new THREE.MeshBasicMaterial();
    applyDepthOffset(material, -3);
    const shader = { uniforms: {} as Record<string, { value: unknown }>, vertexShader: '#include <common>\nvoid main(){\n#include <project_vertex>\n}', fragmentShader: '' };
    material.onBeforeCompile(shader as never, null as never);
    expect(shader.uniforms.uDepthOffset.value).toBe(-3);
    expect(shader.vertexShader).toContain('mvPosition.z - uDepthOffset');
    expect(shader.vertexShader).toContain('gl_Position.z = biased.z / biased.w * gl_Position.w');
    expect(shader.vertexShader.indexOf('#include <project_vertex>')).toBeLessThan(shader.vertexShader.indexOf('biased'));
    expect(material.customProgramCacheKey()).toBe('depthOffset:-3');
  });
});
