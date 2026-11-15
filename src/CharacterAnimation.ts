import * as THREE from 'three'

const { clamp, damp, lerp, smoothstep } = THREE.MathUtils
const TAU = Math.PI * 2
const ease = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)

// Four reference poses through the airborne leg recovery: push off, heel fold,
// knee drive, heel reach. Hermite interpolation keeps the motion continuous.
const runSwingFrames = [
  { time: 0, travel: 0, lift: 0, sole: .55, hip: .30, knee: .28 },
  { time: .28, travel: .10, lift: .38, sole: .42, hip: .12, knee: 2.15 },
  { time: .62, travel: .68, lift: .46, sole: -.12, hip: -.98, knee: 1.60 },
  { time: 1, travel: 1, lift: 0, sole: -.20, hip: -.55, knee: .22 },
] as const
function runSwing(t: number, key: 'travel' | 'lift' | 'sole' | 'hip' | 'knee') {
  const index = t < .28 ? 0 : t < .62 ? 1 : 2
  const from = runSwingFrames[index], to = runSwingFrames[index + 1]
  const previous = runSwingFrames[Math.max(0, index - 1)]
  const next = runSwingFrames[Math.min(3, index + 2)]
  const span = to.time - from.time
  const u = clamp((t - from.time) / span, 0, 1)
  const m0 = index === 0 ? 0 : (to[key] - previous[key]) / (to.time - previous.time) * span
  const m1 = index === 2 ? 0 : (next[key] - from[key]) / (next.time - from.time) * span
  return (2 * u ** 3 - 3 * u ** 2 + 1) * from[key] + (u ** 3 - 2 * u ** 2 + u) * m0
    + (-2 * u ** 3 + 3 * u ** 2) * to[key] + (u ** 3 - u ** 2) * m1
}

