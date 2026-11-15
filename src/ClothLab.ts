import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import RAPIER from '@dimforge/rapier3d'
import { Ragdoll } from './Ragdoll'
import { City, CITY_SCALE } from './City'
import { HeatVision } from './HeatVision'
import { CapeSurface } from './CapeSurface'
import { CapeMotion } from './CapeMotion'
import { ImpactDust } from './ImpactDust'
import { WindEffect } from './WindEffect'
import { GameAudio } from './GameAudio'
import { ImpactShake } from './ImpactShake'

export type Mode = 'cape' | 'falling'
export type MovementDirection = 'forward' | 'backward' | 'left' | 'right'
export type CameraView = 'city' | 'player'
export type FlightTelemetry = { state: 'grounded' | 'flying' | 'landing' | 'released' | 'recovering'; altitude: number; speed: number; x: number; z: number; heading: number }
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

// Render tailoring separately: 53% fewer physics particles than the 19×19 grid.
const COUNT = 13
const CLOTH_MASS = 2 * (18 * 18 * 0.025)
const CAPE_MASS = 1.2
// Cape collides with the environment (1), itself (2) and body copies (8).
// The real ragdoll (4) and sewn shoulder copies (16) never receive cape forces.
const CAPE_COLLISION_GROUPS = 0x0002000b
const STEP = 1 / 60
const MAX_STEPS_PER_FRAME = 2
const MAX_RENDER_PIXELS = 3_000_000
const CAMERA_ROTATE_SPEED = 1.35
const CAMERA_SHOULDER_OFFSET = 1.4
const CAMERA_DEFAULT_ZOOM = 1.2
const CAMERA_INTERIOR_ZOOM = 1.3
const CAMERA_GROUND_CLEARANCE = .35
const vector = (x: number, y: number, z: number) => ({ x, y, z })
const MOVEMENT_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'])

