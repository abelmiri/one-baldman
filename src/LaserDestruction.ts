import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d'
import { laserPlanes, laserSolid, solidGeometry, solidsTouch, subtractLaser, translatedSolid, type LaserSolid } from './LaserGeometry'

export type DestructiblePart = {
  geometry: THREE.BufferGeometry; matrix: THREE.Matrix4; color: THREE.Color
  mesh?: THREE.InstancedMesh; index?: number
}
export type Destructible = {
  kind: 'building' | 'tree' | 'car'; parts: DestructiblePart[]; colliders: RAPIER.Collider[]
  damaged: boolean; transform?: THREE.Object3D; stop?: () => void
  velocity?: THREE.Vector3
}
type Chunk = { owner: Destructible; solids: LaserSolid[]; mesh: THREE.Mesh; body?: RAPIER.RigidBody; colliders: RAPIER.Collider[] }

/** Lazy geometry replacement: untouched scenery retains the original instanced draws. */
export class LaserDestruction {
  readonly objects: Destructible[] = []
  private chunks: Chunk[] = []
  private targets = new Map<number, Destructible | Chunk>()
  private material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .88 })
  private world: RAPIER.World | null = null
  private previous = new Map<number, { owner: Destructible; point: THREE.Vector3 }>()

  constructor(private root: THREE.Group, private dust: (point: THREE.Vector3Like, normal: THREE.Vector3Like, speed: number) => void = () => {}) {}

  create(kind: Destructible['kind']): Destructible {
    const owner: Destructible = { kind, parts: [], colliders: [], damaged: false }
    this.objects.push(owner)
    return owner
  }

  register(owner: Destructible, collider: RAPIER.Collider) {
    owner.colliders.push(collider)
    this.targets.set(collider.handle, owner)
  }

  /** Call after freeing the previous world; old WASM handles must never be reused. */
  reset(world: RAPIER.World) {
    for (const chunk of this.chunks) { chunk.mesh.removeFromParent(); chunk.mesh.geometry.dispose() }
    this.chunks.length = 0
    this.targets.clear()
    this.previous.clear()
    this.world = world
    const dirty = new Set<THREE.InstancedMesh>()
    for (const owner of this.objects) {
      if (owner.damaged) for (const part of owner.parts) if (part.mesh && part.index !== undefined) {
        part.mesh.setMatrixAt(part.index, part.matrix)
        dirty.add(part.mesh)
      }
      owner.damaged = false
      owner.colliders = []
      owner.velocity = undefined
    }
    dirty.forEach(mesh => { mesh.instanceMatrix.needsUpdate = true })
  }

  endStroke(eye?: number) { if (eye === undefined) this.previous.clear(); else this.previous.delete(eye) }

  private activate(owner: Destructible) {
    if (!this.world) return
    owner.damaged = true
    owner.transform?.updateWorldMatrix(true, false)
    const pose = owner.transform?.matrixWorld ?? new THREE.Matrix4()
    const zero = new THREE.Matrix4().makeScale(0, 0, 0)
    const solids = owner.parts.map(part => {
      if (part.mesh && part.index !== undefined) {
        part.mesh.setMatrixAt(part.index, zero)
        part.mesh.instanceMatrix.needsUpdate = true
      }
      return laserSolid(part.geometry, pose.clone().multiply(part.matrix), part.color)
    })
    for (const collider of owner.colliders) {
      this.targets.delete(collider.handle)
      this.world.removeCollider(collider, true)
    }
    owner.colliders = []
    owner.stop?.()
    // The first carve performs the connectivity pass and creates the replacement colliders.
    this.chunks.push({ owner, solids, mesh: new THREE.Mesh(), colliders: [] })
  }

  cut(collider: RAPIER.Collider, point: THREE.Vector3, direction: THREE.Vector3, eye = 0) {
    if (!this.world) return false
    const target = this.targets.get(collider.handle)
    if (!target) { this.previous.delete(eye); return false }
    const owner = 'owner' in target ? target.owner : target
    if (!owner.damaged) this.activate(owner)
    const previous = this.previous.get(eye)
    // Fill small gaps while aiming quickly; unrelated targets never share a stroke.
    const distance = previous?.owner === owner ? previous.point.distanceTo(point) : 0
    const samples = distance < 3 ? Math.max(1, Math.ceil(distance / .24)) : 1
    let changed = false
    for (let sample = 1; sample <= samples; sample++) {
      const contact = samples > 1 ? previous!.point.clone().lerp(point, sample / samples) : point
      for (const chunk of [...this.chunks]) {
        if (chunk.owner !== owner) continue
        const origin = contact.clone(), axis = direction.clone()
        if (chunk.body) {
          const inverse = new THREE.Quaternion().copy(chunk.body.rotation()).invert()
          origin.sub(chunk.body.translation()).applyQuaternion(inverse)
          axis.applyQuaternion(inverse)
        }
        const planes = laserPlanes(origin, axis, .22)
        const remaining = chunk.solids.flatMap(cell => subtractLaser(cell, planes))
        if (chunk.mesh.parent && remaining.length === chunk.solids.length && remaining.every((cell, i) => cell === chunk.solids[i])) continue
        this.rebuild(chunk, remaining, direction, contact)
        changed = true
      }
    }
    this.previous.set(eye, { owner, point: point.clone() })
    if (changed) this.dust(point, direction.clone().negate(), 4)
    return changed
  }

  private rebuild(chunk: Chunk, solids: LaserSolid[], direction: THREE.Vector3, contact: THREE.Vector3) {
    const world = this.world!
    const rotation = chunk.body ? new THREE.Quaternion().copy(chunk.body.rotation()) : new THREE.Quaternion()
    const position = chunk.body ? new THREE.Vector3().copy(chunk.body.translation()) : new THREE.Vector3()
    const velocity = chunk.body ? new THREE.Vector3().copy(chunk.body.linvel()) : chunk.owner.velocity?.clone() ?? new THREE.Vector3()
    const angular = chunk.body ? new THREE.Vector3().copy(chunk.body.angvel()) : new THREE.Vector3()
    for (const collider of chunk.colliders) this.targets.delete(collider.handle)
    if (chunk.body) world.removeRigidBody(chunk.body)
    else chunk.colliders.forEach(collider => world.removeCollider(collider, true))
    chunk.mesh.removeFromParent()
    chunk.mesh.geometry.dispose()
    this.chunks.splice(this.chunks.indexOf(chunk), 1)

    // A spatial sweep limits comparisons to nearby cells, including new cut faces.
    const sorted = solids.map((cell, i) => ({ cell, i })).sort((a, b) => a.cell.bounds.min.x - b.cell.bounds.min.x)
    const parents = solids.map((_, i) => i)
    const find = (i: number): number => { while (parents[i] !== i) { parents[i] = parents[parents[i]]; i = parents[i] } return i }
    for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].cell.bounds.min.x > sorted[i].cell.bounds.max.x + .025) break
      const a = find(sorted[i].i), b = find(sorted[j].i)
      if (a !== b && solidsTouch(sorted[i].cell, sorted[j].cell)) parents[b] = a
    }
    const groups = new Map<number, LaserSolid[]>()
    solids.forEach((cell, i) => { const key = find(i); if (!groups.has(key)) groups.set(key, []); groups.get(key)!.push(cell) })
    for (const cells of groups.values()) {
      const grounded = !chunk.body && chunk.owner.kind !== 'car' && cells.some(cell => cell.bounds.min.y <= .08)
      const volume = cells.reduce((sum, cell) => sum + cell.volume, 0)
      const center = new THREE.Vector3()
      cells.forEach(cell => center.addScaledVector(cell.bounds.getCenter(new THREE.Vector3()), cell.volume / volume))
      const mesh = new THREE.Mesh(solidGeometry(cells, grounded ? new THREE.Vector3() : center), this.material)
      mesh.name = `Laser-cut ${chunk.owner.kind}`
      mesh.castShadow = mesh.receiveShadow = true
      const next: Chunk = { owner: chunk.owner, solids: cells, mesh, colliders: [] }
      if (!grounded) {
        const worldCenter = center.clone().applyQuaternion(rotation).add(position)
        const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(worldCenter.x, worldCenter.y, worldCenter.z)
          .setRotation(rotation).setLinearDamping(.12).setAngularDamping(.18).setCcdEnabled(true))
        // Preserve the velocity field of a previously moving fragment.
        const arm = center.clone().applyQuaternion(rotation)
        body.setLinvel(velocity.clone().add(new THREE.Vector3().crossVectors(angular, arm)), true)
        body.setAngvel(angular, true)
        next.body = body
        // Store the new cells in the body's local frame for subsequent cuts.
        next.solids = cells.map(cell => translatedSolid(cell, center.clone().negate()))
        mesh.position.copy(worldCenter); mesh.quaternion.copy(rotation)
      }
      const largest = next.solids.reduce((a, b) => a.volume > b.volume ? a : b)
      for (const cell of next.solids) {
        // Thin façade details remain visible without hundreds of tiny physics shapes.
        if (cell.volume < .003 && cell !== largest) continue
        const vertices = new Float32Array(cell.vertices.flatMap(p => [p.x, p.y, p.z]))
        const desc = RAPIER.ColliderDesc.convexHull(vertices)
        if (!desc) continue
        desc.setFriction(.75).setRestitution(.05).setDensity(chunk.owner.kind === 'tree' ? 45 : chunk.owner.kind === 'car' ? 110 : 180)
        const collider = world.createCollider(desc, next.body)
        next.colliders.push(collider)
        this.targets.set(collider.handle, next)
      }
      if (next.body) {
        const mass = next.body.mass()
        // Pressure at the cut gives a severed tree or slab a physical tipping moment.
        next.body.applyImpulseAtPoint(direction.clone().multiplyScalar(mass * (chunk.owner.kind === 'tree' ? .65 : .35)), contact, true)
      }
      this.root.add(mesh)
      this.chunks.push(next)
    }
  }

  sync() {
    for (const chunk of this.chunks) if (chunk.body) {
      chunk.mesh.position.copy(chunk.body.translation())
      chunk.mesh.quaternion.copy(chunk.body.rotation())
    }
  }

  groundHeightAt(position: THREE.Vector3, height: number) {
    if (!this.world || position.y <= height || this.chunks.length === 0) return height
    this.world.intersectionsWithRay(new RAPIER.Ray(position, { x: 0, y: -1, z: 0 }), position.y - height, false, hit => {
      if (this.targets.has(hit.collider.handle) && hit.normal.y > .65) height = Math.max(height, position.y - hit.timeOfImpact)
      return true
    }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS)
    return height
  }

  dispose() {
    this.chunks.forEach(chunk => { chunk.mesh.removeFromParent(); chunk.mesh.geometry.dispose() })
    this.chunks.length = 0
    this.targets.clear()
    this.material.dispose()
    this.world = null
  }
}
