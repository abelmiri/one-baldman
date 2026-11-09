import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import RAPIER from '@dimforge/rapier3d'
import { Ragdoll } from './Ragdoll'

export type Mode = 'cape' | 'falling'
export type MovementDirection = 'forward' | 'backward' | 'left' | 'right'
export type Settings = {
  mode: Mode
  wind: number
  windDirection: number
  gravity: number
  stiffness: number
  playing: boolean
  standing: boolean
  gait: 'walk' | 'run'
  sitting: boolean
}

// 24 × 24 cells is almost exactly twice the previous 17 × 17 grid.
const COUNT = 25
const CLOTH_MASS = 2 * (18 * 18 * 0.025)
const CAPE_MASS = 1.2
// Cape (group 2) collides with normal bodies and itself, but not its sewn
// shoulders (group 4). Chest seam points start outside the chest collider.
const CAPE_COLLISION_GROUPS = 0x00020003
const SHOULDER_COLLISION_GROUPS = 0x0004ffff
const STEP = 1 / 60
const MAX_STEPS_PER_FRAME = 2
const MAX_RENDER_PIXELS = 3_000_000
const vector = (x: number, y: number, z: number) => ({ x, y, z })
const MOVEMENT_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'])

function capeDescription() {
  const positions = new Float32Array(COUNT * COUNT * 3)
  const indices: number[] = []
  for (let column = 0; column < COUNT; column++) {
    const across = column / (COUNT - 1) * 2 - 1
    for (let row = 0; row < COUNT; row++) {
      const down = row / (COUNT - 1)
      const width = THREE.MathUtils.lerp(0.924, 1.7, down)
      // Curve the collar around the back of the neck, then clear the torso.
      const collarCurve = 1 - THREE.MathUtils.smoothstep(Math.abs(across), 0.58, 0.83)
      const collarDepth = -0.065 - 0.16 * collarCurve
      const index = column * COUNT + row
      positions[index * 3] = across * width / 2
      const scallop = 0.07 * (1 - Math.cos(column / (COUNT - 1) * Math.PI * 12))
      positions[index * 3 + 1] = 1.96 - down * 1.65 + scallop * down ** 8
      positions[index * 3 + 2] = THREE.MathUtils.lerp(collarDepth, -0.3, Math.min(down / 0.12, 1)) - down * 0.1
      if (column < COUNT - 1 && row < COUNT - 1) {
        indices.push(index, index + 1, index + COUNT, index + 1, index + COUNT + 1, index + COUNT)
      }
    }
  }
  const desc = RAPIER.SoftBodyDesc.trimesh(positions, new Uint32Array(indices))
  if (!desc) throw new Error('ساخت پارچهٔ شنل ناموفق بود')
  return desc.setShapeMatching(false)
}

