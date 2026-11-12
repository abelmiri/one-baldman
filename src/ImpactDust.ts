import * as THREE from 'three'

const CAPACITY = 240

/** Reusable soft dust puffs: one draw call, no per-impact meshes or textures. */
export class ImpactDust {
  readonly mesh: THREE.InstancedMesh
  private texture: THREE.DataTexture
  private opacity = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY), 1)
  private particles = Array.from({ length: CAPACITY }, () => ({
    position: new THREE.Vector3(), velocity: new THREE.Vector3(), age: -1, lifetime: 1, size: 1,
  }))
  private cursor = 0
  private normal = new THREE.Vector3()
  private tangent = new THREE.Vector3()
  private bitangent = new THREE.Vector3()
  private radial = new THREE.Vector3()
  private matrix = new THREE.Matrix4()
  private scale = new THREE.Vector3()

  constructor(scene: THREE.Scene) {
    const size = 64, pixels = new Uint8Array(size * size * 4)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / (size - 1) * 2 - 1, v = y / (size - 1) * 2 - 1
        const radius = Math.hypot(u, v)
        const cloud = .84 + .10 * Math.sin(u * 13 + Math.sin(v * 9)) + .06 * Math.cos(v * 17 - u * 5)
        const alpha = Math.max(0, 1 - radius / cloud) ** 1.4
        pixels.set([255, 255, 255, Math.round(alpha * 255)], (y * size + x) * 4)
      }
    }
    this.texture = new THREE.DataTexture(pixels, size, size)
    this.texture.magFilter = this.texture.minFilter = THREE.LinearFilter
    this.texture.needsUpdate = true
    const geometry = new THREE.PlaneGeometry(1, 1)
    geometry.setAttribute('dustOpacity', this.opacity.setUsage(THREE.DynamicDrawUsage))
    const material = new THREE.ShaderMaterial({
      uniforms: { dustMap: { value: this.texture }, tint: { value: new THREE.Color('#c3aa87') } },
      vertexShader: `attribute float dustOpacity;
        varying vec2 vUv; varying float vOpacity;
        void main() { vUv = uv; vOpacity = dustOpacity;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform sampler2D dustMap; uniform vec3 tint;
        varying vec2 vUv; varying float vOpacity;
        void main() { float alpha = texture2D(dustMap, vUv).a * vOpacity;
          if (alpha < .002) discard;
          gl_FragColor = vec4(tint * mix(.85, 1.12, vUv.y), alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false,
    })
    this.mesh = new THREE.InstancedMesh(geometry, material, CAPACITY)
    this.mesh.name = 'impact-dust'
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.frustumCulled = false
    this.mesh.visible = false
    scene.add(this.mesh)
  }

  burst = (point: THREE.Vector3Like, surfaceNormal: THREE.Vector3Like, speed: number) => {
    if (speed < 1.4) return
    const power = THREE.MathUtils.clamp(Math.sqrt(speed) / 3, .45, 2.6)
    this.normal.copy(surfaceNormal).normalize()
    this.radial.set(Math.abs(this.normal.y) < .9 ? 0 : 1, Math.abs(this.normal.y) < .9 ? 1 : 0, 0)
    this.tangent.crossVectors(this.normal, this.radial).normalize()
    this.bitangent.crossVectors(this.normal, this.tangent)
    const count = Math.round(16 + power * 12)
    for (let i = 0; i < count; i++) {
      const particle = this.particles[this.cursor++ % CAPACITY]
      const angle = Math.random() * Math.PI * 2
      this.radial.copy(this.tangent).multiplyScalar(Math.cos(angle)).addScaledVector(this.bitangent, Math.sin(angle))
      particle.position.copy(point).addScaledVector(this.normal, .06).addScaledVector(this.radial, Math.random() * .16 * power)
      particle.velocity.copy(this.radial).multiplyScalar((.4 + Math.random() * 1.6) * power)
        .addScaledVector(this.normal, (.25 + Math.random() * .8) * power)
      particle.age = 0
      particle.lifetime = .7 + Math.random() * .8
      particle.size = (.45 + Math.random() * .7) * power
    }
    this.mesh.visible = true
  }

  step(dt: number) {
    for (const particle of this.particles) {
      if (particle.age < 0) continue
      particle.age += dt
      if (particle.age >= particle.lifetime) { particle.age = -1; continue }
      particle.velocity.multiplyScalar(Math.exp(-1.8 * dt))
      particle.velocity.y += .28 * dt
      particle.position.addScaledVector(particle.velocity, dt)
    }
  }

  render(camera: THREE.Camera) {
    if (!this.mesh.visible) return
    let active = 0
    for (let i = 0; i < CAPACITY; i++) {
      const particle = this.particles[i]
      const t = particle.age / particle.lifetime
      const alive = particle.age >= 0
      this.scale.setScalar(alive ? particle.size * (1 + t * 2.6) : 0)
      this.matrix.compose(particle.position, camera.quaternion, this.scale)
      this.mesh.setMatrixAt(i, this.matrix)
      this.opacity.setX(i, alive ? (1 - t) ** 2 * THREE.MathUtils.smoothstep(t, 0, .06) : 0)
      if (alive) active++
    }
    this.mesh.visible = active > 0
    this.mesh.instanceMatrix.needsUpdate = true
    this.opacity.needsUpdate = true
  }

  clear() {
    for (const particle of this.particles) particle.age = -1
    this.mesh.visible = false
    this.cursor = 0
  }

  dispose() {
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    const material = this.mesh.material as THREE.Material
    material.dispose()
    this.texture.dispose()
    this.mesh.dispose()
  }
}