export type LimbPose = {
  hip: number; hipRoll: number; knee: number; ankle: number; ankleRoll: number; foot: number
  shoulder: number; shoulderRoll: number; upperArm: number; elbow: number; wrist: number
}
const limbPose = (): LimbPose => ({
  hip: 0, hipRoll: 0, knee: .06, ankle: 0, ankleRoll: 0, foot: 0,
  shoulder: 0, shoulderRoll: 0, upperArm: -.22, elbow: -.18, wrist: -.04,
})
type Foot = {
  position: THREE.Vector3; from: THREE.Vector3; to: THREE.Vector3
  velocity: THREE.Vector3; previous: THREE.Vector3; stanceTime: number
  normal: THREE.Vector3; swinging: boolean; initialized: boolean; pitch: number
  progress: number; duration: number; ready: boolean; load: number
}
const foot = (): Foot => ({
  position: new THREE.Vector3(), from: new THREE.Vector3(), to: new THREE.Vector3(),
  velocity: new THREE.Vector3(), previous: new THREE.Vector3(), stanceTime: 1,
  normal: new THREE.Vector3(0, 1, 0), swinging: false, initialized: false, pitch: 0, progress: 0, duration: .4, ready: true, load: .5,
})
export type GroundSampler = (position: THREE.Vector3, normal: THREE.Vector3) => number
export type GetUpStyle = 'back' | 'front' | 'left' | 'right'
type RecoveryFrame = {
  time: number; height: number; pitch: number; roll: number
  left: Partial<LimbPose>; right: Partial<LimbPose>
}
const crouch = { hip: -1.1, knee: 1.9, foot: -.45, shoulder: -.4, elbow: -.7 }
const kneel = { hip: -.95, knee: 2.1, foot: -.5, shoulder: -.7, elbow: -.8 }
// Four distinct get-ups: sit up from the back, push up from the belly,
// or brace on the lower arm and bring a knee under the body from either side.
const recoveryTracks: Record<GetUpStyle, RecoveryFrame[]> = {
  back: [
    { time: 0, height: .27, pitch: -1.5, roll: 0, left: { hip: -.35, knee: .6, shoulder: -.6, elbow: -1.1 }, right: { hip: -.35, knee: .6, shoulder: -.6, elbow: -1.1 } },
    { time: .32, height: .43, pitch: -.35, roll: 0, left: { hip: -1.4, knee: 1.7, shoulder: .4, elbow: -.15 }, right: { hip: -1.4, knee: 1.7, shoulder: .4, elbow: -.15 } },
    { time: .65, height: .69, pitch: .45, roll: -.12, left: crouch, right: { ...kneel, hip: -.4 } },
    { time: 1, height: 1.19, pitch: 0, roll: 0, left: {}, right: {} },
  ],
  front: [
    { time: 0, height: .27, pitch: 1.5, roll: 0, left: { shoulder: -1.1, elbow: -1.7, knee: .25 }, right: { shoulder: -1.1, elbow: -1.7, knee: .25 } },
    { time: .32, height: .47, pitch: .95, roll: 0, left: { ...kneel, shoulder: -1.3, elbow: -.15 }, right: { ...kneel, shoulder: -1.3, elbow: -.15 } },
    { time: .65, height: .76, pitch: .4, roll: .08, left: { ...kneel, hip: -.3 }, right: crouch },
    { time: 1, height: 1.19, pitch: 0, roll: 0, left: {}, right: {} },
  ],
  left: [
    { time: 0, height: .29, pitch: .15, roll: -1.5, left: { shoulder: -.5, upperArm: .9, elbow: -1.5 }, right: { hip: -.6, knee: 1.2, shoulder: -.8 } },
    { time: .32, height: .48, pitch: .3, roll: -.65, left: { shoulder: -.8, upperArm: .8, elbow: -.1, knee: 1.9 }, right: { ...kneel, hipRoll: -.3 } },
    { time: .65, height: .74, pitch: .4, roll: -.12, left: { ...kneel, hip: -.35 }, right: crouch },
    { time: 1, height: 1.19, pitch: 0, roll: 0, left: {}, right: {} },
  ],
  right: [
    { time: 0, height: .29, pitch: .15, roll: 1.5, left: { hip: -.6, knee: 1.2, shoulder: -.8 }, right: { shoulder: -.5, upperArm: .9, elbow: -1.5 } },
    { time: .32, height: .48, pitch: .3, roll: .65, left: { ...kneel, hipRoll: .3 }, right: { shoulder: -.8, upperArm: .8, elbow: -.1, knee: 1.9 } },
    { time: .65, height: .74, pitch: .4, roll: .12, left: crouch, right: { ...kneel, hip: -.35 } },
    { time: 1, height: 1.19, pitch: 0, roll: 0, left: {}, right: {} },
  ],
}
const recoveryRest = limbPose()

/** Generates joint targets for controlled poses and transitions out of ragdoll. */
export class CharacterAnimation {
  readonly left = limbPose()
  readonly right = limbPose()
  pitch = 0
  roll = 0
  twist = 0
  height = 0
  neck = 0
  head = 0
  readonly feet = [foot(), foot()]
  private phase = 0
  private time = 0
  private speed = 0
  private run = 0
  private weight = 0
  private moving = false
  private lastStep = -1
  private previousSpeed = 0
  private acceleration = 0
  private travelForward = 0
  private travelSide = 0
  private localVelocity = new THREE.Vector3()
  private airForward = 0
  private airSide = 0
  private airBoost = 0
  private inverse = new THREE.Quaternion()
  private facing = new THREE.Quaternion()
  private forward = new THREE.Vector3()
  private rest = new THREE.Vector3()
  private hip = new THREE.Vector3()
  private delta = new THREE.Vector3()

  resetFeet() {
    for (const foot of this.feet) {
      foot.initialized = foot.swinging = false
      foot.ready = true
      foot.progress = 0
      foot.stanceTime = 1
      foot.velocity.set(0, 0, 0)
    }
    this.phase = 0
    this.moving = false
    this.lastStep = -1
    this.weight = this.speed = this.previousSpeed = this.acceleration = this.run = 0
    this.travelForward = this.travelSide = 0
  }

