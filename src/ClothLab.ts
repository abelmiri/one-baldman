import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import RAPIER from '@dimforge/rapier3d'

export type Mode = 'hanging' | 'falling'
export type Settings = {
  mode: Mode
  wind: number
  windDirection: number
  gravity: number
  stiffness: number
  playing: boolean
}

// 24 × 24 cells is almost exactly twice the previous 17 × 17 grid.
const COUNT = 25
const CLOTH_MASS = 2 * (18 * 18 * 0.025)
const STEP = 1 / 60
const vector = (x: number, y: number, z: number) => ({ x, y, z })

export class ClothLab {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100)
  private controls: OrbitControls
  private world: RAPIER.World | null = null
  private cloth: RAPIER.SoftBody | null = null
  private colliderBody: RAPIER.RigidBody | null = null
  private clothMesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material> | null = null
  private sphereMesh: THREE.Mesh
  private railMesh: THREE.Mesh
  private raf = 0
  private previousTime = 0
  private accumulator = 0
  private elapsed = 0
  private sizeObserver: ResizeObserver
  private pointer = new THREE.Vector2()
  private raycaster = new THREE.Raycaster()
  private dragPlane = new THREE.Plane()
  private dragPoint = new THREE.Vector3()
  private dragging: 'sphere' | 'rail' | null = null
  private dragOffset = new THREE.Vector3()
  private railPosition = new THREE.Vector3(0, 3.15, 0)
  private spherePosition = new THREE.Vector3(0, 1.7, 0.58)
  private pinPositions: THREE.Vector3[] = []
  private settings: Settings

  constructor(private host: HTMLElement, settings: Settings) {
    this.settings = { ...settings }
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.domElement.className = 'scene-canvas'
    host.appendChild(this.renderer.domElement)

    this.camera.position.set(5.2, 3.9, 7.2)
    this.camera.lookAt(0, 1.5, 0)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.minDistance = 3.7
    this.controls.maxDistance = 13
    this.controls.maxPolarAngle = Math.PI * 0.89
    this.controls.target.set(0, 1.4, 0)

    this.scene.background = new THREE.Color('#f5f5f2')
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#bac5d2', 2.3))
    const key = new THREE.DirectionalLight('#ffffff', 3.1)
    key.position.set(-3, 8, 6)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.camera.left = -6
    key.shadow.camera.right = 6
    key.shadow.camera.top = 6
    key.shadow.camera.bottom = -6
    key.shadow.bias = -0.0005
    this.scene.add(key)

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: '#e9e9e5', roughness: 0.93 }),
    )
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -0.12
    floor.receiveShadow = true
    this.scene.add(floor)

    this.sphereMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.78, 48, 32),
      new THREE.MeshStandardMaterial({ color: '#ffb76d', metalness: 0.05, roughness: 0.42 }),
    )
    this.sphereMesh.castShadow = true
    this.sphereMesh.receiveShadow = true
    this.scene.add(this.sphereMesh)

    this.railMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.055, 0.055, 3.1, 24),
      new THREE.MeshStandardMaterial({ color: '#343c52', metalness: 0.6, roughness: 0.3 }),
    )
    this.railMesh.rotation.z = Math.PI / 2
    this.railMesh.castShadow = true
    this.scene.add(this.railMesh)

    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown)
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    this.sizeObserver = new ResizeObserver(this.resize)
    this.sizeObserver.observe(host)
    this.resize()
    this.reset()
    this.raf = requestAnimationFrame(this.frame)
  }

  update(settings: Settings) {
    const rebuild = settings.mode !== this.settings.mode || settings.stiffness !== this.settings.stiffness
    this.settings = { ...settings }
    if (rebuild) this.reset()
  }

  reset() {
    this.world?.free()
    this.world = new RAPIER.World(vector(0, -this.settings.gravity, 0))
    this.world.integrationParameters.dt = STEP
    this.world.integrationParameters.softBodiesMaxExtraSubsteps = 4
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(100, 0.1, 100).setTranslation(0, -0.22, 0).setFriction(0.85))
    this.elapsed = 0
    this.accumulator = 0
    if (this.clothMesh) {
      this.scene.remove(this.clothMesh)
      this.clothMesh.geometry.dispose()
      this.clothMesh.material.dispose()
    }

    const hanging = this.settings.mode === 'hanging'
    this.railPosition.set(0, 3.15, 0)
    this.spherePosition.set(0, hanging ? 1.68 : 1.05, hanging ? 0.55 : 0)
    this.railMesh.visible = hanging
    this.railMesh.position.copy(this.railPosition)
    this.sphereMesh.position.copy(this.spherePosition)

    this.colliderBody = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
        this.spherePosition.x, this.spherePosition.y, this.spherePosition.z,
      ),
    )
    this.world.createCollider(RAPIER.ColliderDesc.ball(0.78).setFriction(0.85), this.colliderBody)

    const spacing = 2.7 / (COUNT - 1)
    const origin = hanging ? vector(-1.35, 3.1, 0) : vector(-1.35, 3.75, -1.35)
    const du = vector(spacing, 0, 0)
    const dv = hanging ? vector(0, -spacing, 0) : vector(0, 0, spacing)
    const pinned = hanging ? Array.from({ length: COUNT }, (_, i) => i * COUNT) : []
    const desc = RAPIER.SoftBodyDesc.cloth(origin, du, dv, COUNT, COUNT)
      .setPinnedParticles(pinned)
      .setSoftness(this.settings.stiffness, 1)
      .setParticleMass(CLOTH_MASS / (COUNT * COUNT))
      .setParticleRadius(0.04)
      .setSurfaceCollider(RAPIER.ColliderDesc.ball(0.04).setFriction(0.85))
      .setSelfContacts(true)
      .setLinearDamping(1)
      .setCanSleep(false)
    this.cloth = this.world.createSoftBody(desc)
    this.pinPositions = pinned.map((index) => {
      const p = this.cloth!.particlePosition(index)
      return new THREE.Vector3(p.x, p.y, p.z)
    })

    const positions = this.cloth.particlePositions()
    const boundary = this.cloth.boundary()
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
    geometry.setIndex(Array.from(boundary))
    geometry.computeVertexNormals()
    const material = new THREE.MeshStandardMaterial({
      color: '#536dff', side: THREE.DoubleSide, roughness: 0.68, metalness: 0.02,
      flatShading: false,
    })
    this.clothMesh = new THREE.Mesh(geometry, material)
    this.clothMesh.castShadow = true
    this.clothMesh.receiveShadow = true
    this.clothMesh.frustumCulled = false
    this.scene.add(this.clothMesh)
    this.updateMesh()
  }

  private step() {
    if (!this.world || !this.cloth || !this.colliderBody) return
    this.elapsed += STEP
    this.world.gravity = vector(0, -this.settings.gravity, 0)
    this.colliderBody.setNextKinematicTranslation(vector(
      this.spherePosition.x, this.spherePosition.y, this.spherePosition.z,
    ))
    if (this.settings.mode === 'hanging') {
      this.pinPositions.forEach((base, i) => {
        this.cloth!.setParticleKinematicTarget(i * COUNT, vector(
          base.x + this.railPosition.x,
          base.y + this.railPosition.y - 3.15,
          base.z + this.railPosition.z,
        ))
      })
    }
    this.cloth.resetForces(true)
    if (this.settings.wind > 0) {
      const angle = this.settings.windDirection * Math.PI / 180
      const gust = 0.8 + 0.2 * Math.sin(this.elapsed * 2.4)
      // A pinned sheet can take a stronger continuous push. On free cloth,
      // alternating gusts create visible motion without permanent drift.
      const force = this.settings.mode === 'hanging'
        ? this.settings.wind * CLOTH_MASS * 0.04 * gust
        : this.settings.wind * 0.08 * Math.sin(this.elapsed * 2.8)
      this.cloth.addForce(vector(Math.cos(angle) * force, 0, Math.sin(angle) * force), true)
    }
    this.world.step()
  }

  private updateMesh() {
    if (!this.cloth || !this.clothMesh) return
    const positions = this.cloth.particlePositions()
    const attribute = this.clothMesh.geometry.getAttribute('position') as THREE.BufferAttribute
    ;(attribute.array as Float32Array).set(positions)
    attribute.needsUpdate = true
    this.clothMesh.geometry.computeVertexNormals()
  }

  private frame = (time: number) => {
    if (!this.previousTime) this.previousTime = time
    const delta = Math.min((time - this.previousTime) / 1000, 0.05)
    this.previousTime = time
    if (this.settings.playing) {
      this.accumulator += delta
      let steps = 0
      while (this.accumulator >= STEP && steps < 3) {
        this.step()
        this.accumulator -= STEP
        steps++
      }
      this.updateMesh()
    }
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
    this.raf = requestAnimationFrame(this.frame)
  }

  private resize = () => {
    const width = Math.max(this.host.clientWidth, 1)
    const height = Math.max(this.host.clientHeight, 1)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height)
  }

  private setPointer(event: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    )
    this.raycaster.setFromCamera(this.pointer, this.camera)
  }

  private onPointerDown = (event: PointerEvent) => {
    this.setPointer(event)
    const targets = this.settings.mode === 'hanging' ? [this.sphereMesh, this.railMesh] : [this.sphereMesh]
    const hit = this.raycaster.intersectObjects(targets)[0]
    if (!hit) return
    this.dragging = hit.object === this.sphereMesh ? 'sphere' : 'rail'
    const point = this.dragging === 'sphere' ? this.spherePosition : this.railPosition
    this.dragPlane.setFromNormalAndCoplanarPoint(this.camera.getWorldDirection(new THREE.Vector3()), point)
    this.raycaster.ray.intersectPlane(this.dragPlane, this.dragPoint)
    this.dragOffset.copy(point).sub(this.dragPoint)
    this.controls.enabled = false
    this.renderer.domElement.setPointerCapture(event.pointerId)
    this.renderer.domElement.style.cursor = 'grabbing'
  }

  private onPointerMove = (event: PointerEvent) => {
    if (!this.dragging) {
      this.setPointer(event)
      const targets = this.settings.mode === 'hanging' ? [this.sphereMesh, this.railMesh] : [this.sphereMesh]
      this.renderer.domElement.style.cursor = this.raycaster.intersectObjects(targets).length ? 'grab' : 'auto'
      return
    }
    this.setPointer(event)
    if (!this.raycaster.ray.intersectPlane(this.dragPlane, this.dragPoint)) return
    this.dragPoint.add(this.dragOffset)
    if (this.dragging === 'sphere') {
      this.spherePosition.set(
        THREE.MathUtils.clamp(this.dragPoint.x, -2.5, 2.5),
        THREE.MathUtils.clamp(this.dragPoint.y, 0.8, 3.3),
        THREE.MathUtils.clamp(this.dragPoint.z, -2, 2),
      )
      this.sphereMesh.position.copy(this.spherePosition)
    } else {
      this.railPosition.set(
        THREE.MathUtils.clamp(this.dragPoint.x, -2.7, 2.7),
        THREE.MathUtils.clamp(this.dragPoint.y, 2.025, 4.575),
        THREE.MathUtils.clamp(this.dragPoint.z, -2.25, 2.25),
      )
      this.railMesh.position.copy(this.railPosition)
    }
  }

  private onPointerUp = () => {
    this.dragging = null
    this.controls.enabled = true
    this.renderer.domElement.style.cursor = 'auto'
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    this.sizeObserver.disconnect()
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown)
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    this.controls.dispose()
    this.world?.free()
    this.clothMesh?.geometry.dispose()
    this.clothMesh?.material.dispose()
    this.sphereMesh.geometry.dispose()
    ;(this.sphereMesh.material as THREE.Material).dispose()
    this.railMesh.geometry.dispose()
    ;(this.railMesh.material as THREE.Material).dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
