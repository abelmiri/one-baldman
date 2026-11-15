import * as THREE from 'three'
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js'

type Face = { points: THREE.Vector3[]; color: THREE.Color }
export type LaserSolid = { faces: Face[]; vertices: THREE.Vector3[]; planes: THREE.Plane[]; bounds: THREE.Box3; volume: number; structural: boolean }
const EPS = 1e-6
const CHAR = new THREE.Color('#39251d')
const hullCache = new WeakMap<THREE.BufferGeometry, {
  source: THREE.BufferAttribute | THREE.InterleavedBufferAttribute; version: number; faces: THREE.Vector3[][]
}>()

function clean(points: THREE.Vector3[]) {
  const result = points.filter((p, i) => p.distanceToSquared(points[(i + 1) % points.length]) > EPS * EPS)
  let changed = true
  while (changed && result.length >= 3) {
    changed = false
    for (let i = 0; i < result.length; i++) {
      const a = result[(i + result.length - 1) % result.length], b = result[i], c = result[(i + 1) % result.length]
      const ab = b.clone().sub(a), bc = c.clone().sub(b)
      if (new THREE.Vector3().crossVectors(ab, bc).lengthSq() <= EPS * EPS * ab.lengthSq() * bc.lengthSq()) {
        result.splice(i, 1); changed = true; break
      }
    }
  }
  return result
}

function ordered(points: THREE.Vector3[], normal: THREE.Vector3) {
  const unique: THREE.Vector3[] = []
  for (const p of points) if (!unique.some(q => p.distanceToSquared(q) < EPS * EPS)) unique.push(p)
  const center = unique.reduce((sum, p) => sum.add(p), new THREE.Vector3()).divideScalar(unique.length)
  const u = new THREE.Vector3().crossVectors(normal, Math.abs(normal.y) < .9 ? THREE.Object3D.DEFAULT_UP : new THREE.Vector3(1, 0, 0)).normalize()
  const v = new THREE.Vector3().crossVectors(normal, u)
  return clean(unique.sort((a, b) => Math.atan2(v.dot(a.clone().sub(center)), u.dot(a.clone().sub(center)))
    - Math.atan2(v.dot(b.clone().sub(center)), u.dot(b.clone().sub(center)))))
}

function solid(faces: Face[], structural: boolean): LaserSolid | null {
  const vertices = [...new Map(faces.flatMap(face => face.points).map(p =>
    [`${Math.round(p.x / EPS)},${Math.round(p.y / EPS)},${Math.round(p.z / EPS)}`, p])).values()]
  if (vertices.length < 4) return null
  const bounds = new THREE.Box3().setFromPoints(vertices)
  const center = bounds.getCenter(new THREE.Vector3())
  let volume = 0
  const planes = faces.map(face => new THREE.Plane().setFromCoplanarPoints(...face.points.slice(0, 3) as [THREE.Vector3, THREE.Vector3, THREE.Vector3]))
  for (const face of faces) {
    const a = face.points[0].clone().sub(center)
    for (let i = 1; i < face.points.length - 1; i++) {
      volume += a.dot(new THREE.Vector3().crossVectors(face.points[i].clone().sub(center), face.points[i + 1].clone().sub(center))) / 6
    }
  }
  volume = Math.abs(volume)
  return volume > 1e-7 ? { faces, vertices, planes, bounds, volume, structural } : null
}