function capeDescription() {
  const positions = new Float32Array(COUNT * COUNT * 3)
  const indices: number[] = []
  for (let column = 0; column < COUNT; column++) {
    const across = column / (COUNT - 1) * 2 - 1
    for (let row = 0; row < COUNT; row++) {
      const down = row / (COUNT - 1)
      const width = THREE.MathUtils.lerp(0.924, 1.72, down ** .8)
      // Curve the collar around the back of the neck, then clear the torso.
      const collarCurve = 1 - THREE.MathUtils.smoothstep(Math.abs(across), 0.58, 0.83)
      const collarDepth = -0.065 - 0.16 * collarCurve
      const index = column * COUNT + row
      positions[index * 3] = across * width / 2
      const phase = column / (COUNT - 1) * Math.PI * 8
      const scallop = .014 * (1 - Math.cos(phase))
      positions[index * 3 + 1] = 1.96 - down * 1.67 + .075 * across ** 2 * down ** 4 + scallop * down ** 8
      const pleat = Math.cos(phase + .28 * Math.sin(down * 3.7))
        * (.035 + .055 * down) * THREE.MathUtils.smoothstep(down, 0, .2)
      positions[index * 3 + 2] = THREE.MathUtils.lerp(collarDepth, -.34, Math.min(down / .14, 1)) - down * .13 + pleat
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
  private camera = new THREE.PerspectiveCamera(42, 1, 0.1, 1600)
  private city: City
  private cameraView: CameraView = 'player'
  private ambient = new THREE.HemisphereLight('#fff4d8', '#65826a', 1.6)
  private controls: OrbitControls
  private world: RAPIER.World | null = null
  private cloth: RAPIER.SoftBody | null = null
  private ragdoll: Ragdoll | null = null
  private clothMesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material> | null = null
  private capeSurface: CapeSurface | null = null
  private capeMotion: CapeMotion | null = null
  private clothPositions = new Float32Array(0)
  private previousClothPositions = new Float32Array(0)
  private raf = 0
  private previousTime = 0
  private accumulator = 0
  private elapsed = 0
  private sizeObserver: ResizeObserver
  private pointerLocked = false
  private lookOffset = new THREE.Vector3()
  private lookAngles = new THREE.Spherical()
  private settings: Settings
  private keys = new Set<string>()
  private touchDirections = new Set<MovementDirection>()
  private touchFlight = false
  private touchRunning = false
  private touchDescending = false
  private touchLaser = false
  private impactDestruction = false
  private impactDestructionUntil: number | null = null
  private impactDestructionRecovery = false
  private destructionContacts: { collider: RAPIER.Collider; point: THREE.Vector3; normal: THREE.Vector3 }[] = []
  private flightContacts: { collider: RAPIER.Collider; from: THREE.Vector3; to: THREE.Vector3; normal: THREE.Vector3 }[] = []
  private impactShake = new ImpactShake()
  private flightFrom = new THREE.Vector3()
  private flightTo = new THREE.Vector3()
  private heatVision: HeatVision
  private impactDust: ImpactDust
  private windEffect: WindEffect
  private audio = new GameAudio()
  private telemetryTime = 0
  private renderDirty = true
  private disposed = false
  private renderScale = 1
  private frameAverage = STEP
  private qualityTime = 0
  private movementForward = new THREE.Vector3()
  private movementRight = new THREE.Vector3()
  private movement = new THREE.Vector3()
  private focus = new THREE.Vector3()
  private followOffset = new THREE.Vector3()
  private cameraRight = new THREE.Vector3()
  private cameraZoom = 1
  private keyLight = new THREE.DirectionalLight('#fff0cf', 3)
  private sunOffset = new THREE.Vector3(-75, 140, 65)

  constructor(private host: HTMLElement, settings: Settings,
    private onSitChange: (sitting: boolean) => void = () => {},
    private onTelemetry: (telemetry: FlightTelemetry) => void = () => {},
    private onPointerUnlock: () => void = () => {}) {
    this.settings = { ...settings }
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = .95
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.domElement.className = 'scene-canvas'
    this.renderer.domElement.tabIndex = 0
    this.renderer.domElement.setAttribute('aria-label', 'بازی شهر ساحلی؛ WASD حرکت، Space برخاستن و صعود، W پرواز در جهت موس، Shift همراه W سرعت ۱۰ برابر، C فرود، F لیزر چشم، X رهاشدن؛ کلیک برای کنترل موس و Escape برای منو')
    host.appendChild(this.renderer.domElement)

    this.camera.position.set(0, 250, 190)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.enablePan = false
    this.controls.minDistance = 4
    this.controls.maxDistance = 600
    this.controls.maxPolarAngle = Math.PI - .08
    this.controls.minPolarAngle = .08
    this.controls.target.set(0, 0, 0)
    this.controls.addEventListener('change', this.invalidate)

    this.scene.background = new THREE.Color('#a9d5d9')
    this.scene.fog = new THREE.Fog('#a9d5d9', 450, 1100)
    this.scene.add(this.ambient)
    const key = this.keyLight
    key.position.set(-75, 140, 65)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.camera.left = -115
    key.shadow.camera.right = 115
    key.shadow.camera.top = 115
    key.shadow.camera.bottom = -115
    key.shadow.camera.far = 350 * CITY_SCALE / 1.5
    key.shadow.normalBias = .16
    key.shadow.bias = -0.00005
    this.scene.add(key, key.target)

    this.impactDust = new ImpactDust(this.scene)
    this.city = new City(this.scene, this.renderer.capabilities.getMaxAnisotropy(), this.invalidate, this.onDebris)
    this.heatVision = new HeatVision(this.scene)
    this.windEffect = new WindEffect(this.scene)

    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown, true)
    document.addEventListener('mousemove', this.onMouseMove)
    document.addEventListener('pointerlockchange', this.onPointerLockChange)
    window.addEventListener('blur', this.onBlur)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    this.sizeObserver = new ResizeObserver(this.resize)
    this.sizeObserver.observe(host)
    this.resize()
    this.reset()
    this.setCameraView('player')
    this.raf = requestAnimationFrame(this.frame)
  }

  update(settings: Settings) {
    const wasPlaying = this.settings.playing
    const rebuild = settings.mode !== this.settings.mode || settings.stiffness !== this.settings.stiffness
    this.settings = { ...settings }
    if (!settings.standing) {
      this.impactDestruction = false
      this.impactDestructionUntil = null
      this.impactDestructionRecovery = false
    }
    if (this.world) this.world.gravity = vector(0, -settings.gravity, 0)
    if (rebuild) this.reset()
    else this.ragdoll?.setStanding(settings.standing)
    if (!settings.playing || !settings.standing) this.clearMovement()
    if (!settings.playing) this.unlockPointer()
    this.controls.enabled = settings.playing
    if (wasPlaying !== settings.playing) {
      this.previousTime = 0
      this.frameAverage = STEP
      this.qualityTime = 0
    }
    this.invalidate()
  }

  reset() {
    this.impactShake.clear()
    this.flightContacts.length = 0
    this.impactDestruction = false
    this.impactDestructionUntil = null
    this.impactDestructionRecovery = false
    this.destructionContacts.length = 0
    this.clearMovement()
    this.impactDust.clear()
    this.capeMotion = null
    this.ragdoll?.dispose()
    this.world?.free()
    this.world = new RAPIER.World(vector(0, -this.settings.gravity, 0))
    this.world.integrationParameters.dt = STEP
    this.world.integrationParameters.softBodiesMaxExtraSubsteps = 1
    this.world.integrationParameters.numSolverIterations = 4
    this.world.integrationParameters.maxCcdSubsteps = 1
    this.city.addColliders(this.world)
    this.elapsed = 0
    this.accumulator = 0
    this.previousTime = 0
    this.city.resetTraffic()
    if (this.clothMesh) {
      this.scene.remove(this.clothMesh)
      if (this.capeSurface) this.capeSurface.dispose()
      else {
        this.clothMesh.geometry.dispose()
        this.clothMesh.material.dispose()
      }
    }
    this.capeSurface = null

    const cape = this.settings.mode === 'cape'
    this.ragdoll = new Ragdoll(this.world, this.scene, 0, this.settings.standing, this.onImpact, this.invalidate)
    this.ragdoll.configureFlightDestruction(this.recordFlightContact, this.isBuildingCollider)
    this.ragdoll.controlFocus(this.focus)
    if (this.cameraView === 'player') this.setCameraView('player')

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
      .setLinearDamping(cape ? 0 : 1)
      .setCanSleep(false)
    this.cloth = this.world.createSoftBody(desc)
    if (cape) {
      // Sew every vertex of the collar: outer sections follow the shoulders,
      // and the entire middle section follows the upper back, without gaps.
      for (let column = 0; column < COUNT; column++) {
        const across = column / (COUNT - 1)
        const part = across < .14 ? 'rightShoulder' : across > .86 ? 'leftShoulder' : 'chest'
        this.cloth.attachParticle(column * COUNT, this.ragdoll.capeBodies.get(part)!)
      }
      this.capeMotion = new CapeMotion(this.cloth, this.ragdoll.capeBodies.get('chest')!, COUNT)
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
      color: cape ? '#bf2132' : '#536dff', side: THREE.DoubleSide, roughness: cape ? 0.72 : 0.68, metalness: 0.02,
      flatShading: false,
    })
    if (cape) {
      geometry.dispose()
      material.dispose()
      this.capeSurface = new CapeSurface(COUNT, 4)
    }
    this.clothMesh = new THREE.Mesh(this.capeSurface?.geometry ?? geometry, this.capeSurface?.material ?? material)
    this.clothMesh.castShadow = true
    this.clothMesh.receiveShadow = true
    this.clothMesh.frustumCulled = false
    this.scene.add(this.clothMesh)
    this.updateMesh()
    this.invalidate()
  }

  private step() {
    if (!this.world || !this.cloth || !this.ragdoll) return
    this.elapsed += STEP
    this.city.stepTraffic(this.elapsed)
    this.updateMovement()
    if (this.impactDestructionUntil !== null && this.elapsed >= this.impactDestructionUntil - 1e-8) {
      this.impactDestruction = false
      this.impactDestructionUntil = null
    }
    this.destructionContacts.length = 0
    this.flightContacts.length = 0
    this.ragdoll.setCollisionProtection(this.impactDestruction && this.settings.standing
      && (this.impactDestructionRecovery || this.impactDestructionUntil !== null))
    const destructiveContacts = this.impactDestruction && this.settings.standing && !this.ragdoll.isReleased
      ? this.recordDestructiveContact : undefined
    const wasRecovering = this.ragdoll.isRecovering
    this.ragdoll.step(STEP, destructiveContacts, this.isDestructibleCollider)
    if (this.impactDestructionRecovery && !this.ragdoll.isRecovering && (wasRecovering || !this.ragdoll.isReleased)) {
      this.impactDestructionRecovery = false
      this.impactDestructionUntil = this.elapsed + 3
    }
    this.capeMotion?.beforeStep(STEP)
    this.cloth.resetForces(true)
    if (this.settings.wind > 0) {
      const wind = this.settings.wind / 3
      const angle = this.settings.windDirection * Math.PI / 180
      const gust = 0.8 + 0.2 * Math.sin(this.elapsed * 2.4)
      // A worn cape can take continuous wind; alternate gusts on the free sheet.
      const force = this.settings.mode === 'cape'
        ? wind * CAPE_MASS * 0.052 * gust
        : wind * 0.08 * Math.sin(this.elapsed * 2.8)
      this.cloth.addForce(vector(Math.cos(angle) * force, 0, Math.sin(angle) * force), true)
    }
    this.previousClothPositions.set(this.clothPositions)
    this.world.step()
    this.ragdoll.checkForImpact(this.ragdoll.isReleased ? undefined : destructiveContacts)
    for (const contact of this.destructionContacts) this.city.destruction.queueContact(contact.collider, contact.point, contact.normal)
    for (const contact of this.flightContacts) this.city.destruction.queueFlightPath(contact.collider, contact.from, contact.to, contact.normal)
    if (this.ragdoll.copyFlightSegment(this.flightFrom, this.flightTo)) this.city.destruction.continueFlightPath(this.flightFrom, this.flightTo)
    else this.city.destruction.endFlightPath()
    this.capeMotion?.afterStep(STEP)
    this.clothPositions.set(this.cloth.particlePositions())
    this.impactDust.step(STEP)
  }

  private updateMesh(alpha = 1) {
    if (!this.cloth || !this.clothMesh) return
    if (this.capeSurface) {
      const time = Math.max(0, this.elapsed - STEP + alpha * STEP)
      this.capeSurface.update(this.previousClothPositions, this.clothPositions, alpha, time)
      return
    }
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
    if (this.disposed || document.hidden) { this.raf = 0; return }
    if (!this.previousTime) this.previousTime = time
    const frameDelta = (time - this.previousTime) / 1000
    const delta = Math.min(frameDelta, 0.05)
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
      this.ragdoll?.sync(this.accumulator / STEP)
      this.city.update(Math.max(0, this.elapsed - STEP + this.accumulator))
      this.adaptResolution(frameDelta, delta)
    }
    if (this.settings.playing && this.ragdoll && time - this.telemetryTime > 100) {
      this.telemetryTime = time
      this.ragdoll.renderFocus(this.focus)
      this.onTelemetry({ state: this.ragdoll.flightState, altitude: this.ragdoll.altitude, speed: this.ragdoll.speed,
        x: this.focus.x, z: this.focus.z, heading: this.ragdoll.viewHeading })
    }
    if (this.settings.playing && this.cameraView === 'player' && this.ragdoll) {
      this.ragdoll.renderFocus(this.focus)
      const interior = this.city.buildingAt(this.focus)
      const nextZoom = interior ? CAMERA_INTERIOR_ZOOM : 1
      const zoom = THREE.MathUtils.damp(this.cameraZoom, nextZoom, 6, delta)
      if (Math.abs(zoom - this.cameraZoom) > 1e-4) {
        this.camera.position.sub(this.controls.target).multiplyScalar(this.cameraZoom / zoom).add(this.controls.target)
        this.cameraZoom = zoom
      }
      // Translate both the camera and its orbit target to the right shoulder.
      // The center ray stays aligned with the reticle while the hero sits left of it.
      this.cameraRight.set(1, 0, 0).applyQuaternion(this.camera.quaternion)
      this.focus.addScaledVector(this.cameraRight, CAMERA_SHOULDER_OFFSET)
      this.followOffset.copy(this.focus).sub(this.controls.target).multiplyScalar(1 - Math.exp(-6 * delta))
      this.camera.position.add(this.followOffset)
      this.controls.target.add(this.followOffset)
    }
    if (this.settings.playing && this.cameraView === 'player') {
      this.ragdoll?.renderFocus(this.focus)
      this.keyLight.target.position.copy(this.focus)
      this.keyLight.position.copy(this.focus).add(this.sunOffset)
    }
    if (this.settings.playing) this.controls.update(delta)
    this.keepCameraAboveGround()
    this.impactDust.render(this.camera)
    this.ragdoll?.renderFocus(this.focus)
    if (this.city.updateOcclusion(this.camera, this.focus, delta, this.cameraView === 'player')) this.invalidate()
    this.windEffect.update(Math.max(0, this.elapsed - STEP + this.accumulator), this.focus,
      this.settings.wind, this.settings.windDirection, this.cameraView === 'player')
    this.heatVision.update(this.settings.playing ? delta : 0, this.settings.playing && this.settings.standing
      && !this.ragdoll?.isReleased && !this.ragdoll?.isRecovering && (this.keys.has('KeyF') || this.touchLaser),
      this.ragdoll?.parts.get('head')?.mesh, this.camera, this.world, this.city.destruction)
    this.audio.update(this.settings.playing && !document.hidden && document.hasFocus(),
      this.heatVision.group.visible, this.heatVision.isHittingSurface,
      !!this.ragdoll?.isAirborne, this.ragdoll?.speed ?? 0)
    if (this.settings.playing || this.renderDirty) {
      if (this.cameraView === 'player') this.impactShake.apply(this.camera, this.settings.playing ? delta : 0)
      else this.impactShake.clear()
      try { this.renderer.render(this.scene, this.camera) }
      finally { this.impactShake.restore(this.camera) }
      this.renderDirty = false
    }
    this.raf = requestAnimationFrame(this.frame)
  }

  private invalidate = () => { this.renderDirty = true }

  setMuted(muted: boolean) { this.audio.setMuted(muted) }

  private playImpact(point: THREE.Vector3Like, speed: number, debris = false) {
    this.cameraRight.set(1, 0, 0).applyQuaternion(this.camera.quaternion)
    this.audio.impact(point, speed, this.camera.position, this.cameraRight, debris)
  }

  private onImpact = (point: THREE.Vector3Like, normal: THREE.Vector3Like, speed: number) => {
    this.impactDust.burst(point, normal, speed)
    this.playImpact(point, speed)
  }

  private onDebris = (point: THREE.Vector3Like, normal: THREE.Vector3Like, speed: number) => {
    this.impactDust.burst(point, normal, speed)
    this.playImpact(point, speed, true)
  }

  private adaptResolution(frameDelta: number, delta: number) {
    // Ignore suspension/resize stalls; change resolution slowly to avoid oscillation.
    if (frameDelta <= 0 || frameDelta > .15) return
    this.frameAverage = THREE.MathUtils.damp(this.frameAverage, frameDelta, 2, delta)
    this.qualityTime += delta
    if (this.qualityTime < 2) return
    this.qualityTime = 0
    const next = THREE.MathUtils.clamp(this.renderScale + (this.frameAverage > .022 ? -.1 : this.frameAverage < .018 ? .05 : 0), .65, 1)
    if (Math.abs(next - this.renderScale) < .001) return
    this.renderScale = next
    // A resolution adjustment must preserve the player's zoom and orbit.
    this.setRenderResolution(Math.max(this.host.clientWidth, 1), Math.max(this.host.clientHeight, 1))
  }

  private setRenderResolution(width: number, height: number) {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5, Math.sqrt(MAX_RENDER_PIXELS / (width * height))) * this.renderScale)
  }

  private resize = () => {
    const width = Math.max(this.host.clientWidth, 1)
    const height = Math.max(this.host.clientHeight, 1)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    // Fullscreen on a Retina display otherwise renders many millions of pixels.
    this.setRenderResolution(width, height)
    this.renderer.setSize(width, height)
    if (this.cameraView === 'city') this.setCameraView('city')
    this.invalidate()
  }

  setCameraView(view: CameraView) {
    this.cameraView = view
    this.cameraZoom = 1
    // Distant map surfaces need more depth precision than the close character view.
    this.camera.near = view === 'city' ? 3 : .1
    this.camera.updateProjectionMatrix()
    // Flush any remaining orbit damping before changing views.
    this.controls.enableDamping = false
    this.controls.update()
    const shadowExtent = view === 'city' ? 115 * CITY_SCALE : 24
    const shadow = this.keyLight.shadow
    shadow.camera.left = shadow.camera.bottom = -shadowExtent
    shadow.camera.right = shadow.camera.top = shadowExtent
    shadow.normalBias = view === 'city' ? .16 : .035
    shadow.camera.updateProjectionMatrix()
    if (view === 'city') {
      this.keyLight.position.copy(this.sunOffset)
      this.keyLight.target.position.set(0, 0, 0)
    }
    this.invalidate()
    this.controls.enableDamping = view === 'city'
    this.controls.rotateSpeed = CAMERA_ROTATE_SPEED
    this.controls.mouseButtons.LEFT = view === 'city' ? THREE.MOUSE.ROTATE : null
    this.controls.mouseButtons.RIGHT = null
    if (view === 'city') {
      this.unlockPointer()
      const distance = 119 * CITY_SCALE / Math.tan(THREE.MathUtils.degToRad(21)) / Math.min(1, this.camera.aspect)
      this.controls.target.set(0, 0, 0)
      this.camera.position.set(0, distance * .94, distance * .342)
      this.controls.minDistance = 30
      this.controls.maxDistance = 650 * CITY_SCALE
    } else {
      this.ragdoll?.controlFocus(this.focus)
      this.controls.target.copy(this.focus)
      this.lookOffset.set(0, 2.8, -9.5).divideScalar(CAMERA_DEFAULT_ZOOM)
        .applyAxisAngle(THREE.Object3D.DEFAULT_UP, this.ragdoll?.viewHeading ?? 0)
      this.camera.position.copy(this.focus).add(this.lookOffset)
      this.cameraRight.crossVectors(THREE.Object3D.DEFAULT_UP, this.lookOffset).normalize()
      this.camera.position.addScaledVector(this.cameraRight, CAMERA_SHOULDER_OFFSET)
      this.controls.target.addScaledVector(this.cameraRight, CAMERA_SHOULDER_OFFSET)
      this.controls.minDistance = 3.7
      this.controls.maxDistance = 80
    }
    this.camera.lookAt(this.controls.target)
    this.controls.update()
    this.keepCameraAboveGround()
  }

  private keepCameraAboveGround() {
    if (this.cameraView !== 'player') return
    const minimumHeight = this.city.groundHeightAt(this.camera.position) + CAMERA_GROUND_CLEARANCE
    const lift = minimumHeight - this.camera.position.y
    if (lift <= 0) return
    // Lift the entire orbit so aiming upward keeps its direction and zoom.
    this.camera.position.y += lift
    this.controls.target.y += lift
    this.invalidate()
  }

  setNight(night: boolean) {
    this.city.setNight(night)
    this.ambient.color.set(night ? '#8cadd6' : '#fff4d8')
    this.ambient.intensity = night ? .85 : 1.6
    this.keyLight.color.set(night ? '#9cb7df' : '#fff0cf')
    this.keyLight.intensity = night ? .8 : 3
    const sky = night ? '#142b40' : '#a9d5d9'
    this.scene.background = new THREE.Color(sky)
    this.scene.fog = new THREE.Fog(sky, 450, 1100)
    this.invalidate()
  }

  setTouchDirection(direction: MovementDirection, pressed: boolean) {
    if (pressed && this.settings.playing && this.settings.standing && !this.ragdoll?.isReleased && !this.ragdoll?.isRecovering) {
      this.touchDirections.add(direction)
      if (this.settings.sitting) this.onSitChange(false)
    } else this.touchDirections.delete(direction)
  }

  setTouchFlight(pressed: boolean) {
    this.touchFlight = pressed && this.settings.playing && this.settings.standing && !this.ragdoll?.isReleased && !this.ragdoll?.isRecovering
  }

  setTouchRunning(pressed: boolean) {
    this.touchRunning = pressed && this.settings.playing && !this.ragdoll?.isReleased && !this.ragdoll?.isRecovering
  }

  setTouchDescending(pressed: boolean) {
    this.touchDescending = pressed && this.settings.playing && !this.ragdoll?.isReleased && !this.ragdoll?.isRecovering
  }

  setTouchLaser(pressed: boolean) {
    this.touchLaser = pressed && this.settings.playing && !this.ragdoll?.isReleased && !this.ragdoll?.isRecovering
  }

  toggleRelease() {
    if (!this.settings.playing || !this.settings.standing || this.ragdoll?.isRecovering) return
    this.clearMovement()
    if (this.ragdoll?.isReleased) {
      this.impactDestruction = true
      this.impactDestructionUntil = null
      this.impactDestructionRecovery = true
      this.ragdoll.regainControl(true)
    } else if (this.ragdoll) {
      this.impactDestruction = false
      this.impactDestructionUntil = null
      this.impactDestructionRecovery = false
      this.ragdoll.release(true)
    }
  }

  private recordDestructiveContact = (collider: RAPIER.Collider, point: THREE.Vector3Like, normal: THREE.Vector3Like) => {
    const owner = this.city.destruction.ownerOf(collider)
    if (this.ragdoll?.isBreakingFlight && owner?.kind === 'building') return
    if (!owner || this.destructionContacts.some(contact => this.city.destruction.ownerOf(contact.collider) === owner
      && contact.point.distanceToSquared(point) < .25)) return
    this.destructionContacts.push({ collider, point: new THREE.Vector3().copy(point), normal: new THREE.Vector3().copy(normal) })
  }

  private isDestructibleCollider = (collider: RAPIER.Collider) => !!this.city.destruction.ownerOf(collider)
  private isBuildingCollider = (collider: RAPIER.Collider) => this.city.destruction.ownerOf(collider)?.kind === 'building'

  private recordFlightContact = (collider: RAPIER.Collider, from: THREE.Vector3Like, to: THREE.Vector3Like, normal: THREE.Vector3Like, speed: number) => {
    const owner = this.city.destruction.ownerOf(collider)
    if (!owner || this.flightContacts.some(contact => this.city.destruction.ownerOf(contact.collider) === owner)) return
    this.flightContacts.push({ collider, from: new THREE.Vector3().copy(from), to: new THREE.Vector3().copy(to), normal: new THREE.Vector3().copy(normal) })
    this.impactShake.hit(speed)
  }

  focusGame() { this.renderer.domElement.focus({ preventScroll: true }) }

  private clearMovement = () => {
    this.audio.stop()
    this.keys.clear()
    this.touchDirections.clear()
    this.touchFlight = false
    this.touchRunning = false
    this.touchDescending = false
    this.touchLaser = false
    this.heatVision?.stop()
  }

  private onBlur = () => {
    this.clearMovement()
    this.unlockPointer()
  }

  private onVisibilityChange = () => {
    if (document.hidden) {
      this.onBlur()
      cancelAnimationFrame(this.raf)
      this.raf = 0
    } else if (!this.disposed && !this.raf) {
      this.previousTime = 0
      this.raf = requestAnimationFrame(this.frame)
    }
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.altKey || event.metaKey || event.defaultPrevented) return
    const target = event.target
    if (target instanceof HTMLElement && target.closest('input, textarea, select, button, a, [contenteditable="true"]')) return
    if (!this.settings.playing || !this.settings.standing) return
    if (event.code === 'KeyX') {
      event.preventDefault()
      if (event.repeat) return
      this.toggleRelease()
      return
    }
    if (this.ragdoll?.isReleased || this.ragdoll?.isRecovering) return
    if (MOVEMENT_KEYS.has(event.code) || event.code === 'Space' || event.code === 'KeyC' || event.code === 'KeyF' || event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
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
    this.ragdoll!.setFlightAim(this.movementForward, forward, this.keys.has('KeyF') || this.touchLaser)
    const ascent = this.keys.has('Space') || this.touchFlight
    const airborne = this.ragdoll!.isAirborne || ascent
    if (!airborne) this.movementForward.y = 0
    this.movementForward.normalize()
    this.movementRight.crossVectors(this.movementForward, THREE.Object3D.DEFAULT_UP).normalize()
    this.movement.copy(this.movementForward).multiplyScalar(forward).addScaledVector(this.movementRight, right).clampLength(0, 1)
    if (!this.settings.standing) this.movement.set(0, 0, 0)
    this.ragdoll!.controlFocus(this.focus)
    this.ragdoll!.setFlight(ascent,
      0, right, this.city.groundHeightAt(this.focus), this.keys.has('KeyC') || this.touchDescending)
    this.ragdoll!.setMovement(this.movement.x, this.movement.z,
      this.settings.gait === 'run' || this.touchRunning || this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'), this.settings.sitting, this.movement.y)
  }

  lockPointer = () => {
    const canvas = this.renderer.domElement
    if (this.cameraView !== 'player' || !this.settings.playing || document.pointerLockElement === canvas) return
    this.focusGame()
    // Pointer lock requires a user gesture; rejected requests can be retried by clicking the scene.
    try { canvas.requestPointerLock()?.catch(() => {}) } catch { /* Unsupported or denied by the browser. */ }
  }

  private unlockPointer() {
    if (document.pointerLockElement === this.renderer.domElement) document.exitPointerLock()
  }

  private onPointerLockChange = () => {
    const wasLocked = this.pointerLocked
    this.pointerLocked = document.pointerLockElement === this.renderer.domElement
    this.renderer.domElement.classList.toggle('pointer-locked', this.pointerLocked)
    if (this.pointerLocked && (!this.settings.playing || this.cameraView !== 'player')) {
      this.unlockPointer()
      return
    }
    if (wasLocked && !this.pointerLocked) {
      this.clearMovement()
      if (this.settings.playing && this.cameraView === 'player') this.onPointerUnlock()
    }
  }

  private onPointerDown = (event: PointerEvent) => {
    // OrbitControls uses pointer capture, which conflicts with pointer lock.
    // Keep its drag gestures for touch and the city view.
    if (event.pointerType === 'mouse' && this.cameraView === 'player') event.stopImmediatePropagation()
    if (!event.isPrimary || event.button !== 0) return
    this.focusGame()
    if (event.pointerType === 'mouse') this.lockPointer()
  }

  private onMouseMove = (event: MouseEvent) => {
    if (document.pointerLockElement !== this.renderer.domElement || !this.settings.playing || this.cameraView !== 'player') return
    this.lookOffset.copy(this.camera.position).sub(this.controls.target)
    this.lookAngles.setFromVector3(this.lookOffset)
    const sensitivity = Math.PI * 2 * CAMERA_ROTATE_SPEED / Math.max(this.renderer.domElement.clientHeight, 1)
    this.lookAngles.theta -= event.movementX * sensitivity
    this.lookAngles.phi = THREE.MathUtils.clamp(this.lookAngles.phi - event.movementY * sensitivity,
      this.controls.minPolarAngle, this.controls.maxPolarAngle)
    this.lookOffset.setFromSpherical(this.lookAngles)
    this.camera.position.copy(this.controls.target).add(this.lookOffset)
    this.controls.update()
    this.keepCameraAboveGround()
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.sizeObserver.disconnect()
    this.unlockPointer()
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown, true)
    document.removeEventListener('mousemove', this.onMouseMove)
    document.removeEventListener('pointerlockchange', this.onPointerLockChange)
    window.removeEventListener('blur', this.onBlur)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    this.clearMovement()
    this.controls.removeEventListener('change', this.invalidate)
    this.controls.dispose()
    this.heatVision.dispose()
    this.impactDust.dispose()
    this.windEffect.dispose()
    this.audio.dispose()
    this.ragdoll?.dispose()
    this.world?.free()
    this.world = null
    this.cloth = null
    this.capeMotion = null
    this.ragdoll = null
    this.capeSurface?.dispose()
    this.capeSurface = null
    const geometries = new Set<THREE.BufferGeometry>()
    const materials = new Set<THREE.Material>()
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) {
        geometries.add(object.geometry)
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material)
      }
      if (object instanceof THREE.InstancedMesh) object.dispose()
      if (object instanceof THREE.DirectionalLight) object.shadow.dispose()
    })
    geometries.forEach(geometry => geometry.dispose())
    materials.forEach(material => material.dispose())
    this.city.dispose()
    this.scene.clear()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
