import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { CharacterAnimation, type GetUpStyle, type LimbPose } from './CharacterAnimation'
import { addHeroAppearance } from './HeroAppearance'

type Part = {
  body: RAPIER.RigidBody
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  label: string
  previousPosition: THREE.Vector3
  previousRotation: THREE.Quaternion
  previousVelocity: THREE.Vector3
  inertia: number
  targetPosition: THREE.Vector3
  targetRotation: THREE.Quaternion
}
type AngularJoint = {
  parent: Part
  child: Part
  limits: [number, number, number]
  inertia: number
  motor: RAPIER.SphericalImpulseJoint
  stiffness: number
}
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const STAND_HEIGHT = 1.23
const MAX_STEP_HEIGHT = .4
const RUN_SPEED = 6.40332
const FLIGHT_BOOST_DURATION = 3.5
const FLIGHT_BOOST_RELEASE_DURATION = .65
const PROTECTION_POWER = 100

type PoseLink = {
  parent: Part; child: Part; anchor1: THREE.Vector3; anchor2: THREE.Vector3
  axis?: THREE.Vector3
}

// Physical bodies never collide with the cape. Kinematic copies provide its
// collision surface and collar anchors, including while the real body ragdolls.
const BODY_GROUPS = 0x00040005
const CAPE_PROXY_GROUPS = 0x00080002
const COLLAR_PROXY_GROUPS = 0x00100002

type ImpactHandler = (point: THREE.Vector3Like, normal: THREE.Vector3Like, speed: number) => void
type ContactHandler = (collider: RAPIER.Collider, point: THREE.Vector3Like, normal: THREE.Vector3Like, speed: number) => void
type FlightContactHandler = (collider: RAPIER.Collider, from: THREE.Vector3Like, to: THREE.Vector3Like, normal: THREE.Vector3Like, speed: number) => void

/** Animated kinematic character; switches to a dynamic ragdoll on impact or X. */
export class Ragdoll {
  readonly parts = new Map<string, Part>()
  readonly meshes: THREE.Object3D[] = []
  private angularJoints: AngularJoint[] = []
  private poseLinks: PoseLink[] = []
  private legChains: PoseLink[][] = []
  readonly capeBodies = new Map<string, RAPIER.RigidBody>()
  private ballMotors = new Map<string, AngularJoint>()
  private hinges = new Map<string, RAPIER.RevoluteImpulseJoint>()
  private poseActive: boolean | null = null
  private released = false
  private collisionProtected = false
  private heldSupportHeight: number | null = null
  private breakingFlight = false
  private flightContact?: FlightContactHandler
  private impactPassThrough?: (collider: RAPIER.Collider, speed: number) => boolean
  private buildingCollider?: (collider: RAPIER.Collider) => boolean
  private flightSweepShape = new RAPIER.Ball(1.15)
  private flightSweepHits = new Set<number>()
  private flightFrom = new THREE.Vector3()
  private flightTo = new THREE.Vector3()
  private recovery: { style: GetUpStyle; age: number; duration: number; height: number; rotation: THREE.Quaternion } | null = null
  private direction = new THREE.Vector3()
  private moveVelocity = new THREE.Vector3()
  private running = false
  private flightHeld = false
  private ascentHeld = false
  private descending = false
  private viewDirection = new THREE.Vector3(0, 0, 1)
  private flightBoost = 0
  private aiming = false
  private airborne = false
  private falling = false
  private flightBlend = 0
  private flightPitch = 0
  private flightBank = 0
  private flightAge = 0
  private verticalVelocity = 0
  private landingImpact = 0
  private turnRate = 0
  private animation = new CharacterAnimation()
  private measuredVelocity = new THREE.Vector3()
  private pelvisPosition = new THREE.Vector3()
  private pelvisRotation = new THREE.Quaternion()
  private poseDt = 1 / 60
  private poseResponse = 14
  private ballTargets = new Map<string, THREE.Vector3>()
  private hingeTargets = new Map<string, number>()
  private hingeLimits = new Map<string, [number, number]>()
  private ownBodies = new Set<number>()
  private groundRay = new RAPIER.Ray(v(0, 0, 0), v(0, -1, 0))
  private groundHeight = .04
  private flightRotation = new THREE.Quaternion()
  private flightTravel = new THREE.Vector3()
  private headAim = new THREE.Quaternion()
  private headShare = new THREE.Quaternion()
  private headEuler = new THREE.Euler(0, 0, 0, 'XYZ')
  private flightEuler = new THREE.Euler(0, 0, 0, 'YXZ')
  private sitting = false
  private sitBlend = 0
  private heading = 0
  private standHeight = STAND_HEIGHT
  private torsoTarget = new THREE.Quaternion()
  private seat: THREE.Group
  private seatBody: RAPIER.RigidBody
  private seatVisible = false
  private seatColliding = false
  private supportTarget: THREE.Vector3
  private footContacts = [false, false]
  private standing = false
  private q1 = new THREE.Quaternion()
  private q2 = new THREE.Quaternion()
  private inverseRotation = new THREE.Quaternion()
  private rotation = new THREE.Vector3()
  private torque = new THREE.Vector3()
  private velocity = new THREE.Vector3()
  private position = new THREE.Vector3()
  private impactTime = 0
  private lastImpactTime = -Infinity
  private lastImpactPosition = new THREE.Vector3()
  private impactPoint = new THREE.Vector3()
  private impactNormal = new THREE.Vector3()
  private contactPoint = new THREE.Vector3()
  private contactNormal = new THREE.Vector3()
  private impactVelocity = new THREE.Vector3()
  private protection = 0
  private protectionHold = 0
  private protectionSide = 0
  private supported = false
  private protectionRay = new RAPIER.Ray(v(0, 0, 0), v(0, -1, 0))
  private disposeAppearance: () => void

  /** Muscle engagement, useful for inspecting the physical protective reflex. */
  get protectionStrength() { return this.protection }

