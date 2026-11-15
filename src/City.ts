import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d'
import { CityTextures, type CitySurface } from './CityTextures'
import { LaserDestruction, type Destructible, type DestructiblePart } from './LaserDestruction'
import { buildingShell, type ShellCell } from './BuildingShell'
import { CameraOcclusion } from './CameraOcclusion'

type Shape = 'box' | 'sphere' | 'rock' | 'cylinder' | 'cone' | 'roof' | 'dome'
type Instance = DestructiblePart & { surface: CitySurface | null; buildingOwner?: Destructible }
type BuildingBounds = { origin: THREE.Vector3; inverseRotation: THREE.Quaternion; bounds: THREE.Box3 }
type Obstacle = { center: THREE.Vector3; half: THREE.Vector3; rotation: THREE.Quaternion; inverse: THREE.Quaternion; shape: RAPIER.Shape; landing: boolean; order: number; owner?: Destructible }
const CELL_SIZE = 12
const RENDER_CELL_SIZE = 64
export const CITY_SCALE = 2.25
const cellKey = (x: number, z: number) => (x + 1024) * 2048 + z + 1024
const C = {
  grass: '#64883b', lawn: '#719742', hedge: '#365e30', leaf: '#40752f', lime: '#729e35',
  bark: '#765039', stone: '#d9cbb1', path: '#d5c6a8', road: '#555a61', white: '#f3ead5',
  trim: '#eddfc3', glass: '#355966', roof: '#526574', brick: '#b77452', metal: '#344b4b',
}

