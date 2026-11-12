import * as THREE from 'three'
import atlasUrl from './assets/city-surfaces.webp'

export type CitySurface = 'asphalt' | 'grass' | 'paving' | 'plaster'
const SURFACES: Record<CitySurface, [number, number, number]> = {
  asphalt: [0, 1 / 3, .65], grass: [1, 1 / 1.4, .85],
  paving: [2, 1 / 3, .9], plaster: [3, 1 / 2, .45],
}

/** Four CC0 surfaces, one sampler, and the same spatial instance batches. */
export class CityTextures {
  readonly material = new THREE.MeshStandardMaterial({ roughness: .9, metalness: .02 })
  private atlas: THREE.Texture
  private materials = new Map<string, THREE.MeshStandardMaterial>()
  private disposed = false
  private ready = { value: 0 }

  constructor(anisotropy: number, invalidate: () => void) {
    this.atlas = new THREE.TextureLoader().load(atlasUrl, texture => {
      if (this.disposed) { texture.dispose(); return }
      this.ready.value = 1
      invalidate()
    }, undefined, () => { /* Keep the original palette if loading fails. */ })
    this.atlas.name = 'ambientCG city surface atlas'
    this.atlas.colorSpace = THREE.SRGBColorSpace
    this.atlas.flipY = false
    this.atlas.anisotropy = Math.min(4, anisotropy)
    // A failed or pending image keeps the original flat colors.
    this.material.onBeforeCompile = shader => {
      shader.uniforms.cityAtlas = { value: this.atlas }
      shader.uniforms.cityAtlasReady = this.ready
      shader.vertexShader = shader.vertexShader.replace('#include <common>', `
        #include <common>
        attribute vec3 citySurface;
        varying vec2 vCityUv;
        varying vec2 vCitySurface;
      `).replace('#include <begin_vertex>', `
        #include <begin_vertex>
        vec3 cityPosition = position;
        #ifdef USE_INSTANCING
          cityPosition *= vec3(length(instanceMatrix[0].xyz),
            length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        #endif
        vec3 cityNormal = abs(normal);
        vCityUv = (cityNormal.y > .5 ? cityPosition.xz :
          (cityNormal.x > .5 ? cityPosition.zy : cityPosition.xy)) * citySurface.y;
        vCitySurface = citySurface.xz;
      `)
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `
        #include <common>
        uniform sampler2D cityAtlas;
        uniform float cityAtlasReady;
        varying vec2 vCityUv;
        varying vec2 vCitySurface;
      `).replace('#include <map_fragment>', `
        #include <map_fragment>
        if (vCitySurface.y > 0.0 && cityAtlasReady > 0.0) {
          vec2 tile = vec2(mod(vCitySurface.x, 2.0), floor(vCitySurface.x / 2.0));
          // Wrapped 16px gutters protect tile edges. Explicit derivatives avoid
          // mip seams where fract() wraps; coarse mips fade to the base color.
          vec2 atlasUv = tile * .5 + vec2(16.0 / 1024.0) + fract(vCityUv) * (480.0 / 1024.0);
          vec2 dx = dFdx(vCityUv) * (480.0 / 1024.0);
          vec2 dy = dFdy(vCityUv) * (480.0 / 1024.0);
          float footprint = max(length(dx), length(dy)) * 1024.0;
          float detail = 1.0 - smoothstep(4.0, 12.0, footprint);
          if (detail > 0.0) {
            vec3 grain = textureGrad(cityAtlas, atlasUv, dx, dy).rgb;
            diffuseColor.rgb *= mix(vec3(1.0), grain * 2.0, vCitySurface.y * detail);
          }
        }
      `)
    }
    this.material.customProgramCacheKey = () => 'city-surfaces-v1'
  }

  values(surface: CitySurface | null): [number, number, number] {
    return surface ? SURFACES[surface] : [0, 0, 0]
  }

  surfaceMaterial(color: string) {
    let material = this.materials.get(color)
    if (!material) {
      material = this.material.clone()
      material.color.set(color)
      material.onBeforeCompile = this.material.onBeforeCompile
      material.customProgramCacheKey = this.material.customProgramCacheKey
      this.materials.set(color, material)
    }
    return material
  }

  apply(geometry: THREE.BufferGeometry, surface: CitySurface) {
    const data = new Float32Array(geometry.getAttribute('position').count * 3)
    const values = this.values(surface)
    for (let i = 0; i < data.length; i += 3) data.set(values, i)
    geometry.setAttribute('citySurface', new THREE.BufferAttribute(data, 3))
    return geometry
  }

  dispose() {
    this.disposed = true
    this.atlas.dispose()
    this.material.dispose()
    this.materials.forEach(material => material.dispose())
    this.materials.clear()
  }
}