  getUp(style: GetUpStyle, progress: number) {
    const track = recoveryTracks[style]
    const t = clamp(progress, 0, 1)
    const index = Math.min(track.findIndex(frame => frame.time >= t), track.length - 1)
    const to = track[Math.max(1, index)], from = track[Math.max(1, index) - 1]
    const blend = ease(clamp((t - from.time) / (to.time - from.time), 0, 1))
    this.pitch = lerp(from.pitch, to.pitch, blend)
    this.roll = lerp(from.roll, to.roll, blend)
    this.height = lerp(from.height, to.height, blend)
    this.twist = 0
    this.neck = -this.pitch * .18
    this.head = -this.pitch * .25
    for (const side of ['left', 'right'] as const) {
      for (const key of Object.keys(recoveryRest) as (keyof LimbPose)[]) {
        this[side][key] = lerp(from[side][key] ?? recoveryRest[key], to[side][key] ?? recoveryRest[key], blend)
      }
    }
  }

  walk(dt: number, pelvis: THREE.Vector3, rotation: THREE.Quaternion, heading: number,
    velocity: THREE.Vector3, running: boolean, turnRate: number, impact: number, sampleGround: GroundSampler, contacts: readonly boolean[] = [true, true]) {
    this.time += dt
    this.facing.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, heading)
    this.inverse.copy(this.facing).invert()
    this.localVelocity.copy(velocity).setY(0).applyQuaternion(this.inverse)
    const groundSpeed = this.localVelocity.length()
    const directionScale = 1 / Math.max(groundSpeed, .001)
    this.travelForward = damp(this.travelForward, this.localVelocity.z * directionScale, 12, dt)
    this.travelSide = damp(this.travelSide, this.localVelocity.x * directionScale, 12, dt)
    const lateral = Math.abs(this.travelSide)
    const backward = Math.max(0, -this.travelForward)
    const forwardRun = smoothstep(this.travelForward, .55, .95)
    this.speed = damp(this.speed, Math.min(groundSpeed, 13.2), 10, dt)
    this.run = damp(this.run, running ? forwardRun : 0, 5, dt)
    this.weight = damp(this.weight, smoothstep(this.speed, .025, .3), 10, dt)
    this.acceleration = damp(this.acceleration, (this.speed - this.previousSpeed) / dt, 6, dt)
    this.previousSpeed = this.speed
    // Advance by travelled distance, so accelerating and blocked bodies don't walk in place.
    const run = this.run * smoothstep(this.speed, .6, 2.8)
    // Backsteps are shorter; side steps use a low, wide shuffle. Faster
    // lateral movement lengthens the step without using the sprint heel fold.
    const walkDistance = lerp(lerp(2.3, 1.9, backward), 1.65, lateral)
      * lerp(1, Math.max(1, this.speed / 3.2), Math.max(lateral, backward))
    const cycleDistance = lerp(walkDistance, 7.05, run)
    const frequency = this.speed / cycleDistance
    // Begin with a step, instead of dragging both planted feet until the first
    // distance-driven cycle reaches its swing interval.
    if (!this.moving && this.speed > .12) this.phase = .62
    this.moving = this.speed > (this.moving ? .06 : .12)
    const settling = this.speed < .1 && this.feet.some(foot => foot.swinging)
    this.phase = (this.phase + Math.max(frequency, settling ? .8 : 0) * dt) % 1
    const wave = Math.sin(this.phase * TAU)
    this.pitch = this.weight * lerp(.055 * this.travelForward, .24, run)
      + clamp(this.acceleration * .018, -.07, .08) * this.travelForward
      + Math.sin(this.time * 1.8) * .006 * (1 - this.weight)
    this.roll = (wave * .035 - this.travelSide * .075) * this.weight - clamp(turnRate * this.speed * .016, -.08, .08)
    this.twist = Math.cos(this.phase * TAU) * lerp(.06 * (1 - lateral * .65), .14, run) * this.weight
    // Contact -> down -> passing -> up: absorb weight just after contact,
    // then rise over the supporting leg. Two weight transfers per stride.
    this.height = (lerp(-.035, -.095, run) - Math.sin(this.phase * TAU * 2) * lerp(.022, .065, run))
      * this.weight - lateral * .045 * this.weight - impact * .13
    this.neck = -this.pitch * .4
    this.head = -this.pitch * .25
    this.forward.set(0, 0, 1).applyQuaternion(this.facing)
    this.inverse.copy(rotation).invert()
    this.delta.set(0, 0, 1).applyQuaternion(rotation)
    const pelvisPitch = Math.atan2(-this.delta.y, Math.hypot(this.delta.x, this.delta.z))
    const stance = lerp(.62 + backward * .04 + lateral * .06, .40, run)
    let stepStarted = false

