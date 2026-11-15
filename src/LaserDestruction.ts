import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d'
import { carveGeometry, reviveSolid, type CarveInput, type CarveOutput, type ConvexMeshData } from './LaserCarving'
import { laserPlanes, laserSolid, solidGeometry, connectedGroups, subtractLaser, translatedSolid, type LaserSolid, type SolidConnections } from './LaserGeometry'

export type DestructiblePart = {
  geometry: THREE.BufferGeometry; matrix: THREE.Matrix4; color: THREE.Color
  mesh?: THREE.InstancedMesh; index?: number
}
export type Destructible = {
  kind: 'building' | 'tree' | 'car'; parts: DestructiblePart[]; colliders: RAPIER.Collider[]
  damaged: boolean; transform?: THREE.Object3D; stop?: () => void
  velocity?: THREE.Vector3
}
type Chunk = { owner: Destructible; solids: LaserSolid[]; mesh: THREE.Mesh; body?: RAPIER.RigidBody; colliders: RAPIER.Collider[]; cells: Map<LaserSolid, RAPIER.Collider>; connections: SolidConnections }
type LaserHit = { collider: RAPIER.Collider; point: THREE.Vector3; direction: THREE.Vector3; eye: number; radius?: number; depth?: number }
type Burn = {
  owner: Destructible; target: Destructible | Chunk; elapsed: number; duration: number; radius?: number; depth?: number
  drawIndex?: number; dirty: boolean; workerFailures?: number
  flight?: boolean
  point: THREE.Vector3; direction: THREE.Vector3; normal: THREE.Vector3
  worldPoint: THREE.Vector3; worldDirection: THREE.Vector3; worldNormal: THREE.Vector3
}
type CarveJob = {
  owner: Destructible; burns: Burn[]
  sources: { chunk?: Chunk; solids: LaserSolid[]; input: CarveInput }[]
  staged: Map<LaserSolid, RAPIER.Collider>; stagedBodies: Set<RAPIER.RigidBody>
  results?: CarveOutput[]; error?: string
  preparing?: Generator<void, PreparedSource[]>; prepared?: PreparedSource[]
}
type PreparedSource = {
  solids: LaserSolid[]; connections: SolidConnections; prepared: PreparedCarve
}
type PreparedCarve = {
  groups: LaserSolid[][]; geometry: CarveOutput['geometry']; localSolids: (LaserSolid[] | null)[]
  groupInfo: CarveOutput['groupInfo']; bodies: (RAPIER.RigidBody | undefined)[]; connections: SolidConnections[]
}
const MELT_TIME = 1.5
const MAX_BURNS = 256

