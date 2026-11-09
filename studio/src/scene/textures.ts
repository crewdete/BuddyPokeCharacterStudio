// Original composed bitmaps (OffscreenCanvas from TextureLibrary.compose) -> Three textures.
import * as THREE from 'three';

export class TextureCache {
  private readonly cache = new Map<OffscreenCanvas, THREE.Texture>();

  get(bitmap: OffscreenCanvas): THREE.Texture {
    let texture = this.cache.get(bitmap);
    if (!texture) {
      texture = new THREE.CanvasTexture(bitmap);
      texture.colorSpace = THREE.SRGBColorSpace;
      // The original renderer filled triangles with a repeating CanvasPattern; match its wrapping.
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.anisotropy = 4;
      texture.name = 'buddypoke';
      this.cache.set(bitmap, texture);
    }
    return texture;
  }

  /** Dispose textures whose bitmap is no longer shown. Every dress() composes new bitmaps. */
  retain(live: Set<OffscreenCanvas>) {
    for (const [bitmap, texture] of this.cache) {
      if (live.has(bitmap)) continue;
      texture.dispose();
      this.cache.delete(bitmap);
    }
  }
}
