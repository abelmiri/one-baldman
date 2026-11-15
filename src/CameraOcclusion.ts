import * as THREE from 'three'
import type { Destructible, DestructiblePart } from './LaserDestruction'

type Wall = { part: DestructiblePart; owner: Destructible; bounds: THREE.Box3; matrix: THREE.Matrix4; opacity: number; attribute: THREE.InstancedBufferAttribute; index: number }
type Fragment = { base: THREE.Material; material: THREE.Material; uniform: { value: number } }
const VISIBLE_OPACITY = .08

/** Camera-only screen-door transparency. Opaque depth and spatial instancing stay intact. */
export class CameraOcclusion {
  private buildings = new Map<Destructible, { bounds: THREE.Box3; walls: Wall[] }>()
  private materials = new Map<THREE.Material, THREE.Material>()
  private faded = new Set<Wall>()
  private targets = new Set<Wall>()
  private fragments = new Map<THREE.Mesh, Fragment>()
  private fragmentTargets = new Set<THREE.Mesh>()
  private raycaster = new THREE.Raycaster()
  private hits: THREE.Intersection[] = []
  private direction = new THREE.Vector3()
  private point = new THREE.Vector3()
  private right = new THREE.Vector3()
  private rayMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
  private proxyGeometry = new THREE.BufferGeometry()
  private proxy = new THREE.Mesh(this.proxyGeometry, this.rayMaterial)

  material(base: THREE.Material) {
    let material = this.materials.get(base)
    if (!material) {
      material = this.makeMaterial(base)
      this.materials.set(base, material)
    }
    return material
  }

