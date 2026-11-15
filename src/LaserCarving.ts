import * as THREE from 'three'
import { connectedGroups, laserPlanes, solidGeometry, subtractLaser, translatedSolid, type LaserSolid, type SolidConnections } from './LaserGeometry'

export type CarveInput = {
  solids: LaserSolid[]; shots: { point: THREE.Vector3; direction: THREE.Vector3; radius?: number; depth?: number }[]
  kind: 'building' | 'tree' | 'car'; moving: boolean; visible: boolean
  parts?: { positions: Float32Array; matrix: number[]; color: number[] }[]
  connections?: SolidConnections
}
export type ConvexMeshData = { vertices: Float32Array; indices: Uint32Array }
export type CarveOutput = {
  solids: (number | LaserSolid)[]; groups: number[][]; edges: Uint32Array
  geometry: { position: Float32Array; color: Float32Array; normal: Float32Array; sphere: { center: number[]; radius: number } }[]
  localSolids: (LaserSolid[] | null)[]
  physics: ConvexMeshData[][]
  groupInfo: { center: number[]; grounded: boolean; preserve: boolean; edges: Uint32Array }[]
}

/** Structured cloning preserves shared vertices but not Three.js prototypes. */
export function reviveSolid(cell: LaserSolid) {
  const vectors = new Set(cell.vertices)
  for (const face of cell.faces) {
    Object.setPrototypeOf(face.color, THREE.Color.prototype)
    for (const point of face.points) vectors.add(point)
  }
  for (const plane of cell.planes) {
    Object.setPrototypeOf(plane, THREE.Plane.prototype)
    vectors.add(plane.normal)
  }
  vectors.add(cell.bounds.min); vectors.add(cell.bounds.max)
  for (const vector of vectors) Object.setPrototypeOf(vector, THREE.Vector3.prototype)
  Object.setPrototypeOf(cell.bounds, THREE.Box3.prototype)
  return cell
}

export function carve(input: CarveInput): CarveOutput {
  const originals = new Map(input.parts ? [] : input.solids.map((cell, i) => [cell, i]))
  let solids = input.solids
  for (const shot of input.shots) {
    const planes = laserPlanes(shot.point, shot.direction, shot.radius ?? .22)
    if (shot.depth !== undefined) {
      const axis = shot.direction.clone().normalize()
      planes.push(new THREE.Plane(axis, -axis.dot(shot.point) - shot.depth))
    }
    solids = solids.flatMap(cell => subtractLaser(cell, planes))
  }
  const connections = input.connections ?? new Map<LaserSolid, Set<LaserSolid>>()
  const groups = connectedGroups(solids, connections)
  const indices = new Map(solids.map((cell, i) => [cell, i]))
  const edges: number[] = []
  for (const [cell, neighbors] of connections) for (const other of neighbors) {
    const a = indices.get(cell)!, b = indices.get(other)!
    if (a < b) edges.push(a, b)
  }
  const localSolids: (LaserSolid[] | null)[] = []
  const groupInfo: CarveOutput['groupInfo'] = []
  const geometry = groups.map(cells => {
    const grounded = !input.moving && input.kind !== 'car' && cells.some(cell => cell.bounds.min.y <= .08)
    const preserve = groups.length === 1 && input.visible && (grounded || input.moving)
    const center = new THREE.Vector3()
    if (!grounded && !preserve) {
      const volume = cells.reduce((sum, cell) => sum + cell.volume, 0)
      for (const cell of cells) center.addScaledVector(cell.bounds.getCenter(new THREE.Vector3()), cell.volume / volume)
    }
    const localIndices = new Map(cells.map((cell, i) => [cell, i]))
    const localEdges: number[] = []
    for (const cell of cells) for (const other of connections.get(cell)!) {
      const a = localIndices.get(cell)!, b = localIndices.get(other)!
      if (a < b) localEdges.push(a, b)
    }
    groupInfo.push({ center: center.toArray(), grounded, preserve, edges: new Uint32Array(localEdges) })
    localSolids.push(!grounded && !preserve ? cells.map(cell => translatedSolid(cell, center.clone().negate())) : null)
    const mesh = solidGeometry(cells, center)
    const buffers = {
      position: mesh.getAttribute('position').array as Float32Array,
      color: mesh.getAttribute('color').array as Float32Array,
      normal: mesh.getAttribute('normal').array as Float32Array,
      sphere: { center: mesh.boundingSphere!.center.toArray(), radius: mesh.boundingSphere!.radius },
    }
    mesh.dispose()
    return buffers
  })
  const physics = groups.map((cells, i) => (localSolids[i] ?? cells).map(convexMeshData))
  return {
    solids: solids.map(cell => originals.get(cell) ?? cell),
    groups: groups.map(cells => cells.map(cell => indices.get(cell)!)),
    edges: new Uint32Array(edges), geometry, localSolids, physics, groupInfo,
  }
}

function convexMeshData(cell: LaserSolid): ConvexMeshData {
  const key = (p: THREE.Vector3) => `${Math.round(p.x / 1e-6)},${Math.round(p.y / 1e-6)},${Math.round(p.z / 1e-6)}`
  const indicesByPoint = new Map(cell.vertices.map((p, i) => [key(p), i]))
  const vertices = new Float32Array(cell.vertices.length * 3), indices: number[] = []
  cell.vertices.forEach((p, i) => { vertices[i * 3] = p.x; vertices[i * 3 + 1] = p.y; vertices[i * 3 + 2] = p.z })
  for (const face of cell.faces) for (let i = 1; i < face.points.length - 1; i++) {
    indices.push(indicesByPoint.get(key(face.points[0]))!, indicesByPoint.get(key(face.points[i]))!, indicesByPoint.get(key(face.points[i + 1]))!)
  }
  return { vertices, indices: new Uint32Array(indices) }
}

export function carveGeometry(buffers: CarveOutput['geometry'][number]) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(buffers.position, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(buffers.color, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(buffers.normal, 3))
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3().fromArray(buffers.sphere.center), buffers.sphere.radius)
  return geometry
}
