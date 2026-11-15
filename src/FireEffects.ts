import * as THREE from 'three'

type Fire = { point: THREE.Vector3; age: number; duration: number; size: number; explosion: boolean; anchors?: THREE.Vector3[]; owner?: object }
const MAX_FIRES = 96
const PARTICLES = 36

/** Bounded billboard pool shared by vegetation fires and vehicle explosions. */
export class FireEffects {
  private fires: Fire[] = []
  private mesh: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.ShaderMaterial>
  private pose = new THREE.Object3D()
  private colors = new THREE.InstancedBufferAttribute(new Float32Array(MAX_FIRES * PARTICLES * 4), 4)
  constructor(root: THREE.Group) {
    const geometry = new THREE.PlaneGeometry(1, 1)
    geometry.setAttribute('fireColor', this.colors)
    const material = new THREE.ShaderMaterial({
      vertexShader: `attribute vec4 fireColor; varying vec2 p; varying vec4 tint;
        void main() {
          p = uv * 2.0 - 1.0; tint = fireColor;
          vec4 center = modelViewMatrix * instanceMatrix * vec4(0.,0.,0.,1.);
          center.xy += position.xy * vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz));
          gl_Position = projectionMatrix * center;
        }`,
      fragmentShader: `varying vec2 p; varying vec4 tint;
        void main() {
          float alpha = (1.0 - smoothstep(.15, 1.0, length(p))) * tint.a;
          if (alpha < .005) discard;
          gl_FragColor = vec4(tint.rgb, alpha);
        }`,
      transparent: true, depthWrite: false, toneMapped: false,
    })
    this.mesh = new THREE.InstancedMesh(geometry, material, MAX_FIRES * PARTICLES)
    this.mesh.name = 'vegetation-fire-and-car-explosions'
    this.mesh.userData.worldSpaceEffect = true
    this.mesh.frustumCulled = false
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.colors.setUsage(THREE.DynamicDrawUsage)
    this.mesh.count = 0
    root.add(this.mesh)
  }
  isBurning(owner: object) { return this.fires.some(fire => fire.owner === owner) }

  ignite(point: THREE.Vector3, size: number, explosion = false, anchors?: THREE.Vector3[], owner?: object) {
    if (owner && this.fires.some(fire => fire.owner === owner)) return
    if (!owner && !explosion && this.fires.some(fire => !fire.owner && !fire.explosion && fire.point.distanceToSquared(point) < 6.25)) return
    if (this.fires.length >= MAX_FIRES) this.fires.shift()
    this.fires.push({ point: point.clone(), age: 0, duration: explosion ? 1.2 : 14, size, explosion, anchors, owner })
  }
  update(dt: number) {
    for (const fire of this.fires) fire.age += Math.max(0, dt)
    this.fires = this.fires.filter(fire => fire.age < fire.duration)
    let index = 0
    for (const fire of this.fires) {
      const fade = Math.min(1, (fire.duration - fire.age) / 2)
      for (let i = 0; i < PARTICLES; i++) {
        const phase = (fire.age * (fire.explosion ? .7 : .85) + i * .618) % 1
        const angle = i * 2.4 + fire.age * .3
        const smoke = i >= 24
        const radius = fire.size * (fire.explosion ? fire.age * 3 : .35 + phase * .25)
        const anchor = fire.anchors?.[Math.floor((smoke ? (i - 24) / 12 : i / 24) * fire.anchors.length)]
        this.pose.position.copy(anchor ?? fire.point)
        if (anchor) {
          // Flames remain against the tree; only smoke travels above its surface.
          this.pose.position.x += Math.sin(angle) * fire.size * .08
          this.pose.position.z += Math.cos(angle) * fire.size * .08
          this.pose.position.y += phase * fire.size * (smoke ? 2.5 : .65)
        } else this.pose.position.add(new THREE.Vector3(Math.sin(angle) * radius,
          fire.explosion ? .3 + Math.sin(i * 1.7) * radius : phase * fire.size * (smoke ? 4 : 2), Math.cos(angle) * radius))
        const size = fire.size * (fire.explosion ? .7 + fire.age * 2 : (smoke ? 1.1 : .6) * (1 - phase * .4))
        this.pose.scale.set(size, size * (smoke || fire.explosion ? 1 : 1.8), 1)
        this.pose.updateMatrix()
        this.mesh.setMatrixAt(index, this.pose.matrix)
        this.colors.setXYZW(index++, smoke ? .12 : 1.8, smoke ? .11 : .25 + (1 - phase) * .65,
          smoke ? .1 : .025, fade * (fire.explosion ? 1 - fire.age / fire.duration : (1 - phase) * .85))
      }
    }
    this.mesh.count = index
    if (index) this.mesh.instanceMatrix.needsUpdate = this.colors.needsUpdate = true
  }
  reset() { this.fires.length = 0; this.mesh.count = 0 }
  dispose() {
    this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.mesh.dispose()
  }
}