  constructor(private world: RAPIER.World, private scene: THREE.Scene, z: number, standing: boolean,
    private onImpact: ImpactHandler = () => {}, onAppearanceReady = () => {}) {
    const point = (x: number, y: number, depth = 0) => v(x, y, z + depth)
    const box = (id: string, label: string, center: THREE.Vector3, size: THREE.Vector3, mass: number, color: string) =>
      this.addPart(id, label, center,
        new RoundedBoxGeometry(size.x * 2, size.y * 2, size.z * 2, 3, 0.045),
        RAPIER.ColliderDesc.roundCuboid(size.x - 0.025, size.y - 0.025, size.z - 0.025, 0.025), mass, color)
    const ball = (id: string, label: string, center: THREE.Vector3, radius: number, mass: number, color: string) =>
      this.addPart(id, label, center, new THREE.SphereGeometry(radius, 24, 16),
        RAPIER.ColliderDesc.ball(radius), mass, color)
    const limb = (id: string, label: string, a: THREE.Vector3, b: THREE.Vector3, radius: number, mass: number) => {
      const length = a.distanceTo(b)
      const rotation = new THREE.Quaternion().setFromUnitVectors(v(0, 1, 0), b.clone().sub(a).normalize())
      const geometry = new THREE.CapsuleGeometry(radius, Math.max(0.01, length - radius * 2), 6, 16)
      geometry.applyQuaternion(rotation)
      return this.addPart(id, label, a.clone().add(b).multiplyScalar(0.5), geometry,
        RAPIER.ColliderDesc.capsule(Math.max(0.005, length / 2 - radius), radius).setRotation(rotation),
        mass, '#234db2')
    }

    const pelvis = box('pelvis', 'لگن', point(0, 1.13), v(0.265, 0.17, 0.16), 9, '#234db2')
    const abdomen = box('abdomen', 'شکم و کمر', point(0, 1.43), v(0.215, 0.135, 0.135), 6, '#234db2')
    const chest = box('chest', 'سینه', point(0, 1.77), v(0.30, 0.20, 0.17), 12, '#234db2')
    const neck = ball('neck', 'گردن', point(0, 2.055), 0.085, 0.8, '#efad87')
    const head = ball('head', 'سر', point(0, 2.295), 0.19, 4, '#efad87')
    this.spherical(pelvis, abdomen, point(0, 1.30), [0.45, 0.5, 0.35], 16)
    this.spherical(abdomen, chest, point(0, 1.565), [0.4, 0.5, 0.35], 20)
    this.spherical(chest, neck, point(0, 1.99), [0.45, 0.55, 0.35], 70)
    this.spherical(neck, head, point(0, 2.12), [1.05, 0.8, 0.5], 50)

    for (const sign of [-1, 1]) {
      const side = sign === -1 ? 'right' : 'left'
      const label = sign === -1 ? 'راست' : 'چپ'
      const shoulder = ball(`${side}Shoulder`, `شانهٔ ${label}`, point(sign * 0.385, 1.91), 0.13, 1, '#234db2')
      const elbow = point(sign * 0.68, 1.48)
      const wrist = point(sign * 0.82, 1.12)
      const upperArm = limb(`${side}UpperArm`, `بازوی ${label}`, point(sign * 0.445, 1.86), elbow, 0.112, 2.3)
      const forearm = limb(`${side}Forearm`, `ساعد ${label}`, elbow, wrist, 0.087, 1.4)
      const hand = box(`${side}Hand`, `دست و مچ ${label}`, point(sign * 0.85, 0.995, 0.015), v(0.075, 0.10, 0.055), 0.6, '#efad87')
      this.spherical(chest, shoulder, point(sign * 0.30, 1.91), [2.8, 1.3, 1.5], 3)
      this.hinge(shoulder, upperArm, point(sign * 0.445, 1.86), v(0, 0, sign), -0.35, 1.65)
      this.hinge(upperArm, forearm, elbow, v(1, 0, 0), -2.5, 0.08)
      this.spherical(forearm, hand, wrist, [0.9, 0.55, 0.6], 2)

      const hip = point(sign * 0.17, 1.055)
      const knee = point(sign * 0.205, 0.60)
      const anklePoint = point(sign * 0.225, 0.15)
      const thigh = limb(`${side}Thigh`, `ران ${label}`, hip, knee, 0.135, 5.5)
      const shin = limb(`${side}Shin`, `ساق ${label}`, knee, anklePoint, 0.10, 3)
      const ankle = ball(`${side}Ankle`, `مچ پای ${label}`, anklePoint, 0.068, 0.45, '#bc2334')
      const foot = box(`${side}Foot`, `کف پای ${label}`, point(sign * 0.225, 0.015, 0.10), v(0.105, 0.09, 0.205), 0.9, '#bc2334')
      this.spherical(pelvis, thigh, hip, [1.55, 0.7, 0.75], 5)
      this.hinge(thigh, shin, knee, v(1, 0, 0), -0.05, 2.45)
      this.spherical(shin, ankle, anklePoint, [0.3, 0.45, 0.3], 2)
      this.hinge(ankle, foot, point(sign * 0.225, 0.10), v(1, 0, 0), -0.65, 0.75)
    }
    this.disposeAppearance = addHeroAppearance(this.parts, onAppearanceReady)
    this.legChains = ['left', 'right'].map(side => this.poseLinks.filter(({ child }) =>
      ['Thigh', 'Shin', 'Ankle', 'Foot'].some(limb => child.mesh.userData.partId === side + limb)))
    this.createCapeBodies()

    this.supportTarget = point(0, STAND_HEIGHT)
    this.seat = new THREE.Group()
    const seatMaterial = new THREE.MeshStandardMaterial({ color: '#67768a', roughness: 0.65 })
    const seatTop = new THREE.Mesh(new RoundedBoxGeometry(0.70, 0.08, 0.58, 2, 0.025), seatMaterial)
    seatTop.position.set(0, 0.43, -0.06)
    seatTop.castShadow = seatTop.receiveShadow = true
    this.seat.add(seatTop)
    this.seatBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setEnabled(false))
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.35, 0.04, 0.29).setTranslation(0, 0.43, -0.06).setFriction(0.8), this.seatBody)
    const legGeometry = new THREE.BoxGeometry(0.055, 0.51, 0.055)
    for (const x of [-0.27, 0.27]) {
      for (const z of [-0.28, 0.16]) {
        const leg = new THREE.Mesh(legGeometry, seatMaterial)
        leg.position.set(x, 0.135, z)
        leg.castShadow = true
        this.seat.add(leg)
        world.createCollider(RAPIER.ColliderDesc.cuboid(0.0275, 0.255, 0.0275).setTranslation(x, 0.135, z), this.seatBody)
      }
    }
    this.seat.visible = false
    scene.add(this.seat)
    this.setStanding(standing)
    this.sync()
  }

  private addPart(id: string, label: string, position: THREE.Vector3, geometry: THREE.BufferGeometry,
    collider: RAPIER.ColliderDesc, mass: number, color: string): Part {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z)
      .setLinearDamping(0.2).setAngularDamping(1.4).setCcdEnabled(true)
      .setAdditionalSolverIterations(1))
    this.world.createCollider(collider.setMass(mass).setFriction(0.8).setRestitution(0)
      .setCollisionGroups(BODY_GROUPS).setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL), body)
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.03 }))
    mesh.name = label
    mesh.userData.partId = id
    mesh.castShadow = mesh.receiveShadow = true
    this.scene.add(mesh)
    const moments = body.principalInertia()
    const part = {
      body, mesh, label,
      previousPosition: position.clone(),
      previousRotation: new THREE.Quaternion(),
      previousVelocity: new THREE.Vector3(),
      inertia: Math.min(moments.x, moments.y, moments.z),
      targetPosition: position.clone(), targetRotation: new THREE.Quaternion(),
    }
    this.parts.set(id, part)
    this.ownBodies.add(body.handle)
    this.meshes.push(mesh)
    return part
  }

  private local(part: Part, point: THREE.Vector3) {
    return point.clone().sub(part.body.translation()).applyQuaternion(new THREE.Quaternion().copy(part.body.rotation()).invert())
  }

  private spherical(parent: Part, child: Part, point: THREE.Vector3, limits: AngularJoint['limits'], stiffness: number) {
    const joint = this.world.createImpulseJoint(RAPIER.JointData.spherical(this.local(parent, point), this.local(child, point)),
      parent.body, child.body, true)
    joint.setContactsEnabled(false)
    // Rapier 0.21 may classify a spherical joint as Generic. Wrap the same handle
    // with its spherical API to configure the three angular motors safely.
    const motor = new RAPIER.SphericalImpulseJoint(this.world.impulseJoints.raw, this.world.bodies, joint.handle)
    const inertia = 1 / (1 / parent.inertia + 1 / child.inertia)
    for (const axis of [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngY, RAPIER.JointAxis.AngZ]) {
      motor.configureMotorModel(axis, RAPIER.MotorModel.ForceBased)
      motor.configureMotorPosition(axis, 0, stiffness, 2 * Math.sqrt(stiffness * inertia))
      motor.setMotorMaxForce(axis, 45)
    }
    this.poseLinks.push({ parent, child, anchor1: this.local(parent, point), anchor2: this.local(child, point) })
    const record = { parent, child, limits, inertia, motor, stiffness }
    this.angularJoints.push(record)
    this.ballMotors.set(child.mesh.userData.partId, record)
  }

  private hinge(parent: Part, child: Part, point: THREE.Vector3, axis: THREE.Vector3, min: number, max: number) {
    const joint = this.world.createImpulseJoint(RAPIER.JointData.revolute(this.local(parent, point), this.local(child, point), axis),
      parent.body, child.body, true) as RAPIER.RevoluteImpulseJoint
    joint.setContactsEnabled(false)
    joint.setLimits(min, max)
    joint.configureMotorPosition(0, 3, 1.2)
    joint.setMotorMaxForce(6)
    this.poseLinks.push({ parent, child, anchor1: this.local(parent, point), anchor2: this.local(child, point), axis })
    this.hinges.set(child.mesh.userData.partId, joint)
    this.hingeLimits.set(child.mesh.userData.partId, [min, max])
  }

  setMovement(x: number, z: number, running: boolean, sitting: boolean, y = 0) {
    if (this.released || this.recovery) return
    this.direction.set(x, y, z).clampLength(0, 1)
    this.running = running
    if (sitting !== this.sitting) this.standHeight = this.groundHeight + STAND_HEIGHT - .04
    this.sitting = sitting
  }

  setFlight(held: boolean, pitch: number, bank: number, groundHeight: number, descending = false) {
    const controlled = this.standing && !this.released && !this.recovery
    if (controlled && (held || descending)) this.heldSupportHeight = null
    this.ascentHeld = held && controlled
    this.descending = descending && controlled
    // Taking off latches flight; releasing Space holds altitude until C is held.
    this.flightHeld = controlled && (held || (this.airborne && !this.falling)) && !this.descending
    this.flightPitch = pitch
    this.flightBank = bank
    this.groundHeight = Math.max(groundHeight, this.heldSupportHeight ?? -Infinity)
    if (this.ascentHeld && !this.airborne) {
      this.airborne = true
      this.flightAge = 0
      this.flightBoost = 0
      this.verticalVelocity = 0
      this.animation.resetFeet()
      this.sitting = false
      this.sitBlend = 0
      this.seatVisible = this.seat.visible = false
      this.setSeatCollision(false)
    }
    if (this.ascentHeld) this.falling = false
  }

  setFlightAim(direction: THREE.Vector3, _forward: number, aiming = false) {
    this.viewDirection.copy(direction).normalize()
    this.aiming = aiming
  }

  get isAirborne() { return this.airborne }

  get viewHeading() { return this.heading }

  get flightState(): 'grounded' | 'flying' | 'landing' | 'released' | 'recovering' {
    if (this.released) return 'released'
    if (this.recovery) return 'recovering'
    return !this.airborne ? 'grounded' : this.flightHeld ? 'flying' : 'landing'
  }

  get isReleased() { return this.released }
  get isBreakingFlight() { return this.breakingFlight }
  copyFlightSegment(from: THREE.Vector3, to: THREE.Vector3) {
    if (!this.breakingFlight) return false
    from.copy(this.flightFrom); to.copy(this.flightTo)
    return true
  }
  configureFlightDestruction(contact: FlightContactHandler, filter: (collider: RAPIER.Collider) => boolean) {
    this.flightContact = contact; this.buildingCollider = filter
  }
  configureImpactPassThrough(filter: (collider: RAPIER.Collider, speed: number) => boolean) {
    this.impactPassThrough = filter
  }
  get isCollisionProtected() { return this.collisionProtected }
  get isRecovering() { return this.recovery !== null }

  setCollisionProtection(enabled: boolean) { this.collisionProtected = enabled && !this.released }
  get altitude() {
    return Math.max(0, this.parts.get('pelvis')!.body.translation().y - STAND_HEIGHT)
  }
  get speed() {
    return this.velocity.copy(this.parts.get('pelvis')!.body.linvel()).length()
  }

  renderFocus(target: THREE.Vector3) {
    target.copy(this.parts.get('pelvis')!.mesh.position)
    target.y += .17
    return target
  }

  controlFocus(target: THREE.Vector3) {
    if (this.released || this.recovery) {
      target.copy(this.parts.get('pelvis')!.body.translation())
      target.y += .17
      return target
    }
    return target.set(this.supportTarget.x, this.supportTarget.y + .17 - this.sitBlend * .45, this.supportTarget.z)
  }

  release() {
    if (this.released) return
    this.collisionProtected = false
    this.breakingFlight = false
    this.recovery = null
    this.setStanding(false)
    this.released = true
    this.configurePose(false)
    this.direction.set(0, 0, 0)
    this.sitting = false
    this.sitBlend = 0
    this.seatVisible = this.seat.visible = false
    this.setSeatCollision(false)
    // Keep the current momentum, but remove any remaining balance torque immediately.
    this.parts.forEach(({ body }) => body.resetTorques(true))
  }

  regainControl(preserveHeight = false) {
    if (!this.released) return
    const pelvis = this.parts.get('pelvis')!.body
    const chest = this.parts.get('chest')!.body
    const position = pelvis.translation()
    const momentum = this.velocity.copy(pelvis.linvel()).clone()
    const rotation = new THREE.Quaternion().copy(chest.rotation())
    const forward = v(0, 0, 1).applyQuaternion(rotation)
    const side = v(1, 0, 0).applyQuaternion(rotation)
    let distance = Infinity
    // Ignore downward exits when a fallen body overlaps a car or another obstacle.
    this.world.intersectionsWithRay(
      new RAPIER.Ray(v(position.x, position.y + .1, position.z), v(0, -1, 0)), 500, false,
      hit => {
        if (hit.normal.y > .65) distance = Math.min(distance, hit.timeOfImpact)
        return true
      }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, undefined, this.isGroundCollider)
    const physicalGround = Number.isFinite(distance) ? position.y + .1 - distance : this.groundHeight
    if (preserveHeight && this.heldSupportHeight === null
      && Number.isFinite(distance) && position.y - physicalGround < 1.6) {
      this.heldSupportHeight = physicalGround
    }
    const ground = Math.max(physicalGround,
      this.heldSupportHeight ?? -Infinity)
    this.groundHeight = ground
    const grounded = (Number.isFinite(distance) || this.heldSupportHeight !== null) && position.y - ground < 1.6
    if (Math.hypot(forward.x, forward.z) > .3) this.heading = Math.atan2(forward.x, forward.z)
    const style: GetUpStyle = Math.abs(side.y) > Math.abs(forward.y)
      ? (side.y < 0 ? 'left' : 'right') : (forward.y < 0 ? 'front' : 'back')
    this.released = false
    pelvis.setEnabledTranslations(true, true, true, true)
    this.setStanding(true, true)
    if (grounded) {
      this.recovery = { style, age: 0, duration: style === 'back' ? 3 : 2.6,
        height: position.y, rotation }
      this.torsoTarget.copy(rotation)
    } else {
      // Catch the body where it is, preserving travel and altitude in midair.
      this.airborne = true
      this.falling = true
      this.flightAge = 1
      this.moveVelocity.copy(momentum).setY(0)
      this.verticalVelocity = momentum.y
      this.torsoTarget.copy(rotation)
    }
  }

  private updateRecovery(dt: number) {
    const recovery = this.recovery!
    recovery.age += dt
    const t = Math.min(1, recovery.age / recovery.duration)
    this.animation.getUp(recovery.style, t)
    this.flightEuler.set(this.animation.pitch, this.heading, this.animation.roll, 'YXZ')
    this.flightRotation.setFromEuler(this.flightEuler)
    // Begin at the actual fallen orientation and height, then brace, kneel and rise.
    const engage = THREE.MathUtils.smoothstep(t, 0, .22)
    this.torsoTarget.copy(recovery.rotation).slerp(this.flightRotation, engage)
    this.supportTarget.y = THREE.MathUtils.lerp(recovery.height, this.groundHeight + this.animation.height, engage)
    this.applyLimbPose('left', this.animation.left)
    this.applyLimbPose('right', this.animation.right)
    this.applyHeadPose()
    if (t === 1) {
      this.recovery = null
      this.heldSupportHeight = null
      this.groundHeight = this.groundBelow(this.supportTarget, this.supportTarget.y + .1)
      this.standHeight = this.groundHeight + STAND_HEIGHT - .04
      this.animation.resetFeet()
    }
  }

  private updateFlight(dt: number) {
    this.flightAge += dt
    if (Math.hypot(this.viewDirection.x, this.viewDirection.z) > .001) {
      const heading = Math.atan2(this.viewDirection.x, this.viewDirection.z)
      const turn = Math.atan2(Math.sin(heading - this.heading), Math.cos(heading - this.heading))
      const rotation = THREE.MathUtils.clamp(turn, -7 * dt, 7 * dt)
      this.heading += rotation
      this.turnRate = THREE.MathUtils.damp(this.turnRate, rotation / dt, 6, dt)
    } else this.turnRate = THREE.MathUtils.damp(this.turnRate, 0, 6, dt)
    const boosting = this.running && this.direction.lengthSq() > .001 && !this.falling
    this.flightBoost = THREE.MathUtils.clamp(this.flightBoost
      + dt * (boosting ? 1 / FLIGHT_BOOST_DURATION : -1 / FLIGHT_BOOST_RELEASE_DURATION), 0, 1)
    // Ease in and out of acceleration instead of jumping straight to the 10x target.
    const speed = this.falling ? (this.running ? RUN_SPEED : 2.4)
      : 11 * THREE.MathUtils.lerp(1, 10, THREE.MathUtils.smootherstep(this.flightBoost, 0, 1))
    const travel = speed * THREE.MathUtils.smoothstep(this.flightAge, .05, .4)
    this.position.copy(this.direction).setY(0).multiplyScalar(travel)
    this.moveVelocity.lerp(this.position, 1 - Math.exp(-8 * dt))
    this.supportTarget.addScaledVector(this.moveVelocity, dt)
    const breaking = !!this.flightContact && !this.falling && Math.hypot(this.moveVelocity.length(), this.verticalVelocity) * 3.6 > 200
    this.groundHeight = this.groundBelow(this.supportTarget, this.supportTarget.y + .1, undefined, 500, breaking)
    const landing = this.groundHeight + STAND_HEIGHT - .04
    const clearance = Math.max(0, this.supportTarget.y - landing)
    const launch = this.flightHeld ? Math.sin(Math.PI * THREE.MathUtils.clamp(this.flightAge / .65, 0, 1)) : 0
    const vertical = this.direction.y * travel + (this.ascentHeld ? 6 : 0) - (this.descending ? 6 : 0)
      + (this.flightAge < .3 && !this.descending ? 3 : 0)
    // No gravity or residual vertical drift in controlled hover.
    this.verticalVelocity = this.falling ? this.verticalVelocity - 9.8 * dt
      : vertical === 0 ? 0 : THREE.MathUtils.damp(this.verticalVelocity, vertical, 10, dt)
    this.supportTarget.y = Math.max(landing, Math.min(300, this.supportTarget.y + this.verticalVelocity * dt))
    const approach = this.descending || this.falling || vertical < 0
      ? 1 - THREE.MathUtils.smoothstep(clearance, .2, 3.4) : 0
    const glide = THREE.MathUtils.smoothstep(this.moveVelocity.length(), 1, 9)
      * THREE.MathUtils.smoothstep(this.flightAge, .25, 1.05) * (1 - approach)
    this.flightBlend = THREE.MathUtils.damp(this.flightBlend, glide, 5, dt)
    // Bank follows the actual turn, with a smaller input-driven trim.
    const bank = THREE.MathUtils.clamp(-this.turnRate * .16 - this.flightBank * .08, -.5, .5) * this.flightBlend
    this.flightPitch = -Math.asin(THREE.MathUtils.clamp(this.viewDirection.y, -1, 1))
    // Measure travel in the view-facing frame, so diagonal and reverse inputs
    // blend their own poses instead of reusing the forward-flight silhouette.
    this.flightTravel.copy(this.moveVelocity).setY(0)
    if (this.flightTravel.lengthSq() > .001) this.flightTravel.normalize()
    else this.flightTravel.set(0, 0, 0)
    this.q1.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, -this.heading)
    this.flightTravel.applyQuaternion(this.q1)
    this.animation.fly(dt, this.falling ? 0 : this.flightBlend, this.flightPitch, bank, this.verticalVelocity,
      launch, this.falling ? 1 : approach, this.moveVelocity.length(), this.flightTravel.z, this.flightTravel.x,
      THREE.MathUtils.smootherstep(this.flightBoost, 0, 1))
    this.flightEuler.set(this.animation.pitch, this.heading, this.animation.roll, 'YXZ')
    this.flightRotation.setFromEuler(this.flightEuler)
    this.torsoTarget.copy(this.flightRotation)
    this.applyLimbPose('left', this.animation.left)
    this.applyLimbPose('right', this.animation.right)
    // Airborne head targets are calculated after the chest transform is known.
    if (!this.ascentHeld && this.verticalVelocity <= 0 && this.supportTarget.y <= landing + .01
      && this.parts.get('pelvis')!.body.translation().y < landing + .22) {
      this.airborne = false
      this.falling = false
      this.flightHeld = false
      this.flightBoost = 0
      this.emitImpact(this.contactPoint.set(this.supportTarget.x, this.groundHeight, this.supportTarget.z),
        THREE.Object3D.DEFAULT_UP, Math.abs(this.verticalVelocity))
      this.landingImpact = THREE.MathUtils.clamp(-this.verticalVelocity / 4.5, .15, 1)
      this.verticalVelocity = 0
      this.animation.resetFeet()
      this.standHeight = landing
      this.supportTarget.y = landing
    }
  }

  private configurePose(active: boolean) {
    if (this.poseActive === active) return
    this.poseActive = active
    this.ballTargets.clear()
    this.hingeTargets.clear()
    this.animation.resetFeet()
    if (!active) {
      for (const { motor } of this.angularJoints) {
        for (const axis of [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngY, RAPIER.JointAxis.AngZ]) {
          motor.configureMotor(axis, 0, 0, 0, 0)
          motor.setMotorMaxForce(axis, 0)
        }
      }
      for (const joint of this.hinges.values()) {
        joint.configureMotor(0, 0, 0, 0)
        joint.setMotorMaxForce(0)
      }
      return
    }
    // Restore the passive torso motors as well when enabling the active pose.
    for (const { motor, stiffness, inertia } of this.angularJoints) {
      for (const axis of [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngY, RAPIER.JointAxis.AngZ]) {
        motor.configureMotorPosition(axis, 0, stiffness, 2 * Math.sqrt(stiffness * inertia))
        motor.setMotorMaxForce(axis, 45)
      }
    }
    for (const side of ['left', 'right']) {
      for (const [part, stiffness, maxForce] of [['Thigh', 220, 110], ['Ankle', 40, 35], ['Shoulder', 45, 35], ['Hand', 8, 8]] as const) {
        const joint = this.ballMotors.get(`${side}${part}`)!
        for (const axis of [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngY, RAPIER.JointAxis.AngZ]) {
          joint.motor.configureMotorPosition(axis, 0, stiffness, 2 * Math.sqrt(stiffness * joint.inertia))
          joint.motor.setMotorMaxForce(axis, maxForce)
        }
      }
      for (const [part, stiffness, damping, maxForce] of [['Shin', 100, 4, 85], ['Foot', 60, 3, 35], ['Forearm', 24, 3, 20], ['UpperArm', 32, 3, 35]] as const) {
        const joint = this.hinges.get(`${side}${part}`)!
        joint.configureMotorModel(RAPIER.MotorModel.ForceBased)
        joint.configureMotorPosition(0, stiffness, damping)
        joint.setMotorMaxForce(maxForce)
      }
    }
  }

  private ballPose(id: string, angle: number, stiffness: number, yaw = 0, roll = 0, response = this.poseResponse) {
    const joint = this.ballMotors.get(id)!
    let previous = this.ballTargets.get(id)
    if (!previous) {
      previous = new THREE.Vector3()
      this.ballTargets.set(id, previous)
    }
    for (let i = 0; i < 3; i++) {
      const axis = i === 0 ? RAPIER.JointAxis.AngX : i === 1 ? RAPIER.JointAxis.AngY : RAPIER.JointAxis.AngZ
      const angleTarget = i === 0 ? angle : i === 1 ? yaw : roll
      const target = THREE.MathUtils.clamp(angleTarget, -joint.limits[i] * .95, joint.limits[i] * .95)
      const current = previous.getComponent(i)
      const next = THREE.MathUtils.damp(current, target, response, this.poseDt)
      joint.motor.configureMotor(axis, next, THREE.MathUtils.clamp((next - current) / this.poseDt, -8, 8),
        stiffness, 2 * Math.sqrt(stiffness * joint.inertia))
      previous.setComponent(i, next)
    }
  }

  private hingePose(id: string, angle: number, stiffness: number, damping: number) {
    const limits = this.hingeLimits.get(id)!
    const current = this.hingeTargets.get(id) ?? 0
    const target = THREE.MathUtils.clamp(angle, limits[0], limits[1])
    const next = THREE.MathUtils.damp(current, target, this.poseResponse, this.poseDt)
    this.hinges.get(id)!.configureMotor(next, THREE.MathUtils.clamp((next - current) / this.poseDt, -8, 8), stiffness, damping)
    this.hingeTargets.set(id, next)
  }

  private applyLimbPose(side: 'left' | 'right', pose: LimbPose, sitting = 0) {
    this.ballPose(`${side}Thigh`, THREE.MathUtils.lerp(pose.hip, -1.45, sitting), 220, 0, pose.hipRoll * (1 - sitting))
    this.ballPose(`${side}Ankle`, pose.ankle * (1 - sitting), 40, 0, pose.ankleRoll * (1 - sitting))
    this.ballPose(`${side}Shoulder`, THREE.MathUtils.lerp(pose.shoulder, -.25, sitting), 45, 0, pose.shoulderRoll * (1 - sitting))
    this.ballPose(`${side}Hand`, pose.wrist * (1 - sitting), 8)
    this.hingePose(`${side}UpperArm`, THREE.MathUtils.lerp(pose.upperArm, -.12, sitting), 32, 3)
    this.hingePose(`${side}Shin`, THREE.MathUtils.lerp(pose.knee, 1.5, sitting), 100, 4)
    this.hingePose(`${side}Foot`, pose.foot * (1 - sitting), 60, 3)
    this.hingePose(`${side}Forearm`, THREE.MathUtils.lerp(pose.elbow, -.85, sitting), 24, 3)
  }

  private applyHeadPose(chestRotation?: THREE.Quaternion) {
    if (this.airborne && chestRotation) {
      const yaw = Math.hypot(this.viewDirection.x, this.viewDirection.z) > .001
        ? Math.atan2(this.viewDirection.x, this.viewDirection.z) : this.heading
      const pitch = -Math.asin(THREE.MathUtils.clamp(this.viewDirection.y, -1, 1))
      this.headEuler.set(pitch, yaw, 0, 'YXZ')
      this.headAim.setFromEuler(this.headEuler).premultiply(this.q2.copy(chestRotation).invert())
      // Split the complete relative rotation across neck and head. This also
      // cancels body bank and twist, keeping the eyes level with camera aim.
      for (const [id, share, stiffness] of [['neck', .32, 70], ['head', .68, 50]] as const) {
        this.headShare.identity().slerp(this.headAim, share)
        this.headEuler.setFromQuaternion(this.headShare, 'XYZ')
        // The body is already smoothed. Counter-rotation must follow it in the
        // same frame, otherwise the eyes drift off target during direction changes.
        this.ballPose(id, this.headEuler.x, stiffness, this.headEuler.y, this.headEuler.z, Infinity)
      }
      return
    }
    if (this.airborne || this.aiming) {
      const pitch = -Math.asin(THREE.MathUtils.clamp(this.viewDirection.y, -1, 1)) - this.animation.pitch
      const yaw = Math.atan2(this.viewDirection.x, this.viewDirection.z) - this.heading
      const turn = Math.atan2(Math.sin(yaw), Math.cos(yaw))
      this.ballPose('neck', pitch * .32, 70, turn * .4)
      this.ballPose('head', pitch * .68, 50, turn * .6)
    } else {
      this.ballPose('neck', this.animation.neck * (1 - this.sitBlend), 70)
      this.ballPose('head', this.animation.head * (1 - this.sitBlend), 50)
    }
  }

  private sampleGround = (position: THREE.Vector3, normal: THREE.Vector3) => {
    return this.groundBelow(position, this.groundHeight + .55, normal, 1.1)
  }

  private groundBelow(position: THREE.Vector3, ceiling: number, normal?: THREE.Vector3, distance = 500, ignoreBuildings = false) {
    this.groundRay.origin.x = position.x
    this.groundRay.origin.y = ceiling
    this.groundRay.origin.z = position.z
    let nearest = Infinity
    normal?.set(0, 1, 0)
    // Ignore downward exits when the ray starts inside a wall or rooftop fixture.
    this.world.intersectionsWithRay(this.groundRay, distance, false, hit => {
      if (hit.normal.y > .65 && hit.timeOfImpact < nearest) {
        nearest = hit.timeOfImpact
        normal?.copy(hit.normal)
      }
      return true
    }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, undefined, ignoreBuildings ? this.isFlightGroundCollider : this.isGroundCollider)
    return Math.max(Number.isFinite(nearest) ? ceiling - nearest : this.groundHeight, this.heldSupportHeight ?? -Infinity)
  }

  private isGroundCollider = (collider: RAPIER.Collider) => {
    if (!((collider.collisionGroups() >>> 16) & 1)) return false
    const parent = collider.parent()
    return !parent || (!this.ownBodies.has(parent.handle) && parent.handle !== this.seatBody.handle)
  }
  private isFlightGroundCollider = (collider: RAPIER.Collider) => this.isGroundCollider(collider) && !this.buildingCollider?.(collider)

  private setSeatCollision(enabled: boolean) {
    if (enabled === this.seatColliding) return
    this.seatColliding = enabled
    this.seatBody.setEnabled(enabled)
  }

  private updatePose(dt: number) {
    this.poseDt = dt
    this.poseResponse = this.falling ? 96 : this.airborne || this.recovery ? 14 : this.running ? 96 : 22
    const active = this.standing
    this.configurePose(active)
    if (!active) {
      this.moveVelocity.multiplyScalar(Math.exp(-12 * dt))
      return
    }
    if (this.recovery) {
      this.updateRecovery(dt)
      return
    }
    if (this.airborne) {
      this.updateFlight(dt)
      return
    }
    if (this.sitting && !this.seatVisible) {
      this.seatVisible = true
      this.moveVelocity.set(0, 0, 0)
      this.seat.position.set(this.supportTarget.x, this.groundHeight - .04, this.supportTarget.z)
      this.seat.quaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, this.heading)
      this.seatBody.setTranslation(this.seat.position, true)
      this.seatBody.setRotation(this.seat.quaternion, true)
      this.setSeatCollision(false)
    }
    this.sitBlend = THREE.MathUtils.damp(this.sitBlend, this.sitting ? 1 : 0, 5, dt)
    if (this.seatVisible) {
      // Fold the legs before inserting a solid seat beneath them.
      this.seat.visible = this.sitting ? this.sitBlend > 0.65 : this.sitBlend > 0.45
      this.setSeatCollision(this.sitting ? this.sitBlend > 0.9 : this.sitBlend > 0.45)
    }
    if (!this.sitting && this.sitBlend < 0.45 && this.seatVisible) {
      this.seatVisible = false
      this.seat.visible = false
      this.setSeatCollision(false)
    }
    const hasDirection = this.direction.lengthSq() > 0.001 && !this.sitting && this.sitBlend < 0.12
    if (hasDirection || this.aiming) {
      this.standHeight = this.groundHeight + STAND_HEIGHT - .04
      // Keep facing the view so backward and lateral inputs produce actual
      // backsteps and strafing instead of turning every input into a run.
      const targetHeading = Math.hypot(this.viewDirection.x, this.viewDirection.z) > .001
        ? Math.atan2(this.viewDirection.x, this.viewDirection.z) : this.heading
      const difference = Math.atan2(Math.sin(targetHeading - this.heading), Math.cos(targetHeading - this.heading))
      const rotation = THREE.MathUtils.clamp(difference, -3.8 * dt, 3.8 * dt)
      this.heading += rotation
      this.turnRate = THREE.MathUtils.damp(this.turnRate, rotation / dt, 8, dt)
    } else this.turnRate = THREE.MathUtils.damp(this.turnRate, 0, 8, dt)
    const speed = this.running ? RUN_SPEED : 2.4
    this.position.copy(this.direction).multiplyScalar(hasDirection ? speed : 0)
    this.moveVelocity.lerp(this.position, 1 - Math.exp(-8 * dt))
    this.supportTarget.addScaledVector(this.moveVelocity, dt)
    // Sample at the new position every physics step, including while idle.
    this.groundHeight = this.groundBelow(this.supportTarget, this.supportTarget.y - .6)
    // Retain support while a planted sole still overlaps the ledge. Starting the
    // fall at the pelvis center can drag a trailing boot through the roof edge.
    for (const [index, side] of ['left', 'right'].entries()) {
      if (this.animation.feet[index].swinging) continue
      const foot = this.parts.get(`${side}Foot`)!.body
      this.q1.copy(foot.rotation())
      for (const x of [-.1, .1]) for (const z of [-.205, .205]) {
        this.position.set(x, 0, z).applyQuaternion(this.q1).add(foot.translation())
        const height = this.groundBelow(this.position, this.supportTarget.y - .6)
        if (Math.abs(this.supportTarget.y - (height + STAND_HEIGHT - .04)) < .55) {
          this.groundHeight = Math.max(this.groundHeight, height)
        }
      }
    }
    this.standHeight = this.groundHeight + STAND_HEIGHT - .04
    if (this.supportTarget.y - this.standHeight > .55 && this.sitBlend < .12) {
      this.airborne = this.falling = true
      this.flightHeld = false
      this.flightAge = 1
      this.verticalVelocity = 0
      this.animation.resetFeet()
      return
    }
    // Keep both legs within reach when straddling a ridge or a side slope.
    let support = this.groundHeight
    for (const side of [-1, 1]) {
      this.position.set(side * .225 * Math.cos(this.heading), 0, -side * .225 * Math.sin(this.heading))
        .add(this.supportTarget)
      const height = this.sampleGround(this.position, this.contactNormal)
      if (this.groundHeight - height < .45) support = Math.min(support, height)
    }
    this.standHeight = support + STAND_HEIGHT - .04
    const pelvis = this.parts.get('pelvis')!.body
    this.pelvisPosition.copy(pelvis.translation())
    this.pelvisRotation.copy(pelvis.rotation())
    this.measuredVelocity.copy(this.moveVelocity)
    if (this.sitBlend > .12) this.measuredVelocity.set(0, 0, 0)
    this.landingImpact = THREE.MathUtils.damp(this.landingImpact, 0, 7, dt)
    this.animation.walk(dt, this.pelvisPosition, this.pelvisRotation, this.heading,
      this.measuredVelocity, this.running, this.turnRate, this.landingImpact, this.sampleGround, this.footContacts)
    const lowerBlend = THREE.MathUtils.smoothstep(this.sitBlend, .65, .98)
    const poseBlend = THREE.MathUtils.smoothstep(this.sitBlend, 0, .70)
    this.flightEuler.set(THREE.MathUtils.lerp(this.animation.pitch, .04, poseBlend), this.heading,
      this.animation.roll * (1 - poseBlend), 'YXZ')
    this.torsoTarget.setFromEuler(this.flightEuler)
    this.applyLimbPose('left', this.animation.left, poseBlend)
    this.applyLimbPose('right', this.animation.right, poseBlend)
    this.applyHeadPose()
    const height = THREE.MathUtils.lerp(this.standHeight + this.animation.height, this.groundHeight + .68, lowerBlend)
    this.supportTarget.y = THREE.MathUtils.damp(this.supportTarget.y, height, 8, dt)
  }

  setStanding(enabled: boolean, preserveHeight = false) {
    if (!enabled && this.heldSupportHeight !== null) {
      this.heldSupportHeight = null
      this.parts.get('pelvis')!.body.setEnabledTranslations(true, true, true, true)
    }
    if (this.released && enabled) return
    if (enabled === this.standing) return
    this.standing = enabled
    this.protection = this.protectionHold = this.protectionSide = 0
    this.airborne = this.falling = this.flightHeld = this.ascentHeld = this.descending = false
    this.flightBlend = this.verticalVelocity = this.landingImpact = this.turnRate = 0
    this.flightBoost = 0
    this.moveVelocity.set(0, 0, 0)
    this.animation.resetFeet()
    this.parts.forEach(({ body }) => {
      body.setBodyType(enabled ? RAPIER.RigidBodyType.KinematicPositionBased : RAPIER.RigidBodyType.Dynamic, true)
      body.resetForces(false)
      body.resetTorques(false)
    })
    if (enabled) {
      this.seatVisible = false
      this.seat.visible = false
      this.setSeatCollision(false)
      const pelvis = this.parts.get('pelvis')!
      // Re-enable at the current location without teleporting a fallen body.
      this.supportTarget.copy(pelvis.body.translation())
      this.standHeight = this.groundHeight + STAND_HEIGHT - .04
      if (!preserveHeight) this.supportTarget.y = this.standHeight
    }
    this.parts.forEach(({ body }) => body.wakeUp())
  }

  private createCapeBodies() {
    for (const [id, { body }] of this.parts) {
      const position = body.translation()
      const proxy = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(position.x, position.y, position.z))
      this.ownBodies.add(proxy.handle)
      this.capeBodies.set(id, proxy)
      for (let i = 0; i < body.numColliders(); i++) {
        const collider = body.collider(i)
        const local = collider.translationWrtParent()!
        this.world.createCollider(new RAPIER.ColliderDesc(collider.shape)
          .setTranslation(local.x, local.y, local.z)
          .setRotation(collider.rotationWrtParent()!).setFriction(.8).setMass(0)
          .setCollisionGroups(id.endsWith('Shoulder') ? COLLAR_PROXY_GROUPS : CAPE_PROXY_GROUPS), proxy)
      }
    }
  }

  private animateBodies() {
    const pelvis = this.parts.get('pelvis')!
    pelvis.targetPosition.copy(this.supportTarget)
    this.q1.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, -this.animation.twist)
    pelvis.targetRotation.copy(this.torsoTarget).multiply(this.q1)
    // Links are constructed from torso to fingertips/toes, in parent-first order.
    for (const link of this.poseLinks) {
      if (this.airborne && link.child.mesh.userData.partId === 'neck') this.applyHeadPose(link.parent.targetRotation)
      this.animateLink(link)
    }
    if (!this.airborne && !this.recovery && this.sitBlend < .12) this.plantFeet()
  }

  private animateLink({ parent, child, anchor1, anchor2, axis }: PoseLink) {
    const id = child.mesh.userData.partId as string
    if (axis) this.q1.setFromAxisAngle(axis, this.hingeTargets.get(id) ?? 0)
    else {
      const angles = this.ballTargets.get(id)
      this.flightEuler.set(angles?.x ?? 0,
        (angles?.y ?? 0) + (id === 'abdomen' || id === 'chest' ? this.animation.twist : 0), angles?.z ?? 0, 'XYZ')
      this.q1.setFromEuler(this.flightEuler)
    }
    child.targetRotation.copy(parent.targetRotation).multiply(this.q1)
    child.targetPosition.copy(anchor1).applyQuaternion(parent.targetRotation).add(parent.targetPosition)
      .sub(this.position.copy(anchor2).applyQuaternion(child.targetRotation))
  }

  private plantFeet() {
    for (let i = 0; i < this.legChains.length; i++) {
      if (this.animation.feet[i].swinging) continue
      const chain = this.legChains[i]
      const thigh = chain[0].child.mesh.userData.partId as string
      const shin = chain[1].child.mesh.userData.partId as string
      const ankle = chain[2].child.mesh.userData.partId as string
      const foot = chain[3].child
      const footId = foot.mesh.userData.partId as string
      const sole = foot.mesh.getObjectByName('boot-sole') as THREE.Mesh
      const vertices = sole.geometry.getAttribute('position')
      const hipTarget = this.ballTargets.get(thigh)!
      const ankleTarget = this.ballTargets.get(ankle)!
      let hip = hipTarget.x, knee = this.hingeTargets.get(shin) ?? 0
      const solePitch = hip + knee + ankleTarget.x + (this.hingeTargets.get(footId) ?? 0)
      const pose = (h: number, k: number) => {
        hipTarget.x = h
        this.hingeTargets.set(shin, k)
        const pitch = solePitch - h - k
        ankleTarget.x = THREE.MathUtils.clamp(pitch * .35, -.3, .3)
        this.hingeTargets.set(footId, THREE.MathUtils.clamp(pitch - ankleTarget.x, -.65, .75))
        for (const link of chain) this.animateLink(link)
      }
      // Resolve the final sole against the support plane after torso motion and
      // joint smoothing. Adjust the leg joints so the whole chain stays connected.
      for (let iteration = 0; iteration < 10; iteration++) {
        const height = this.sampleGround(foot.targetPosition, this.contactNormal)
        const surfaceX = foot.targetPosition.x, surfaceZ = foot.targetPosition.z
        const clearance = () => {
          this.inverseRotation.copy(foot.targetRotation).invert()
          this.rotation.copy(this.contactNormal).applyQuaternion(this.inverseRotation)
          let minimum = Infinity
          for (let vertex = 0; vertex < vertices.count; vertex++) {
            const projection = (vertices.getX(vertex) + sole.position.x) * this.rotation.x
              + (vertices.getY(vertex) + sole.position.y) * this.rotation.y
              + (vertices.getZ(vertex) + sole.position.z) * this.rotation.z
            minimum = Math.min(minimum, projection)
          }
          return (minimum + (foot.targetPosition.y - height) * this.contactNormal.y
            + (foot.targetPosition.x - surfaceX) * this.contactNormal.x
            + (foot.targetPosition.z - surfaceZ) * this.contactNormal.z) / this.contactNormal.y
        }
        const gap = clearance() - .002
        if (Math.abs(gap) < .003) break
        pose(hip + .005, knee)
        const hipGradient = (clearance() - .002 - gap) / .005
        pose(hip, knee + .005)
        const kneeGradient = (clearance() - .002 - gap) / .005
        const correction = -gap / (hipGradient ** 2 + kneeGradient ** 2 + .0001)
        hip = THREE.MathUtils.clamp(hip + THREE.MathUtils.clamp(correction * hipGradient, -.15, .15), -1.55, 1.55)
        knee = THREE.MathUtils.clamp(knee + THREE.MathUtils.clamp(correction * kneeGradient, -.15, .15), 0, 2.45)
        pose(hip, knee)
      }
    }
  }

  private isSupportContact(normal: RAPIER.Vector) {
    // Ordinary foot support and a controlled landing must not count as crashes.
    return normal.y > .65 && (!this.airborne || !this.flightHeld || this.flightAge < .3
      || (!this.ascentHeld && this.verticalVelocity <= 0))
  }

  private isFootSupport(surface: RAPIER.Collider, foot: RAPIER.Collider) {
    const position = foot.translation()
    if (position.y > this.groundHeight + .45) return false
    this.groundRay.origin.x = position.x
    this.groundRay.origin.y = position.y + .1
    this.groundRay.origin.z = position.z
    const hit = surface.castRayAndGetNormal(this.groundRay, .65, true)
    return !!hit && this.isSupportContact(hit.normal)
      && Math.abs(this.groundRay.origin.y - hit.timeOfImpact - this.groundHeight) < .08
  }

  private isLowerLeg(id: string) { return id.endsWith('Foot') || id.endsWith('Ankle') || id.endsWith('Shin') }

  private isWalkableStep(surface: RAPIER.Collider, point: THREE.Vector3Like, normal: THREE.Vector3Like) {
    if (!this.standing || this.released || this.airborne) return false
    // A low contact alone is not enough: a tall wall can also touch a boot.
    // Confirm a reachable upward-facing top just inside the contacted surface.
    const base = this.groundHeight
    if (point.y > base + MAX_STEP_HEIGHT + .03) return false
    const parent = surface.parent()
    if (parent && !parent.isFixed()) return false
    this.groundRay.origin.x = point.x - normal.x * .03
    this.groundRay.origin.y = base + MAX_STEP_HEIGHT + .03
    this.groundRay.origin.z = point.z - normal.z * .03
    const hit = surface.castRayAndGetNormal(this.groundRay, MAX_STEP_HEIGHT + .13, false)
    return !!hit && hit.normal.y > .65
  }

  private sweepForImpact(dt: number) {
    for (const [id, { body, targetPosition }] of this.parts) {
      this.velocity.copy(targetPosition).sub(body.translation()).divideScalar(dt)
      if (this.velocity.lengthSq() < 1e-6) continue
      for (let i = 0; i < body.numColliders(); i++) {
        const collider = body.collider(i)
        const hit = this.world.castShape(collider.translation(), collider.rotation(), this.velocity,
          collider.shape, 0, dt, false, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
          undefined, undefined, undefined, other => {
            if (!this.isGroundCollider(other)) return false
            if (this.breakingFlight && this.buildingCollider?.(other)) return false
            this.impactVelocity.copy(this.velocity)
            const obstacle = other.parent()
            if (obstacle) this.impactVelocity.sub(obstacle.velocityAtPoint(collider.translation()))
            if (this.impactPassThrough?.(other, Math.max(this.impactVelocity.length(),
              Math.hypot(this.moveVelocity.length(), this.verticalVelocity)))) return false
            if (id.endsWith('Foot') && this.isFootSupport(other, collider)) return false
            // An initially penetrating sole can give a degenerate sweep normal.
            // Use its existing contact normal to exclude ordinary support first.
            const contact = other.contactCollider(collider, .01)
            return !contact || !this.isSupportContact(contact.normal1)
          })
        if (hit && !this.isSupportContact(hit.normal1)
          && !(this.isLowerLeg(id) && this.isWalkableStep(hit.collider, hit.witness1, hit.normal1))) {
          this.contactNormal.copy(hit.normal1)
          this.impactVelocity.copy(this.velocity)
          const obstacle = hit.collider.parent()
          if (obstacle) this.impactVelocity.sub(obstacle.velocityAtPoint(hit.witness1))
          this.emitImpact(hit.witness1, hit.normal1, Math.max(0, -this.impactVelocity.dot(this.contactNormal)))
          return true
        }
      }
    }
    return false
  }

  private sweepForDestructiveContacts(dt: number, onContact: ContactHandler, filter: (collider: RAPIER.Collider) => boolean) {
    for (const [id, { body, targetPosition }] of this.parts) {
      this.velocity.copy(targetPosition).sub(body.translation()).divideScalar(dt)
      if (this.velocity.lengthSq() < 1e-6) continue
      for (let i = 0; i < body.numColliders(); i++) {
        const collider = body.collider(i)
        const hit = this.world.castShape(collider.translation(), collider.rotation(), this.velocity,
          collider.shape, 0, dt, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
          undefined, undefined, undefined, other => this.isGroundCollider(other) && filter(other))
        if (hit && !this.isSupportContact(hit.normal1)
          && !(id.endsWith('Foot') && this.isFootSupport(hit.collider, collider))
          && !(this.isLowerLeg(id) && this.isWalkableStep(hit.collider, hit.witness1, hit.normal1))) {
          this.impactVelocity.copy(this.velocity)
          const obstacle = hit.collider.parent()
          if (obstacle) this.impactVelocity.sub(obstacle.velocityAtPoint(hit.witness1))
          onContact(hit.collider, hit.witness1, hit.normal1, this.impactVelocity.length())
        }
      }
    }
  }

  private sweepForFlightDestruction(dt: number) {
    const pelvis = this.parts.get('pelvis')!
    const from = pelvis.body.translation(), to = pelvis.targetPosition
    this.velocity.copy(to).sub(from).divideScalar(dt)
    const speed = this.velocity.length()
    this.breakingFlight = !!this.flightContact && this.airborne && !this.falling && !this.recovery && speed * 3.6 > 200
    if (!this.breakingFlight) return
    this.flightFrom.copy(from); this.flightTo.copy(to)
    this.flightSweepHits.clear()
    // Sweep the body's envelope once per surface, catching thin walls at boost speed.
    for (let i = 0; i < 12; i++) {
      const hit = this.world.castShape(from, pelvis.body.rotation(), this.velocity, this.flightSweepShape,
        0, dt, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, undefined,
        collider => !this.flightSweepHits.has(collider.handle) && !!this.buildingCollider?.(collider))
      if (!hit) break
      this.flightSweepHits.add(hit.collider.handle)
      this.flightContact!(hit.collider, from, to, hit.normal1, speed)
    }
  }

  // Run after world.step as well: a moving car can hit an idle character.
  checkForImpact(onContact?: ContactHandler) {
    const canRelease = this.standing && !this.released && !this.recovery && !this.collisionProtected
    let impact = false
    let strongest = 0
    this.supported = false
    for (const [id, { body, previousVelocity }] of this.parts) {
      for (let i = 0; i < body.numColliders(); i++) {
        const collider = body.collider(i)
        this.world.contactPairsWith(collider, other => {
          if (!this.isGroundCollider(other)) return
          if (this.breakingFlight && this.buildingCollider?.(other)) return
          const footSupport = id.endsWith('Foot') && this.isFootSupport(other, collider)
          this.world.contactPair(collider, other, (manifold, flipped) => {
            this.contactNormal.copy(manifold.normal()).multiplyScalar(flipped ? 1 : -1)
            for (let j = 0; j < manifold.numContacts(); j++) {
              if (manifold.contactDist(j) > .01) continue
              if (this.contactNormal.y > .5) this.supported = true
              const local = flipped ? manifold.localContactPoint2(j) : manifold.localContactPoint1(j)
              if (!local) continue
              this.contactPoint.copy(local).applyQuaternion(this.q1.copy(collider.rotation())).add(collider.translation())
              const walkable = footSupport || this.isSupportContact(this.contactNormal)
                || (this.isLowerLeg(id) && this.isWalkableStep(other, this.contactPoint, this.contactNormal))
              if (walkable) continue
              if (onContact && manifold.contactDist(j) <= .001) {
                const surface = flipped ? manifold.localContactPoint1(j) : manifold.localContactPoint2(j)
                if (surface) {
                  const point = new THREE.Vector3().copy(surface).applyQuaternion(new THREE.Quaternion().copy(other.rotation())).add(other.translation())
                  this.impactVelocity.copy(previousVelocity)
                  const obstacle = other.parent()
                  if (obstacle) this.impactVelocity.sub(obstacle.velocityAtPoint(point))
                  onContact(other, point, this.contactNormal, this.impactVelocity.length())
                }
              }
              this.impactVelocity.copy(previousVelocity)
              const obstacle = other.parent()
              if (obstacle) this.impactVelocity.sub(obstacle.velocityAtPoint(this.contactPoint))
              // Destruction still receives the contact, but a breakable prop cannot knock
              // the controlled hero down above its destruction threshold (including rubble).
              if (this.impactPassThrough?.(other, Math.max(this.impactVelocity.length(),
                Math.hypot(this.moveVelocity.length(), this.verticalVelocity)))) continue
              if (canRelease && manifold.contactDist(j) <= .001) impact = true
              const speed = Math.max(0, -this.impactVelocity.dot(this.contactNormal))
              if (speed > strongest) {
                strongest = speed
                this.impactPoint.copy(this.contactPoint)
                this.impactNormal.copy(this.contactNormal)
              }
            }
          })
        })
      }
    }
    if (canRelease && impact) this.release()
    if (strongest >= 1.4) {
      if (!this.standing) this.braceForImpact(this.impactNormal, strongest)
      this.emitImpact(this.impactPoint, this.impactNormal, strongest)
    } else if (canRelease && impact) this.protectionHold = .45
  }

  private braceForImpact(normal: THREE.Vector3Like, speed: number) {
    this.protectionHold = Math.max(this.protectionHold, THREE.MathUtils.clamp(speed * .045, .3, .85))
    // The normal points away from the obstacle. Choose the exposed side in the
    // chest's frame; this works while tumbling and for impacts from moving cars.
    this.inverseRotation.copy(this.parts.get('chest')!.body.rotation()).invert()
    this.contactNormal.copy(normal).negate().applyQuaternion(this.inverseRotation)
    this.protectionSide = THREE.MathUtils.clamp(this.contactNormal.x * 1.6, -1, 1)
  }

  private updateProtection(dt: number) {
    const pelvis = this.parts.get('pelvis')!.body
    this.protectionHold = Math.max(0, this.protectionHold - dt)
    const speed = this.velocity.copy(pelvis.linvel()).length()
    // Anticipate a surface for a quarter second along the actual trajectory.
    // Ignore body/cape copies and sensors, just as the collision release does.
    if (speed > 1.5) {
      this.protectionRay.origin = this.parts.get('chest')!.body.translation()
      this.protectionRay.dir = this.velocity.multiplyScalar(1 / speed)
      const hit = this.world.castRayAndGetNormal(this.protectionRay, speed * .28 + .3, true,
        RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, undefined, this.isGroundCollider)
      if (hit) this.braceForImpact(hit.normal, speed)
    }
    const falling = !this.supported && pelvis.linvel().y < -.8
    const target = this.protectionHold > 0 ? 1 : falling ? .72 : 0
    this.protection = THREE.MathUtils.damp(this.protection, target, target > this.protection ? 13 : 3.2, dt)
    const strength = this.protection < .015 ? 0 : this.protection
    const musclePower = strength * PROTECTION_POWER
    // Finite joint torques only: never balance, teleport or brake the root.
    // Opposing muscle forces preserve the body's linear impact momentum.
    const ball = (id: string, x: number, y: number, z: number, spring: number, maxForce: number) => {
      const joint = this.ballMotors.get(id)!
      const angles = [x, y, z]
      for (let i = 0; i < 3; i++) {
        angles[i] = THREE.MathUtils.clamp(angles[i], -joint.limits[i] * .9, joint.limits[i] * .9)
      }
      // A single quaternion spring avoids competing Euler-axis motors at the
      // large shoulder angles needed to bring the fists beside the temples.
      this.flightEuler.set(angles[0], angles[1], angles[2], 'XYZ')
      this.q1.copy(joint.parent.body.rotation())
      this.q2.setFromEuler(this.flightEuler).premultiply(this.q1)
      this.inverseRotation.copy(joint.child.body.rotation()).invert()
      this.q2.multiply(this.inverseRotation).normalize()
      if (this.q2.w < 0) this.q2.set(-this.q2.x, -this.q2.y, -this.q2.z, -this.q2.w)
      const sine = Math.hypot(this.q2.x, this.q2.y, this.q2.z)
      const angle = sine > 1e-6 ? 2 * Math.atan2(sine, this.q2.w) / sine : 2
      this.rotation.set(this.q2.x, this.q2.y, this.q2.z).multiplyScalar(angle)
      const stiffness = spring * musclePower
      const damping = 2 * Math.sqrt(stiffness * joint.inertia)
      this.velocity.copy(joint.child.body.angvel()).sub(this.position.copy(joint.parent.body.angvel()))
      this.torque.copy(this.rotation).multiplyScalar(stiffness).addScaledVector(this.velocity, -damping)
        .divideScalar(1 + damping * dt / joint.inertia + stiffness * dt * dt / joint.inertia)
        .clampLength(0, maxForce * musclePower)
      if (strength) {
        joint.child.body.addTorque(this.torque, true)
        joint.parent.body.addTorque(this.torque.multiplyScalar(-1), true)
      }
    }
    const hinge = (id: string, angle: number, spring: number, maxForce: number) => {
      const joint = this.hinges.get(id)!
      const limits = this.hingeLimits.get(id)!
      joint.configureMotorModel(RAPIER.MotorModel.ForceBased)
      joint.configureMotorPosition(THREE.MathUtils.clamp(angle, limits[0], limits[1]), spring * musclePower,
        1.6 * strength * Math.sqrt(PROTECTION_POWER))
      joint.setMotorMaxForce(maxForce * musclePower)
    }
    ball('abdomen', .20, 0, -.05 * this.protectionSide, 34, 12)
    ball('chest', .16, 0, -.08 * this.protectionSide, 38, 14)
    ball('neck', .16, 0, 0, 18, 5)
    ball('head', .32, -.12 * this.protectionSide, 0, 20, 5)
    for (const sign of [-1, 1]) {
      const side = sign < 0 ? 'right' : 'left'
      const exposed = .5 + .5 * sign * this.protectionSide
      // Forearms shield the temples and jaw; elbows close over the ribs.
      ball(`${side}Shoulder`, -1.70 - .20 * exposed, -sign * .80, -sign * .85, 48, 16)
      hinge(`${side}UpperArm`, -.28, 26, 10)
      hinge(`${side}Forearm`, -2.35 + .10 * exposed, 28, 10)
      ball(`${side}Hand`, -.12, 0, 0, 5, 2)
      ball(`${side}Thigh`, -.48 - .15 * exposed, 0, sign * .10, 34, 15)
      hinge(`${side}Shin`, 1.05 + .2 * exposed, 30, 13)
      ball(`${side}Ankle`, .06, 0, 0, 6, 3)
      hinge(`${side}Foot`, -.12, 8, 3)
    }
  }

  private emitImpact(point: THREE.Vector3Like, normal: THREE.Vector3Like, speed: number) {
    if (speed < 1.4) return
    // Several limbs can hit the same patch in one collision; emit one cloud there.
    if (this.impactTime - this.lastImpactTime < .16 && this.lastImpactPosition.distanceToSquared(point) < 2.25) return
    this.lastImpactTime = this.impactTime
    this.lastImpactPosition.copy(point)
    this.onImpact(point, normal, speed)
  }

  private enforceJointLimits(dt: number) {
    for (const { parent, child, limits, inertia } of this.angularJoints) {
      this.q1.copy(parent.body.rotation())
      this.inverseRotation.copy(this.q1).invert()
      this.q2.copy(child.body.rotation()).premultiply(this.inverseRotation).normalize()
      if (this.q2.w < 0) this.q2.set(-this.q2.x, -this.q2.y, -this.q2.z, -this.q2.w)
      const sine = Math.hypot(this.q2.x, this.q2.y, this.q2.z)
      const scale = sine > 1e-6 ? 2 * Math.atan2(sine, this.q2.w) / sine : 2
      this.rotation.set(this.q2.x, this.q2.y, this.q2.z).multiplyScalar(scale)
      if (Math.abs(this.rotation.x) <= limits[0] && Math.abs(this.rotation.y) <= limits[1]
        && Math.abs(this.rotation.z) <= limits[2]) continue
      this.velocity.copy(child.body.angvel()).sub(this.position.copy(parent.body.angvel()))
        .applyQuaternion(this.inverseRotation)
      for (let axis = 0; axis < 3; axis++) {
        const angle = this.rotation.getComponent(axis)
        const excess = angle - THREE.MathUtils.clamp(angle, -limits[axis], limits[axis])
        const spring = excess ? 90 : 0
        const damping = 2 * Math.sqrt(spring * inertia)
        const force = (-spring * excess - damping * this.velocity.getComponent(axis))
          / (1 + damping * dt / inertia + spring * dt * dt / inertia)
        this.torque.setComponent(axis, THREE.MathUtils.clamp(force, -45, 45))
      }
      this.torque.applyQuaternion(this.q1)
      child.body.addTorque(this.torque, true)
      parent.body.addTorque(this.torque.multiplyScalar(-1), true)
    }
  }

  step(dt: number, onContact?: ContactHandler, contactFilter?: (collider: RAPIER.Collider) => boolean) {
    this.breakingFlight = false
    this.impactTime += dt
    this.parts.forEach(({ body, previousPosition, previousRotation, previousVelocity }) => {
      previousPosition.copy(body.translation())
      previousRotation.copy(body.rotation())
      previousVelocity.copy(body.linvel())
      body.resetTorques(false)
      body.resetForces(false)
    })
    // Grounded animation uses sampled support; it doesn't depend on solver impulses.
    this.footContacts.fill(true)
    this.updatePose(dt)
    if (this.standing) {
      this.animateBodies()
      this.sweepForFlightDestruction(dt)
      // Get-up animation moves kinematic limbs too; catch thin scenery crossed between poses.
      if (onContact && contactFilter) this.sweepForDestructiveContacts(dt, onContact, contactFilter)
      this.parts.forEach(({ body, targetPosition, previousVelocity }) => {
        previousVelocity.copy(targetPosition).sub(body.translation()).divideScalar(dt)
      })
      if (!this.recovery && !this.collisionProtected && this.sweepForImpact(dt)) this.release()
      else {
        for (const { body, targetPosition, targetRotation } of this.parts.values()) {
          body.setNextKinematicTranslation(targetPosition)
          body.setNextKinematicRotation(targetRotation)
        }
      }
    }
    if (!this.standing) {
      this.updateProtection(dt)
      this.enforceJointLimits(dt)
    }
    // Copies are always kinematic: cape contacts and attachment forces can never
    // feed back into the real body, even during a fall or a collision.
    for (const [id, proxy] of this.capeBodies) {
      const { body, targetPosition, targetRotation } = this.parts.get(id)!
      if (this.standing) {
        proxy.setNextKinematicTranslation(targetPosition)
        proxy.setNextKinematicRotation(targetRotation)
      } else {
        this.position.copy(body.translation()).addScaledVector(this.velocity.copy(body.linvel()), dt)
        this.velocity.copy(body.angvel())
        const speed = this.velocity.length()
        this.q1.setFromAxisAngle(this.velocity.divideScalar(speed || 1), speed * dt)
        this.q2.copy(body.rotation()).premultiply(this.q1)
        proxy.setNextKinematicTranslation(this.position)
        proxy.setNextKinematicRotation(this.q2)
      }
    }
  }

  sync(alpha = 1) {
    this.parts.forEach(({ body, mesh, previousPosition, previousRotation }) => {
      mesh.position.lerpVectors(previousPosition, this.position.copy(body.translation()), alpha)
      mesh.quaternion.slerpQuaternions(previousRotation, this.q1.copy(body.rotation()), alpha)
    })
  }

  dispose() {
    this.disposeAppearance()
    const geometries = new Set<THREE.BufferGeometry>()
    const materials = new Set<THREE.Material>()
    for (const object of [...this.meshes, this.seat]) {
      this.scene.remove(object)
      object.traverse((child) => {
        if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
          geometries.add(child.geometry)
          for (const material of Array.isArray(child.material) ? child.material : [child.material]) materials.add(material)
        }
      })
    }
    geometries.forEach((geometry) => geometry.dispose())
    materials.forEach((material) => material.dispose())
  }
}
