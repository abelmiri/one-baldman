import * as THREE from 'three'
import { clipSolid, connectedGroups, type LaserSolid, type SolidConnections } from './LaserGeometry.ts'

// Metres of material a square metre of intact attachment can carry. This is a
// gameplay strength, shared by tension and compression, rather than a FEM model.
const SUPPORT_LENGTH = 20
const FRACTURE_GAP = .04
const EPS = 1e-6
const DEBRIS_SIZE = 6.5
type Contact = { area: number; plane: THREE.Plane }
const contacts = new WeakMap<LaserSolid, WeakMap<LaserSolid, Contact>>()

/** Failed floors and walls lose their joints instead of falling as a rigid shell. */
function fractureUnsupported(solids: LaserSolid[], connections: SolidConnections): LaserSolid[] {
  const replacements = new Map<LaserSolid, LaserSolid[]>()
  for (const group of connectedGroups(solids, connections)) {
    if (group.some(cell => cell.bounds.min.y <= .08)) continue
    const bounds = new THREE.Box3()
    let volume = 0
    for (const cell of group) { bounds.union(cell.bounds); volume += cell.volume }
    const size = bounds.getSize(new THREE.Vector3())
    // Small severed pieces already make suitable debris. Keep their exact cuts.
    if (volume < 12 || Math.max(size.x, size.y, size.z) < 8) continue
    const span = Math.max(size.x, size.y, size.z)
    // Compact low-rise buildings need fewer cuts: at most two panels per axis.
    // Larger buildings keep the existing detail and bounded subdivision cost.
    const compact = size.y <= 12 && Math.max(size.x, size.z) <= 24
    const panelSize = Math.max(DEBRIS_SIZE, span / (compact ? 2 : 6))
    for (const cell of group) {
      let inset: LaserSolid | null = cell
      for (const [faceIndex, face] of cell.planes.entries()) {
        if (!inset) break
        const plane = face.clone(); plane.constant += FRACTURE_GAP / 2
        // Joint clearance moves an existing surface inward; it must retain the
        // facade (or previous burn) color instead of charring the whole panel.
        inset = clipSolid(inset, plane, cell.faces[faceIndex].color)
      }
      let pieces = inset ? [inset] : []
      for (const axis of ['x', 'y', 'z'] as const) {
        const normal = new THREE.Vector3(); normal[axis] = 1
        for (let position = bounds.min[axis] + panelSize; position < bounds.max[axis]; position += panelSize) {
          pieces = pieces.flatMap(piece => {
            if (piece.bounds.min[axis] >= position + FRACTURE_GAP / 2
              || piece.bounds.max[axis] <= position - FRACTURE_GAP / 2) return [piece]
            const left = clipSolid(piece, new THREE.Plane(normal, -position + FRACTURE_GAP / 2))
            const right = clipSolid(piece, new THREE.Plane(normal.clone().negate(), position + FRACTURE_GAP / 2))
            return [left, right].filter((part): part is LaserSolid => part !== null)
          })
        }
      }
      replacements.set(cell, pieces)
    }
  }
  return replacements.size ? solids.flatMap(cell => replacements.get(cell) ?? [cell]) : solids
}

/** Clip actual face polygons; bounding boxes overestimate diagonal laser slivers. */
function contactBetween(a: LaserSolid, b: LaserSolid): Contact {
  let cache = contacts.get(a)
  const cached = cache?.get(b)
  if (cached) return cached
  let area = 0, plane = a.planes[0], separation = -Infinity
  for (let faceIndex = 0; faceIndex < a.faces.length; faceIndex++) {
    const boundary = a.planes[faceIndex]
    const distances = b.vertices.map(p => boundary.distanceToPoint(p))
    const nearest = Math.min(...distances)
    // Point/edge contacts have zero area. Still fracture at their interface,
    // rather than using an unrelated face that could consume the whole slab.
    if (area === 0 && nearest > separation) { separation = nearest; plane = boundary }
    // Only an interface facing the other cell can transmit load between cells.
    if (Math.max(...distances) < -.025) continue
    let polygon = a.faces[faceIndex].points
    for (const limit of b.planes) {
      const clipped: THREE.Vector3[] = []
      for (let i = 0; i < polygon.length; i++) {
        const p = polygon[i], q = polygon[(i + 1) % polygon.length]
        const dp = limit.distanceToPoint(p) - 1e-5, dq = limit.distanceToPoint(q) - 1e-5
        if (dp <= 0) clipped.push(p)
        if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) clipped.push(p.clone().lerp(q, dp / (dp - dq)))
      }
      polygon = clipped
      if (polygon.length < 3) break
    }
    const cross = new THREE.Vector3(), sum = new THREE.Vector3()
    for (let i = 1; i + 1 < polygon.length; i++) {
      sum.add(cross.crossVectors(polygon[i].clone().sub(polygon[0]), polygon[i + 1].clone().sub(polygon[0])))
    }
    const faceArea = sum.length() / 2
    if (faceArea > area) { area = faceArea; plane = boundary }
  }
  const contact = { area, plane }
  if (!cache) { cache = new WeakMap(); contacts.set(a, cache) }
  cache.set(b, contact)
  return contact
}