    for (let i = 0; i < 2; i++) {
      const sign = i === 0 ? 1 : -1
      const pose = i === 0 ? this.left : this.right
      const foot = this.feet[i]
      const cycle = (this.phase + i * .5) % 1
      this.rest.set(sign * .225, 0, 0).applyQuaternion(this.facing).add(pelvis)
      this.rest.y = sampleGround(this.rest, foot.normal) + .225
      if (!foot.initialized) {
        foot.position.copy(this.rest)
        foot.initialized = true
        foot.swinging = false
      }
      foot.previous.copy(foot.position)
      this.delta.copy(foot.position).sub(this.rest).setY(0)
      if (!foot.swinging && cycle < stance) foot.ready = true
      const recenter = this.weight < .08 && this.delta.lengthSq() > .18 ** 2
      const overdue = run < .65 && this.delta.lengthSq() > lerp(1.2, .60, run) ** 2
      const scheduled = foot.ready && cycle >= stance && this.weight >= .015
      if (!stepStarted && !foot.swinging && (!this.moving || this.lastStep !== i)
        && (!this.feet[1 - i].swinging || run > .65) && contacts[1 - i]
        && (scheduled || overdue || recenter)) {
        this.lastStep = i
        stepStarted = true
        foot.swinging = true
        foot.ready = false
        foot.progress = 0
        foot.stanceTime = 0
        // Allow enough swing time for the longer strides while retaining a quick recovery at high speed.
        foot.duration = clamp((1 - stance) / Math.max(frequency, .4), lerp(.18, .06, run), .96)
        foot.from.copy(foot.position)
        foot.to.copy(this.rest).addScaledVector(velocity, foot.duration + stance / (2 * Math.max(frequency, .5)))
        foot.to.y = sampleGround(foot.to, foot.normal) + .225
      }
      if (foot.swinging) {
        foot.progress = Math.min(1, foot.progress + dt / foot.duration)
        const t = foot.progress
        // Predict the pelvis at touchdown, including the remaining swing time.
        // Steering changes the early swing arc; the final touchdown stays fixed.
        if (t < .65) {
          this.delta.copy(this.rest).addScaledVector(velocity, (1 - t) * foot.duration + stance / (2 * Math.max(frequency, .5)))
          foot.to.lerp(this.delta, 1 - Math.exp(-lerp(12, 36, run) * dt))
          foot.to.y = sampleGround(foot.to, foot.normal) + .225
        }
        foot.position.lerpVectors(foot.from, foot.to, lerp(ease(t), runSwing(t, 'travel'), run))
        // Lift early to fold the knee through passing, then lower the heel
        // gently into contact. Zero vertical velocity at either end of swing.
        const liftPhase = t < .45 ? .5 * ease(t / .45) : .5 + .5 * ease((t - .45) / .55)
        foot.position.y += lerp(Math.sin(Math.PI * liftPhase) ** 2 * lerp(.12, .10, lateral),
          Math.max(0, runSwing(t, 'lift')), run) * Math.max(.5, this.weight)
        if (t === 1) foot.swinging = false
      }
      foot.velocity.copy(foot.position).sub(foot.previous).divideScalar(dt).clampLength(0, 10)
      const swinging = foot.swinging
      if (!swinging) foot.stanceTime += dt
      // Roll load from the rear foot to the arriving foot during double support.
      const stanceLoad = .15 + .85 * Math.sin(Math.PI * clamp(cycle / stance, 0, 1))
      foot.load = swinging ? 0 : lerp(.5, stanceLoad, this.weight)
      // A planted target stays fixed. Walking waits for opposite support;
      // running permits the brief airborne interval between contacts.
      if (!swinging) foot.position.y = sampleGround(foot.position, foot.normal) + .225
      foot.pitch = damp(foot.pitch, Math.atan2(foot.normal.dot(this.forward), foot.normal.y), 12, dt)
      this.hip.set(sign * .17, -.075, 0).applyQuaternion(rotation).add(pelvis)
      this.delta.copy(foot.position).sub(this.hip).applyQuaternion(this.inverse)
      // Resolve lateral abduction before sagittal IK so side steps retain
      // their support height and do not force a straight, sliding knee.
      const upper = .455, lower = .45
      const reach = upper + lower - .008
      const vertical = Math.max(.25, -this.delta.y)
      pose.hipRoll = clamp(-Math.atan2(this.delta.x - sign * .055, vertical), -.5, .5)
      const down = clamp(Math.hypot(vertical, this.delta.x - sign * .055), .25, reach - .001)
      // Preserve the support height when a long stride exceeds leg reach.
      // Clamping the total distance alone shortens the leg above the surface.
      const reachForward = Math.sqrt(Math.max(0, reach * reach - down * down))
      const forward = clamp(this.delta.z, -reachForward, reachForward)
      const distance = clamp(Math.hypot(down, forward), .35, reach)
      const bend = Math.acos(clamp((upper * upper + distance * distance - lower * lower) / (2 * upper * distance), -1, 1))
      const hip = -Math.atan2(forward, down) - bend
      const knee = Math.acos(clamp((distance * distance - upper * upper - lower * lower) / (2 * upper * lower), -1, 1))
      pose.hip = hip
      pose.knee = knee + impact * .35
      if (swinging) {
        // Long strides can put the world-space target beyond leg reach. Fold
        // the heel and drive the knee during recovery, then return smoothly
        // to terrain IK before touchdown.
        const recovery = run * smoothstep(foot.progress, 0, .20)
          * (1 - smoothstep(foot.progress, .72, 1))
        pose.hip = lerp(pose.hip, runSwing(foot.progress, 'hip') - pelvisPitch, recovery)
        pose.knee = lerp(pose.knee, clamp(runSwing(foot.progress, 'knee'), .06, 2.45), recovery)
      }
      const heelStrike = swinging ? -.16 * smoothstep(foot.progress, .55, .92)
        : -.16 * (1 - smoothstep(foot.stanceTime, 0, .12))
      const toeOff = swinging ? .26 * (1 - smoothstep(foot.progress, 0, .45))
        : .26 * smoothstep(cycle / stance, .68, 1)
      // Backward steps land on the forefoot and release through the heel;
      // lateral steps keep the sole nearly level for a stable shuffle.
      const walkingSole = (heelStrike + toeOff) * (1 - lateral * .85) * (1 - backward * 1.7)
      const runningSole = swinging ? runSwing(foot.progress, 'sole')
        : lerp(-.20, .55, smoothstep(cycle / stance, .15, 1))
      const sole = foot.pitch + lerp(walkingSole, runningSole, run) * this.weight
        - (pelvisPitch + pose.hip + pose.knee)
      pose.ankle = clamp(sole * .35, -.28, .28)
      pose.ankleRoll = clamp(-pose.hipRoll, -.28, .28)
      pose.foot = clamp(sole - pose.ankle, -.62, .72)
      // Follow the actual leg drive so the arms remain opposed to the knees
      // through heel recovery, steering and the return to terrain contact.
      const legSwing = -Math.atan2(this.delta.z, down)
      const armSwing = lerp(clamp(-legSwing, -.55, .55), clamp(-pose.hip * .9 - .18, -.85, .85), run)
      pose.shoulder = damp(pose.shoulder, armSwing * this.weight, lerp(12, 24, run), dt)
      pose.shoulderRoll = -sign * this.twist * .4 + this.travelSide * wave * .055 * this.weight
      pose.upperArm = lerp(-.25 - lateral * .06, -.13, run) + Math.min(Math.abs(turnRate), 3) * .025
      pose.elbow = -.16 - this.weight * lerp(.18, 1.12, run) - Math.max(0, -pose.shoulder) * .30
      pose.wrist = lerp(-.04, -.10, run) - pose.shoulder * .12
    }
  }

  fly(dt: number, glide: number, pitchInput: number, bank: number, verticalSpeed: number,
    launch: number, approach: number, speed: number, forward = 1, side = 0, boost = 1) {
    this.time += dt
    const breath = Math.sin(this.time * 2.1) * .012
    const landing = smoothstep(approach, 0, 1)
    const cruise = glide * (1 - landing)
    this.airForward = damp(this.airForward, clamp(forward, -1, 1), 7, dt)
    this.airSide = damp(this.airSide, clamp(side, -1, 1), 7, dt)
    this.airBoost = damp(this.airBoost, clamp(boost, 0, 1), 5, dt)
    const fast = this.airBoost
    const ahead = Math.max(0, this.airForward)
    const back = Math.max(0, -this.airForward)
    const lateral = Math.abs(this.airSide)
    const drive = cruise * fast
    // Slow flight stays upright, with a small lean into travel. Fast forward
    // flight stretches into the Superman pose; reverse and side flight brace
    // against the airflow while leaving room for the head to track the view.
    const travelPitch = clamp(this.airForward * lerp(.22, 1.25, fast)
      + pitchInput * ahead * fast, pitchInput - 1.2, pitchInput + 1.25)
    this.pitch = damp(this.pitch, lerp(-.06, travelPitch, cruise)
      - clamp(verticalSpeed * .008, -.04, .06) + landing * .1, 4.5, dt)
    // Reverse flight uses a seated brace instead of leaning past the neck's reach.
    this.pitch = Math.max(-.48, Math.min(1.30, this.pitch))
    this.roll = damp(this.roll, bank * .5 - this.airSide * cruise * lerp(.18, .48, fast), 4, dt)
    this.twist = damp(this.twist, -bank * .13 - this.airSide * cruise * .08, 5, dt)
    this.height = 0
    // Counter-rotate the head so the character looks ahead during a glide.
    this.neck = clamp(-this.pitch * .24, -.3, .12)
    this.head = clamp(-this.pitch * .40, -.52, .15)
    for (let i = 0; i < 2; i++) {
      const sign = i === 0 ? 1 : -1
      const pose = i === 0 ? this.left : this.right
      const trail = Math.sin(this.time * 2.4 + i * 1.3) * .025 * smoothstep(speed, 1, 12)
      // Reference silhouette: one long trailing leg and one softly tucked
      // knee. Keep that asymmetry stable instead of pedalling in midair.
      const leading = lateral > .1 ? smoothstep(sign * this.airSide, -.4, .4) : i === 0 ? 1 : 0
      const tucked = lerp(i === 0 ? 1 : 0, 1 - leading, lateral)
      pose.hip = lerp(.08 - tucked * .34 - launch * .18 + drive * ahead * .06
        - back * cruise * lerp(.20, .46, fast) - leading * lateral * drive * .12 + trail, -.12, landing)
      pose.hipRoll = (-sign * (.025 + lateral * cruise * .08) + this.airSide * cruise * .14 + bank * .04) * (1 - landing)
      pose.knee = lerp(.14 + tucked * .44 + launch * .28 - drive * ahead * .06
        + back * cruise * lerp(.12, .32, fast) + lateral * drive * .10, .24, landing)
      pose.ankle = lerp(.06, -.04, landing)
      pose.ankleRoll = clamp(-pose.hipRoll * .5, -.28, .28)
      pose.foot = lerp(.24 + drive * .1 - tucked * .08 - back * cruise * .18, -.12, landing)
      // Superman silhouette: one fist reaches forward in cruise, the other
      // arm bends alongside the torso; hovering returns to relaxed arms.
      pose.shoulder = lerp(-.12 - drive * ahead * (i === 0 ? 2.55 : .30)
        - back * cruise * lerp(.25, .65, fast) - leading * lateral * drive * .55
        + sign * bank * .14 + breath, -.12, landing)
      pose.shoulderRoll = (-sign * (.025 + lateral * cruise * lerp(.12, .32, fast))
        + bank * .04) * (1 - landing)
      pose.upperArm = -.16 + landing * .16 + sign * bank * .07
      pose.elbow = -.14 - (i === 1 ? drive * ahead * .8 : 0) - back * cruise * .55
        - (1 - leading) * lateral * cruise * lerp(.18, .65, fast)
        - launch * .12 - landing * .18 - sign * bank * .06
      pose.wrist = lerp(-.04, -.06, landing)
    }
  }
}
