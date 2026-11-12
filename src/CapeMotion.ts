import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d'

const MAX_STRETCH = 1.035
const VERTICAL_AIR_DRAG = .8
// Let the cloth approach the frontmost collar point, but never flip over the wearer.
const FORWARD_ALLOWANCE = .025

/** Simulate flutter relative to the wearer, instead of dragging cloth through a stationary frame. */
export class CapeMotion {
  private carrierVelocity = new THREE.Vector3()
  private previousCarrierVelocity = new THREE.Vector3()
  private velocity = new THREE.Vector3()
  private position = new THREE.Vector3()
  private forward = new THREE.Vector3()
  private carrierRotation = new THREE.Quaternion()
  private carrierPosition = new THREE.Vector3()
  private carrierAngularVelocity = new THREE.Vector3()
  private boundaryVelocity = new THREE.Vector3()
  private particleVelocity = new THREE.Vector3()
  private edges: { a: number; b: number; length: number }[] = []
  private columnLengths: Float32Array
  private original: Float32Array

  constructor(private cloth: RAPIER.SoftBody, private carrier: RAPIER.RigidBody, private count: number) {
    this.original = new Float32Array(cloth.particlePositions())
    this.columnLengths = new Float32Array(count * count)
    const edges = cloth.edges()
    for (let i = 0; i < edges.length / 2; i++) {
      if (cloth.isEdgeBend(i)) continue
      this.edges.push({ a: edges[i * 2], b: edges[i * 2 + 1], length: cloth.edgeRestLength(i) * MAX_STRETCH })
    }
    for (let column = 0; column < count; column++) {
      for (let row = 1; row < count; row++) {
        const i = column * count + row
        this.columnLengths[i] = this.position.fromArray(this.original, i * 3)
          .distanceTo(this.velocity.fromArray(this.original, (i - 1) * 3)) * MAX_STRETCH
      }
    }
  }

  beforeStep(dt: number) {
    this.carrierVelocity.copy(this.carrier.nextTranslation()).sub(this.carrier.translation()).divideScalar(dt)
    const drag = Math.exp(-dt)
    const velocities = this.cloth.particleVelocities()
    for (let i = 0; i < this.count * this.count; i++) {
      if (i % this.count === 0) continue // Sewn particles are owned by their rigid anchors.
      this.velocity.fromArray(velocities, i * 3)
      this.velocity.sub(this.previousCarrierVelocity).multiplyScalar(drag)
        .addScaledVector(this.carrierVelocity, -.35 * dt).add(this.carrierVelocity)
      // Resist vertical motion through still air in world space. Carrier-frame
      // damping alone carries the cape down with the body instead of letting
      // the hem trail upward in freefall. This quadratic drag update stays
      // stable at high descent speeds and also lets the cape settle on landing.
      this.velocity.y /= 1 + VERTICAL_AIR_DRAG * Math.abs(this.velocity.y) * dt
      this.cloth.setParticleVelocity(i, this.velocity)
    }
    this.previousCarrierVelocity.copy(this.carrierVelocity)
  }

  afterStep(dt: number) {
    const positions = this.cloth.particlePositions()
    this.original.set(positions)
    this.carrierPosition.copy(this.carrier.translation())
    this.carrierAngularVelocity.copy(this.carrier.angvel())
    this.forward.set(0, 0, 1).applyQuaternion(this.carrierRotation.copy(this.carrier.rotation()))
    // Use the sewn collar to define a rear half-space in the chest's frame.
    // It follows pitch, banking and ragdoll rotation instead of world axes.
    let forwardLimit = -Infinity
    for (let column = 0; column < this.count; column++) {
      this.position.fromArray(positions, column * this.count * 3).sub(this.carrierPosition)
      forwardLimit = Math.max(forwardLimit, this.position.dot(this.forward))
    }
    forwardLimit += FORWARD_ALLOWANCE
    for (let i = 0; i < this.count * this.count; i++) {
      if (i % this.count === 0) continue
      const at = i * 3
      this.position.fromArray(positions, at)
      const excess = this.velocity.copy(this.position).sub(this.carrierPosition).dot(this.forward) - forwardLimit
      if (excess > 0) this.position.addScaledVector(this.forward, -excess).toArray(positions, at)
    }
    // The following length corrections only move points toward their neighbors,
    // so they preserve this half-space, including at the fixed collar.
    // Tension-only constraints preserve folds and prevent rubber-like extension.
    for (let pass = 0; pass < 8; pass++) {
      for (const { a, b, length } of this.edges) {
        const ai = a * 3, bi = b * 3
        const dx = positions[bi] - positions[ai], dy = positions[bi + 1] - positions[ai + 1], dz = positions[bi + 2] - positions[ai + 2]
        const distanceSq = dx * dx + dy * dy + dz * dz
        if (distanceSq <= length * length) continue
        const wa = a % this.count === 0 ? 0 : 1, wb = b % this.count === 0 ? 0 : 1
        if (wa + wb === 0) continue
        const correction = (1 - length / Math.sqrt(distanceSq)) / (wa + wb)
        for (let axis = 0; axis < 3; axis++) {
          const delta = (positions[bi + axis] - positions[ai + axis]) * correction
          positions[ai + axis] += delta * wa
          positions[bi + axis] -= delta * wb
        }
      }
    }
    // A final collar-to-hem pass gives every column a strict length limit,
    // including abrupt stops, dives and changes of direction at full boost.
    for (let column = 0; column < this.count; column++) {
      for (let row = 1; row < this.count; row++) {
        const i = column * this.count + row, at = i * 3, parent = at - 3
        this.position.fromArray(positions, at).sub(this.velocity.fromArray(positions, parent))
        if (this.position.lengthSq() > this.columnLengths[i] ** 2) {
          this.position.setLength(this.columnLengths[i]).add(this.velocity).toArray(positions, at)
        }
      }
    }
    const velocities = this.cloth.particleVelocities()
    for (let i = 0; i < this.count * this.count; i++) {
      if (i % this.count === 0) continue
      const at = i * 3
      this.position.fromArray(positions, at)
      this.velocity.fromArray(this.original, at).sub(this.position)
      const corrected = this.velocity.lengthSq() >= 1e-12
      const atBoundary = this.boundaryVelocity.copy(this.position).sub(this.carrierPosition)
        .dot(this.forward) >= forwardLimit - 1e-5
      if (!corrected && !atBoundary) continue
      if (corrected) this.cloth.setParticlePosition(i, this.position)
      this.particleVelocity.fromArray(velocities, at)
      if (corrected) {
        this.particleVelocity.addScaledVector(this.velocity, -.5 / dt).sub(this.carrierVelocity)
          .clampLength(0, 18).add(this.carrierVelocity)
      }
      if (atBoundary) {
        // Stop only forward motion relative to the moving, rotating boundary;
        // retain tangential flutter and allow the cloth to fall back freely.
        this.boundaryVelocity.cross(this.carrierAngularVelocity).negate().add(this.carrierVelocity)
        const forwardSpeed = this.velocity.copy(this.particleVelocity).sub(this.boundaryVelocity).dot(this.forward)
        if (forwardSpeed > 0) this.particleVelocity.addScaledVector(this.forward, -forwardSpeed)
      }
      this.cloth.setParticleVelocity(i, this.particleVelocity)
    }
  }
}
