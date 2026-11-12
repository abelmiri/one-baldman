import * as THREE from 'three'
import skinColorUrl from './assets/hero-skin-color.webp'
import skinDetailUrl from './assets/hero-skin-detail.webp'
import suitColorUrl from './assets/hero-suit-color.webp'
import suitNormalUrl from './assets/hero-suit-normal.webp'
import suitRoughnessUrl from './assets/hero-suit-roughness.webp'

// One small texture set shared by all physical limbs and preview characters.
// Ready neutral pixels keep the material usable before loading, or offline if
// an image fails. Color maps are sRGB; normals/height/roughness are linear.
class HeroTextures {
  private listeners = new Set<() => void>()
  private references = 0
  private disposed = false
  private load(url: string, fallback: string, color = false) {
    const canvas = document.createElement('canvas')
    // WebGL's immutable storage cannot grow from 1px after the first render.
    // Match the authored maps so late image upload reuses valid GPU storage.
    canvas.width = canvas.height = 512
    const context = canvas.getContext('2d')!
    context.fillStyle = fallback
    context.fillRect(0, 0, 512, 512)
    const texture = new THREE.Texture<HTMLCanvasElement | HTMLImageElement>(canvas)
    texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping
    texture.anisotropy = 4
    texture.needsUpdate = true
    const image = new Image()
    image.onload = () => {
      if (this.disposed) return
      texture.image = image
      texture.needsUpdate = true
      this.listeners.forEach(invalidate => invalidate())
    }
    image.src = url
    return texture
  }
  readonly skinColor = this.load(skinColorUrl, '#e0ab8c', true)
  readonly skinDetail = this.load(skinDetailUrl, '#80d280')
  readonly suitColor = this.load(suitColorUrl, '#ffffff', true)
  readonly suitNormal = this.load(suitNormalUrl, '#8080ff')
  readonly suitRoughness = this.load(suitRoughnessUrl, '#ffffff')

  constructor() {
    this.skinColor.repeat.set(2, 2)
    this.skinDetail.repeat.set(2, 2)
    for (const texture of [this.suitColor, this.suitNormal, this.suitRoughness]) texture.repeat.set(1.25, 1)
  }

  retain(invalidate: () => void) {
    this.references++
    this.listeners.add(invalidate)
    let released = false
    return () => {
      if (released) return
      released = true
      this.listeners.delete(invalidate)
      this.references--
      // A game reset immediately reuses the same decoded images/GPU maps.
      queueMicrotask(() => {
        if (this.references || this.disposed) return
        this.disposed = true
        for (const texture of [this.skinColor, this.skinDetail, this.suitColor, this.suitNormal, this.suitRoughness]) texture.dispose()
        if (shared === this) shared = null
      })
    }
  }
}

let shared: HeroTextures | null = null
export function acquireHeroTextures(invalidate: () => void) {
  const textures = shared ??= new HeroTextures()
  return { textures, dispose: textures.retain(invalidate) }
}
