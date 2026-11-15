// Run: node --experimental-strip-types tests/building-support.mjs
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { breakWeakBuildingConnections } from '../src/BuildingSupport.ts'
import { carve } from '../src/LaserCarving.ts'
import { buildingShell } from '../src/BuildingShell.ts'
import { connectedGroups, laserPlanes, laserSolid, solidsTouch, subtractLaser } from '../src/LaserGeometry.ts'

const color = new THREE.Color('#b97b59')
const box = (w, h, d, x, y, z = 0) => {
  const geometry = new THREE.BoxGeometry(w, h, d)
  const cell = laserSolid(geometry, new THREE.Matrix4().makeTranslation(x, y, z), color)
  geometry.dispose()
  return cell
}
const source = box(4, 4, 4, 0, 2)
const axis = new THREE.Vector3(0, 0, 1)
const input = { solids: [source], kind: 'building', moving: false, visible: false }
const hole = carve({ ...input, shots: [{ point: new THREE.Vector3(0, 2, -2), direction: axis }] })
assert.equal(hole.groups.length, 1, 'a small hole collapsed the building')
assert(hole.groupInfo[0].grounded)

// Leave a real material bridge at the right edge, without completing the cut.
const shots = []
for (let x = -2.16; x < 1.81; x += .24) shots.push({ point: new THREE.Vector3(x, 2, -2), direction: axis })
const cut = shots.reduce((cells, shot) => cells.flatMap(cell => subtractLaser(cell, laserPlanes(shot.point, axis, .22))), [source])
assert.equal(connectedGroups(cut, new Map()).length, 1, 'fixture has no remaining bridge')
const connections = new Map()
const broken = breakWeakBuildingConnections(cut, connections)
const groups = connectedGroups(broken, connections)
assert.equal(groups.length, 2, 'narrow remaining bridge kept the upper section suspended')
assert(broken.reduce((sum, cell) => sum + cell.volume, 0) < cut.reduce((sum, cell) => sum + cell.volume, 0), 'broken attachments were not removed')
assert(groups[0].every(a => groups[1].every(b => !solidsTouch(a, b))), 'fracture gap still transmits support')
assert.deepEqual(breakWeakBuildingConnections(broken, connections), broken, 'an already fractured neck kept eroding')
const worker = carve({ ...input, shots })
assert.equal(worker.groups.length, groups.length, 'worker and direct cuts disagree about detachment')
assert(worker.groupInfo.some(group => !group.grounded), 'worker did not release the upper fragment')

// Load can travel through several attachments. Each is weak alone, but their
// combined area supports the slab; loss of one should release it.
const base = box(4, .5, 1, 0, .25)
const left = box(.3, .5, 1, -1, .75), right = box(.3, .5, 1, 1, .75)
const slab = box(4, 2.5, 1, 0, 2.25)
const supported = [base, left, right, slab]
assert.deepEqual(breakWeakBuildingConnections(supported, new Map()), supported, 'parallel supports were not combined')
const damaged = breakWeakBuildingConnections([base, left, slab], new Map())
assert(connectedGroups(damaged, new Map()).length > 1, 'remaining overloaded support did not fail')

const edgeSlab = box(4, 2.5, 1, 4, 1.75)
const edgeContact = breakWeakBuildingConnections([base, edgeSlab], new Map())
assert.equal(connectedGroups(edgeContact, new Map()).length, 2, 'an edge contact held up a large slab')
assert(edgeContact.some(cell => cell.volume > edgeSlab.volume * .9), 'zero-area attachment deleted the slab instead of releasing it')

const moving = carve({ ...input, moving: true, shots })
assert.equal(moving.groups.length, 1, 'local coordinates of moving debris were treated as grounded structure')
const tree = carve({ ...input, kind: 'tree', shots })
assert.equal(tree.groups.length, 1, 'building strength rules leaked into trees')

// A failed multi-storey shell must not become one rigid, hollow falling building.
const shell = buildingShell(14, 12, 10, true).map(cell =>
  box(cell.w, cell.h, cell.d, cell.x, cell.y + 8.5, cell.z))
const foundation = box(14, .5, 10, 0, .25)
const failingPier = box(.2, 2, .2, 0, 1.5)
const structure = [foundation, failingPier, ...shell]
assert.equal(connectedGroups(structure, new Map()).length, 1, 'collapse fixture was already detached')
const debris = breakWeakBuildingConnections(structure, new Map())
const rubble = connectedGroups(debris, new Map())
const released = rubble.filter(group => group.every(cell => cell.bounds.min.y > .08))
assert(released.length > 8, 'failed walls and floors remained one rigid shell')
assert(rubble.some(group => group.some(cell => cell.bounds.min.y <= .08 && cell.volume > foundation.volume * .8)),
  'collapse removed the grounded foundation')
for (const group of released) {
  const bounds = new THREE.Box3()
  group.forEach(cell => bounds.union(cell.bounds))
  const size = bounds.getSize(new THREE.Vector3())
  assert(Math.max(size.x, size.y, size.z) <= 6.5 + 1e-5, 'a continuous wall survived across debris panels')
}
assert(debris.reduce((sum, cell) => sum + cell.volume, 0) > structure.reduce((sum, cell) => sum + cell.volume, 0) * .8,
  'collapse erased the building instead of producing debris')
const collapsedWorker = carve({ ...input, solids: structure, shots: [] })
assert.equal(collapsedWorker.groups.length, rubble.length, 'worker and direct collapse differ')
assert(collapsedWorker.groupInfo.filter(group => !group.grounded).length === released.length,
  'collapsed panels were not prepared as dynamic debris')
assert(connectedGroups(breakWeakBuildingConnections(shell, new Map()), new Map()).length > 8,
  'a completely unsupported shell bypassed fracture')
const fallingShell = carve({ ...input, solids: shell, moving: true, shots: [] })
assert.equal(fallingShell.groups.length, 1, 'moving debris was fractured again on an unrelated cut')

// Joint clearance must preserve each exterior face, including different colors
// on the same solid, while newly exposed fracture faces remain charred.
const painted = box(12, .4, 10, 0, 5)
painted.faces.forEach((face, i) => { face.color = new THREE.Color().setHSL(i / painted.faces.length, .6, .5) })
const verifyFacade = cells => {
  const seen = new Set()
  let interior = 0
  for (const cell of cells) for (const [i, face] of cell.faces.entries()) {
    const surface = painted.planes.findIndex(plane => plane.normal.dot(cell.planes[i].normal) > .999999
      && Math.abs(cell.planes[i].constant - plane.constant - .02) < 1e-5)
    if (surface >= 0) {
      assert(face.color.equals(painted.faces[surface].color), 'collapse recolored an exterior face')
      seen.add(surface)
    } else {
      assert(face.color.equals(new THREE.Color('#39251d')), 'new fracture face lost its burn color')
      interior++
    }
  }
  assert.equal(seen.size, painted.faces.length, 'collapse lost a painted side')
  assert(interior > 0, 'fixture did not create new fracture faces')
}
verifyFacade(breakWeakBuildingConnections([painted], new Map()))
const paintedWorker = carve({ ...input, solids: [painted], shots: [] })
verifyFacade(paintedWorker.solids.map(cell => typeof cell === 'number' ? painted : cell))
console.log(JSON.stringify({ passed: true, partialHoleStable: true, weakBridgeBreaks: true, fractureRemovesMaterial: true,
  parallelSupports: true, workerParity: true, collapsePanels: released.length, facadeColorsPreserved: true }))
