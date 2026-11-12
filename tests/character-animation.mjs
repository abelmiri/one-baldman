// Run with: node --experimental-strip-types tests/character-animation.mjs
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { CharacterAnimation } from '../src/CharacterAnimation.ts'

const ground = (_position, normal) => { normal.set(0, 1, 0); return .04 }
const rotation = new THREE.Quaternion()
const results = []
for (const fps of [30, 60, 120]) {
  const animation = new CharacterAnimation()
  const pelvis = new THREE.Vector3(0, 1.23, 0)
  const velocity = new THREE.Vector3()
  const dt = 1 / fps
  const step = (contacts = [true, true]) => {
    pelvis.addScaledVector(velocity, dt)
    animation.walk(dt, pelvis, rotation, 0, velocity, false, 0, 0, ground, contacts)
    for (const pose of [animation.left, animation.right]) {
      assert(Object.values(pose).every(Number.isFinite), 'non-finite joint target')
      assert(pose.knee >= 0 && pose.knee <= 2.45, 'knee outside anatomical limits')
    }
  }
  for (let i = 0; i < fps; i++) step()
  assert(animation.feet.every(f => !f.swinging), 'idle must not step')
  velocity.z = 2.4
  const starts = []
  let firstStep = Infinity, clearance = 0
  for (let i = 0; i < fps * 5; i++) {
    const previous = animation.feet.map(f => ({swinging: f.swinging, position: f.position.clone()}))
    step()
    assert(animation.feet.filter(f => f.swinging).length <= 1, 'walking lost double-support constraint')
    animation.feet.forEach((f, side) => {
      if (f.swinging && !previous[side].swinging) {
        firstStep = Math.min(firstStep, i * dt)
        starts.push(side)
      }
      if (!f.swinging && !previous[side].swinging) {
        assert(f.position.distanceTo(previous[side].position) < 1e-8, 'planted target slid')
      }
      clearance = Math.max(clearance, f.position.y - .265)
    })
  }
  assert(firstStep < .2, 'start dragged both feet before stepping')
  assert(starts.length >= 8 && starts.length <= 12, 'walking cadence does not match speed and stride distance')
  assert(starts.every((side, i) => i === 0 || side !== starts[i - 1]), 'feet did not alternate')
  assert(clearance > .09, 'swing foot did not clear the ground')
  velocity.set(0, 0, 0)
  for (let i = 0; i < fps * 3; i++) step()
  assert(animation.feet.every(f => !f.swinging), 'stopping left a foot in midair')
  assert(Math.abs(animation.left.shoulder) < .02 && Math.abs(animation.right.shoulder) < .02, 'arms did not settle')
  animation.resetFeet()
  velocity.z = 2.4
  for (let i = 0; i < fps; i++) step([false, false])
  assert(animation.feet.every(f => !f.swinging), 'step began without a supporting contact')
  results.push({fps, steps: starts.length, firstStep, clearance})
}