type Edge = { to: number; reverse: number; capacity: number }

/** Route weight through all alternative attachments before declaring a neck weak. */
export function breakWeakBuildingConnections(solids: LaserSolid[], connections: SolidConnections): LaserSolid[] {
  connectedGroups(solids, connections)
  const count = solids.length, source = count, sink = count + 1
  const graph: Edge[][] = Array.from({ length: count + 2 }, () => [])
  const indices = new Map(solids.map((cell, i) => [cell, i]))
  const total = solids.reduce((sum, cell) => sum + cell.volume, 0)
  const add = (from: number, to: number, capacity: number) => {
    graph[from].push({ to, reverse: graph[to].length, capacity })
    graph[to].push({ to: from, reverse: graph[from].length - 1, capacity: 0 })
  }
  const joints: { a: number; b: number; contact: Contact }[] = []
  let grounded = false
  solids.forEach((cell, a) => {
    if (cell.bounds.min.y <= .08) { add(source, a, total + 1); grounded = true }
    else add(a, sink, cell.volume)
    for (const other of connections.get(cell)!) {
      const b = indices.get(other)!
      if (a >= b) continue
      const contact = contactBetween(cell, other)
      joints.push({ a, b, contact })
      add(a, b, contact.area * SUPPORT_LENGTH)
      add(b, a, contact.area * SUPPORT_LENGTH)
    }
  })
  if (!grounded) return fractureUnsupported(solids, connections)

  const levels = new Int32Array(graph.length), cursors = new Int32Array(graph.length)
  const visit = () => {
    levels.fill(-1); levels[source] = 0
    const queue = [source]
    for (let i = 0; i < queue.length; i++) for (const edge of graph[queue[i]]) {
      if (edge.capacity <= EPS || levels[edge.to] !== -1) continue
      levels[edge.to] = levels[queue[i]] + 1; queue.push(edge.to)
    }
    return levels[sink] !== -1
  }
  const send = (from: number, amount: number): number => {
    if (from === sink) return amount
    for (; cursors[from] < graph[from].length; cursors[from]++) {
      const edge = graph[from][cursors[from]]
      if (edge.capacity <= EPS || levels[edge.to] !== levels[from] + 1) continue
      const sent = send(edge.to, Math.min(amount, edge.capacity))
      if (sent <= EPS) continue
      edge.capacity -= sent; graph[edge.to][edge.reverse].capacity += sent
      return sent
    }
    return 0
  }
  while (visit()) {
    cursors.fill(0)
    while (send(source, total + 1) > EPS) { /* exhaust this level graph */ }
  }
  // The final residual search marks the side still supported by the ground.
  const replacements = new Map<LaserSolid, LaserSolid | null>()
  for (const { a, b, contact } of joints) {
    if ((levels[a] >= 0) === (levels[b] >= 0)) continue
    const left = replacements.has(solids[a]) ? replacements.get(solids[a])! : solids[a]
    const right = replacements.has(solids[b]) ? replacements.get(solids[b])! : solids[b]
    // Remove the attachment itself so the released slab cannot hang on an old
    // collider. Both new faces are charred, just like the original laser cut.
    const plane = contact.plane.clone(); plane.constant += FRACTURE_GAP
    if (left) replacements.set(solids[a], clipSolid(left, plane))
    plane.copy(contact.plane).negate(); plane.constant += FRACTURE_GAP
    if (right) replacements.set(solids[b], clipSolid(right, plane))
  }
  const fractured = solids.flatMap(cell => {
    const next = replacements.has(cell) ? replacements.get(cell)! : cell
    return next ? [next] : []
  })
  return fractureUnsupported(fractured, connections)
}