  private makeMaterial(base: THREE.Material, uniform?: { value: number }) {
    const material = base.clone()
    // Material.clone() does not preserve custom shader callbacks (e.g. the city atlas).
    const compile = base.onBeforeCompile
    const cacheKey = base.customProgramCacheKey()
    material.onBeforeCompile = (shader, renderer) => {
      compile.call(material, shader, renderer)
      if (uniform) shader.uniforms.cameraOpacity = uniform
      else shader.vertexShader = shader.vertexShader.replace('#include <common>',
        '#include <common>\nattribute float cameraOpacity;\nvarying float vCameraOpacity;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCameraOpacity = cameraOpacity;')
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>',
        `#include <common>\n${uniform ? 'uniform float cameraOpacity;' : 'varying float vCameraOpacity;'}`)
        .replace('#include <opaque_fragment>', `
          // Ordered coverage leaves depth holes for the hero, including layered walls.
          vec2 pixel = floor(gl_FragCoord.xy);
          float coverage = fract(0.5 * pixel.x + 0.75 * pixel.y);
          coverage = (coverage * 4.0 + fract(0.5 * floor(pixel.x / 2.0) + 0.75 * floor(pixel.y / 2.0))) / 4.0;
          if (${uniform ? 'cameraOpacity' : 'vCameraOpacity'} <= coverage) discard;
          #include <opaque_fragment>
        `)
    }
    material.customProgramCacheKey = () => `${cacheKey}-camera-coverage-${uniform ? 'mesh' : 'instance'}-v1`
    return material
  }

  register(owner: Destructible, part: DestructiblePart, attribute: THREE.InstancedBufferAttribute, index: number) {
    if (!part.geometry.boundingBox) part.geometry.computeBoundingBox()
    const matrix = part.matrix.clone()
    const bounds = part.geometry.boundingBox!.clone().applyMatrix4(matrix)
    let building = this.buildings.get(owner)
    if (!building) { building = { bounds: new THREE.Box3(), walls: [] }; this.buildings.set(owner, building) }
    building.bounds.union(bounds)
    building.walls.push({ part, owner, bounds, matrix, attribute, index, opacity: 1 })
  }

  update(camera: THREE.Camera, character: THREE.Vector3, delta: number, meshes: THREE.Mesh[], enabled: boolean) {
    this.targets.clear(); this.fragmentTargets.clear()
    if (enabled) {
      camera.updateWorldMatrix(true, false)
      this.right.setFromMatrixColumn(camera.matrixWorld, 0)
      // Cover the torso, head and sides instead of relying on a single center ray.
      for (let sample = 0; sample < 5; sample++) {
        this.point.copy(character)
        if (sample < 3) this.point.y += (sample - 1) * .6
        else this.point.addScaledVector(this.right, sample === 3 ? -.3 : .3)
        this.direction.copy(this.point).sub(camera.position)
        const distance = this.direction.length()
        if (distance < .3) continue
        this.raycaster.set(camera.position, this.direction.multiplyScalar(1 / distance))
        this.raycaster.near = .03; this.raycaster.far = distance - .15
        for (const [owner, building] of this.buildings) {
          if (owner.damaged || !this.intersects(building.bounds)) continue
          for (const wall of building.walls) {
            if (this.targets.has(wall) || !this.intersects(wall.bounds)) continue
            this.proxy.geometry = wall.part.geometry
            this.proxy.matrixWorld.copy(wall.matrix)
            if (this.hit(this.proxy)) this.targets.add(wall)
          }
        }
        for (const mesh of meshes) {
          if (this.fragmentTargets.has(mesh)) continue
          mesh.updateWorldMatrix(true, false)
          this.proxy.geometry = mesh.geometry
          this.proxy.matrixWorld.copy(mesh.matrixWorld)
          if (this.hit(this.proxy)) this.fragmentTargets.add(mesh)
        }
      }
    }
    let changed = false
    for (const wall of this.targets) this.faded.add(wall)
    for (const wall of this.faded) {
      const target = !wall.owner.damaged && this.targets.has(wall) ? VISIBLE_OPACITY : 1
      const opacity = this.fade(wall.opacity, target, delta)
      if (opacity !== wall.opacity) {
        wall.opacity = opacity; wall.attribute.setX(wall.index, opacity); wall.attribute.needsUpdate = true; changed = true
      }
      if (opacity === 1) this.faded.delete(wall)
    }
    for (const mesh of this.fragmentTargets) {
      if (this.fragments.has(mesh) || Array.isArray(mesh.material)) continue
      const uniform = { value: 1 }, base = mesh.material, material = this.makeMaterial(base, uniform)
      this.fragments.set(mesh, { base, material, uniform }); mesh.material = material
    }
    for (const [mesh, state] of this.fragments) {
      const opacity = mesh.parent ? this.fade(state.uniform.value, this.fragmentTargets.has(mesh) ? VISIBLE_OPACITY : 1, delta) : 1
      if (opacity !== state.uniform.value) { state.uniform.value = opacity; changed = true }
      if (opacity === 1) {
        if (mesh.material === state.material) mesh.material = state.base
        state.material.dispose(); this.fragments.delete(mesh)
      }
    }
    return changed
  }

  private intersects(bounds: THREE.Box3) {
    if (bounds.containsPoint(this.raycaster.ray.origin)) return true
    const hit = this.raycaster.ray.intersectBox(bounds, this.point)
    return !!hit && hit.distanceToSquared(this.raycaster.ray.origin) <= this.raycaster.far ** 2
  }

  private hit(mesh: THREE.Mesh) {
    this.hits.length = 0
    mesh.raycast(this.raycaster, this.hits)
    return this.hits.length > 0
  }

  private fade(current: number, target: number, delta: number) {
    const next = THREE.MathUtils.damp(current, target, target < current ? 22 : 12, Math.max(0, delta))
    return Math.abs(next - target) < .002 ? target : next
  }

  reset() {
    for (const wall of this.faded) { wall.opacity = 1; wall.attribute.setX(wall.index, 1); wall.attribute.needsUpdate = true }
    this.faded.clear(); this.targets.clear(); this.fragmentTargets.clear()
    for (const [mesh, state] of this.fragments) {
      if (mesh.material === state.material) mesh.material = state.base
      state.material.dispose()
    }
    this.fragments.clear()
  }

  dispose() {
    this.reset(); this.materials.forEach(material => material.dispose()); this.materials.clear()
    this.buildings.clear(); this.proxyGeometry.dispose(); this.rayMaterial.dispose()
  }
}
