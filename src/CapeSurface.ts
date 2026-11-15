import * as THREE from 'three'

// Keep physics inexpensive; a separate smooth surface carries the tailoring.
const SUBDIVISIONS = 3

export class CapeSurface {
  readonly geometry = new THREE.BufferGeometry()
  readonly material: THREE.MeshPhysicalMaterial
  private weave: THREE.DataTexture
  private samples: { indices: number[]; weights: number[] }[] = []
  private count: number
  private columnCount: number
  private particles: Float32Array
  private columns: Float32Array
  private folds: Float32Array
  private rippleSines: Float32Array
  private rippleCosines: Float32Array

  constructor(particleCount: number, subdivisions = SUBDIVISIONS) {
    this.count = (particleCount - 1) * subdivisions + 1
    // Twice as many panels across the cape resolve its narrow vertical folds.
    this.columnCount = (this.count - 1) * 2 + 1
    this.particles = new Float32Array(particleCount * particleCount * 3)
    this.columns = new Float32Array(this.columnCount * particleCount * 3)
    this.folds = new Float32Array(this.columnCount * this.count)
    this.rippleSines = new Float32Array(this.folds.length)
    this.rippleCosines = new Float32Array(this.folds.length)
    const positions = new Float32Array(this.columnCount * this.count * 3)
    const uv = new Float32Array(this.columnCount * this.count * 2)
    const colors = new Float32Array(positions.length)
    const indices: number[] = []
    const color = new THREE.Color()
    for (let column = 0; column < this.columnCount; column++) {
      const u = column / (this.columnCount - 1)
      const coordinate = u * (particleCount - 1)
      const cell = Math.min(Math.floor(coordinate), particleCount - 2)
      const t = coordinate - cell
      // Catmull–Rom interpolation preserves the sewn particle positions.
      this.samples.push({
        indices: [-1, 0, 1, 2].map(offset => THREE.MathUtils.clamp(cell + offset, 0, particleCount - 1)),
        weights: [-.5 * t + t * t - .5 * t ** 3, 1 - 2.5 * t * t + 1.5 * t ** 3,
          .5 * t + 2 * t * t - 1.5 * t ** 3, -.5 * t * t + .5 * t ** 3],
      })
      for (let row = 0; row < this.count; row++) {
        const v = row / (this.count - 1)
        const index = column * this.count + row
        const envelope = THREE.MathUtils.smoothstep(v, .04, .3) * (.45 + .55 * v)
        const fold = Math.cos(u * Math.PI * 8 + .28 * Math.sin(v * 3.7)) * .038
        this.folds[index] = (fold - .052) * envelope
        const ripplePhase = u * Math.PI * 6 - v * 7
        this.rippleSines[index] = Math.sin(ripplePhase) * .012 * v * envelope
        this.rippleCosines[index] = Math.cos(ripplePhase) * .012 * v * envelope
        uv.set([u, v], index * 2)
        // A narrow turned hem and inset seam, in the same crimson fabric.
        const edge = Math.min(u, 1 - u, 1 - v)
        color.set(edge < .009 ? '#9a1923' : edge < .025 ? '#d74a45' : '#ffffff')
        colors.set([color.r, color.g, color.b], index * 3)
        if (column < this.columnCount - 1 && row < this.count - 1) {
          indices.push(index, index + 1, index + this.count, index + 1, index + this.count + 1, index + this.count)
        }
      }
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage))
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(positions.length), 3).setUsage(THREE.DynamicDrawUsage))
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    this.geometry.setIndex(indices)

    // A tiny repeatable woven height map, without an external texture download.
    const size = 64
    const threads = new Uint8Array(size * size * 4)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const grain = ((x * 73 + y * 151 + x * y * 13) % 31) / 31
        const height = 110 + 14 * Math.sin(x * Math.PI / 2) * Math.cos(y * Math.PI / 2) + grain * 8
        const index = (y * size + x) * 4
        threads.set([height, height, height, 255], index)
      }
    }
    this.weave = new THREE.DataTexture(threads, size, size)
    this.weave.wrapS = this.weave.wrapT = THREE.RepeatWrapping
    this.weave.repeat.set(18, 24)
    this.weave.magFilter = THREE.LinearFilter
    this.weave.minFilter = THREE.LinearMipmapLinearFilter
    this.weave.generateMipmaps = true
    this.weave.needsUpdate = true
    this.material = new THREE.MeshPhysicalMaterial({
      color: '#b51e2b', side: THREE.DoubleSide, vertexColors: true,
      roughness: .94, metalness: 0, sheen: 1, sheenColor: '#df5550', sheenRoughness: .9,
      bumpMap: this.weave, bumpScale: .003,
    })
  }

  update(previous: Float32Array, current: Float32Array, alpha: number, time: number) {
    const attribute = this.geometry.getAttribute('position') as THREE.BufferAttribute
    const positions = attribute.array as Float32Array
    const particleCount = Math.sqrt(current.length / 3)
    // Interpolate time once per physics particle, then evaluate the bicubic
    // surface as two four-tap passes. Scratch buffers are reused every frame.
    for (let i = 0; i < current.length; i++) {
      this.particles[i] = previous[i] + (current[i] - previous[i]) * alpha
    }
    for (let column = 0; column < this.columnCount; column++) {
      const across = this.samples[column]
      for (let row = 0; row < particleCount; row++) {
        const output = (column * particleCount + row) * 3
        for (let axis = 0; axis < 3; axis++) {
          let value = 0
          for (let x = 0; x < 4; x++) {
            value += this.particles[(across.indices[x] * particleCount + row) * 3 + axis] * across.weights[x]
          }
          this.columns[output + axis] = value
        }
      }
    }
    for (let column = 0; column < this.columnCount; column++) {
      for (let row = 0; row < this.count; row++) {
        const down = this.samples[row * 2]
        const output = (column * this.count + row) * 3
        for (let axis = 0; axis < 3; axis++) {
          let value = 0
          for (let y = 0; y < 4; y++) {
            value += this.columns[(column * particleCount + down.indices[y]) * 3 + axis] * down.weights[y]
          }
          positions[output + axis] = value
        }
      }
    }
    this.updateNormals(positions)
    const normals = this.geometry.getAttribute('normal')
    const rippleSin = Math.sin(time * 1.65), rippleCos = Math.cos(time * 1.65)
    for (let column = 0; column < this.columnCount; column++) {
      for (let row = 1; row < this.count; row++) {
        const index = column * this.count + row
        // Residual pleats survive still air. Small travelling ripples give the
        // relaxed cloth life; both fade out at the sewn collar and follow its
        // deformed normal through turns, flight and ragdoll motion.
        // The triangle winding points toward the wearer. Keep decorative
        // folds outside the collision surface so the suit cannot poke through.
        // sin(a + t) reuses the spatial phase; only two trig calls per frame.
        const offset = this.folds[index] + this.rippleSines[index] * rippleCos + this.rippleCosines[index] * rippleSin
        for (let axis = 0; axis < 3; axis++) positions[index * 3 + axis] += normals.array[index * 3 + axis] * offset
      }
    }
    attribute.needsUpdate = true
    this.updateNormals(positions)
  }

  private updateNormals(positions: Float32Array) {
    // The topology never changes. Work directly on the packed buffers rather
    // than calling attribute getters/setters for every triangle twice per frame.
    const attribute = this.geometry.getAttribute('normal') as THREE.BufferAttribute
    const normals = attribute.array as Float32Array
    const indices = this.geometry.index!.array
    normals.fill(0)
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3
      const cbx = positions[c] - positions[b], cby = positions[c + 1] - positions[b + 1], cbz = positions[c + 2] - positions[b + 2]
      const abx = positions[a] - positions[b], aby = positions[a + 1] - positions[b + 1], abz = positions[a + 2] - positions[b + 2]
      const nx = cby * abz - cbz * aby, ny = cbz * abx - cbx * abz, nz = cbx * aby - cby * abx
      normals[a] += nx; normals[a + 1] += ny; normals[a + 2] += nz
      normals[b] += nx; normals[b + 1] += ny; normals[b + 2] += nz
      normals[c] += nx; normals[c + 1] += ny; normals[c + 2] += nz
    }
    for (let i = 0; i < normals.length; i += 3) {
      const x = normals[i], y = normals[i + 1], z = normals[i + 2]
      const inverse = 1 / (Math.sqrt(x * x + y * y + z * z) || 1)
      normals[i] *= inverse; normals[i + 1] *= inverse; normals[i + 2] *= inverse
    }
    attribute.needsUpdate = true
  }

  dispose() {
    this.geometry.dispose()
    this.material.dispose()
    this.weave.dispose()
  }
}