/** Convex source primitives become closed volumes, including the open-bottom dome. */
export function laserSolid(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, color: THREE.Color, structural = true) {
  const source = geometry.getAttribute('position')
  const version = source instanceof THREE.BufferAttribute ? source.version : source.data.version
  let cached = hullCache.get(geometry)
  if (!cached || cached.source !== source || cached.version !== version) {
    const points = Array.from({ length: source.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(source, i))
    const hull = new ConvexGeometry(points)
    const positions = hull.getAttribute('position')
    const faces: THREE.Vector3[][] = []
    const planes: THREE.Plane[] = []
    for (let i = 0; i < positions.count; i += 3) {
      const triangle = [0, 1, 2].map(j => new THREE.Vector3().fromBufferAttribute(positions, i + j))
      const plane = new THREE.Plane().setFromCoplanarPoints(triangle[0], triangle[1], triangle[2])
      const index = planes.findIndex(p => p.normal.dot(plane.normal) > 1 - EPS && Math.abs(p.constant - plane.constant) < EPS)
      if (index < 0) { planes.push(plane); faces.push(triangle) }
      else faces[index].push(...triangle)
    }
    hull.dispose()
    cached = { source, version, faces: faces.map((points, i) => ordered(points, planes[i].normal)) }
    hullCache.set(geometry, cached)
  }
  const reflected = matrix.determinant() < 0
  return solid(cached.faces.map(face => {
    const points = face.map(p => p.clone().applyMatrix4(matrix))
    if (reflected) points.reverse()
    return { points, color }
  }), structural)!
}

function clip(source: LaserSolid, plane: THREE.Plane) {
  const faces: Face[] = [], cap: THREE.Vector3[] = []
  for (const face of source.faces) {
    const points: THREE.Vector3[] = []
    for (let i = 0; i < face.points.length; i++) {
      const a = face.points[i], b = face.points[(i + 1) % face.points.length]
      const da = plane.distanceToPoint(a), db = plane.distanceToPoint(b)
      if (da <= EPS) points.push(a)
      if ((da < -EPS && db > EPS) || (da > EPS && db < -EPS)) {
        const p = a.clone().lerp(b, da / (da - db))
        points.push(p); cap.push(p)
      } else if (Math.abs(da) <= EPS) cap.push(a)
    }
    const polygon = clean(points)
    if (polygon.length >= 3) faces.push({ points: polygon, color: face.color })
  }
  const boundary = ordered(cap, plane.normal)
  if (boundary.length >= 3) faces.push({ points: boundary, color: CHAR })
  return solid(faces, source.structural)
}

/** An eight-sided beam removes material all the way through the target. */
export function laserPlanes(origin: THREE.Vector3, direction: THREE.Vector3, radius: number) {
  const axis = direction.clone().normalize()
  const u = new THREE.Vector3().crossVectors(axis, Math.abs(axis.y) < .9 ? THREE.Object3D.DEFAULT_UP : new THREE.Vector3(1, 0, 0)).normalize()
  const v = new THREE.Vector3().crossVectors(axis, u)
  return Array.from({ length: 8 }, (_, i) => {
    const angle = i * Math.PI / 4
    const normal = u.clone().multiplyScalar(Math.cos(angle)).addScaledVector(v, Math.sin(angle))
    return new THREE.Plane(normal, -normal.dot(origin) - radius)
  }).concat(new THREE.Plane(axis.clone().negate(), axis.dot(origin) - .08))
}

export function subtractLaser(source: LaserSolid, planes: THREE.Plane[]): LaserSolid[] {
  // Reject untouched cells before splitting, avoiding fragmentation on repeated hits.
  const { min, max } = source.bounds
  if (planes.some(plane => {
    const n = plane.normal
    // The box's nearest corner can reject distant cells without visiting vertices.
    const nearest = n.x * (n.x >= 0 ? min.x : max.x) + n.y * (n.y >= 0 ? min.y : max.y)
      + n.z * (n.z >= 0 ? min.z : max.z) + plane.constant
    return nearest >= -EPS || source.vertices.every(p => plane.distanceToPoint(p) >= -EPS)
  })) return [source]
  const result: LaserSolid[] = []
  let remainder: LaserSolid | null = source
  for (const plane of planes) {
    if (!remainder) break
    const distances = remainder.vertices.map(p => plane.distanceToPoint(p))
    if (Math.max(...distances) <= EPS) continue
    const outside = clip(remainder, plane.clone().negate())
    if (outside) result.push(outside)
    remainder = clip(remainder, plane)
  }
  return result
}

/** Face separation preserves attachment until the actual material bridge is cut. */
export function solidsTouch(a: LaserSolid, b: LaserSolid, tolerance = .025) {
  const amin = a.bounds.min, amax = a.bounds.max, bmin = b.bounds.min, bmax = b.bounds.max
  if (bmin.x > amax.x + tolerance || bmax.x < amin.x - tolerance
    || bmin.y > amax.y + tolerance || bmax.y < amin.y - tolerance
    || bmin.z > amax.z + tolerance || bmax.z < amin.z - tolerance) return false
  return !a.planes.some(plane => b.vertices.every(p => plane.distanceToPoint(p) > tolerance))
    && !b.planes.some(plane => a.vertices.every(p => plane.distanceToPoint(p) > tolerance))
}

export type SolidConnections = Map<LaserSolid, Set<LaserSolid>>

/** Unchanged cells retain their contact graph; only new cut faces need testing. */
export function connectedGroups(solids: LaserSolid[], connections: SolidConnections): LaserSolid[][] {
  const current = new Set(solids)
  for (const [cell, neighbors] of connections) {
    if (current.has(cell)) continue
    for (const neighbor of neighbors) connections.get(neighbor)?.delete(cell)
    connections.delete(cell)
  }
  const added = solids.filter(cell => !connections.has(cell))
  const tested = new Set<LaserSolid>()
  for (const cell of added) connections.set(cell, new Set())
  for (const cell of added) {
    tested.add(cell)
    for (const other of solids) {
      if (tested.has(other) || !solidsTouch(cell, other)) continue
      connections.get(cell)!.add(other)
      connections.get(other)!.add(cell)
    }
  }
  const groups: LaserSolid[][] = [], visited = new Set<LaserSolid>()
  for (const cell of solids) {
    if (visited.has(cell)) continue
    const group = [cell]
    visited.add(cell)
    for (let i = 0; i < group.length; i++) for (const neighbor of connections.get(group[i])!) {
      if (visited.has(neighbor)) continue
      visited.add(neighbor)
      group.push(neighbor)
    }
    groups.push(group)
  }
  return groups
}

export function solidGeometry(solids: LaserSolid[], center: THREE.Vector3) {
  let count = 0
  for (const { faces } of solids) for (const { points } of faces) count += (points.length - 2) * 9
  const positions = new Float32Array(count), colors = new Float32Array(count), normals = new Float32Array(count)
  const normal = new THREE.Vector3(), edge = new THREE.Vector3()
  let offset = 0
  for (const { faces } of solids) for (const { points, color } of faces) {
    normal.subVectors(points[1], points[0]).cross(edge.subVectors(points[2], points[0])).normalize()
    for (let i = 1; i < points.length - 1; i++) for (let j = 0; j < 3; j++) {
      const p = points[j === 0 ? 0 : j === 1 ? i : i + 1]
      positions[offset] = p.x - center.x; positions[offset + 1] = p.y - center.y; positions[offset + 2] = p.z - center.z
      colors[offset] = color.r; colors[offset + 1] = color.g; colors[offset + 2] = color.b
      normals[offset] = normal.x; normals[offset + 1] = normal.y; normals[offset + 2] = normal.z
      offset += 3
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geometry.computeBoundingSphere()
  return geometry
}

export function translatedSolid(source: LaserSolid, offset: THREE.Vector3) {
  return solid(source.faces.map(face => ({ color: face.color, points: face.points.map(p => p.clone().add(offset)) })), source.structural)!
}
