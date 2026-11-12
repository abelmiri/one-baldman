import * as THREE from 'three'
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js'

type Face = { points: THREE.Vector3[]; color: THREE.Color }
export type LaserSolid = { faces: Face[]; vertices: THREE.Vector3[]; planes: THREE.Plane[]; bounds: THREE.Box3; volume: number; structural: boolean }
const EPS = 1e-6
const CHAR = new THREE.Color('#39251d')

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
  const points = Array.from({ length: source.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(source, i).applyMatrix4(matrix))
  const hull = new ConvexGeometry(points)
  const positions = hull.getAttribute('position')
  const faces: Face[] = []
  const planes: THREE.Plane[] = []
  for (let i = 0; i < positions.count; i += 3) {
    const triangle = [0, 1, 2].map(j => new THREE.Vector3().fromBufferAttribute(positions, i + j))
    const plane = new THREE.Plane().setFromCoplanarPoints(triangle[0], triangle[1], triangle[2])
    const index = planes.findIndex(p => p.normal.dot(plane.normal) > 1 - EPS && Math.abs(p.constant - plane.constant) < EPS)
    if (index < 0) { planes.push(plane); faces.push({ points: triangle, color }) }
    else faces[index].points.push(...triangle)
  }
  hull.dispose()
  faces.forEach((face, i) => { face.points = ordered(face.points, planes[i].normal) })
  return solid(faces, structural)!
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
  if (planes.some(plane => source.vertices.every(p => plane.distanceToPoint(p) >= -EPS))) return [source]
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
  if (!a.bounds.clone().expandByScalar(tolerance).intersectsBox(b.bounds)) return false
  return !a.planes.some(plane => b.vertices.every(p => plane.distanceToPoint(p) > tolerance))
    && !b.planes.some(plane => a.vertices.every(p => plane.distanceToPoint(p) > tolerance))
}

export function solidGeometry(solids: LaserSolid[], center: THREE.Vector3) {
  const positions: number[] = [], colors: number[] = []
  for (const { faces } of solids) for (const { points, color } of faces) {
    for (let i = 1; i < points.length - 1; i++) for (const p of [points[0], points[i], points[i + 1]]) {
      positions.push(p.x - center.x, p.y - center.y, p.z - center.z)
      colors.push(color.r, color.g, color.b)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return geometry
}

export function translatedSolid(source: LaserSolid, offset: THREE.Vector3) {
  return solid(source.faces.map(face => ({ color: face.color, points: face.points.map(p => p.clone().add(offset)) })), source.structural)!
}
