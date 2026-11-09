// The original painter's-algorithm renderer sorted triangles by `max z + screenZDepthOffset`, where a
// negative offset (hair -3/-5, caps and skirts -3, shadow -10) pulls a mesh in front of whatever lies
// within that many units behind it. With a depth buffer, hair resting on the head would z-fight
// instead. This patch reproduces the original rule exactly: the depth written for each vertex is
// computed as if it were `-offset` units closer to the camera along the view axis, while its screen
// position is unchanged. Works for perspective and orthographic projections.
import type * as THREE from 'three';

export function applyDepthOffset(material: THREE.Material, offset: number) {
  if (!offset) return;
  material.userData.depthOffset = offset;
  material.onBeforeCompile = shader => {
    shader.uniforms.uDepthOffset = { value: offset };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uDepthOffset;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        {
          vec4 biased = projectionMatrix * vec4(mvPosition.xy, mvPosition.z - uDepthOffset, mvPosition.w);
          gl_Position.z = biased.z / biased.w * gl_Position.w;
        }`,
      );
  };
  material.customProgramCacheKey = () => `depthOffset:${offset}`;
}
