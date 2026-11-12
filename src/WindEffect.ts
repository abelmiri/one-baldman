import * as THREE from 'three'

const CAPACITY = 320
const SEGMENTS = 8

/** World-space wind ribbons: fixed buffers, one draw, all animation on the GPU. */
export class WindEffect {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>

  constructor(scene: THREE.Scene) {
    const geometry = new THREE.InstancedBufferGeometry()
    const positions: number[] = [], indices: number[] = []
    for (let i = 0; i <= SEGMENTS; i++) {
      positions.push(i / SEGMENTS, -.5, 0, i / SEGMENTS, .5, 0)
      if (i < SEGMENTS) {
        const a = i * 2
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
      }
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setIndex(indices)
    const seeds = new Float32Array(CAPACITY * 4)
    for (let i = 0; i < CAPACITY; i++) {
      // Deterministic scatter without runtime particle allocation or respawning.
      seeds.set([((i * .754877666) % 1) * 2 - 1,
        ((i * .569840291 + .3) % 1) * 2 - 1,
        ((i * .438579021 + .7) % 1) * 2 - 1, (i * .618033989) % 1], i * 4)
    }
    geometry.setAttribute('windSeed', new THREE.InstancedBufferAttribute(seeds, 4))
    const material = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 }, focus: { value: new THREE.Vector3() },
        wind: { value: new THREE.Vector3() }, strength: { value: 0 },
      },
      vertexShader: `attribute vec4 windSeed;
        uniform float time; uniform vec3 focus; uniform vec3 wind; uniform float strength;
        varying float vAlpha; varying vec2 vUv;
        void main() {
          vec3 extent = vec3(18., 8., 18.);
          float travel = time * .8 + (1. - cos(time * 2.4)) * (.2 / 2.4);
          vec3 center = mod(windSeed.xyz * extent + wind * travel - focus + extent, extent * 2.) - extent;
          vec3 normalizedDistance = abs(center) / extent;
          float edge = 1. - smoothstep(.65, 1., max(max(normalizedDistance.x, normalizedDistance.z), normalizedDistance.y));
          center += focus;
          vec3 direction = normalize(wind);
          vec3 side = normalize(cross(direction, vec3(0., 1., 0.)));
          float ribbonLength = (1.1 + strength * 3.5) * (.65 + windSeed.w * .7);
          vec3 p = center - direction * (1. - position.x) * ribbonLength;
          p += side * sin(position.x * 3.14 + time * 1.4 + windSeed.w * 6.28) * .18 * sin(position.x * 3.14);
          vec3 ribbonSide = cross(normalize(cameraPosition - p), direction);
          ribbonSide /= max(.001, length(ribbonSide));
          p += ribbonSide * position.y * (.035 + strength * .045);
          vUv = vec2(position.x, position.y + .5);
          vAlpha = edge * smoothstep(.15, 1.5, p.y) * (.16 + strength * .18);
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.);
        }`,
      fragmentShader: `varying float vAlpha; varying vec2 vUv;
        void main() {
          float alpha = vAlpha * sin(vUv.x * 3.14159) * (1. - abs(vUv.y * 2. - 1.));
          gl_FragColor = vec4(.83, .94, 1., alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    })
    this.mesh = new THREE.Mesh(geometry, material)
    this.mesh.name = 'directional-wind'
    this.mesh.frustumCulled = false
    this.mesh.visible = false
    scene.add(this.mesh)
  }

  update(time: number, focus: THREE.Vector3, wind: number, direction: number, visible = true) {
    const speed = Math.max(0, wind)
    this.mesh.visible = visible && speed > 0
    if (!this.mesh.visible) return
    const uniforms = this.mesh.material.uniforms
    const strength = Math.min(1, Math.sqrt(speed / 30))
    const angle = THREE.MathUtils.degToRad(direction)
    // Same world axes and gust timing as the forces applied to the cape.
    uniforms.wind.value.set(Math.cos(angle), 0, Math.sin(angle)).multiplyScalar(3 * (1 + speed * .55))
    uniforms.time.value = time
    uniforms.focus.value.copy(focus)
    uniforms.strength.value = strength
    this.mesh.geometry.instanceCount = Math.min(CAPACITY, 2 * Math.round(28 + speed * 4))
  }

  dispose() {
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
  }
}