/** Lazy geometry replacement: untouched scenery retains the original instanced draws. */
export class LaserDestruction {
  readonly objects: Destructible[] = []
  private chunks: Chunk[] = []
  private targets = new Map<number, Destructible | Chunk>()
  private material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .88 })
  private world: RAPIER.World | null = null
  private previous = new Map<number, { owner: Destructible; point: THREE.Vector3 }>()
  private burns: Burn[] = []
  private flightTargets = new Map<Destructible, THREE.Box3>()
  private flightBounds = new THREE.Box3()
  private burnTime = 0
  private carveWorker?: Worker
  private carveJob?: CarveJob
  private stagedColliders?: Map<LaserSolid, RAPIER.Collider>
  private physicsMeshes = new WeakMap<LaserSolid, ConvexMeshData>()
  private burnHeat = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BURNS), 1)
  private burnMarks: THREE.InstancedMesh<THREE.CircleGeometry, THREE.ShaderMaterial>
  private burnPose = new THREE.Object3D()
  private surfaceAxis = new THREE.Vector3(0, 0, 1)

  constructor(private root: THREE.Group, private dust: (point: THREE.Vector3Like, normal: THREE.Vector3Like, speed: number) => void = () => {}) {
    const geometry = new THREE.CircleGeometry(.27, 24)
    geometry.setAttribute('burnHeat', this.burnHeat)
    const material = new THREE.ShaderMaterial({
      uniforms: { burnTime: { value: 0 } },
      vertexShader: `attribute float burnHeat;
        uniform float burnTime;
        varying vec2 spotUv; varying float heat;
        void main() {
          spotUv = uv; heat = clamp((burnTime - burnHeat) / 1.5, 0.0, 1.0);
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `varying vec2 spotUv; varying float heat;
        void main() {
          float glow = 1.0 - smoothstep(0.2, 1.0, length(spotUv * 2.0 - 1.0));
          vec3 color = mix(vec3(0.8, 0.005, 0.0), vec3(1.0, 0.25, 0.015), heat * heat * glow);
          gl_FragColor = vec4(color, glow * (0.65 + 0.3 * heat));
        }`,
      transparent: true, depthWrite: false, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    })
    this.burnMarks = new THREE.InstancedMesh(geometry, material, MAX_BURNS)
    this.burnMarks.name = 'laser-burning-surfaces'
    this.burnMarks.count = 0
    this.burnMarks.frustumCulled = false
    this.burnMarks.renderOrder = 2
    this.burnMarks.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.burnHeat.setUsage(THREE.DynamicDrawUsage)
    root.add(this.burnMarks)
  }

  /** A first contact starts an independent fuse; repeated hits never restart it. */
  ignite(collider: RAPIER.Collider, point: THREE.Vector3, direction: THREE.Vector3, normal: THREE.Vector3Like) {
    const target = this.targets.get(collider.handle)
    const owner = target && ('owner' in target ? target.owner : target)
    if (!target || owner?.kind !== 'building') return
    if (this.burns.some(burn => burn.duration > 0 && burn.owner === owner && burn.worldPoint.distanceToSquared(point) <= .22 * .22
      && burn.worldNormal.dot(normal) > .95) || this.burns.length >= MAX_BURNS) return
    const burn: Burn = { owner, target, elapsed: 0, duration: MELT_TIME, dirty: true, point: new THREE.Vector3(), direction: new THREE.Vector3(), normal: new THREE.Vector3(),
      worldPoint: point.clone(), worldDirection: direction.clone(), worldNormal: new THREE.Vector3().copy(normal) }
    this.attachBurn(burn, target)
    this.burns.push(burn)
    this.drawBurn(this.burns.filter(point => point.duration > 0).length - 1, burn)
    this.burnMarks.count = this.burns.filter(point => point.duration > 0).length
  }

  /** Immediate, shallow damage from physical character contacts, processed off-thread. */
  queueContact(collider: RAPIER.Collider, point: THREE.Vector3, normal: THREE.Vector3) {
    if (normal.lengthSq() < 1e-8) return
    const target = this.targets.get(collider.handle)
    const owner = target && ('owner' in target ? target.owner : target)
    if (!target || !owner || this.burns.length >= MAX_BURNS) return
    if (this.burns.some(burn => burn.duration === 0 && burn.owner === owner
      && burn.worldPoint.distanceToSquared(point) < .25 && burn.worldNormal.dot(normal) > .5)) return
    const burn: Burn = { owner, target, elapsed: 0, duration: 0, radius: .48, depth: .65, dirty: true,
      point: new THREE.Vector3(), direction: new THREE.Vector3(), normal: new THREE.Vector3(),
      worldPoint: point.clone(), worldDirection: normal.clone().normalize().negate(), worldNormal: normal.clone().normalize() }
    this.attachBurn(burn, target)
    this.burns.push(burn)
    // A fresh collision takes priority over a laser fuse that has not expired yet.
    const job = this.carveJob
    if (job && job.burns.every(point => point.duration - point.elapsed > .08)) {
      this.clearCarving()
      this.discardStaged(job)
    }
  }

  queueFlightPath(collider: RAPIER.Collider, from: THREE.Vector3, to: THREE.Vector3, normal: THREE.Vector3) {
    const target = this.targets.get(collider.handle)
    const owner = target && ('owner' in target ? target.owner : target)
    const distance = from.distanceTo(to)
    if (!target || owner?.kind !== 'building' || distance < 1e-6 || this.burns.length >= MAX_BURNS) return
    if (!this.flightTargets.has(owner)) {
      const bounds = new THREE.Box3()
      for (const part of owner.parts) {
        if (!part.geometry.boundingBox) part.geometry.computeBoundingBox()
        bounds.union(part.geometry.boundingBox!.clone().applyMatrix4(part.matrix))
      }
      if (owner.transform) bounds.applyMatrix4(owner.transform.matrixWorld)
      this.flightTargets.set(owner, bounds)
    }
    if (this.burns.some(burn => burn.flight && burn.owner === owner && burn.worldPoint.distanceToSquared(from) < .01)) return
    const direction = to.clone().sub(from).multiplyScalar(1 / distance)
    const burn: Burn = { owner, target, elapsed: 0, duration: 0, radius: 1.2, depth: distance + 1.2, flight: true, dirty: true,
      point: from.clone(), direction: direction.clone(), normal: normal.clone(),
      worldPoint: from.clone(), worldDirection: direction, worldNormal: normal.lengthSq() > 1e-8 ? normal.clone().normalize() : direction.clone().negate() }
    this.attachBurn(burn, target)
    this.burns.push(burn)
    const job = this.carveJob
    if (job && job.burns.every(point => point.duration - point.elapsed > .08)) {
      this.clearCarving(); this.discardStaged(job)
    }
  }

  continueFlightPath(from: THREE.Vector3, to: THREE.Vector3) {
    this.flightBounds.min.copy(from).min(to).addScalar(-1.2)
    this.flightBounds.max.copy(from).max(to).addScalar(1.2)
    for (const [owner, bounds] of this.flightTargets) {
      if (!this.flightBounds.intersectsBox(bounds)) { this.flightTargets.delete(owner); continue }
      const collider = !owner.damaged ? owner.colliders[0] : this.chunks.find(chunk => chunk.owner === owner && chunk.colliders.length)?.colliders[0]
      if (collider) this.queueFlightPath(collider, from, to, to.clone().sub(from).normalize().negate())
      else this.flightTargets.delete(owner)
    }
  }

  endFlightPath() { this.flightTargets.clear() }

  updateBurns(dt: number) {
    if (this.burns.length === 0) {
      this.burnMarks.count = 0
      if (this.carveJob) {
        const job = this.carveJob
        this.clearCarving()
        this.discardStaged(job)
      }
      return
    }
    this.burnTime += Math.max(0, dt)
    this.burnMarks.material.uniforms.burnTime.value = this.burnTime
    this.burns = this.burns.filter(burn => this.resolveBurn(burn))
    for (const burn of this.burns) {
      this.burnWorldPose(burn)
      burn.elapsed += Math.max(0, dt)
    }
    this.finishCarve()
    if (!this.carveJob) {
      // Use the fuse time to prepare cuts away from the animation thread.
      const first = this.burns.reduce<Burn | undefined>((first, burn) => {
        if (burn.elapsed < Math.max(0, burn.duration - .5)) return first
        return !first || burn.duration - burn.elapsed < first.duration - first.elapsed ? burn : first
      }, undefined)
      if (first) this.startCarve(first.owner)
    }
    let mark = 0
    for (const burn of this.burns) if (burn.duration > 0) this.drawBurn(mark++, burn)
    this.burnMarks.count = mark
  }

  private sourceSolids(owner: Destructible) {
    owner.transform?.updateWorldMatrix(true, false)
    const pose = owner.transform?.matrixWorld ?? new THREE.Matrix4()
    return owner.parts.map(part => laserSolid(part.geometry, pose.clone().multiply(part.matrix), part.color))
  }

  private startCarve(owner: Destructible) {
    const oldest = this.burns.reduce((age, burn) => burn.owner === owner ? Math.max(age, burn.elapsed - burn.duration) : age, -Infinity)
    // Nearby deadlines share work; old fuses never wait for a much newer point.
    const burns = this.burns.filter(burn => burn.owner === owner && burn.elapsed >= Math.max(0, burn.duration - .5) && burn.elapsed - burn.duration >= oldest - .08)
    const chunks = this.chunks.filter(chunk => chunk.owner === owner)
    const sources = (owner.damaged ? chunks.map(chunk => ({ chunk, solids: chunk.solids }))
      : [{ chunk: undefined, solids: [] as LaserSolid[] }]).map(source => {
      const inverse = source.chunk?.body ? new THREE.Quaternion().copy(source.chunk.body.rotation()).invert() : null
      const shots = burns.map(burn => {
        const point = burn.worldPoint.clone(), direction = burn.worldDirection.clone()
        if (inverse && source.chunk?.body) {
          point.sub(source.chunk.body.translation()).applyQuaternion(inverse)
          direction.applyQuaternion(inverse)
        }
        return { point, direction, radius: burn.radius, depth: burn.depth }
      })
      return { ...source, input: { solids: source.solids, connections: source.chunk?.connections, shots,
        kind: owner.kind, moving: !!source.chunk?.body, visible: !!source.chunk?.mesh.parent } as CarveInput }
    })
    if (!owner.damaged) {
      const templates = new Map<THREE.BufferGeometry, Float32Array>()
      owner.transform?.updateWorldMatrix(true, false)
      const pose = owner.transform?.matrixWorld ?? new THREE.Matrix4()
      sources[0].input.parts = owner.parts.map(part => {
        let positions = templates.get(part.geometry)
        if (!positions) {
          const source = part.geometry.getAttribute('position')
          positions = new Float32Array(source.count * 3)
          for (let i = 0; i < source.count; i++) {
            positions[i * 3] = source.getX(i); positions[i * 3 + 1] = source.getY(i); positions[i * 3 + 2] = source.getZ(i)
          }
          templates.set(part.geometry, positions)
        }
        return { positions, matrix: pose.clone().multiply(part.matrix).elements, color: part.color.toArray() }
      })
    }
    const job: CarveJob = { owner, burns, sources, staged: new Map(), stagedBodies: new Set() }
    this.carveJob = job
    if (!this.carveWorker) {
      const worker = new Worker(new URL('./LaserWorker.ts', import.meta.url), { type: 'module' })
      this.carveWorker = worker
      worker.onmessage = (event: MessageEvent<{ results?: CarveOutput[]; error?: string }>) => {
        if (this.carveWorker !== worker || !this.carveJob) return
        this.carveJob.results = event.data.results
        this.carveJob.error = event.data.error
      }
      worker.onerror = event => { if (this.carveWorker === worker && this.carveJob) this.carveJob.error = event.message }
    }
    this.carveWorker.postMessage(sources.map(source => source.input))
  }

  private finishCarve() {
    const job = this.carveJob
    if (!job || (!job.results && !job.error)) return
    // Direct cuts or a reset may have invalidated the worker's snapshot.
    if (job.sources.some(source => source.chunk ? source.chunk.solids !== source.solids || !source.chunk.mesh.parent : job.owner.damaged)) {
      this.discardStaged(job)
      this.carveJob = undefined
      return
    }
    if (job.results && !job.prepared) {
      job.preparing ??= this.prepareCarve(job)
      const deadline = performance.now() + 2
      do {
        const step = job.preparing.next()
        if (step.done) { job.prepared = step.value; break }
      } while (performance.now() < deadline)
      if (!job.prepared) return
    }
    if (job.burns.some(burn => this.burns.includes(burn) && burn.elapsed < burn.duration - 1e-8)) return
    this.carveJob = undefined
    const completed = new Set(job.burns)
    if (job.error) {
      this.clearCarving()
      this.discardStaged(job)
      console.error('Laser carving worker failed:', job.error)
      if (job.burns.some(burn => burn.duration === 0)) {
        // Contact destruction must never freeze rendering by falling back to synchronous CSG.
        for (const burn of job.burns) burn.workerFailures = (burn.workerFailures ?? 0) + 1
        this.burns = this.burns.filter(burn => !completed.has(burn) || burn.workerFailures! < 3)
        return
      }
      this.burns = this.burns.filter(burn => !completed.has(burn))
      this.cutMany(job.burns.flatMap(burn => {
        const collider = burn.target.colliders[0]
        return collider ? [{ collider, point: burn.worldPoint, direction: burn.worldDirection, eye: -1, radius: burn.radius, depth: burn.depth }] : []
      }), false)
      return
    }
    this.burns = this.burns.filter(burn => !completed.has(burn))
    this.stagedColliders = job.staged
    job.sources.forEach((source, i) => {
      const result = job.results![i]
      if (source.chunk && result.solids.length === source.solids.length && result.solids.every((cell, index) => cell === index)) return
      const { solids, connections, prepared } = job.prepared![i]
      const chunk = source.chunk ?? this.activate(job.owner, source.solids)!
      chunk.connections = connections
      const shot = source.input.shots[source.input.shots.length - 1]
      const contact = shot.point.clone(), direction = shot.direction.clone()
      if (chunk.body) {
        const rotation = new THREE.Quaternion().copy(chunk.body.rotation())
        contact.applyQuaternion(rotation).add(chunk.body.translation()); direction.applyQuaternion(rotation)
      }
      this.rebuild(chunk, solids, direction, contact, prepared)
      for (const body of prepared.bodies) if (body) job.stagedBodies.delete(body)
    })
    this.stagedColliders = undefined
    this.discardStaged(job)
    this.burns = this.burns.filter(burn => this.resolveBurn(burn))
    // The dust pool is finite; sample large batches instead of repeatedly overwriting it.
    for (let i = 0; i < job.burns.length; i += Math.max(1, Math.ceil(job.burns.length / 8))) {
      const burn = job.burns[i]
      this.dust(burn.worldPoint, burn.worldNormal, 4)
    }
  }

  /** Hydrate worker results within a small per-frame CPU budget before the fuse expires. */
  private *prepareCarve(job: CarveJob): Generator<void, PreparedSource[]> {
    const prepared: PreparedSource[] = []
    for (let sourceIndex = 0; sourceIndex < job.sources.length; sourceIndex++) {
      const result = job.results![sourceIndex], source = job.sources[sourceIndex]
      const solids: LaserSolid[] = []
      for (let i = 0; i < result.solids.length; i++) {
        const cell = result.solids[i]
        solids.push(typeof cell === 'number' ? source.solids[cell] : reviveSolid(cell))
        if (i % 32 === 0) yield
      }
      const groups = result.groups.map(group => group.map(index => solids[index]))
      const connections = new Map(solids.map(cell => [cell, new Set<LaserSolid>()]))
      for (let edge = 0; edge < result.edges.length; edge += 2) {
        const a = solids[result.edges[edge]], b = solids[result.edges[edge + 1]]
        connections.get(a)!.add(b); connections.get(b)!.add(a)
        if (edge % 256 === 0) yield
      }
      const localSolids: (LaserSolid[] | null)[] = []
      const bodies: (RAPIER.RigidBody | undefined)[] = []
      const groupConnections: SolidConnections[] = []
      for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
        const local = result.localSolids[groupIndex]
        const cells = local ? [] as LaserSolid[] : groups[groupIndex]
        const count = local?.length ?? cells.length
        for (let i = 0; i < count; i++) {
          if (local) cells.push(reviveSolid(local[i]))
          this.physicsMeshes.set(cells[i], result.physics[groupIndex][i])
          if (i % 32 === 0) yield
        }
        const info = result.groupInfo[groupIndex]
        if (groups.length === 1 && !local) groupConnections.push(connections)
        else {
          const graph = new Map(cells.map(cell => [cell, new Set<LaserSolid>()]))
          for (let edge = 0; edge < info.edges.length; edge += 2) {
            const a = cells[info.edges[edge]], b = cells[info.edges[edge + 1]]
            graph.get(a)!.add(b); graph.get(b)!.add(a)
            if (edge % 256 === 0) yield
          }
          groupConnections.push(graph)
        }
        // Keep the old scenery active while both static and detached shapes are prepared disabled.
        const body = !info.grounded && !info.preserve
          ? this.world!.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setEnabled(false)
            .setLinearDamping(.12).setAngularDamping(.18).setCcdEnabled(true)) : undefined
        bodies.push(body)
        if (body) job.stagedBodies.add(body)
        if (info.grounded || body) {
          const largest = cells.reduce((a, b) => a.volume > b.volume ? a : b)
          for (let i = 0; i < cells.length; i++) {
            const cell = cells[i]
            if (source.chunk?.cells.has(cell) || cell.volume < .003 && cell !== largest) continue
            const collider = this.createCellCollider(cell, job.owner.kind, body, false)
            if (collider) job.staged.set(cell, collider)
            if (i % 16 === 0) yield
          }
        }
        localSolids.push(local ? cells : null)
      }
      prepared.push({ solids, connections, prepared: { groups, geometry: result.geometry, localSolids, groupInfo: result.groupInfo, bodies, connections: groupConnections } })
    }
    return prepared
  }

  private discardStaged(job: CarveJob) {
    for (const collider of job.staged.values()) this.world!.removeCollider(collider, true)
    job.staged.clear()
    for (const body of job.stagedBodies) this.world!.removeRigidBody(body)
    job.stagedBodies.clear()
  }

  private clearCarving() {
    this.carveWorker?.terminate()
    this.carveWorker = undefined
    this.carveJob = undefined
    this.stagedColliders = undefined
  }

  private attachBurn(burn: Burn, target: Destructible | Chunk) {
    burn.dirty = true
    burn.target = target
    burn.point.copy(burn.worldPoint); burn.direction.copy(burn.worldDirection); burn.normal.copy(burn.worldNormal)
    if (!burn.flight && 'owner' in target && target.body) {
      const inverse = new THREE.Quaternion().copy(target.body.rotation()).invert()
      burn.point.sub(target.body.translation()).applyQuaternion(inverse)
      burn.direction.applyQuaternion(inverse); burn.normal.applyQuaternion(inverse)
    }
  }

  private burnWorldPose(burn: Burn) {
    burn.worldPoint.copy(burn.point); burn.worldDirection.copy(burn.direction); burn.worldNormal.copy(burn.normal)
    if (!burn.flight && 'owner' in burn.target && burn.target.body) {
      const rotation = new THREE.Quaternion().copy(burn.target.body.rotation())
      burn.worldPoint.applyQuaternion(rotation).add(burn.target.body.translation())
      burn.worldDirection.applyQuaternion(rotation); burn.worldNormal.applyQuaternion(rotation)
    }
  }

  private resolveBurn(burn: Burn) {
    if ('owner' in burn.target ? burn.target.mesh.parent : !burn.owner.damaged) return true
    if (burn.flight) {
      const next = this.chunks.find(chunk => chunk.owner === burn.owner && chunk.colliders.length)
      if (next) { this.attachBurn(burn, next); return true }
      return false
    }
    // A previous melt may replace the collider or detach the burning section.
    for (const chunk of this.chunks) {
      if (chunk.owner !== burn.owner) continue
      const point = burn.worldPoint.clone()
      if (chunk.body) point.sub(chunk.body.translation()).applyQuaternion(new THREE.Quaternion().copy(chunk.body.rotation()).invert())
      if (!chunk.solids.some(cell => cell.bounds.distanceToPoint(point) <= .03
        && cell.planes.every(plane => plane.distanceToPoint(point) <= .03))) continue
      this.attachBurn(burn, chunk)
      return true
    }
    return false
  }

  private drawBurn(index: number, burn: Burn) {
    if (burn.drawIndex === index && !burn.dirty && !('owner' in burn.target && burn.target.body)) return
    this.burnPose.position.copy(burn.worldPoint).addScaledVector(burn.worldNormal, .006)
    this.burnPose.quaternion.setFromUnitVectors(this.surfaceAxis, burn.worldNormal)
    this.burnPose.updateMatrix()
    this.burnMarks.setMatrixAt(index, this.burnPose.matrix)
    this.burnHeat.setX(index, this.burnTime - burn.elapsed)
    this.burnMarks.instanceMatrix.addUpdateRange(index * 16, 16)
    this.burnHeat.addUpdateRange(index, 1)
    this.burnMarks.instanceMatrix.needsUpdate = this.burnHeat.needsUpdate = true
    burn.drawIndex = index
    burn.dirty = false
  }

  create(kind: Destructible['kind']): Destructible {
    const owner: Destructible = { kind, parts: [], colliders: [], damaged: false }
    this.objects.push(owner)
    return owner
  }

  register(owner: Destructible, collider: RAPIER.Collider) {
    owner.colliders.push(collider)
    this.targets.set(collider.handle, owner)
  }

  ownerOf(collider: RAPIER.Collider) {
    const target = this.targets.get(collider.handle)
    return target && ('owner' in target ? target.owner : target)
  }

  /** Call after freeing the previous world; old WASM handles must never be reused. */
  reset(world: RAPIER.World) {
    this.endFlightPath()
    this.clearCarving()
    for (const chunk of this.chunks) { chunk.mesh.removeFromParent(); chunk.mesh.geometry.dispose() }
    this.chunks.length = 0
    this.targets.clear()
    this.previous.clear()
    this.burns.length = 0
    this.burnTime = 0
    this.burnMarks.material.uniforms.burnTime.value = 0
    this.burnMarks.count = 0
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

  private activate(owner: Destructible, preparedSolids?: LaserSolid[]) {
    if (!this.world) return
    owner.damaged = true
    const solids = preparedSolids ?? this.sourceSolids(owner)
    const zero = new THREE.Matrix4().makeScale(0, 0, 0)
    for (const part of owner.parts) if (part.mesh && part.index !== undefined) {
      part.mesh.setMatrixAt(part.index, zero)
      part.mesh.instanceMatrix.needsUpdate = true
    }
    for (const collider of owner.colliders) {
      this.targets.delete(collider.handle)
      this.world.removeCollider(collider, true)
    }
    owner.colliders = []
    owner.stop?.()
    // The first carve performs the connectivity pass and creates the replacement colliders.
    const chunk: Chunk = { owner, solids, mesh: new THREE.Mesh(), colliders: [], cells: new Map(), connections: new Map() }
    this.chunks.push(chunk)
    return chunk
  }

  cut(collider: RAPIER.Collider, point: THREE.Vector3, direction: THREE.Vector3, eye = 0) {
    return this.cutMany([{ collider, point, direction, eye }])
  }

  /** Resolve all hits before replacing colliders; rebuild each affected chunk once. */
  cutMany(hits: readonly LaserHit[], interpolate = true) {
    if (!this.world) return false
    const resolved = hits.map(hit => {
      const target = this.targets.get(hit.collider.handle)
      return { ...hit, owner: target ? ('owner' in target ? target.owner : target) : undefined }
    })
    const pending = new Map<Chunk, { solids: LaserSolid[]; direction: THREE.Vector3; contact: THREE.Vector3 }>()
    for (const { owner, point, direction, eye, radius, depth } of resolved) {
      if (!owner) { this.previous.delete(eye); continue }
      if (!owner.damaged) this.activate(owner)
      const previous = interpolate ? this.previous.get(eye) : undefined
      // Fill small gaps while aiming quickly; unrelated targets never share a stroke.
      const distance = previous?.owner === owner ? previous.point.distanceTo(point) : 0
      const samples = distance < 3 ? Math.max(1, Math.ceil(distance / .24)) : 1
      let changed = false
      for (const chunk of this.chunks) {
        if (chunk.owner !== owner) continue
        const inverse = chunk.body ? new THREE.Quaternion().copy(chunk.body.rotation()).invert() : null
        const position = chunk.body?.translation()
        const axis = direction.clone()
        if (inverse) axis.applyQuaternion(inverse)
        let solids = pending.get(chunk)?.solids ?? chunk.solids
        for (let sample = 1; sample <= samples; sample++) {
          const contact = samples > 1 ? previous!.point.clone().lerp(point, sample / samples) : point
          const origin = contact.clone()
          if (inverse && position) origin.sub(position).applyQuaternion(inverse)
          const planes = laserPlanes(origin, axis, radius ?? .22)
          if (depth !== undefined) {
            const normal = axis.clone().normalize()
            planes.push(new THREE.Plane(normal, -normal.dot(origin) - depth))
          }
          const remaining = solids.flatMap(cell => subtractLaser(cell, planes))
          if (chunk.mesh.parent && remaining.length === solids.length && remaining.every((cell, i) => cell === solids[i])) continue
          solids = remaining
          pending.set(chunk, { solids, direction, contact })
          changed = true
        }
      }
      if (interpolate) this.previous.set(eye, { owner, point: point.clone() })
      if (changed) this.dust(point, direction.clone().negate(), 4)
    }
    for (const [chunk, { solids, direction, contact }] of pending) this.rebuild(chunk, solids, direction, contact)
    if (pending.size) this.burns = this.burns.filter(burn => this.resolveBurn(burn))
    return pending.size > 0
  }

  private rebuild(chunk: Chunk, solids: LaserSolid[], direction: THREE.Vector3, contact: THREE.Vector3, prepared?: PreparedCarve) {
    for (const burn of this.burns) if (burn.target === chunk) this.burnWorldPose(burn)
    const world = this.world!
    const rotation = chunk.body ? new THREE.Quaternion().copy(chunk.body.rotation()) : new THREE.Quaternion()
    const position = chunk.body ? new THREE.Vector3().copy(chunk.body.translation()) : new THREE.Vector3()
    const velocity = chunk.body ? new THREE.Vector3().copy(chunk.body.linvel()) : chunk.owner.velocity?.clone() ?? new THREE.Vector3()
    const angular = chunk.body ? new THREE.Vector3().copy(chunk.body.angvel()) : new THREE.Vector3()
    const groups = prepared?.groups ?? connectedGroups(solids, chunk.connections)
    // A connected fragment keeps its coordinate frame, body and unchanged shapes.
    if (groups.length === 1 && chunk.mesh.parent) {
      const cells = groups[0]
      const grounded = prepared?.groupInfo[0].grounded ?? (!chunk.body && chunk.owner.kind !== 'car' && cells.some(cell => cell.bounds.min.y <= .08))
      if (grounded || chunk.body) {
        const geometry = prepared ? carveGeometry(prepared.geometry[0]) : solidGeometry(cells, new THREE.Vector3())
        chunk.mesh.geometry.dispose()
        chunk.mesh.geometry = geometry
        chunk.solids = cells
        this.updateColliders(chunk)
        this.pushChunk(chunk, direction, contact)
        return
      }
    }

    for (const collider of chunk.colliders) this.targets.delete(collider.handle)
    if (chunk.body) world.removeRigidBody(chunk.body)
    else chunk.colliders.forEach(collider => world.removeCollider(collider, true))
    chunk.mesh.removeFromParent()
    chunk.mesh.geometry.dispose()
    this.chunks.splice(this.chunks.indexOf(chunk), 1)

    for (const [groupIndex, cells] of groups.entries()) {
      const grounded = prepared?.groupInfo[groupIndex].grounded ?? (!chunk.body && chunk.owner.kind !== 'car' && cells.some(cell => cell.bounds.min.y <= .08))
      const center = new THREE.Vector3()
      if (prepared) center.fromArray(prepared.groupInfo[groupIndex].center)
      else if (!grounded) {
        const volume = cells.reduce((sum, cell) => sum + cell.volume, 0)
        cells.forEach(cell => center.addScaledVector(cell.bounds.getCenter(new THREE.Vector3()), cell.volume / volume))
      }
      const mesh = new THREE.Mesh(prepared ? carveGeometry(prepared.geometry[groupIndex]) : solidGeometry(cells, grounded ? new THREE.Vector3() : center), this.material)
      mesh.name = `Laser-cut ${chunk.owner.kind}`
      mesh.castShadow = mesh.receiveShadow = true
      const next: Chunk = { owner: chunk.owner, solids: cells, mesh, colliders: [], cells: new Map(), connections: new Map() }
      if (!grounded) {
        const worldCenter = center.clone().applyQuaternion(rotation).add(position)
        const body = prepared?.bodies[groupIndex] ?? world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(worldCenter.x, worldCenter.y, worldCenter.z)
          .setRotation(rotation).setLinearDamping(.12).setAngularDamping(.18).setCcdEnabled(true))
        body.setTranslation(worldCenter, true)
        body.setRotation(rotation, true)
        // Preserve the velocity field of a previously moving fragment.
        const arm = center.clone().applyQuaternion(rotation)
        body.setLinvel(velocity.clone().add(new THREE.Vector3().crossVectors(angular, arm)), true)
        body.setAngvel(angular, true)
        next.body = body
        // Store the new cells in the body's local frame for subsequent cuts.
        next.solids = prepared?.localSolids[groupIndex] ?? cells.map(cell => translatedSolid(cell, center.clone().negate()))
        mesh.position.copy(worldCenter); mesh.quaternion.copy(rotation)
      }
      // Translation preserves contact; transfer the graph into the new local frame.
      if (prepared) next.connections = prepared.connections[groupIndex]
      else if (grounded && groups.length === 1) next.connections = chunk.connections
      else {
        const localCells = new Map(cells.map((cell, i) => [cell, next.solids[i]]))
        for (const cell of cells) next.connections.set(localCells.get(cell)!,
          new Set([...chunk.connections.get(cell)!].map(neighbor => localCells.get(neighbor)!)))
      }
      this.updateColliders(next)
      next.body?.setEnabled(true)
      this.pushChunk(next, direction, contact)
      this.root.add(mesh)
      this.chunks.push(next)
    }
  }

  private pushChunk(chunk: Chunk, direction: THREE.Vector3, contact: THREE.Vector3) {
    if (!chunk.body) return
    // Pressure at the cut gives a severed tree or slab a physical tipping moment.
    chunk.body.applyImpulseAtPoint(direction.clone().multiplyScalar(chunk.body.mass() * (chunk.owner.kind === 'tree' ? .65 : .35)), contact, true)
  }

  private updateColliders(chunk: Chunk) {
    const world = this.world!
    const largest = chunk.solids.reduce((a, b) => a.volume > b.volume ? a : b)
    const wanted = new Set(chunk.solids.filter(cell => cell.volume >= .003 || cell === largest))
    for (const [cell, collider] of chunk.cells) if (!wanted.has(cell)) {
      this.targets.delete(collider.handle)
      world.removeCollider(collider, true)
      chunk.cells.delete(cell)
    }
    for (const cell of wanted) {
      if (chunk.cells.has(cell)) continue
      let collider = this.stagedColliders?.get(cell)
      if (collider) {
        this.stagedColliders!.delete(cell)
        collider.setEnabled(true)
      } else {
        collider = this.createCellCollider(cell, chunk.owner.kind, chunk.body)
        if (!collider) continue
      }
      chunk.cells.set(cell, collider)
      this.targets.set(collider.handle, chunk)
    }
    chunk.colliders = [...chunk.cells.values()]
  }

  private colliderDesc(cell: LaserSolid, kind: Destructible['kind']) {
    const mesh = this.physicsMeshes.get(cell)
    let desc: RAPIER.ColliderDesc | null
    if (mesh) desc = RAPIER.ColliderDesc.convexMesh(mesh.vertices, mesh.indices)
    else {
      const vertices = new Float32Array(cell.vertices.length * 3)
      cell.vertices.forEach((p, i) => { vertices[i * 3] = p.x; vertices[i * 3 + 1] = p.y; vertices[i * 3 + 2] = p.z })
      desc = RAPIER.ColliderDesc.convexHull(vertices)
    }
    return desc?.setFriction(.75).setRestitution(.05).setDensity(kind === 'tree' ? 45 : kind === 'car' ? 110 : 180) ?? null
  }

  private createCellCollider(cell: LaserSolid, kind: Destructible['kind'], body?: RAPIER.RigidBody, enabled = true): RAPIER.Collider | undefined {
    for (let attempt = 0; attempt < 2; attempt++) {
      const cachedMesh = this.physicsMeshes.has(cell)
      const desc = this.colliderDesc(cell, kind)
      if (!desc) return
      try { return this.world!.createCollider(desc.setEnabled(enabled), body) }
      catch (error) {
        if (!(error instanceof Error) || !error.message.includes('expected instance of RawShape')) throw error
        // Repeated cuts can collapse mesh edges at physics precision. Rebuild the convex hull;
        // if even that is degenerate, keep the visible sliver without an invalid physics shape.
        if (!cachedMesh) return
        this.physicsMeshes.delete(cell)
      }
    }
  }

  /** Current visible replacement meshes; original city instances are handled separately. */
  buildingMeshes(target: THREE.Mesh[]) {
    target.length = 0
    for (const chunk of this.chunks) if (chunk.owner.kind === 'building' && chunk.mesh.parent) target.push(chunk.mesh)
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
    this.endFlightPath()
    this.clearCarving()
    this.burns.length = 0
    this.burnMarks.removeFromParent()
    this.burnMarks.geometry.dispose()
    this.burnMarks.material.dispose()
    this.burnMarks.dispose()
    this.chunks.forEach(chunk => { chunk.mesh.removeFromParent(); chunk.mesh.geometry.dispose() })
    this.chunks.length = 0
    this.targets.clear()
    this.material.dispose()
    this.world = null
  }
}