const runningResults = []
for (const fps of [30, 60, 120]) {
  const animation = new CharacterAnimation()
  const pelvis = new THREE.Vector3(0, 1.23, 0)
  const velocity = new THREE.Vector3(0, 0, 6.40332)
  const dt = 1 / fps
  const starts = []
  let clearance = 0, knee = 0, airborne = 0, steadyRun = false
  const step = running => {
    const previous = animation.feet.map(f => ({ initialized: f.initialized, swinging: f.swinging, position: f.position.clone() }))
    pelvis.addScaledVector(velocity, dt)
    animation.walk(dt, pelvis, rotation, 0, velocity, running, 0, 0, ground)
    for (const pose of [animation.left, animation.right]) {
      assert(Object.values(pose).every(Number.isFinite), 'non-finite running pose')
      assert(pose.knee >= 0 && pose.knee <= 2.45, 'running knee outside limits')
      knee = Math.max(knee, pose.knee)
    }
    animation.feet.forEach((foot, side) => {
      if (steadyRun && foot.swinging && foot.progress >= .25 && foot.progress <= .62) {
        const pose = side === 0 ? animation.left : animation.right
        assert(pose.knee > 1.4, 'running recovery locked the knee on a long stride')
        if (foot.progress > .55) assert(pose.hip < -.7, 'running knee drive did not bring the thigh forward')
      }
      if (foot.swinging && !previous[side].swinging) starts.push(side)
      if (previous[side].initialized && !foot.swinging && !previous[side].swinging) {
        assert(foot.position.distanceTo(previous[side].position) < 1e-8, 'running support foot slid')
      }
      clearance = Math.max(clearance, foot.position.y - .265)
    })
    if (animation.feet.every(f => f.swinging)) airborne++
  }
  for (let i = 0; i < fps * 6; i++) {
    steadyRun = i >= fps
    step(true)
  }
  steadyRun = false
  assert(starts.every((side, i) => !i || side !== starts[i - 1]), 'running steps did not alternate')
  assert(starts.length >= 8 && starts.length <= 12, 'running cadence does not match ground speed and doubled stride')
  assert(clearance > .40 && knee > 1.9, 'run lost the reference heel fold and high knee')
  assert(airborne > 0, 'run has no airborne recovery')
  assert(animation.pitch > .2 && animation.left.elbow < -1, 'run lost the forward lean and bent elbows')
  const runSteps = starts.length
  velocity.z = 2.4
  for (let i = 0; i < fps; i++) step(false)
  velocity.set(0, 0, 0)
  for (let i = 0; i < fps * 3; i++) step(false)
  assert(animation.feet.every(f => !f.swinging), 'run-to-idle left a suspended foot')
  assert(Math.abs(animation.left.shoulder) < .02 && Math.abs(animation.right.shoulder) < .02, 'run-to-idle arms did not settle')
  runningResults.push({ fps, steps: runSteps, clearance, knee, airborne })
}

const flight = new CharacterAnimation()
for (const glide of [0, .5, 1]) {
  for (const bank of [-.5, 0, .5]) {
    for (let i = 0; i < 180; i++) flight.fly(1 / 60, glide, 0, bank, 3.5, 0, 0, 11 * glide)
    assert(flight.left.knee > flight.right.knee, 'flight lost its tucked/trailing-leg silhouette')
    for (const pose of [flight.left, flight.right]) {
      assert(Object.values(pose).every(Number.isFinite))
      assert(pose.upperArm < .1, 'flight reverted to outstretched wings')
      assert(pose.shoulder >= -2.8 && pose.shoulder <= .2, 'flight shoulder exceeds anatomical reach')
      assert(Math.abs(pose.wrist) < .15, 'flight fist is not aligned with forearm')
    }
    if (glide === 1) {
      assert(flight.left.shoulder < -2.4, 'cruise must extend the leading fist')
      assert(flight.right.elbow < -.8, 'cruise must tuck the other arm')
      assert(flight.pitch > 1.1, 'cruise must use the Superman horizontal pose')
    }
  }
}
for (let i = 0; i < 120; i++) flight.fly(1 / 60, 0, 0, 0, -1, 0, 1, 0)
assert(Math.abs(flight.left.hip - flight.right.hip) < .01, 'landing legs not aligned')
assert(Math.abs(flight.left.knee - flight.right.knee) < .01, 'landing knees not aligned')
assert(Math.abs(flight.pitch) < .15, 'landing torso not upright')
for (const style of ['back', 'front', 'left', 'right']) {
  for (const progress of [0, .25, .5, .75, 1]) {
    flight.getUp(style, progress)
    assert(Object.values(flight.left).every(Number.isFinite))
    assert(Object.values(flight.right).every(Number.isFinite))
  }
}
console.log(JSON.stringify({passed: true, walking: results, running: runningResults, flight: 'hover, cruise, banks, landing and recovery passed'}, null, 2))