/** A deterministic, instanced, world-scale interpretation of the reference map. */
export class City {
  readonly root = new THREE.Group()
  readonly destruction: LaserDestruction
  private structureOwner?: Destructible
  private batches = new Map<Shape, Instance[]>()
  private occlusion = new CameraOcclusion()
  private occlusionFragments: THREE.Mesh[] = []
  private buildingBounds = new WeakMap<Destructible, BuildingBounds>()
  private obstacles: Obstacle[] = []
  private obstacleCells = new Map<number, Obstacle[]>()
  private candidates: Obstacle[] = []
  private candidateSet = new Set<Obstacle>()
  private local = new THREE.Vector3()
  private localStep = new THREE.Vector3()
  private travelStep = new THREE.Vector3()
  private supportRay = new RAPIER.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0))
  private routePoint = new THREE.Vector3()
  private routeTangent = new THREE.Vector3()
  private geometries: Record<Shape, THREE.BufferGeometry> = {
    box: new THREE.BoxGeometry(1, 1, 1), sphere: new THREE.SphereGeometry(1, 8, 6),
    rock: new THREE.IcosahedronGeometry(1, 1), cylinder: new THREE.CylinderGeometry(1, 1, 1, 12),
    cone: new THREE.ConeGeometry(1, 1, 8), dome: new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    roof: this.roofGeometry(),
  }
  private material = new THREE.MeshStandardMaterial({ roughness: .84, metalness: .02 })
  private textures: CityTextures
  private transform = new THREE.Matrix4()
  private randomState = 7319
  private shellLayouts = new Map<string, ShellCell[]>()
  private water: THREE.ShaderMaterial
  private lamps: THREE.MeshStandardMaterial
  private glow = new THREE.MeshBasicMaterial({ color: '#ffc773', transparent: true, opacity: 0, depthWrite: false })
  private nightLights: THREE.PointLight[] = []
  private jets: THREE.Points
  private traffic: { mesh: THREE.Group; offset: number; speed: number; owner: Destructible; body?: RAPIER.RigidBody }[] = []
  private route: THREE.CurvePath<THREE.Vector3>

  constructor(scene: THREE.Scene, anisotropy = 1, invalidate: () => void = () => {},
    dust?: (point: THREE.Vector3Like, normal: THREE.Vector3Like, speed: number) => void) {
    this.destruction = new LaserDestruction(this.root, dust)
    this.textures = new CityTextures(anisotropy, invalidate)
    this.root.name = 'Reference city'
    this.transform.makeScale(CITY_SCALE, CITY_SCALE, CITY_SCALE)
    scene.add(this.root)
    this.water = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, night: { value: 0 } },
      vertexShader: `varying vec3 world; uniform float time;
        void main() { vec3 p = position; vec4 w = modelMatrix * vec4(p, 1.);
          w.y += .065 * sin(w.x * .55 + time) * cos(w.z * .48 + time * .7);
          world = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `varying vec3 world; uniform float time; uniform float night;
        void main() { vec2 p = world.xz;
          float wave = sin(p.x * .7 + sin(p.y * .32 + time) * 1.8 + time * 1.2);
          float detail = sin(p.y * 1.3 - p.x * .6 + time * .9);
          float crest = smoothstep(.91, 1., wave * detail);
          vec3 c = mix(vec3(.012,.19,.24), vec3(.02,.34,.4), .5 + .16 * wave);
          c += crest * .045; c *= mix(1., .32, night);
          gl_FragColor = vec4(c,1.);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    })
    this.lamps = new THREE.MeshStandardMaterial({ color: '#ffe2a2', emissive: '#ffc569', emissiveIntensity: .35 })
    this.route = this.roundedRoute(83, 21)
    this.terrain()
    this.streets()
    this.civicQuarter()
    this.park()
    this.neighborhoods()
    this.landscaping()
    this.streetFurniture()
    this.bridge()
    // These standalone meshes and lights are built outside the instanced transform.
    for (const object of this.root.children) {
      object.position.multiplyScalar(CITY_SCALE)
      object.scale.multiplyScalar(CITY_SCALE)
      if (object instanceof THREE.PointLight) object.distance *= CITY_SCALE
    }
    this.flush()
    this.createTraffic()
    const drops = new Float32Array(120 * 3)
    const dropPositions = new THREE.BufferAttribute(drops, 3).setUsage(THREE.DynamicDrawUsage)
    this.jets = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', dropPositions),
      new THREE.PointsMaterial({ color: '#b8eff0', size: .13, transparent: true, opacity: .8 }))
    this.jets.frustumCulled = false
    this.root.add(this.jets)
    // The city is static; only car roots and fountain vertices change at runtime.
    this.root.traverse(object => { object.updateMatrix(); object.matrixAutoUpdate = false })
    this.traffic.forEach(car => { car.mesh.matrixAutoUpdate = true })
  }

  private rand() {
    this.randomState = (Math.imul(this.randomState, 1664525) + 1013904223) >>> 0
    return this.randomState / 4294967296
  }

  private at(x: number, z: number, rotation: number, build: () => void) {
    const previous = this.transform
    this.transform = previous.clone().multiply(new THREE.Matrix4().makeTranslation(x, 0, z))
      .multiply(new THREE.Matrix4().makeRotationY(rotation))
    build()
    this.transform = previous
  }

  private put(shape: Shape, color: string, x: number, y: number, z: number,
    sx: number, sy: number, sz: number, rotation = 0, surface: CitySurface | null = null, cameraWall = false) {
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rotation), new THREE.Vector3(sx, sy, sz))
    matrix.premultiply(this.transform)
    if (!this.batches.has(shape)) this.batches.set(shape, [])
    const buildingOwner = cameraWall && this.structureOwner?.kind === 'building' ? this.structureOwner : undefined
    const instance = { matrix, color: new THREE.Color(color), surface, geometry: this.geometries[shape],
      buildingOwner }
    this.batches.get(shape)!.push(instance)
    // Ground paths stay in the static city even when the structure above is cut.
    if (this.structureOwner && y + sy / 2 > .3) this.structureOwner.parts.push(instance)
  }

  private structure(kind: Destructible['kind'], build: () => void) {
    const previous = this.structureOwner
    const owner = this.destruction.create(kind)
    this.structureOwner = owner
    build()
    this.structureOwner = previous
    return owner
  }

  private surfaceForColor(color: string): CitySurface | null {
    if (color === C.road) return 'asphalt'
    if (color === C.grass || color === C.lawn) return 'grass'
    if (color === C.stone || color === C.path) return 'paving'
    return null
  }

  private box(color: string, x: number, y: number, z: number, w: number, h: number, d: number,
    rotation = 0, surface = this.surfaceForColor(color)) {
    if (this.isBuildingVolume(w, h, d)) {
      const owner = this.structureOwner
      if (owner && !this.buildingBounds.has(owner)) {
        const parentPosition = new THREE.Vector3()
        const parentRotation = new THREE.Quaternion()
        this.transform.decompose(parentPosition, parentRotation, new THREE.Vector3())
        const localRotation = new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rotation)
        const center = new THREE.Vector3(x, y, z).applyMatrix4(this.transform)
        const inverseRotation = parentRotation.multiply(localRotation).invert()
        const wall = .24
        const bounds = new THREE.Box3(
          new THREE.Vector3(-w / 2 + wall, -h / 2 + .12, -d / 2 + wall).multiplyScalar(CITY_SCALE),
          new THREE.Vector3(w / 2 - wall, h / 2 - .24, d / 2 - wall).multiplyScalar(CITY_SCALE))
        this.buildingBounds.set(owner, { origin: center, inverseRotation, bounds })
      }
      const cosine = Math.cos(rotation), sine = Math.sin(rotation)
      for (const cell of this.shellLayout(w, h, d, y - h / 2 > .1)) this.put('box',
        cell.role === 'wall' ? color : cell.role === 'floor' ? '#a29782' : '#c8bea9',
        x + cosine * cell.x + sine * cell.z, y + cell.y, z - sine * cell.x + cosine * cell.z,
        cell.w, cell.h, cell.d, rotation, cell.role === 'wall' ? surface : null, cell.role === 'wall')
      return
    }
    this.put('box', color, x, y, z, w, h, d, rotation, surface)
  }

  private isBuildingVolume(w: number, h: number, d: number) {
    return this.structureOwner?.kind === 'building' && w >= 4 && d >= 4 && h >= 2
  }

  private shellLayout(w: number, h: number, d: number, includeBase: boolean) {
    const key = `${w},${h},${d},${includeBase}`
    let cells = this.shellLayouts.get(key)
    if (!cells) { cells = buildingShell(w, h, d, includeBase); this.shellLayouts.set(key, cells) }
    return cells
  }

  private obstacle(x: number, y: number, z: number, w: number, h: number, d: number, landing = false, geometry: Shape = 'box') {
    if (geometry === 'box' && this.isBuildingVolume(w, h, d)) {
      for (const cell of this.shellLayout(w, h, d, y - h / 2 > .1)) this.obstacle(x + cell.x, y + cell.y, z + cell.z,
        cell.w, cell.h, cell.d, cell.role === 'floor')
      return
    }
    const center = new THREE.Vector3(x, y, z).applyMatrix4(this.transform)
    const rotation = new THREE.Quaternion()
    this.transform.decompose(new THREE.Vector3(), rotation, new THREE.Vector3())
    const half = new THREE.Vector3(w / 2, h / 2, d / 2).multiplyScalar(CITY_SCALE)
    let shape: RAPIER.Shape = new RAPIER.Cuboid(half.x, half.y, half.z)
    if (geometry !== 'box') {
      // Build the collider from the same vertices and scale as the visible roof.
      const source = this.geometries[geometry].getAttribute('position')
      const vertices = new Float32Array(source.count * 3)
      const bounds = new THREE.Box3()
      for (let i = 0; i < source.count; i++) {
        const point = new THREE.Vector3(source.getX(i) * w, source.getY(i) * h, source.getZ(i) * d).multiplyScalar(CITY_SCALE)
        point.toArray(vertices, i * 3)
        bounds.expandByPoint(point)
      }
      const offset = bounds.getCenter(new THREE.Vector3())
      bounds.getSize(half).multiplyScalar(.5)
      center.add(offset.clone().applyQuaternion(rotation))
      for (let i = 0; i < source.count; i++) {
        vertices[i * 3] -= offset.x
        vertices[i * 3 + 1] -= offset.y
        vertices[i * 3 + 2] -= offset.z
      }
      shape = new RAPIER.ConvexPolyhedron(vertices)
    }
    const obstacle = { center, half, rotation, inverse: rotation.clone().invert(), shape, landing, order: this.obstacles.length, owner: this.structureOwner }
    this.obstacles.push(obstacle)
    // Insert the rotated footprint into every overlapped cell, including long walls.
    const e = new THREE.Matrix4().makeRotationFromQuaternion(rotation).elements
    const extentX = Math.abs(e[0]) * half.x + Math.abs(e[8]) * half.z
    const extentZ = Math.abs(e[2]) * half.x + Math.abs(e[10]) * half.z
    for (let xCell = Math.floor((center.x - extentX) / CELL_SIZE); xCell <= Math.floor((center.x + extentX) / CELL_SIZE); xCell++) {
      for (let zCell = Math.floor((center.z - extentZ) / CELL_SIZE); zCell <= Math.floor((center.z + extentZ) / CELL_SIZE); zCell++) {
        const key = cellKey(xCell, zCell)
        if (!this.obstacleCells.has(key)) this.obstacleCells.set(key, [])
        this.obstacleCells.get(key)!.push(obstacle)
      }
    }
  }

  private roundShape(w: number, d: number, r: number) {
    const s = new THREE.Shape(), x = -w / 2, y = -d / 2
    s.moveTo(x + r, y); s.lineTo(x + w - r, y)
    s.quadraticCurveTo(x + w, y, x + w, y + r); s.lineTo(x + w, y + d - r)
    s.quadraticCurveTo(x + w, y + d, x + w - r, y + d); s.lineTo(x + r, y + d)
    s.quadraticCurveTo(x, y + d, x, y + d - r); s.lineTo(x, y + r)
    s.quadraticCurveTo(x, y, x + r, y)
    return s
  }

  private surface(shape: THREE.Shape, color: string, y: number, x = 0, z = 0) {
    const geometry = new THREE.ShapeGeometry(shape, 24)
    const surface = this.surfaceForColor(color)
    const mesh = new THREE.Mesh(surface ? this.textures.apply(geometry, surface) : geometry,
      surface ? this.textures.surfaceMaterial(color) : new THREE.MeshStandardMaterial({ color, roughness: .95 }))
    mesh.rotation.x = -Math.PI / 2
    mesh.position.set(x, y, z)
    mesh.receiveShadow = true
    this.root.add(mesh)
    return mesh
  }

  private roundedRoute(half: number, radius: number) {
    const path = new THREE.CurvePath<THREE.Vector3>(), b = half - radius
    const v = (x: number, z: number) => new THREE.Vector3(x, 0, z)
    path.add(new THREE.LineCurve3(v(-b, -half), v(b, -half)))
    path.add(new THREE.QuadraticBezierCurve3(v(b, -half), v(half, -half), v(half, -b)))
    path.add(new THREE.LineCurve3(v(half, -b), v(half, b)))
    path.add(new THREE.QuadraticBezierCurve3(v(half, b), v(half, half), v(b, half)))
    path.add(new THREE.LineCurve3(v(b, half), v(-b, half)))
    path.add(new THREE.QuadraticBezierCurve3(v(-b, half), v(-half, half), v(-half, b)))
    path.add(new THREE.LineCurve3(v(-half, b), v(-half, -b)))
    path.add(new THREE.QuadraticBezierCurve3(v(-half, -b), v(-half, -half), v(-b, -half)))
    return path
  }

  private terrain() {
    const ocean = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400, 80, 80), this.water)
    ocean.rotation.x = -Math.PI / 2
    ocean.position.y = -2.2
    this.root.add(ocean)
    const island = this.roundShape(202, 202, 33)
    const land = new THREE.Mesh(this.textures.apply(new THREE.ExtrudeGeometry(island,
      { depth: 2.5, bevelEnabled: false, curveSegments: 32 }), 'grass'), this.textures.surfaceMaterial(C.grass))
    land.rotation.x = -Math.PI / 2
    land.position.y = -2.62
    land.receiveShadow = true
    this.root.add(land)
    const coast = this.roundedRoute(99, 31)
    for (let i = 0; i < 250; i++) {
      const p = coast.getPointAt(i / 250)
      const size = 1 + this.rand() * 1.5
      this.put('rock', ['#a5a69a', '#bab6a3', '#8e968c'][i % 3], p.x, -1.1 + this.rand() * .4, p.z,
        size * 1.4, size, size, this.rand() * 6)
      if (i % 3 === 0) {
        const inland = p.clone().multiplyScalar(.945)
        if (!(inland.x > 66 && inland.z > 65)) this.tree(inland.x, inland.z, .65 + this.rand() * .3)
      }
    }
    // Low invisible coast guard follows the actual shoreline instead of an infinite floor.
    for (let i = 0; i < 96; i++) {
      const a = coast.getPointAt(i / 96), b = coast.getPointAt((i + 1) / 96)
      const bridgeDistance = Math.abs(.5 * (a.x - 94) + .866 * (a.z - 89))
      if (a.x > 70 && a.z > 70 && bridgeDistance < 5.5) continue
      this.at((a.x + b.x) / 2, (a.z + b.z) / 2, Math.atan2(b.x - a.x, b.z - a.z), () =>
        this.obstacle(0, 35, 0, .7, 80, a.distanceTo(b) + .2))
    }
    for (let i = 0; i < 280; i++) {
      const side = i % 4, along = this.rand() * 166 - 83, outer = 91 + this.rand() * 4
      const x = side < 2 ? along : (side === 2 ? -outer : outer)
      const z = side < 2 ? (side === 0 ? -outer : outer) : along
      if (x > 73 && z > 72) continue
      this.put('sphere', i % 4 ? C.lime : '#e4cc78', x, .12, z, .18, .18, .18)
    }
  }

  private streets() {
    const sidewalk = this.roundShape(179, 179, 26)
    sidewalk.holes.push(new THREE.Path(this.roundShape(155, 155, 14).getPoints(32).reverse()))
    this.surface(sidewalk, C.stone, -.07)
    const road = this.roundShape(174, 174, 23)
    road.holes.push(new THREE.Path(this.roundShape(158, 158, 15).getPoints(32).reverse()))
    this.surface(road, C.road, -.045)
    const intersections = [-42, 17, 61]
    for (const z of [-31, 15, 57]) {
      const start = z === 57 ? -42 : -83, end = z === 57 ? 61 : 83
      this.box(C.stone, (start + end) / 2, -.08, z, end - start, .1, 12)
      this.box(C.road, (start + end) / 2, -.015, z, end - start, .04, 8)
      for (let x = start + 2; x < end; x += 5) {
        if (intersections.some(ix => Math.abs(x - ix) < 7)) continue
        this.box('#e8d59a', x, .012, z, 2.4, .015, .10)
      }
      for (const edge of [-3.65, 3.65]) this.box(C.white, (start + end) / 2, .012, z + edge, end - start, .015, .09)
    }
    for (const [x, start, end] of [[-42, -83, 83], [17, -31, 57], [61, 15, 83], [48, -83, -31]]) {
      this.box(C.stone, x, -.07, (start + end) / 2, 12, .1, end - start)
      this.box(C.road, x, .015, (start + end) / 2, 8, .04, end - start)
      for (let z = start + 3; z < end; z += 5) {
        if ([-31, 15, 57].some(iz => Math.abs(z - iz) < 7)) continue
        this.box('#e8d59a', x, .043, z, .1, .015, 2.4)
      }
      for (const edge of [-3.65, 3.65]) this.box(C.white, x + edge, .043, (start + end) / 2, .09, .015, end - start)
    }
    for (let i = 0; i < 122; i++) {
      const p = this.route.getPointAt(i / 122), tangent = this.route.getTangentAt(i / 122)
      if ([-31, 15].some(z => Math.abs(z - p.z) < 6) || Math.abs(p.x + 42) < 6) continue
      this.box(C.white, p.x, .01, p.z, .1, .015, 2.2, Math.atan2(tangent.x, tangent.z))
    }
    for (const [x, z] of [[-42, -31], [17, -31], [48, -31], [-42, 15], [17, 15], [61, 15], [-42, 57], [17, 57], [61, 57]]) {
      for (const side of [-1, 1]) {
        for (let i = -3; i <= 3; i++) {
          this.box(C.white, x + i * .95, .065, z + side * 5.5, .48, .018, 2.2)
          if (z !== -31 || x === -42) this.box(C.white, x + side * 5.5, .067, z + i * .95, 2.2, .018, .48)
        }
      }
    }
    const plots = [[-64, -57, 28, 38], [5, -57, 72, 38], [64, -57, 24, 38], [-64, -8, 28, 32],
      [-12, -8, 46, 32], [48, -8, 50, 32], [-64, 43, 28, 44], [-12, 36, 46, 28],
      [39, 36, 29, 28], [72, 45, 12, 48], [9, 70, 86, 14]]
    for (const [x, z, w, d] of plots) {
      this.surface(this.roundShape(w + 2, d + 2, 2), C.path, -.025, x, z)
      this.surface(this.roundShape(w - 1, d - 1, 1.5), C.lawn, -.005, x, z)
    }
  }

  private tree(x: number, z: number, scale = 1, blossom = false) {
    scale *= 1.3
    this.structure('tree', () => this.at(x, z, this.rand() * 6, () => {
      this.put('cylinder', C.bark, 0, 1.45 * scale, 0, .34 * scale, 3 * scale, .34 * scale)
      const greens = blossom ? ['#e9a0b4', '#d87f9f', '#f0b3c4'] : [C.leaf, C.lime, '#639343']
      for (let i = 0; i < 6; i++) {
        const angle = i * 2.4, radius = i ? .9 * scale : 0
        this.put('rock', greens[i % 3], Math.sin(angle) * radius, (3.15 + (i % 3) * .5) * scale,
          Math.cos(angle) * radius, 1.4 * scale, (1.3 + this.rand() * .5) * scale, 1.4 * scale)
      }
      this.obstacle(0, 1.3 * scale, 0, .55 * scale, 3 * scale, .55 * scale)
    }))
  }

  private hedge(x: number, z: number, w: number, d: number) {
    this.box(C.hedge, x, .42, z, w, .9, d)
    for (let i = 0; i < Math.ceil(w / 1.3); i++) {
      this.put('rock', C.leaf, x - w / 2 + (i + .5) * w / Math.ceil(w / 1.3), .8, z, .8, .48, d * .6)
    }
  }

  private flowers(x: number, z: number, length: number) {
    this.box('#6d7b3b', x, .06, z, length, .15, .9)
    for (let i = 0; i < length * 3; i++) {
      this.put('sphere', ['#df9fb5', '#f5d792', '#ede4ca'][i % 3], x - length / 2 + this.rand() * length,
        .25 + this.rand() * .25, z + (this.rand() - .5) * .7, .17, .2, .17)
    }
  }

  private bench(x: number, z: number, angle = 0) {
    this.at(x, z, angle, () => {
      for (const dx of [-.85, .85]) this.box(C.metal, dx, .38, 0, .12, .8, .75)
      for (let i = 0; i < 4; i++) this.box('#aa7951', 0, .78, -.3 + i * .2, 2.3, .12, .15)
      for (let i = 0; i < 3; i++) this.box('#b48a60', 0, 1.1 + i * .2, -.38, 2.3, .15, .1)
      this.obstacle(0, .7, 0, 2.3, 1.4, .9)
    })
  }

  private window(x: number, y: number, z: number, w = 1, h = 1.6) {
    this.put('box', C.trim, x, y, z, w + .24, h + .24, .16, 0, null, true)
    this.put('box', C.glass, x, y, z + .09, w, h, .08, 0, null, true)
    this.put('box', '#a6bbba', x - w * .16, y + h * .07, z + .14, .08, h * .78, .025, 0, null, true)
    this.put('box', C.trim, x, y, z + .15, w + .04, .07, .04, 0, null, true)
    this.put('box', C.trim, x, y - h / 2 - .08, z + .15, w + .4, .16, .35, 0, null, true)
  }

  private building(x: number, z: number, w: number, d: number, floors: number, color: string, shops = false) {
    this.structure('building', () => this.at(x, z, 0, () => {
      const h = floors * 2.9 + .6
      this.box(color, 0, h / 2, 0, w, h, d, 0, 'plaster')
      this.obstacle(0, h / 2, 0, w, h, d, true)
      for (let f = 0; f < floors; f++) {
        for (const side of [-1, 1]) {
          this.at(0, 0, side === 1 ? 0 : Math.PI, () => {
            for (let dx = -w / 2 + 1.7; dx < w / 2 - .6; dx += 2.7) {
              if (shops && f === 0) continue
              this.window(dx, 1.7 + f * 2.9, d / 2 + .05, 1.25, 1.7)
            }
          })
          this.at(side * w / 2, 0, side * Math.PI / 2, () => {
            for (let dx = -d / 2 + 1.6; dx < d / 2 - .5; dx += 2.8) this.window(dx, 1.7 + f * 2.9, .04, 1.1, 1.65)
          })
        }
        if (f > 0) this.box(C.trim, 0, f * 2.9 + .2, 0, w + .18, .15, d + .18)
      }
      this.box('#71767a', 0, h + .1, 0, w + .45, .3, d + .45)
      this.box('#a7a39b', 0, h + .28, 0, w - .6, .12, d - .6)
      this.obstacle(0, h + .1, 0, w + .45, .3, d + .45, true)
      this.obstacle(0, h + .28, 0, w - .6, .12, d - .6, true)
      for (const side of [-1, 1]) {
        this.box(C.trim, side * (w / 2 + .1), h + .47, 0, .2, .55, d + .4)
        this.box(C.trim, 0, h + .47, side * (d / 2 + .1), w + .4, .55, .2)
        this.obstacle(side * (w / 2 + .1), h + .47, 0, .2, .55, d + .4, true)
        this.obstacle(0, h + .47, side * (d / 2 + .1), w + .4, .55, .2, true)
      }
      for (let i = 0; i < Math.max(1, w / 4); i++) {
        const dx = -w / 3 + i * 2.9
        this.box('#d0cbc0', dx, h + .65, -d * .15, 1.5, .8, 1.5)
        this.put('cylinder', '#646c6a', dx, h + 1.08, -d * .15, .43, .08, .43)
        this.obstacle(dx, h + .65, -d * .15, 1.5, .8, 1.5, true)
        this.obstacle(dx, h + 1.08, -d * .15, .43, .08, .43, true, 'cylinder')
        for (let j = 0; j < 4; j++) this.box('#898b82', dx, h + .62 + j * .12, -d * .15 + .77, 1.2, .04, .02)
      }
      this.box(C.trim, 0, 1.4, d / 2 + .13, 1.8, 2.8, .22)
      this.box('#354a49', 0, 1.25, d / 2 + .28, 1.35, 2.5, .1)
      if (shops) {
        this.box(C.glass, 0, 1.4, d / 2 + .18, w - .9, 2.5, .12)
        for (let dx = -w / 2 + .5; dx < w / 2; dx += 1.65) this.box(C.trim, dx, 1.4, d / 2 + .27, .1, 2.6, .12)
        const awning = ['#b95750', '#2c8279', '#e5ad48', '#508e84', '#c66957'][Math.floor(x / 10 + 10) % 5]
        for (let i = 0; i < Math.ceil(w / .55); i++) {
          this.box(i % 2 ? C.white : awning, -w / 2 + (i + .5) * w / Math.ceil(w / .55), 3.03, d / 2 + .9,
            w / Math.ceil(w / .55), .17, 1.8)
          this.box(i % 2 ? C.white : awning, -w / 2 + (i + .5) * w / Math.ceil(w / .55), 2.83, d / 2 + 1.75,
            w / Math.ceil(w / .55), .4, .1)
        }
      }
    }))
  }

  private house(x: number, z: number, color: string, roof: string, angle = 0, yardDepth = 9.7) {
    this.structure('building', () => this.at(x, z, angle, () => {
      this.box(color, 0, 2.05, 0, 8, 4, 7.6, 0, 'plaster')
      this.obstacle(0, 2.05, 0, 8, 4, 7.6, true)
      this.put('roof', roof, 0, 5, 0, 9.4, 2.5, 9.2)
      this.obstacle(0, 5, 0, 9.4, 2.5, 9.2, true, 'roof')
      this.box(C.trim, 0, 4.05, 0, 8.7, .23, 8.4)
      this.box('#ac937b', 2.5, 5.15, -1.5, .75, 2.4, .8)
      this.obstacle(2.5, 5.15, -1.5, .75, 2.4, .8, true)
      this.window(-2.25, 2.25, 3.87, 1.4, 1.65)
      this.window(2.25, 2.25, 3.87, 1.4, 1.65)
      this.box(C.trim, 0, 1.45, 4, 1.6, 2.8, .25)
      this.box('#6e827d', 0, 1.35, 4.16, 1.25, 2.65, .1)
      this.box(C.trim, 0, .2, 4.9, 3, .4, 1.7)
      this.put('roof', roof, 0, 3.4, 4.5, 3.5, 1.1, 2.7)
      this.obstacle(0, 3.4, 4.5, 3.5, 1.1, 2.7, true, 'roof')
      for (const dx of [-1.4, 1.4]) this.box(C.trim, dx, 1.5, 5.4, .16, 2.7, .16)
      this.box(C.path, 0, .025, (5.4 + yardDepth) / 2, 1.6, .045, yardDepth - 5.4)
      for (const dx of [-5.7, 5.7]) {
        this.hedge(dx, 1, 1.2, 12)
        this.tree(dx, -4, .65)
        this.flowers(dx, 5, 1.6)
      }
      for (const side of [-1, 1]) {
        for (let i = 0; i < 5; i++) this.box('#bcaa85', side * (2.5 + i * .7), .65, yardDepth, .16, 1.3, .16)
        this.box('#c5b795', side * 3.9, .9, yardDepth, 3.5, .13, .12)
        this.box('#c5b795', side * 3.9, .4, yardDepth, 3.5, .13, .12)
      }
    }))
  }

  private civicQuarter() {
    this.building(-66, -65, 15, 11, 4, '#b97b59')
    this.building(-59, -45, 14, 10, 3, '#ac7151')
    this.structure('building', () => this.at(6, -62, 0, () => {
      // Paving stays outside the hall; its interior shares the game terrain.
      this.box(C.path, 0, .02, 15, 31, .1, 11)
      this.box('#c9b897', 0, 1, 0, 34, 2, 19)
      this.box('#d2b88c', 0, 5.2, 0, 30, 8.5, 17)
      this.obstacle(0, 1, 0, 34, 2, 19, true)
      this.obstacle(0, 5.2, 0, 30, 8.5, 17, true)
      this.box(C.trim, 0, 9.3, 0, 32, .6, 19)
      this.put('roof', '#487778', 0, 11, 0, 33, 3.2, 21)
      this.obstacle(0, 9.3, 0, 32, .6, 19, true)
      this.obstacle(0, 11, 0, 33, 3.2, 21, true, 'roof')
      for (const side of [-1, 1]) {
        for (const dx of [-12, -8, 8, 12]) {
          this.at(0, 0, side === 1 ? 0 : Math.PI, () => this.window(dx, 5.9, 8.6, 1.7, 3.7))
        }
      }
      this.box(C.trim, 0, 2.4, 11.1, 11, .6, 6)
      for (let i = 0; i < 6; i++) this.box(C.trim, 0, .2 + i * .32, 15.8 - i * .57, 11, .4, 1.1)
      for (const dx of [-4.5, -1.5, 1.5, 4.5]) {
        this.put('cylinder', C.trim, dx, 5.9, 12.3, .45, 6.8, .45)
        this.box(C.trim, dx, 2.7, 12.3, 1.1, .4, 1.1)
        this.box(C.trim, dx, 9.2, 12.3, 1.1, .4, 1.1)
      }
      this.box(C.trim, 0, 9.7, 11.3, 12, .6, 6)
      this.put('roof', C.trim, 0, 11.25, 11.3, 13, 2.6, 6.5)
      this.put('cylinder', '#dbc7a2', 0, 12.2, -1, 5.1, 5.3, 5.1)
      this.obstacle(0, 11.25, 11.3, 13, 2.6, 6.5, true, 'roof')
      this.obstacle(0, 12.2, -1, 5.1, 5.3, 5.1, true, 'cylinder')
      for (let i = 0; i < 12; i++) {
        const a = i / 12 * Math.PI * 2
        this.at(Math.sin(a) * 5.08, -1 + Math.cos(a) * 5.08, a, () => this.window(0, 12.5, .02, 1.1, 2.7))
      }
      this.put('cylinder', C.trim, 0, 14.9, -1, 5.65, .45, 5.65)
      this.put('dome', '#387c7d', 0, 15.05, -1, 5.55, 6.8, 5.55)
      this.obstacle(0, 14.9, -1, 5.65, .45, 5.65, true, 'cylinder')
      this.obstacle(0, 15.05, -1, 5.55, 6.8, 5.55, true, 'dome')
      for (let i = 0; i < 12; i++) {
        const a = i / 12 * Math.PI * 2
        const points = Array.from({ length: 17 }, (_, j) => {
          const t = j / 16 * Math.PI / 2
          return new THREE.Vector3(Math.cos(t) * 5.59 * Math.sin(a), 15.06 + Math.sin(t) * 6.84,
            -1 + Math.cos(t) * 5.59 * Math.cos(a))
        })
        // Convex segments also participate in cutting and stay attached to the dome.
        for (let j = 0; j < points.length - 1; j++) {
          const direction = points[j + 1].clone().sub(points[j])
          const matrix = new THREE.Matrix4().compose(points[j].clone().lerp(points[j + 1], .5),
            new THREE.Quaternion().setFromUnitVectors(THREE.Object3D.DEFAULT_UP, direction.clone().normalize()),
            new THREE.Vector3(.055, direction.length() + .015, .055)).premultiply(this.transform)
          const instance = { matrix, color: new THREE.Color('#c0b080'), surface: null, geometry: this.geometries.cylinder }
          if (!this.batches.has('cylinder')) this.batches.set('cylinder', [])
          this.batches.get('cylinder')!.push(instance)
          this.structureOwner!.parts.push(instance)
        }
      }
      this.put('cylinder', '#d6ae5a', 0, 22.1, -1, .55, .6, .55)
      this.put('cone', '#e3bf6e', 0, 23.2, -1, .52, 1.9, .52)
      this.obstacle(0, 22.1, -1, .55, .6, .55, true, 'cylinder')
      this.obstacle(0, 23.2, -1, .52, 1.9, .52, true, 'cone')
    }))
    // Symmetrical civic garden and fountain, in the same position as the reference.
    for (const dx of [-17, 29]) {
      this.hedge(dx, -40, 17, 1.3)
      this.tree(dx - 4, -46, 1, true)
      this.tree(dx + 5, -53, .95)
      this.flowers(dx, -43, 8)
      this.bench(dx, -39.2, Math.PI)
    }
    this.put('cylinder', C.trim, 6, .2, -41.5, 3, .6, 3)
    this.put('cylinder', '#279ca8', 6, .54, -41.5, 2.65, .08, 2.65)
    this.put('cylinder', C.trim, 6, 1.1, -41.5, .45, 1.3, .45)
    this.put('cylinder', '#83d0cf', 6, 1.85, -41.5, 1.05, .15, 1.05)
    this.obstacle(6, .7, -41.5, 5.8, 1.4, 5.8)
    // Parking lot and its small service building.
    this.box(C.road, 64, .035, -56, 23, .08, 34)
    this.building(65, -69, 9, 5, 1, '#b99e80')
    for (const x of [57, 71]) {
      for (let z = -62; z <= -43; z += 4.5) {
        this.box(C.white, x, .09, z, 5, .025, .10)
        this.box(C.white, x + (x === 57 ? -2.5 : 2.5), .09, z + 2, .1, .025, 4)
      }
    }
    for (const [x, z, color] of [[57, -60, '#b74e4c'], [71, -55.5, '#efbe49'], [57, -46.5, '#dce2d9'], [71, -42, '#cbd4d0']] as const) {
      this.car(x, z, color, Math.PI / 2, true)
    }
    for (const z of [-64, -51, -39]) this.tree(75, z, .7)
  }

  private park() {
    this.hedge(-13, -23, 39, 1.1)
    this.hedge(-13, 6.8, 39, 1.1)
    this.hedge(-34, -8, 1, 28)
    this.box(C.path, 1, .03, -7, 2.4, .07, 31)
    const loop = new THREE.EllipseCurve(-15, -8, 12, 10, 0, Math.PI * 2, false, 0)
    const path = new THREE.CatmullRomCurve3(loop.getPoints(80).map(p => new THREE.Vector3(p.x, .045, p.y)), true)
    const trail = new THREE.Mesh(new THREE.TubeGeometry(path, 90, 1.05, 5, true),
      new THREE.MeshStandardMaterial({ color: C.path, roughness: 1 }))
    trail.scale.y = .055
    this.root.add(trail)
    this.box(C.path, -6, .025, -7, 13, .065, 2.2)
    this.at(-10, -8, 0, () => {
      this.put('cylinder', C.trim, 0, .12, 0, 3.7, .35, 3.7)
      this.put('cylinder', '#b09b79', 0, .36, 0, 3.3, .2, 3.3)
      this.obstacle(0, .2, 0, 6.4, .5, 6.4)
      for (let i = 0; i < 8; i++) {
        const a = i / 8 * Math.PI * 2, x = Math.sin(a) * 2.8, z = Math.cos(a) * 2.8
        this.put('cylinder', C.trim, x, 2, z, .12, 3.5, .12)
      }
      this.put('cone', '#ad6552', 0, 4.8, 0, 4.2, 2.6, 4.2)
      this.put('sphere', '#b99458', 0, 6.2, 0, .16, .3, .16)
    })
    const pond = new THREE.Shape()
    pond.moveTo(-30, 0); pond.bezierCurveTo(-33, -5, -28, -12, -24, -9)
    pond.bezierCurveTo(-21, -8, -23, -4, -18, -2)
    pond.bezierCurveTo(-12, 1, -17, 5, -22, 4)
    pond.bezierCurveTo(-28, 5, -31, 4, -30, 0)
    const water = new THREE.Mesh(new THREE.ShapeGeometry(pond, 28), this.water)
    water.rotation.x = -Math.PI / 2
    water.position.set(0, .055, -3)
    this.root.add(water)
    const points = pond.getPoints(50)
    for (let i = 0; i < points.length; i += 2) {
      const p = points[i]
      this.put('rock', '#b7b89a', p.x, .22, -p.y - 3, .6, .35, .55)
    }
    this.obstacle(-26, .05, -1, 7.5, .5, 9)
    this.obstacle(-20, .05, -5, 5, .5, 4)
    for (let i = 0; i < 11; i++) {
      const x = -29 + this.rand() * 7, z = -5 + this.rand() * 8
      this.put('cylinder', '#608752', x, .09, z, .27, .025, .27)
    }
    this.at(-26, -9, -.25, () => {
      for (let i = 0; i < 15; i++) this.box('#ad875c', (i - 7) * .33, .45 + Math.sin(i / 14 * Math.PI) * .5, 0, .3, .13, 2.1)
      for (const z of [-1.1, 1.1]) {
        this.box('#95734f', 0, 1.35, z, 5, .15, .13)
        for (const x of [-2.2, 0, 2.2]) this.box('#95734f', x, .9, z, .15, 1.5, .15)
      }
    })
    for (const [x, z, s] of [[-30, -18, .85], [-22, -20, .9], [-7, -20, .9], [6, -19, .8], [-32, 3, .7], [-7, 4, .65], [7, 4, .65]]) this.tree(x, z, s)
    this.tree(-27, -14, .85, true)
    this.bench(-18, -20)
    this.bench(-3, -12, Math.PI / 2)
    this.bench(-17, 3, Math.PI)
    this.flowers(-18, 6, 10)
    this.flowers(6, -8, 8)
    this.building(-65, -10, 17, 13, 3, '#82a4a8')
    // Glass-fronted corner office.
    this.box('#31677b', -65, 3.2, -3.4, 15, 5.5, .18)
    for (let x = -72; x <= -58; x += 2.3) this.box(C.trim, x, 3.2, -3.2, .13, 5.5, .1)
    this.box(C.trim, -65, 3.8, -3.2, 15, .14, .1)
  }

  private neighborhoods() {
    for (const [i, color] of ['#ac6c4d', '#d3ac6c', '#b7a280', '#be805c', '#d2b587'].entries()) {
      this.building(28 + i * 9.25, -9, 8.8, 13 + (i % 2), 2 + Number(i === 0), color, true)
    }
    this.building(39, 35, 21, 19, 5, '#ad7958')
    this.box(C.path, 39, .04, 48, 7, .08, 5)
    for (const x of [27, 51]) {
      this.tree(x, 26, .8)
      this.tree(x, 45, .85)
      this.flowers(x, 39, 2)
    }
    this.house(-65, 29, '#e3cea4', '#b06754')
    this.house(-64, 51, '#a9bbc0', '#556a7d')
    this.house(-57, 70, '#d5b99d', '#b56e57', -.4)
    this.house(-29, 34, '#b1c2c2', '#546a80')
    this.house(-14, 34, '#d5b487', '#927861')
    this.house(1, 34, '#d3b69a', '#a55c4b')
    for (const [i, color] of ['#b6c6c5', '#e1c2a1', '#d8cdb1'].entries()) {
      this.house(-24 + i * 30, 69, color, ['#59788a', '#ae6958', '#5b6972'][i], 0, 8.2)
    }
    for (const [i, color] of ['#d7c5a1', '#c3c9b1', '#d2ba97'].entries()) {
      this.house(72, 28 + i * 18, color, i === 1 ? '#606c79' : '#637184', -Math.PI / 2, 6.5)
    }
    // Café terrace with striped parasols and little round tables.
    for (const x of [39, 46, 64]) {
      this.put('cylinder', C.metal, x, .75, 4.7, .07, 1.5, .07)
      this.put('cylinder', C.trim, x, 1.15, 4.7, .9, .12, .9)
      this.put('cylinder', '#a99476', x, 1.8, 4.7, .055, 3.6, .055)
      this.put('cone', x === 39 ? '#cf6a57' : '#f1d8ab', x, 3.3, 4.7, 1.9, .8, 1.9)
      for (const dx of [-1.4, 1.4]) {
        this.box('#af7f57', x + dx, .65, 4.7, .65, .15, .7)
        this.box(C.metal, x + dx, .3, 4.7, .1, .6, .5)
      }
      this.obstacle(x, .6, 4.7, 1.8, 1.3, 1.8)
    }
    for (const z of [11, 52]) {
      for (let x = -31; x < 54; x += 10) {
        if (Math.abs(x - 17) < 7) continue
        this.tree(x, z, .7)
      }
    }
  }

  private landscaping() {
    // Frame each block with planting, leaving the pavement and entrances open.
    for (const x of [-29, 39]) {
      for (const z of [-72, -62, -52, -41]) this.tree(x, z, .8 + this.rand() * .2)
      this.hedge(x, -57, 1.2, 33)
    }
    for (const x of [-18, -8, 22, 31]) {
      this.tree(x, -75, .8)
      this.flowers(x, -47.5, 4.2)
    }
    for (const x of [-15, 27]) {
      this.box(C.path, x, .035, -58, 1.4, .06, 27)
      for (const z of [-67, -59]) this.flowers(x + (x < 0 ? 3 : -3), z, 3.8)
      this.bench(x, -52, x < 0 ? Math.PI / 2 : -Math.PI / 2)
    }
    for (const x of [-76, -50]) {
      for (const z of [-73, -57, -39]) this.tree(x, z, .75)
    }
    this.hedge(-77, -57, 1, 32)
    this.flowers(-66, -38.5, 9)
    this.tree(-76, -21, .8)
    this.tree(-52, -21, .7)
    this.tree(-76, 4, .7)
    this.tree(-51, 5, .7)
    this.flowers(-64, 6, 8)
    this.building(-52, -7, 4, 7, 1, '#c7956d', true)
    this.bench(-65, 4)
    for (const x of [-76, -51]) {
      for (const z of [23, 42, 62]) this.tree(x, z, .7)
    }
    this.tree(-73, 60, .8, true)
    this.tree(-51, 28, .65, true)
    for (const x of [-32, -19, -5, 8]) {
      this.tree(x, 24, .6)
      this.flowers(x, 48, 2.7)
    }
    for (const x of [-9, 21, 49]) {
      this.tree(x, 65, .8)
      this.tree(x, 76, .7)
      this.flowers(x, 73, 2.8)
    }
    for (const z of [-21, -12, 0]) this.tree(75, z, .7)
    for (const x of [27, 39, 51, 63]) this.tree(x, -22, .65)
    this.flowers(32, 7, 6)
    this.flowers(68, 7, 5)
    this.tree(-7, -16, .55, true)
    // Small flower islands in the broad southern avenue.
    for (const x of [-19, 39]) {
      this.box(C.trim, x, .1, 57, 17, .25, 1.5)
      this.hedge(x, 57, 16, 1.2)
      this.flowers(x, 57, 13)
    }
  }

  private streetFurniture() {
    const bulbGeometry = new THREE.SphereGeometry(.22, 8, 6)
    const pools: THREE.Matrix4[] = []
    const bulbs: THREE.Matrix4[] = []
    for (const z of [-36.5, 9, 62]) {
      for (let x = -75; x < 77; x += 15) {
        if ([-42, 17, 48, 61].some(ix => Math.abs(x - ix) < 6)) continue
        this.at(x, z, 0, () => {
          this.put('cylinder', C.metal, 0, 2.4, 0, .075, 4.8, .075)
          this.put('cylinder', C.metal, 0, .12, 0, .22, .3, .22)
          this.box(C.metal, .35, 4.85, 0, .85, .1, .14)
          this.put('cone', C.metal, .7, 4.75, 0, .4, .25, .4)
          bulbs.push(new THREE.Matrix4().makeTranslation(x + .7, 4.62, z))
          pools.push(new THREE.Matrix4().compose(new THREE.Vector3(x + .7, .09, z),
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2), new THREE.Vector3(2.6, 2.6, 1)))
          this.obstacle(0, 2, 0, .22, 4, .22)
        })
      }
    }
    const lights = new THREE.InstancedMesh(bulbGeometry, this.lamps, bulbs.length)
    bulbs.forEach((matrix, i) => lights.setMatrixAt(i, matrix))
    lights.computeBoundingSphere()
    this.root.add(lights)
    const illumination = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 24), this.glow, pools.length)
    pools.forEach((matrix, i) => illumination.setMatrixAt(i, matrix))
    illumination.computeBoundingSphere()
    this.root.add(illumination)
    for (const [x, z] of [[1, -2], [6, -41.5], [44, 3]]) {
      const light = new THREE.PointLight('#ffc271', 0, 16, 1.6)
      light.position.set(x, 4, z)
      this.root.add(light)
      this.nightLights.push(light)
    }
    for (const [x, z] of [[-47, -36], [12, 10], [56, 10], [-47, 52]]) {
      this.put('cylinder', C.metal, x, 1.8, z, .06, 3.6, .06)
      this.box('#335e58', x, 3.15, z, 2.6, .65, .1)
      this.box(C.white, x, 3.15, z + .06, 1.8, .09, .02)
    }
    for (const x of [-35, 24, 68]) {
      this.put('cylinder', '#52695d', x, .55, 7, .35, 1.1, .35)
      this.put('cylinder', C.metal, x, 1.13, 7, .39, .12, .39)
    }
  }

  private bridge() {
    this.at(94, 89, -Math.PI / 3, () => {
      this.box('#9b9788', 0, -.6, 0, 9.4, 1.3, 42)
      this.box(C.road, 0, .065, 0, 7, .08, 42)
      this.obstacle(0, -.55, 0, 9.4, 1.2, 42)
      for (const x of [-4.25, 4.25]) {
        this.box(C.trim, x, .65, 0, .4, 1.3, 42)
        this.obstacle(x, .65, 0, .4, 1.3, 42)
        for (let z = -20; z <= 20; z += 3) this.box('#d8cdb6', x, 1.35, z, .65, .2, .65)
      }
      for (const z of [-9, 9]) this.box('#9e9b8c', 0, -3, z, 8, 5, 1.6)
      for (let z = -20; z < 21; z += 5) this.box('#e7cf89', 0, .12, z, .1, .02, 2.4)
      this.obstacle(0, 35, 20.5, 9, 80, .7)
    })
  }

  private car(x: number, z: number, color: string, angle: number, collision: boolean) {
    return this.structure('car', () => this.at(x, z, angle, () => {
      this.box('#26363c', 0, .38, 0, 1.65, .3, 3.8)
      this.box(color, 0, .8, 0, 1.85, .7, 4)
      this.box(color, 0, 1.35, -.2, 1.6, .6, 2)
      this.box('#385766', 0, 1.4, .84, 1.4, .45, .09)
      this.box('#385766', 0, 1.4, -1.23, 1.4, .4, .09)
      for (const side of [-1, 1]) {
        this.box('#385766', side * .815, 1.4, -.2, .04, .38, 1.7)
        this.box('#e8dfb1', side * .6, .82, 2.02, .4, .2, .05)
        this.box('#aa493d', side * .6, .82, -2.02, .4, .2, .05)
        for (const dz of [-1.2, 1.2]) this.put('sphere', '#263037', side * .88, .39, dz, .23, .39, .39)
      }
      if (collision) this.obstacle(0, .8, 0, 1.9, 1.6, 4.1)
    }))
  }

  private createTraffic() {
    // Reuse the same instancing builder for each moving car, with shared geometries.
    for (let i = 0; i < 7; i++) {
      const owner = this.car(0, 0, ['#c26850', '#e9be59', '#d6ded4', '#668f9b', '#607c70', '#dfd2b8', '#986a64'][i], 0, false)
      const group = new THREE.Group()
      this.flush(group)
      this.root.add(group)
      owner.transform = group
      this.traffic.push({ mesh: group, offset: i / 7, speed: i % 2 ? -1 : 1, owner })
    }
    this.update(0)
  }

  private flush(target = this.root) {
    for (const [shape, instances] of this.batches) {
      // Spatial batches allow camera and shadow frusta to reject distant blocks.
      const chunks = new Map<number, Instance[]>()
      for (const instance of instances) {
        const key = target === this.root ? cellKey(Math.floor(instance.matrix.elements[12] / RENDER_CELL_SIZE), Math.floor(instance.matrix.elements[14] / RENDER_CELL_SIZE)) : 0
        if (!chunks.has(key)) chunks.set(key, [])
        chunks.get(key)!.push(instance)
      }
      for (const group of chunks.values()) {
        // Only box batches need per-instance surface data. Keep all materials
        // in the same draw, including untextured trim, glass, and road markings.
        const textured = group.some(instance => instance.surface !== null)
        const occluders = group.some(instance => instance.buildingOwner)
        const geometry = textured || occluders ? this.geometries[shape].clone() : this.geometries[shape]
        if (textured) {
          const surfaces = new Float32Array(group.length * 3)
          group.forEach((instance, i) => surfaces.set(this.textures.values(instance.surface), i * 3))
          geometry.setAttribute('citySurface', new THREE.InstancedBufferAttribute(surfaces, 3))
        }
        if (occluders) {
          const attribute = new THREE.InstancedBufferAttribute(new Float32Array(group.length).fill(1), 1)
          attribute.setUsage(THREE.DynamicDrawUsage)
          geometry.setAttribute('cameraOpacity', attribute)
          group.forEach((instance, index) => {
            if (instance.buildingOwner) this.occlusion.register(instance.buildingOwner, instance, attribute, index)
          })
        }
        const baseMaterial = textured ? this.textures.material : this.material
        const material = occluders ? this.occlusion.material(baseMaterial) : baseMaterial
        const mesh = new THREE.InstancedMesh(geometry, material, group.length)
        group.forEach((instance, i) => {
          mesh.setMatrixAt(i, instance.matrix); mesh.setColorAt(i, instance.color)
          instance.mesh = mesh; instance.index = i
        })
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        mesh.castShadow = mesh.receiveShadow = true
        mesh.computeBoundingSphere()
        mesh.name = `City ${shape} (${group.length})`
        target.add(mesh)
      }
    }
    this.batches.clear()
  }

  buildingAt(position: THREE.Vector3) {
    for (const owner of this.destruction.objects) {
      if (owner.kind !== 'building') continue
      const cached = this.buildingBounds.get(owner)
      if (!cached) continue
      const local = position.clone().sub(cached.origin).applyQuaternion(cached.inverseRotation)
      const bounds = cached.bounds
      if (local.x > bounds.min.x + .35 && local.x < bounds.max.x - .35
        && local.z > bounds.min.z + .35 && local.z < bounds.max.z - .35
        && local.y > bounds.min.y - .18 && local.y < bounds.max.y - .35) return owner
    }
    return null
  }

  updateOcclusion(camera: THREE.Camera, character: THREE.Vector3, delta: number, enabled = true) {
    this.destruction.buildingMeshes(this.occlusionFragments)
    return this.occlusion.update(camera, character, delta, this.occlusionFragments, enabled)
  }

  dispose() {
    this.occlusion.dispose()
    this.destruction.dispose()
    this.textures.dispose()
  }

  private roofGeometry() {
    const shape = new THREE.Shape()
    shape.moveTo(-.5, -.5); shape.lineTo(.5, -.5); shape.lineTo(0, .5); shape.closePath()
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false })
    geometry.translate(0, 0, -.5)
    return geometry
  }

  addColliders(world: RAPIER.World) {
    this.occlusion.reset()
    this.destruction.reset(world)
    // One reusable static environment is attached to each new physics world.
    // Match the walkable pavement height so boots remain above the visible paths.
    world.createCollider(RAPIER.ColliderDesc.cuboid(99 * CITY_SCALE, .12 * CITY_SCALE, 99 * CITY_SCALE)
      .setTranslation(0, -.08 * CITY_SCALE, 0).setFriction(.85))
    for (const { center, shape, rotation, owner } of this.obstacles) {
      if (owner?.kind === 'tree') continue
      const collider = world.createCollider(new RAPIER.ColliderDesc(shape)
        .setTranslation(center.x, center.y, center.z).setRotation(rotation).setFriction(.8))
      if (owner) this.destruction.register(owner, collider)
    }
    // Crown and trunk colliders follow visible tree primitives, so a beam can
    // cut branches and foliage as well as the load-bearing trunk.
    for (const owner of this.destruction.objects) if (owner.kind === 'tree') {
      for (const part of owner.parts) {
        const source = part.geometry.getAttribute('position')
        const vertices = new Float32Array(source.count * 3)
        const point = new THREE.Vector3()
        for (let i = 0; i < source.count; i++) point.fromBufferAttribute(source, i).applyMatrix4(part.matrix).toArray(vertices, i * 3)
        const desc = RAPIER.ColliderDesc.convexHull(vertices)
        if (desc) this.destruction.register(owner, world.createCollider(desc.setFriction(.8)))
      }
    }
    for (const car of this.traffic) {
      car.body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(car.mesh.position.x, 0, car.mesh.position.z).setRotation(car.mesh.quaternion))
      const collider = world.createCollider(RAPIER.ColliderDesc.cuboid(.95 * CITY_SCALE, .8 * CITY_SCALE, 2 * CITY_SCALE)
        .setTranslation(0, .8 * CITY_SCALE, 0).setFriction(.6), car.body)
      this.destruction.register(car.owner, collider)
      car.owner.stop = () => {
        car.owner.velocity = car.body ? new THREE.Vector3().copy(car.body.linvel()) : new THREE.Vector3()
        if (car.body) world.removeRigidBody(car.body)
        car.body = undefined
      }
    }
  }

  private nearby(position: THREE.Vector3, radius: number) {
    this.candidates.length = 0
    this.candidateSet.clear()
    for (let x = Math.floor((position.x - radius) / CELL_SIZE); x <= Math.floor((position.x + radius) / CELL_SIZE); x++) {
      for (let z = Math.floor((position.z - radius) / CELL_SIZE); z <= Math.floor((position.z + radius) / CELL_SIZE); z++) {
        const cell = this.obstacleCells.get(cellKey(x, z))
        if (!cell) continue
        for (const obstacle of cell) if (!obstacle.owner?.damaged && !this.candidateSet.has(obstacle)) {
          this.candidateSet.add(obstacle)
          this.candidates.push(obstacle)
        }
      }
    }
    // Preserve construction order at corners where several façades overlap.
    return this.candidates.sort((a, b) => a.order - b.order)
  }

  /** Keep the standing support outside obstacles, so it never pulls a body through a wall. */
  constrainMovement(position: THREE.Vector3, direction: THREE.Vector3) {
    if (direction.lengthSq() === 0) return
    const local = this.local
    const step = this.travelStep.copy(direction).multiplyScalar(.7)
    for (const obstacle of this.nearby(position, 1.5)) {
      if (obstacle.center.y + obstacle.half.y < position.y - 1.25 || obstacle.center.y - obstacle.half.y > position.y + 1.1) continue
      local.copy(position).add(step).sub(obstacle.center).applyQuaternion(obstacle.inverse)
      if (Math.abs(local.x) < obstacle.half.x + .5 && Math.abs(local.z) < obstacle.half.z + .5) {
        // Slide along a façade, rather than stopping diagonal input completely.
        const localStep = this.localStep.copy(step).applyQuaternion(obstacle.inverse)
        const depthX = obstacle.half.x + .5 - Math.abs(local.x)
        const depthZ = obstacle.half.z + .5 - Math.abs(local.z)
        if (depthX < depthZ) {
          if (localStep.x * (local.x - localStep.x) < 0) localStep.x = 0
        } else if (localStep.z * (local.z - localStep.z) < 0) localStep.z = 0
        direction.copy(localStep.applyQuaternion(obstacle.rotation)).divideScalar(.7)
        step.copy(direction).multiplyScalar(.7)
      }
    }
  }

  groundHeightAt(position: THREE.Vector3) {
    let height = .04 * CITY_SCALE
    this.supportRay.origin.x = position.x
    this.supportRay.origin.y = position.y
    this.supportRay.origin.z = position.z
    for (const obstacle of this.nearby(position, .4)) {
      if (!obstacle.landing) continue
      const hit = obstacle.shape.castRayAndGetNormal(this.supportRay, obstacle.center, obstacle.rotation, position.y - height, false)
      if (hit && hit.normal.y > .65) height = Math.max(height, position.y - hit.timeOfImpact)
    }
    return this.destruction.groundHeightAt(position, height)
  }

  setNight(night: boolean) {
    this.water.uniforms.night.value = Number(night)
    this.lamps.emissiveIntensity = night ? 3 : .35
    this.glow.opacity = night ? .18 : 0
    this.nightLights.forEach(light => { light.intensity = night ? 14 : 0 })
  }

  resetTraffic() {
    this.update(0)
    for (const car of this.traffic) {
      if (car.owner.damaged) continue
      car.body?.setTranslation(car.mesh.position, true)
      car.body?.setRotation(car.mesh.quaternion, true)
    }
  }

  private sampleCar(car: (typeof this.traffic)[number], time: number) {
    const t = ((car.offset + time * .008 * car.speed) % 1 + 1) % 1
    const point = this.route.getPointAt(t, this.routePoint)
    const tangent = this.route.getTangentAt(t, this.routeTangent).multiplyScalar(car.speed)
    point.x -= tangent.z * 1.85
    point.z += tangent.x * 1.85
    point.multiplyScalar(CITY_SCALE)
    return Math.atan2(tangent.x, tangent.z)
  }

  stepTraffic(time: number) {
    for (const car of this.traffic) {
      if (car.owner.damaged) continue
      const angle = this.sampleCar(car, time)
      car.body?.setNextKinematicTranslation(this.routePoint)
      // The visual rotation is interpolated separately in update().
      car.body?.setNextKinematicRotation({ x: 0, y: Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) })
    }
  }

  update(time: number) {
    this.destruction.sync()
    this.water.uniforms.time.value = time
    for (const car of this.traffic) {
      if (car.owner.damaged) continue
      car.mesh.rotation.y = this.sampleCar(car, time)
      car.mesh.position.copy(this.routePoint)
    }
    if (this.jets) {
      const positions = this.jets.geometry.getAttribute('position') as THREE.BufferAttribute
      for (let i = 0; i < positions.count; i++) {
        const t = (time * .7 + i / positions.count) % 1, a = i * 2.39996
        positions.setXYZ(i, (6 + Math.cos(a) * t * 1.3) * CITY_SCALE,
          (.7 + Math.sin(t * Math.PI) * 2.6) * CITY_SCALE, (-41.5 + Math.sin(a) * t * 1.3) * CITY_SCALE)
      }
      positions.needsUpdate = true
    }
  }
}
