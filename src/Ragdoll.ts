import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'

type Part = {
  body: RAPIER.RigidBody
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  label: string
  previousPosition: THREE.Vector3
  previousRotation: THREE.Quaternion
  inertia: number
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
const origin = v(0, 0, 0)
const STAND_HEIGHT = 1.23

/** Dynamic mannequin: no animation or mesh-to-body teleporting. */
export class Ragdoll {
  readonly parts = new Map<string, Part>()
  readonly meshes: THREE.Object3D[] = []
  private angularJoints: AngularJoint[] = []
  private torso: Part[] = []
  private ballMotors = new Map<string, AngularJoint>()
  private hinges = new Map<string, RAPIER.RevoluteImpulseJoint>()
  private poseActive = false
  private direction = new THREE.Vector3()
  private moveVelocity = new THREE.Vector3()
  private running = false
  private sitting = false
  private sitBlend = 0
  private heading = 0
  private phase = 0
  private standHeight = STAND_HEIGHT
  private facing = new THREE.Quaternion()
  private torsoTarget = new THREE.Quaternion()
  private seat: THREE.Group
  private seatBody: RAPIER.RigidBody
  private seatVisible = false
  private seatColliding = false
  private support: RAPIER.RigidBody
  private supportJoints: RAPIER.ImpulseJoint[] = []
  private supportTarget: THREE.Vector3
  private standing = false
  private grab: { part: Part; local: THREE.Vector3; handle: RAPIER.RigidBody; supportOffset: THREE.Vector3 } | null = null
  private grabTarget = new THREE.Vector3()
  private highlighted: Part | null = null
  private marker: THREE.Mesh
  private tether: THREE.Line
  private q1 = new THREE.Quaternion()
  private q2 = new THREE.Quaternion()
  private inverseRotation = new THREE.Quaternion()
  private rotation = new THREE.Vector3()
  private velocity = new THREE.Vector3()
  private torque = new THREE.Vector3()
  private position = new THREE.Vector3()

  constructor(private world: RAPIER.World, private scene: THREE.Scene, z: number, standing: boolean) {
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
        mass, '#151b23')
    }

    const pelvis = box('pelvis', 'لگن', point(0, 1.13), v(0.265, 0.17, 0.16), 9, '#11151c')
    const abdomen = box('abdomen', 'شکم و کمر', point(0, 1.43), v(0.215, 0.135, 0.135), 6, '#1b222b')
    const chest = box('chest', 'سینه', point(0, 1.77), v(0.30, 0.20, 0.17), 12, '#1c232c')
    const neck = ball('neck', 'گردن', point(0, 2.055), 0.085, 0.8, '#090c10')
    const head = ball('head', 'سر', point(0, 2.295), 0.19, 4, '#0a0d12')
    this.torso = [pelvis, abdomen, chest]
    this.spherical(pelvis, abdomen, point(0, 1.30), [0.45, 0.5, 0.35], 16)
    this.spherical(abdomen, chest, point(0, 1.565), [0.4, 0.5, 0.35], 20)
    this.spherical(chest, neck, point(0, 1.99), [0.35, 0.55, 0.35], 70)
    this.spherical(neck, head, point(0, 2.12), [0.65, 0.8, 0.5], 50)

    for (const sign of [-1, 1]) {
      const side = sign === -1 ? 'right' : 'left'
      const label = sign === -1 ? 'راست' : 'چپ'
      const shoulder = ball(`${side}Shoulder`, `شانهٔ ${label}`, point(sign * 0.385, 1.91), 0.105, 1, '#141a22')
      const elbow = point(sign * 0.68, 1.48)
      const wrist = point(sign * 0.82, 1.12)
      const upperArm = limb(`${side}UpperArm`, `بازوی ${label}`, point(sign * 0.445, 1.86), elbow, 0.092, 2.3)
      const forearm = limb(`${side}Forearm`, `ساعد ${label}`, elbow, wrist, 0.074, 1.4)
      const hand = box(`${side}Hand`, `دست و مچ ${label}`, point(sign * 0.85, 0.995, 0.015), v(0.075, 0.115, 0.05), 0.6, '#090c12')
      this.spherical(chest, shoulder, point(sign * 0.30, 1.91), [1.8, 1.3, 1.5], 3)
      this.hinge(shoulder, upperArm, point(sign * 0.445, 1.86), v(0, 0, sign), -0.35, 1.65)
      this.hinge(upperArm, forearm, elbow, v(1, 0, 0), -2.5, 0.08)
      this.spherical(forearm, hand, wrist, [0.9, 0.55, 0.6], 2)

      const hip = point(sign * 0.17, 1.055)
      const knee = point(sign * 0.205, 0.60)
      const anklePoint = point(sign * 0.225, 0.15)
      const thigh = limb(`${side}Thigh`, `ران ${label}`, hip, knee, 0.115, 5.5)
      const shin = limb(`${side}Shin`, `ساق ${label}`, knee, anklePoint, 0.085, 3)
      const ankle = ball(`${side}Ankle`, `مچ پای ${label}`, anklePoint, 0.068, 0.45, '#0a0d12')
      const foot = box(`${side}Foot`, `کف پای ${label}`, point(sign * 0.225, 0.015, 0.10), v(0.105, 0.09, 0.205), 0.9, '#0b1018')
      this.spherical(pelvis, thigh, hip, [1.55, 0.7, 0.75], 5)
      this.hinge(thigh, shin, knee, v(1, 0, 0), -0.05, 2.45)
      this.spherical(shin, ankle, anklePoint, [0.3, 0.45, 0.3], 2)
      this.hinge(ankle, foot, point(sign * 0.225, 0.10), v(1, 0, 0), -0.65, 0.75)
    }
    this.addHeroDetails()

    this.supportTarget = point(0, STAND_HEIGHT)
    this.support = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(this.supportTarget.x, this.supportTarget.y, this.supportTarget.z))
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
    this.marker = new THREE.Mesh(new THREE.SphereGeometry(0.045, 16, 12),
      new THREE.MeshBasicMaterial({ color: '#526bfa', depthTest: false }))
    this.marker.renderOrder = 10
    this.tether = new THREE.Line(new THREE.BufferGeometry().setFromPoints([origin, origin]),
      new THREE.LineBasicMaterial({ color: '#526bfa', depthTest: false, transparent: true, opacity: 0.75 }))
    this.tether.renderOrder = 9
    this.marker.visible = this.tether.visible = false
    scene.add(this.marker, this.tether)
    this.setStanding(standing)
    this.sync()
  }

  private addPart(id: string, label: string, position: THREE.Vector3, geometry: THREE.BufferGeometry,
    collider: RAPIER.ColliderDesc, mass: number, color: string): Part {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z)
      .setLinearDamping(0.2).setAngularDamping(1.4).setCcdEnabled(true)
      .setAdditionalSolverIterations(1))
    this.world.createCollider(collider.setMass(mass).setFriction(0.8).setRestitution(0), body)
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
      inertia: Math.min(moments.x, moments.y, moments.z),
    }
    this.parts.set(id, part)
    this.meshes.push(mesh)
    return part
  }

  private local(part: Part, point: THREE.Vector3) {
    return point.clone().sub(part.body.translation()).applyQuaternion(new THREE.Quaternion().copy(part.body.rotation()).invert())
  }

  private addHeroDetails() {
    const armor = new THREE.MeshStandardMaterial({ color: '#252d38', roughness: 0.48, metalness: 0.3 })
    const black = new THREE.MeshStandardMaterial({ color: '#080b10', roughness: 0.65, metalness: 0.12 })
    const gold = new THREE.MeshStandardMaterial({ color: '#a58b48', roughness: 0.48, metalness: 0.55 })
    const add = (id: string, geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) => {
      const mesh = new THREE.Mesh(geometry, material)
      mesh.position.set(x, y, z)
      mesh.receiveShadow = true
      this.parts.get(id)!.mesh.add(mesh)
      return mesh
    }
    const head = this.parts.get('head')!
    const earGeometry = new THREE.ConeGeometry(0.045, 0.2, 4)
    for (const sign of [-1, 1]) {
      const ear = add('head', earGeometry, head.mesh.material, sign * 0.12, 0.19, -0.02)
      ear.rotation.z = -sign * 0.07
      ear.castShadow = true
      // The cowl's ears collide as part of the existing head body.
      this.world.createCollider(RAPIER.ColliderDesc.cone(0.1, 0.045)
        .setTranslation(ear.position.x, ear.position.y, ear.position.z).setRotation(ear.quaternion).setMass(0), head.body)
    }
    const jaw = new THREE.MeshStandardMaterial({ color: '#b58d72', roughness: 0.85 })
    add('head', new THREE.SphereGeometry(0.193, 20, 10, Math.PI * 0.31, Math.PI * 0.38, Math.PI * 0.56, Math.PI * 0.28), jaw, 0, 0, 0)
    const eyes = new THREE.BufferGeometry()
    const eyePositions: number[] = []
    for (const sign of [-1, 1]) {
      for (const [across, height] of [[0.112, 0.048], [0.027, 0.029], [0.040, 0.007], [0.100, 0.018]]) {
        eyePositions.push(sign * across, height, Math.sqrt(0.199 ** 2 - across ** 2 - height ** 2))
      }
    }
    eyes.setAttribute('position', new THREE.Float32BufferAttribute(eyePositions, 3))
    eyes.setIndex([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6])
    eyes.computeVertexNormals()
    add('head', eyes, new THREE.MeshStandardMaterial({ color: '#f1f8ff', emissive: '#c8e4ff', emissiveIntensity: 0.65, side: THREE.DoubleSide }), 0, 0, 0)
    const nose = add('head', new THREE.ConeGeometry(0.028, 0.07, 4), black, 0, -0.004, 0.185)
    nose.rotation.x = Math.PI / 2
    add('head', new THREE.BoxGeometry(0.055, 0.007, 0.008), black, 0, -0.10, 0.169)

    const pectoral = new RoundedBoxGeometry(0.25, 0.13, 0.035, 2, 0.02)
    for (const sign of [-1, 1]) {
      add('chest', pectoral, armor, sign * 0.135, 0.055, 0.179).rotation.z = -sign * 0.05
    }
    add('chest', new RoundedBoxGeometry(0.52, 0.30, 0.035, 2, 0.025), armor, 0, 0.03, -0.1775)
    const badge = add('chest', new THREE.CircleGeometry(0.16, 40), gold, 0, 0.035, 0.221)
    badge.scale.y = 0.42
    const bat = new THREE.Shape()
    const outline = [
      [-0.137, 0.018], [-0.095, 0.027], [-0.064, 0.043], [-0.038, 0.030], [-0.018, 0.037],
      [-0.015, 0.060], [0, 0.040], [0.015, 0.060], [0.018, 0.037], [0.038, 0.030],
      [0.064, 0.043], [0.095, 0.027], [0.137, 0.018], [0.107, -0.025], [0.080, -0.005],
      [0.057, -0.040], [0.037, -0.018], [0, -0.055], [-0.037, -0.018], [-0.057, -0.040],
      [-0.080, -0.005], [-0.107, -0.025],
    ]
    outline.forEach(([x, y], index) => index ? bat.lineTo(x, y) : bat.moveTo(x, y))
    bat.closePath()
    add('chest', new THREE.ShapeGeometry(bat), black, 0, 0.035, 0.224)
    const abdominalPlate = new RoundedBoxGeometry(0.33, 0.043, 0.028, 2, 0.013)
    for (const y of [-0.07, 0, 0.07]) add('abdomen', abdominalPlate, armor, 0, y, 0.14)
    add('pelvis', new RoundedBoxGeometry(0.56, 0.075, 0.34, 2, 0.015), gold, 0, 0.11, 0)
    add('pelvis', new RoundedBoxGeometry(0.095, 0.085, 0.025, 2, 0.008), gold, 0, 0.11, 0.19)
    const pouch = new RoundedBoxGeometry(0.065, 0.09, 0.035, 2, 0.01)
    for (const sign of [-1, 1]) add('pelvis', pouch, gold, sign * 0.18, 0.105, 0.185)

    const fin = new THREE.Shape().moveTo(0, 0.04).lineTo(0.11, -0.01).lineTo(0, -0.045)
    fin.closePath()
    const finGeometry = new THREE.ExtrudeGeometry(fin, { depth: 0.03, bevelEnabled: false })
    const shinGuard = new RoundedBoxGeometry(0.13, 0.24, 0.035, 2, 0.015)
    const shoulderCap = new THREE.SphereGeometry(0.12, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.6)
    for (const sign of [-1, 1]) {
      const side = sign === -1 ? 'right' : 'left'
      add(`${side}Shoulder`, shoulderCap, armor, 0, 0, 0)
      add(`${side}Shin`, shinGuard, armor, 0, 0, 0.078)
      for (let i = 0; i < 3; i++) {
        add(`${side}Forearm`, finGeometry, black, sign * 0.07, 0.08 - i * 0.075, -0.015).scale.x = sign
      }
    }
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
    this.hinges.set(child.mesh.userData.partId, joint)
  }

  setMovement(x: number, z: number, running: boolean, sitting: boolean) {
    this.direction.set(x, 0, z).clampLength(0, 1)
    this.running = running
    if (sitting !== this.sitting) this.standHeight = STAND_HEIGHT
    this.sitting = sitting
  }

  controlFocus(target: THREE.Vector3) {
    return target.set(this.supportTarget.x, 1.4 - this.sitBlend * 0.45, this.supportTarget.z)
  }

  private configurePose(active: boolean) {
    if (this.poseActive === active) return
    this.poseActive = active
    for (const side of ['left', 'right']) {
      for (const [part, stiffness, maxForce] of [['Thigh', 220, 110], ['Ankle', 40, 35], ['Shoulder', 32, 35]] as const) {
        const joint = this.ballMotors.get(`${side}${part}`)!
        const gain = active ? stiffness : joint.stiffness
        for (const axis of [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngY, RAPIER.JointAxis.AngZ]) {
          joint.motor.configureMotorPosition(axis, 0, gain, 2 * Math.sqrt(gain * joint.inertia))
          joint.motor.setMotorMaxForce(axis, active ? maxForce : 45)
        }
      }
      for (const [part, stiffness, damping, maxForce] of [['Shin', 100, 4, 85], ['Foot', 60, 3, 35], ['Forearm', 24, 3, 20]] as const) {
        const joint = this.hinges.get(`${side}${part}`)!
        joint.configureMotorModel(active ? RAPIER.MotorModel.ForceBased : RAPIER.MotorModel.AccelerationBased)
        joint.configureMotorPosition(0, active ? stiffness : 3, active ? damping : 1.2)
        joint.setMotorMaxForce(active ? maxForce : 6)
      }
    }
  }

  private ballPose(id: string, angle: number, stiffness: number) {
    const joint = this.ballMotors.get(id)!
    joint.motor.configureMotorPosition(RAPIER.JointAxis.AngX, angle, stiffness, 2 * Math.sqrt(stiffness * joint.inertia))
  }

  private setSeatCollision(enabled: boolean) {
    if (enabled === this.seatColliding) return
    this.seatColliding = enabled
    this.seatBody.setEnabled(enabled)
  }

  private updatePose(dt: number) {
    const active = this.standing && !this.grab
    this.configurePose(active)
    if (!active) {
      this.moveVelocity.multiplyScalar(Math.exp(-12 * dt))
      return
    }
    if (this.sitting && !this.seatVisible) {
      this.seatVisible = true
      this.moveVelocity.set(0, 0, 0)
      this.seat.position.set(this.supportTarget.x, 0, this.supportTarget.z)
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
    let alignment = 1
    if (hasDirection) {
      this.standHeight = STAND_HEIGHT
      const targetHeading = Math.atan2(this.direction.x, this.direction.z)
      const difference = Math.atan2(Math.sin(targetHeading - this.heading), Math.cos(targetHeading - this.heading))
      this.heading += THREE.MathUtils.clamp(difference, -3.8 * dt, 3.8 * dt)
      alignment = Math.max(0.15, Math.cos(difference))
    }
    const speed = this.running ? 1.8 : 0.8
    this.position.copy(this.direction).multiplyScalar(hasDirection ? speed * alignment : 0)
    this.moveVelocity.lerp(this.position, 1 - Math.exp(-8 * dt))
    this.supportTarget.addScaledVector(this.moveVelocity, dt)
    const movement = THREE.MathUtils.clamp(this.moveVelocity.length() / speed, 0, 1)
    this.phase += dt * Math.PI * 2 * (this.running ? 2.3 : 1.55) * movement
    const bob = Math.abs(Math.sin(this.phase)) * movement * (this.running ? 0.045 : 0.02)
    const lowerBlend = THREE.MathUtils.smoothstep(this.sitBlend, 0.65, 0.98)
    const poseBlend = THREE.MathUtils.smoothstep(this.sitBlend, 0, 0.70)
    this.facing.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, this.heading)
    this.torsoTarget.copy(this.facing).multiply(this.q2.setFromAxisAngle(
      this.position.set(1, 0, 0), movement * (this.running ? 0.14 : 0.045) + this.sitBlend * 0.04,
    ))
    let longestLeg = 0
    for (const [side, offset] of [['left', 0], ['right', Math.PI]] as const) {
      const cycle = this.phase + offset
      const stride = (this.running ? 0.8 : 0.52) * movement * (1 - poseBlend)
      const hip = THREE.MathUtils.lerp(-Math.sin(cycle) * stride, -1.45, poseBlend)
      const knee = THREE.MathUtils.lerp(0.035 + movement * (0.10 + Math.max(0, Math.cos(cycle)) * (this.running ? 1.1 : 0.65)), 1.5, poseBlend)
      const ankle = THREE.MathUtils.clamp(-(hip + knee) * 0.3, -0.28, 0.28)
      const foot = THREE.MathUtils.clamp(-(hip + knee) - ankle, -0.6, 0.7)
      longestLeg = Math.max(longestLeg, 0.455 * Math.cos(hip) + 0.45 * Math.cos(hip + knee))
      this.ballPose(`${side}Thigh`, hip, 220)
      this.ballPose(`${side}Ankle`, ankle, 40)
      this.ballPose(`${side}Shoulder`, Math.sin(cycle) * stride * 0.65 - this.sitBlend * 0.25, 32)
      this.hinges.get(`${side}Shin`)!.configureMotorPosition(knee, 100, 4)
      this.hinges.get(`${side}Foot`)!.configureMotorPosition(foot, 60, 3)
      this.hinges.get(`${side}Forearm`)!.configureMotorPosition(
        -THREE.MathUtils.lerp(0.15 + movement * (this.running ? 0.6 : 0.15), 0.85, this.sitBlend), 24, 3,
      )
    }
    // Lower the pelvis as the stance leg bends, keeping walking feet near the ground.
    const legDrop = (0.905 - longestLeg) * movement * (1 - poseBlend) * (this.running ? 0.65 : 1)
    const stanceLowering = 0.075 * movement * (1 - poseBlend)
    const height = THREE.MathUtils.lerp(this.standHeight - legDrop - stanceLowering + bob, 0.72, lowerBlend)
    this.supportTarget.y = THREE.MathUtils.damp(this.supportTarget.y, height, 8, dt)
  }

  setStanding(enabled: boolean) {
    if (enabled === this.standing) return
    this.standing = enabled
    this.supportJoints.forEach((joint) => this.world.removeImpulseJoint(joint, true))
    this.supportJoints = []
    if (enabled) {
      this.seatVisible = false
      this.seat.visible = false
      this.setSeatCollision(false)
      const pelvis = this.parts.get('pelvis')!
      // Re-enable at the current location without teleporting a fallen body.
      this.supportTarget.copy(pelvis.body.translation())
      this.supportTarget.y = STAND_HEIGHT
      this.support.setTranslation(this.supportTarget, true)
      this.supportJoints.push(this.world.createImpulseJoint(
        RAPIER.JointData.spring(0, 3500, 350, origin, origin), this.support, pelvis.body, true))
      this.supportJoints.push(this.world.createImpulseJoint(
        RAPIER.JointData.spring(0, 2500, 250, v(0, 0.55, 0), origin), this.support, this.parts.get('chest')!.body, true))
    }
    this.parts.forEach(({ body }) => body.wakeUp())
  }

  partFor(object: THREE.Object3D): Part | undefined {
    let current: THREE.Object3D | null = object
    while (current) {
      if (current.userData.partId) return this.parts.get(current.userData.partId)
      current = current.parent
    }
  }

  highlight(part?: Part) {
    if (this.highlighted === part) return
    this.highlighted?.mesh.material.emissive.setHex(0)
    this.highlighted = part ?? null
    part?.mesh.material.emissive.setHex(0x172c50)
  }

  startGrab(part: Part, point: THREE.Vector3) {
    this.endGrab()
    const local = this.local(part, point)
    const handle = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(point.x, point.y, point.z))
    this.world.createImpulseJoint(RAPIER.JointData.spring(0, 1800, 100, origin, local), handle, part.body, true)
    this.grab = { part, local, handle, supportOffset: this.supportTarget.clone().sub(point) }
    this.grabTarget.copy(point)
    this.highlight(part)
    this.marker.visible = this.tether.visible = true
    this.parts.forEach(({ body }) => body.wakeUp())
  }

  moveGrab(point: THREE.Vector3) {
    this.grabTarget.copy(point)
    this.grabTarget.x = THREE.MathUtils.clamp(point.x, -4, 4)
    this.grabTarget.y = THREE.MathUtils.clamp(point.y, -0.05, 4.5)
    this.grabTarget.z = THREE.MathUtils.clamp(point.z, -3, 3)
  }

  endGrab() {
    if (this.grab) this.world.removeRigidBody(this.grab.handle)
    this.grab = null
    this.highlight()
    this.marker.visible = this.tether.visible = false
  }

  step(dt: number) {
    // Forces persist in Rapier. Clear last step's joint torques before applying PD springs.
    this.parts.forEach(({ body, previousPosition, previousRotation }) => {
      previousPosition.copy(body.translation())
      previousRotation.copy(body.rotation())
      body.resetTorques(false)
    })
    this.updatePose(dt)
    for (const { parent, child, limits, inertia } of this.angularJoints) {
      this.q1.copy(parent.body.rotation())
      this.inverseRotation.copy(this.q1).invert()
      this.q2.copy(child.body.rotation()).premultiply(this.inverseRotation).normalize()
      if (this.q2.w < 0) this.q2.set(-this.q2.x, -this.q2.y, -this.q2.z, -this.q2.w)
      const sine = Math.hypot(this.q2.x, this.q2.y, this.q2.z)
      const scale = sine > 1e-6 ? 2 * Math.atan2(sine, this.q2.w) / sine : 2
      this.rotation.set(this.q2.x, this.q2.y, this.q2.z).multiplyScalar(scale)
      // The solver handles the normal spring motion. Only calculate extra torques
      // when a ball joint reaches one of its anatomical stops.
      if (Math.abs(this.rotation.x) <= limits[0] && Math.abs(this.rotation.y) <= limits[1]
        && Math.abs(this.rotation.z) <= limits[2]) continue
      this.velocity.copy(child.body.angvel()).sub(parent.body.angvel()).applyQuaternion(this.inverseRotation)
      for (let axis = 0; axis < 3; axis++) {
        const angle = this.rotation.getComponent(axis)
        const excess = angle - THREE.MathUtils.clamp(angle, -limits[axis], limits[axis])
        // Soft anatomical stops on ball joints; elbows/knees have solver-enforced hinge limits.
        // Implicit damping is essential for the low-inertia neck, hands and ankles.
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
    if (this.standing) {
      // Optional torso springs and bounded balance torques help pose the mannequin.
      // Every visible part remains dynamic, including the pelvis and torso.
      if (this.grab && this.torso.includes(this.grab.part)) {
        this.supportTarget.copy(this.grab.handle.translation()).add(this.grab.supportOffset)
        this.standHeight = this.supportTarget.y
      }
      this.support.setNextKinematicTranslation(this.supportTarget)
      for (const { body, inertia } of this.torso) {
        this.q1.copy(body.rotation()).invert()
        this.q2.copy(this.torsoTarget).multiply(this.q1)
        if (this.q2.w < 0) this.q2.set(-this.q2.x, -this.q2.y, -this.q2.z, -this.q2.w)
        this.rotation.set(this.q2.x, this.q2.y, this.q2.z).multiplyScalar(2)
        this.velocity.copy(body.angvel())
        // Compensate for the larger fixed step so standing assistance stays firm.
        const spring = 200
        const damping = 2 * Math.sqrt(spring * inertia)
        this.torque.copy(this.rotation).multiplyScalar(spring).addScaledVector(this.velocity, -damping)
          .multiplyScalar(1 / (1 + damping * dt / inertia + spring * dt * dt / inertia)).clampLength(0, 65)
        body.addTorque(this.torque, true)
      }
    }
    if (this.grab) {
      // Bound the handle speed so a sudden cursor jump cannot launch the body.
      this.position.copy(this.grabTarget).sub(this.grab.handle.translation()).clampLength(0, 6 * dt)
        .add(this.grab.handle.translation())
      this.grab.handle.setNextKinematicTranslation(this.position)
    }
  }

  sync(alpha = 1) {
    this.parts.forEach(({ body, mesh, previousPosition, previousRotation }) => {
      mesh.position.lerpVectors(previousPosition, this.position.copy(body.translation()), alpha)
      mesh.quaternion.slerpQuaternions(previousRotation, this.q1.copy(body.rotation()), alpha)
    })
    if (this.grab) {
      this.position.copy(this.grab.local).applyQuaternion(this.grab.part.mesh.quaternion)
        .add(this.grab.part.mesh.position)
      this.marker.position.copy(this.position)
      const points = this.tether.geometry.getAttribute('position') as THREE.BufferAttribute
      points.setXYZ(0, this.position.x, this.position.y, this.position.z)
      const target = this.grab.handle.translation()
      points.setXYZ(1, target.x, target.y, target.z)
      points.needsUpdate = true
      this.tether.geometry.computeBoundingSphere()
    }
  }

  dispose() {
    this.endGrab()
    const geometries = new Set<THREE.BufferGeometry>()
    const materials = new Set<THREE.Material>()
    for (const object of [...this.meshes, this.marker, this.tether, this.seat]) {
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
