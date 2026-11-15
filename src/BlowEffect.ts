import * as THREE from 'three'

export const BLOW_RANGE = 90

/** A pulsing, widening stream of air projected from the character's mouth. */
export class BlowEffect {
  readonly group = new THREE.Group()
  private material: THREE.ShaderMaterial

  constructor(scene: THREE.Scene) {
    const positions: number[] = []
    const uvs: number[] = []
    const indices: number[] = []
    const rings = 20, sides = 24
    for (let ring = 0; ring <= rings; ring++) {
      const t = ring / rings
      const radius = .12 + t * 10
      for (let side = 0; side <= sides; side++) {
        const angle = side / sides * Math.PI * 2
        positions.push(Math.cos(angle) * radius, Math.sin(angle) * radius, t * BLOW_RANGE)
        uvs.push(side / sides, t)
        if (ring < rings && side < sides) {
          const a = ring * (sides + 1) + side
          const b = a + sides + 1
          indices.push(a, b, a + 1, b, b + 1, a + 1)
        }
      }
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    geometry.setIndex(indices)
    this.material = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 } },
      vertexShader: `varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
      fragmentShader: `uniform float time; varying vec2 vUv;
        void main() {
          float envelope = smoothstep(0., .055, vUv.y) * (1. - smoothstep(.91, 1., vUv.y));
          float wave = .5 + .5 * sin(vUv.y * 96. - time * 12. + sin(vUv.x * 18. + time * 3.) * 2.);
          float streak = .55 + .45 * sin(vUv.x * 42. + vUv.y * 24. - time * 8.);
          float alpha = envelope * (.12 + wave * .2) * streak;
          vec3 color = mix(vec3(.30, .78, 1.), vec3(.91, .98, 1.), wave * .65);
          gl_FragColor = vec4(color, alpha);
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    })
    const stream = new THREE.Mesh(geometry, this.material)
    stream.name = 'super-breath-stream'
    stream.frustumCulled = false
    this.group.name = 'super-breath'
    this.group.visible = false
    this.group.add(stream)
    scene.add(this.group)
  }

  update(dt: number, active: boolean, origin: THREE.Vector3, direction: THREE.Vector3) {
    this.group.visible = active
    if (!active) return
    this.material.uniforms.time.value += dt
    this.group.position.copy(origin)
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction)
  }

  dispose() {
    this.group.removeFromParent()
    this.group.traverse(object => {
      if (object instanceof THREE.Mesh) object.geometry.dispose()
    })
    this.material.dispose()
  }
}
