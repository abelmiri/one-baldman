import * as THREE from 'three'

/** Bounded camera-only shake: no postprocessing, particles, timers, or per-frame allocations. */
export class ImpactShake {
  private trauma = 0
  private time = 0
  private position = new THREE.Vector3()
  private rotation = new THREE.Quaternion()
  private offset = new THREE.Vector3()
  private angles = new THREE.Euler()
  private delta = new THREE.Quaternion()
  private applied = false

  hit(speed: number) { this.trauma = Math.min(1, this.trauma + THREE.MathUtils.clamp(speed / 180, .2, .5)) }
  clear() { this.trauma = 0 }

  apply(camera: THREE.Camera, dt: number) {
    this.time += Math.max(0, dt)
    this.trauma = Math.max(0, this.trauma - Math.max(0, dt) * 2.8)
    if (this.trauma <= 0) return
    this.position.copy(camera.position); this.rotation.copy(camera.quaternion)
    const strength = this.trauma * this.trauma, t = this.time
    this.offset.set(Math.sin(t * 83) * .065, Math.sin(t * 101 + .7) * .045, 0)
      .multiplyScalar(strength).applyQuaternion(this.rotation)
    this.angles.set(Math.sin(t * 71) * .012 * strength, Math.sin(t * 89 + 2) * .009 * strength, Math.sin(t * 63) * .007 * strength)
    camera.position.add(this.offset)
    camera.quaternion.multiply(this.delta.setFromEuler(this.angles))
    camera.updateMatrixWorld()
    this.applied = true
  }

  restore(camera: THREE.Camera) {
    if (!this.applied) return
    camera.position.copy(this.position); camera.quaternion.copy(this.rotation)
    camera.updateMatrixWorld()
    this.applied = false
  }
}
