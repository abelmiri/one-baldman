import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d'
import type { LaserDestruction } from './LaserDestruction'

const RANGE = 250

/** Two pooled eye beams. Ray queries stop at the first solid city surface. */
export class HeatVision {
  readonly group = new THREE.Group()
  private beams: THREE.Group[] = []
  private impacts: THREE.Mesh[] = []
  private eyes: THREE.Mesh[] = []
  private light = new THREE.PointLight('#ff2020', 0, 7, 2)
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 })
  private origin = new THREE.Vector3()
  private direction = new THREE.Vector3()
  private aim = new THREE.Vector3()
  private eyePosition = new THREE.Vector3()
  private up = new THREE.Vector3(0, 1, 0)
  private time = 0
  private cutTime = 0
  private hits: { collider: RAPIER.Collider; point: THREE.Vector3; direction: THREE.Vector3; eye: number }[] = []

  constructor(scene: THREE.Scene) {
    this.group.name = 'heat-vision'
    this.group.visible = false
    const glow = new THREE.MeshBasicMaterial({ color: '#ff172b', transparent: true,
      opacity: .25, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })
    const core = new THREE.MeshBasicMaterial({ color: '#fff2cf', toneMapped: false })
    const red = new THREE.MeshBasicMaterial({ color: '#ff2436', toneMapped: false })
    const beamGeometry = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true)
    const sphere = new THREE.SphereGeometry(1, 12, 8)
    for (let i = 0; i < 2; i++) {
      const beam = new THREE.Group()
      for (const [radius, mat] of [[.005, core], [.014, red], [.045, glow]] as const) {
        const mesh = new THREE.Mesh(beamGeometry, mat)
        mesh.scale.set(radius, 1, radius)
        mesh.renderOrder = 3
        beam.add(mesh)
      }
      const eye = new THREE.Mesh(sphere, red)
      eye.scale.set(.026, .021, .024)
      const impact = new THREE.Mesh(sphere, glow)
      this.beams.push(beam)
      this.eyes.push(eye)
      this.impacts.push(impact)
      this.group.add(beam, eye, impact)
    }
    this.group.add(this.light)
    scene.add(this.group)
  }

  stop() {
    this.group.visible = false; this.light.intensity = 0; this.cutTime = 0
  }

  get isHittingSurface() { return this.group.visible && this.impacts.some(impact => impact.visible) }

  update(dt: number, active: boolean, head: THREE.Object3D | undefined,
    camera: THREE.Camera, world: RAPIER.World | null, destruction?: LaserDestruction) {
    destruction?.updateBurns(dt)
    if (!active || !head || !world) { this.stop(); destruction?.endStroke(); return }
    this.time += dt
    this.cutTime += dt
    const cutting = this.cutTime >= 1 / 30
    if (cutting) this.cutTime %= 1 / 30
    this.hits.length = 0
    this.group.visible = true
    camera.getWorldPosition(this.origin)
    camera.getWorldDirection(this.direction)
    head.getWorldPosition(this.eyePosition)
    // Start the aiming ray beyond the following camera, so scenery behind
    // the hero cannot become the target when the camera is near a wall.
    this.origin.addScaledVector(this.direction, this.origin.distanceTo(this.eyePosition) + .4)
    this.ray.origin = this.origin
    this.ray.dir = this.direction
    const target = world.castRay(this.ray, RANGE, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined, undefined, undefined, collider => !!((collider.collisionGroups() >>> 16) & 1))
    this.aim.copy(this.origin).addScaledVector(this.direction, target?.timeOfImpact ?? RANGE)
    for (let i = 0; i < 2; i++) {
      head.localToWorld(this.eyePosition.set(i === 0 ? -.070 : .070, .025, .191))
      this.direction.copy(this.aim).sub(this.eyePosition).normalize()
      this.ray.origin = this.eyePosition
      this.ray.dir = this.direction
      const hit = world.castRayAndGetNormal(this.ray, RANGE, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
        undefined, undefined, undefined, collider => !!((collider.collisionGroups() >>> 16) & 1))
      const length = Math.min(hit?.timeOfImpact ?? RANGE, this.eyePosition.distanceTo(this.aim))
      const beam = this.beams[i]
      beam.position.copy(this.eyePosition).addScaledVector(this.direction, length * .5)
      beam.quaternion.setFromUnitVectors(this.up, this.direction)
      beam.scale.y = length
      this.eyes[i].position.copy(this.eyePosition)
      const impact = this.impacts[i]
      impact.visible = !!hit
      impact.position.copy(this.eyePosition).addScaledVector(this.direction, length)
      impact.scale.setScalar(.11 + Math.sin(this.time * 47 + i) * .025)
      const owner = hit && destruction?.ownerOf(hit.collider)
      if (hit && owner?.kind === 'building') {
        destruction?.ignite(hit.collider, impact.position, this.direction, hit.normal)
        destruction?.endStroke(i)
      } else if (cutting && hit) {
        this.hits.push({ collider: hit.collider, point: impact.position.clone(), direction: this.direction.clone(), eye: i })
      } else if (!hit) destruction?.endStroke(i)
    }
    // Query both eyes before changing colliders referenced by this frame's hits.
    destruction?.cutMany(this.hits)
    this.light.position.copy(this.eyes[0].position).lerp(this.eyes[1].position, .5)
    this.light.intensity = 2.4 + Math.sin(this.time * 41) * .5
  }

  dispose() {
    this.group.removeFromParent()
    const geometries = new Set<THREE.BufferGeometry>()
    const materials = new Set<THREE.Material>()
    this.group.traverse(object => {
      if (object instanceof THREE.Mesh) {
        geometries.add(object.geometry)
        materials.add(object.material)
      }
    })
    geometries.forEach(geometry => geometry.dispose())
    materials.forEach(material => material.dispose())
    this.light.dispose()
  }
}