export class ClothLab {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100)
  private controls: OrbitControls
  private world: RAPIER.World | null = null
  private cloth: RAPIER.SoftBody | null = null
  private ragdoll: Ragdoll | null = null
  private clothMesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material> | null = null
  private clothPositions = new Float32Array(0)
  private previousClothPositions = new Float32Array(0)
  private raf = 0
  private previousTime = 0
  private accumulator = 0
  private elapsed = 0
  private sizeObserver: ResizeObserver
  private pointer = new THREE.Vector2()
  private raycaster = new THREE.Raycaster()
  private dragPlane = new THREE.Plane()
  private dragPoint = new THREE.Vector3()
  private pointerId: number | null = null
  private dragOffset = new THREE.Vector3()
  private settings: Settings
  private keys = new Set<string>()
  private touchDirections = new Set<MovementDirection>()
  private movementForward = new THREE.Vector3()
  private movementRight = new THREE.Vector3()
  private movement = new THREE.Vector3()
  private focus = new THREE.Vector3()
  private followOffset = new THREE.Vector3()
  private keyLight = new THREE.DirectionalLight('#ffffff', 3.1)

  constructor(private host: HTMLElement, settings: Settings, private onGrabChange: (label: string) => void = () => {},
    private onSitChange: (sitting: boolean) => void = () => {}) {
    this.settings = { ...settings }
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.domElement.className = 'scene-canvas'
    this.renderer.domElement.tabIndex = 0
    this.renderer.domElement.setAttribute('aria-label', 'نمای سه‌بعدی؛ حرکت با WASD یا کلیدهای جهت‌دار، دویدن با Shift و نشستن با C')
    host.appendChild(this.renderer.domElement)

    this.camera.position.set(3.2, 2.7, 5.6)
    this.camera.lookAt(0, 1.5, 0)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.minDistance = 3.7
    this.controls.maxDistance = 13
    this.controls.maxPolarAngle = Math.PI * 0.89
    this.controls.target.set(0, 1.4, 0)

    this.scene.background = new THREE.Color('#f5f5f2')
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#bac5d2', 2.3))
    const key = this.keyLight
    key.position.set(-3, 8, 6)
    key.castShadow = true
    key.shadow.mapSize.set(1024, 1024)
    key.shadow.camera.left = -6
    key.shadow.camera.right = 6
    key.shadow.camera.top = 6
    key.shadow.camera.bottom = -6
    key.shadow.bias = -0.0005
    this.scene.add(key, key.target)

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(2000, 2000),
      new THREE.MeshStandardMaterial({ color: '#e9e9e5', roughness: 0.93 }),
    )
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -0.12
    floor.receiveShadow = true
    this.scene.add(floor)
    // A world-space reference makes travel visible while the camera follows.
    const grid = new THREE.GridHelper(200, 200, '#cbd3df', '#dce2eb')
    grid.position.y = -0.115
    grid.material.transparent = true
    grid.material.opacity = 0.4
    grid.material.depthWrite = false
    this.scene.add(grid)

    // Pick before OrbitControls handles the same event.
    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown, true)
    this.renderer.domElement.addEventListener('lostpointercapture', this.onPointerUp)
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('pointercancel', this.onPointerUp)
    window.addEventListener('blur', this.onBlur)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    document.addEventListener('visibilitychange', this.onVisibilityChange)
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
    else this.ragdoll?.setStanding(settings.standing)
    if (!settings.playing || !settings.standing) this.clearMovement()
    if (!settings.playing) this.cancelDrag()
  }

  reset() {
    this.clearMovement()
    this.cancelDrag()
    this.ragdoll?.dispose()
    this.world?.free()
    this.world = new RAPIER.World(vector(0, -this.settings.gravity, 0))
    this.world.integrationParameters.dt = STEP
    this.world.integrationParameters.softBodiesMaxExtraSubsteps = 1
    this.world.integrationParameters.numSolverIterations = 4
    this.world.integrationParameters.maxCcdSubsteps = 1
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(1000, 0.1, 1000).setTranslation(0, -0.22, 0).setFriction(0.85))
    this.elapsed = 0
    this.accumulator = 0
    if (this.clothMesh) {
      this.scene.remove(this.clothMesh)
      this.clothMesh.geometry.dispose()
      this.clothMesh.material.dispose()
    }

    const cape = this.settings.mode === 'cape'
    this.ragdoll = new Ragdoll(this.world, this.scene, 0, this.settings.standing)
    this.ragdoll.controlFocus(this.focus)
    this.followOffset.copy(this.focus).sub(this.controls.target)
    this.camera.position.add(this.followOffset)
    this.controls.target.copy(this.focus)
    this.keyLight.position.set(-3, 8, 6)
    this.keyLight.target.position.set(0, 0, 0)

    const spacing = 2.7 / (COUNT - 1)
    const mass = cape ? CAPE_MASS : CLOTH_MASS
    const radius = cape ? 0.018 : 0.04
    const desc = (cape ? capeDescription() : RAPIER.SoftBodyDesc.cloth(
      vector(-1.35, 3.75, -1.35), vector(spacing, 0, 0), vector(0, 0, spacing), COUNT, COUNT,
    ))
      .setSoftness(this.settings.stiffness, 1)
      .setParticleMass(mass / (COUNT * COUNT))
      .setParticleRadius(radius)
      .setSurfaceCollider(RAPIER.ColliderDesc.ball(radius).setFriction(0.85)
        .setCollisionGroups(cape ? CAPE_COLLISION_GROUPS : 0xffffffff))
      .setSelfContacts(true)
      .setAdditionalPgsIterations(1)
      .setLinearDamping(1)
      .setCanSleep(false)
    this.cloth = this.world.createSoftBody(desc)
    if (cape) {
      for (const side of ['rightShoulder', 'leftShoulder']) {
        this.ragdoll.parts.get(side)!.body.collider(0).setCollisionGroups(SHOULDER_COLLISION_GROUPS)
      }
      // Sew every vertex of the collar: outer sections follow the shoulders,
      // and the entire middle section follows the upper back, without gaps.
      for (let column = 0; column < COUNT; column++) {
        const part = column < 4 ? 'rightShoulder' : column > COUNT - 5 ? 'leftShoulder' : 'chest'
        this.cloth.attachParticle(column * COUNT, this.ragdoll.parts.get(part)!.body)
      }
    }

    const positions = this.cloth.particlePositions()
    this.clothPositions = new Float32Array(positions)
    this.previousClothPositions = new Float32Array(positions)
    const boundary = this.cloth.boundary()
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3).setUsage(THREE.DynamicDrawUsage))
    geometry.setIndex(Array.from(boundary))
    geometry.computeVertexNormals()
    const material = new THREE.MeshStandardMaterial({
      color: cape ? '#101218' : '#536dff', side: THREE.DoubleSide, roughness: cape ? 0.92 : 0.68, metalness: 0.02,
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
    if (!this.world || !this.cloth || !this.ragdoll) return
    this.elapsed += STEP
    this.world.gravity = vector(0, -this.settings.gravity, 0)
    this.updateMovement()
    this.ragdoll.step(STEP)
    this.cloth.resetForces(true)
    if (this.settings.wind > 0) {
      const wind = this.settings.wind / 3
      const angle = this.settings.windDirection * Math.PI / 180
      const gust = 0.8 + 0.2 * Math.sin(this.elapsed * 2.4)
      // A worn cape can take continuous wind; alternate gusts on the free sheet.
      const force = this.settings.mode === 'cape'
        ? wind * CAPE_MASS * 0.04 * gust
        : wind * 0.08 * Math.sin(this.elapsed * 2.8)
      this.cloth.addForce(vector(Math.cos(angle) * force, 0, Math.sin(angle) * force), true)
    }
    this.previousClothPositions.set(this.clothPositions)
    this.world.step()
    this.clothPositions.set(this.cloth.particlePositions())
  }

  private updateMesh(alpha = 1) {
    if (!this.cloth || !this.clothMesh) return
    const attribute = this.clothMesh.geometry.getAttribute('position') as THREE.BufferAttribute
    const positions = attribute.array as Float32Array
    for (let i = 0; i < positions.length; i++) {
      const previous = this.previousClothPositions[i]
      positions[i] = previous + (this.clothPositions[i] - previous) * alpha
    }
    attribute.needsUpdate = true
    this.clothMesh.geometry.computeVertexNormals()
  }

  private frame = (time: number) => {
    if (!this.previousTime) this.previousTime = time
    const delta = Math.min((time - this.previousTime) / 1000, 0.05)
    this.previousTime = time
    if (this.settings.playing) {
      // Bound catch-up work so a slow frame cannot start a growing physics backlog.
      this.accumulator = Math.min(this.accumulator + delta, STEP * MAX_STEPS_PER_FRAME)
      let steps = 0
      while (this.accumulator >= STEP && steps < MAX_STEPS_PER_FRAME) {
        this.step()
        this.accumulator -= STEP
        steps++
      }
      this.updateMesh(this.accumulator / STEP)
    }
    this.ragdoll?.sync(this.settings.playing ? this.accumulator / STEP : 1)
    if (this.ragdoll && this.settings.standing && this.pointerId === null) {
      this.ragdoll.controlFocus(this.focus)
      this.followOffset.copy(this.focus).sub(this.controls.target).multiplyScalar(1 - Math.exp(-6 * delta))
      this.camera.position.add(this.followOffset)
      this.controls.target.add(this.followOffset)
      this.keyLight.position.x = this.focus.x - 3
      this.keyLight.position.z = this.focus.z + 6
      this.keyLight.target.position.set(this.focus.x, 0, this.focus.z)
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
    // Fullscreen on a Retina display otherwise renders many millions of pixels.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5, Math.sqrt(MAX_RENDER_PIXELS / (width * height))))
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

  setTouchDirection(direction: MovementDirection, pressed: boolean) {
    if (pressed && this.settings.playing && this.settings.standing) {
      this.touchDirections.add(direction)
      if (this.settings.sitting) this.onSitChange(false)
    } else this.touchDirections.delete(direction)
  }

  private clearMovement = () => {
    this.keys.clear()
    this.touchDirections.clear()
  }

  private onBlur = () => {
    this.clearMovement()
    this.cancelDrag()
  }

  private onVisibilityChange = () => {
    if (document.hidden) this.onBlur()
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.altKey || event.metaKey || event.defaultPrevented) return
    const target = event.target
    if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return
    if (!this.settings.playing || !this.settings.standing) return
    if (event.code === 'KeyC') {
      if (!event.repeat) this.onSitChange(!this.settings.sitting)
      event.preventDefault()
      return
    }
    if (MOVEMENT_KEYS.has(event.code) || event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
      this.keys.add(event.code)
      event.preventDefault()
      if (MOVEMENT_KEYS.has(event.code) && this.settings.sitting) this.onSitChange(false)
    }
  }

  private onKeyUp = (event: KeyboardEvent) => {
    if (this.keys.delete(event.code)) event.preventDefault()
  }

  private updateMovement() {
    const forward = Number(this.keys.has('KeyW') || this.keys.has('ArrowUp') || this.touchDirections.has('forward'))
      - Number(this.keys.has('KeyS') || this.keys.has('ArrowDown') || this.touchDirections.has('backward'))
    const right = Number(this.keys.has('KeyD') || this.keys.has('ArrowRight') || this.touchDirections.has('right'))
      - Number(this.keys.has('KeyA') || this.keys.has('ArrowLeft') || this.touchDirections.has('left'))
    this.camera.getWorldDirection(this.movementForward)
    this.movementForward.y = 0
    this.movementForward.normalize()
    this.movementRight.crossVectors(this.movementForward, THREE.Object3D.DEFAULT_UP)
    this.movement.copy(this.movementForward).multiplyScalar(forward).addScaledVector(this.movementRight, right).clampLength(0, 1)
    if (!this.settings.standing || this.pointerId !== null) this.movement.set(0, 0, 0)
    this.ragdoll!.setMovement(this.movement.x, this.movement.z,
      this.settings.gait === 'run' || this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'), this.settings.sitting)
  }

  private onPointerDown = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0 || this.pointerId !== null) return
    this.renderer.domElement.focus({ preventScroll: true })
    this.setPointer(event)
    const hit = this.raycaster.intersectObjects(this.pickTargets(), true)[0]
    const part = hit && this.ragdoll?.partFor(hit.object)
    if (!part || !this.settings.playing) return
    this.clearMovement()
    const point = hit.point
    this.dragPlane.setFromNormalAndCoplanarPoint(this.camera.getWorldDirection(new THREE.Vector3()), point)
    this.raycaster.ray.intersectPlane(this.dragPlane, this.dragPoint)
    this.dragOffset.copy(point).sub(this.dragPoint)
    this.ragdoll!.startGrab(part, hit.point)
    this.onGrabChange(part.label)
    this.controls.enabled = false
    this.pointerId = event.pointerId
    this.renderer.domElement.setPointerCapture(event.pointerId)
    this.renderer.domElement.style.cursor = 'grabbing'
  }

  private onPointerMove = (event: PointerEvent) => {
    if (this.pointerId !== null && event.pointerId !== this.pointerId) return
    if (this.pointerId === null) {
      this.setPointer(event)
      const hit = this.raycaster.intersectObjects(this.pickTargets(), true)[0]
      const part = hit && this.ragdoll?.partFor(hit.object)
      this.ragdoll?.highlight(this.settings.playing ? part : undefined)
      this.renderer.domElement.style.cursor = part && this.settings.playing ? 'grab' : 'auto'
      this.renderer.domElement.title = part ? `${part.label}${this.settings.playing ? ' — بگیرید و بکشید' : ' — ابتدا ادامه را بزنید'}` : ''
      return
    }
    this.setPointer(event)
    if (!this.raycaster.ray.intersectPlane(this.dragPlane, this.dragPoint)) return
    this.dragPoint.add(this.dragOffset)
    this.ragdoll?.moveGrab(this.dragPoint)
  }

  private pickTargets() {
    return this.ragdoll?.meshes ?? []
  }

  private onPointerUp = (event: PointerEvent) => {
    if (event.pointerId !== this.pointerId) return
    this.cancelDrag()
  }

  private cancelDrag = () => {
    const id = this.pointerId
    this.pointerId = null
    this.ragdoll?.endGrab()
    this.controls.enabled = true
    if (id !== null && this.renderer.domElement.hasPointerCapture(id)) this.renderer.domElement.releasePointerCapture(id)
    this.renderer.domElement.style.cursor = 'auto'
    this.onGrabChange('')
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    this.sizeObserver.disconnect()
    this.cancelDrag()
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown, true)
    this.renderer.domElement.removeEventListener('lostpointercapture', this.onPointerUp)
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('pointercancel', this.onPointerUp)
    window.removeEventListener('blur', this.onBlur)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    this.clearMovement()
    this.controls.dispose()
    this.ragdoll?.dispose()
    this.world?.free()
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
        object.geometry.dispose()
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose()
      }
      if (object instanceof THREE.DirectionalLight) object.shadow.dispose()
    })
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
