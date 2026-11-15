import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d'

const MAX_STRETCH = 1.035
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
  private normal = new THREE.Vector3()
  private across = new THREE.Vector3()
  private down = new THREE.Vector3()
  private airVelocity = new THREE.Vector3()
  private relativeAir = new THREE.Vector3()
  private edges: { a: number; b: number; length: number }[] = []
  private columnLengths: Float32Array
  private original: Float32Array
  private dampedVelocities: Float32Array

  constructor(private cloth: RAPIER.SoftBody, private carrier: RAPIER.RigidBody, private count: number) {
    this.original = new Float32Array(cloth.particlePositions())
    this.dampedVelocities = new Float32Array(count * count * 3)
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

  beforeStep(dt: number, wind = 0, windDirection = 0, time = 0) {
    this.carrierVelocity.copy(this.carrier.nextTranslation()).sub(this.carrier.translation()).divideScalar(dt)
    const drag = Math.exp(-.3 * dt)
    const velocities = this.cloth.particleVelocities()
    const positions = this.cloth.particlePositions()
    this.dampedVelocities.set(velocities)
    // Internal fabric friction removes short-wavelength chatter without
    // resisting the cape's shared motion or pulling its folds flat.
    // Read a snapshot so damping is independent of edge traversal order.
    const smoothing = .5 * (1 - Math.exp(-12 * dt))
    for (const { a, b } of this.edges) {
      if (a % this.count === 0 || b % this.count === 0) continue
      for (let axis = 0; axis < 3; axis++) {
        const ai = a * 3 + axis, bi = b * 3 + axis
        const exchange = (velocities[bi] - velocities[ai]) * smoothing
        this.dampedVelocities[ai] += exchange
        this.dampedVelocities[bi] -= exchange
      }
    }
    const angle = windDirection * Math.PI / 180
    const windSpeed = Math.max(0, wind) * .18
    for (let i = 0; i < this.count * this.count; i++) {
      if (i % this.count === 0) continue // Sewn particles are owned by their rigid anchors.
      const column = Math.floor(i / this.count), row = i % this.count
      const exposure = row / (this.count - 1)
      this.velocity.fromArray(this.dampedVelocities, i * 3)
      // Carry most of a fast translation with the wearer to keep the coarse
      // solver stable, retaining inertia instead of instantly matching a stop.
      // The shoulders follow the wearer closely while the hem lags behind,
      // letting starts, braking and turns send a broad wave down the fabric.
      const carry = THREE.MathUtils.lerp(.88, .62, THREE.MathUtils.smoothstep(exposure, 0, 1))
      this.velocity.addScaledVector(this.carrierVelocity, carry)
        .addScaledVector(this.previousCarrierVelocity, -carry)
        .sub(this.carrierVelocity).multiplyScalar(drag).add(this.carrierVelocity)

      // Local surface orientation determines how much air the fabric catches.
      // Centred differences use the physical folds, including during ragdolls.
      this.across.fromArray(positions, (Math.min(column + 1, this.count - 1) * this.count + row) * 3)
        .sub(this.position.fromArray(positions, (Math.max(column - 1, 0) * this.count + row) * 3))
      this.down.fromArray(positions, (column * this.count + Math.min(row + 1, this.count - 1)) * 3)
        .sub(this.position.fromArray(positions, (i - 1) * 3))
      this.normal.crossVectors(this.across, this.down).normalize()
      this.position.fromArray(positions, i * 3)
      // Continuous world-space gusts travel across the cloth; the hem receives
      // more turbulence than the sheltered collar, without random frame noise.
      const phase = time * 2.1 - this.position.x * .65 - this.position.z * .43
      const gust = 1 + .18 * Math.sin(phase) + .08 * Math.sin(phase * 2.37 + this.position.y)
      this.airVelocity.set(Math.cos(angle), 0, Math.sin(angle)).multiplyScalar(windSpeed * gust)
      const flutter = windSpeed * .09 * exposure * Math.sin(phase * 1.73 + column * .41)
      this.airVelocity.x -= Math.sin(angle) * flutter
      this.airVelocity.z += Math.cos(angle) * flutter
      this.airVelocity.y = flutter * .55
      this.relativeAir.copy(this.velocity).sub(this.airVelocity)
      const normalSpeed = this.relativeAir.dot(this.normal)
      // Implicit quadratic drag cannot overshoot the air velocity at full boost.
      // Normal pressure dominates; light tangential drag lets cloth stream out.
      const normalDrag = .85 * Math.abs(normalSpeed) * dt
      const skinDrag = .025 * this.relativeAir.length() * dt
      this.relativeAir.addScaledVector(this.normal, -normalSpeed * normalDrag / (1 + normalDrag))
        .multiplyScalar(1 / (1 + skinDrag))
      this.velocity.copy(this.airVelocity).add(this.relativeAir)
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
    // Leave half a millimetre for Float32 rounding during the subsequent
    // length projections, especially far from the city origin in flight.
    forwardLimit += FORWARD_ALLOWANCE - .0005
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
