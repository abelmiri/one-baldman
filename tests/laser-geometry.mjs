// Run: node --experimental-strip-types tests/laser-geometry.mjs
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { laserPlanes, laserSolid, solidGeometry, solidsTouch, subtractLaser, translatedSolid } from '../src/LaserGeometry.ts'

const box = new THREE.BoxGeometry(4, 4, 4)
const source = laserSolid(box, new THREE.Matrix4(), new THREE.Color('#b97b59'))
assert(Math.abs(source.volume - 64) < 1e-8)
for (const axis of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, .5, 1).normalize()]) {
  const planes = laserPlanes(axis.clone().multiplyScalar(-5), axis, .22)
  const cells = subtractLaser(source, planes)
  assert(cells.reduce((sum, cell) => sum + cell.volume, 0) < source.volume - .2, 'beam removed no volume')
  assert(cells.every(cell => cell.planes.some(plane => plane.distanceToPoint(new THREE.Vector3()) >= -1e-5)), 'beam center remains filled')
  const repeated = cells.flatMap(cell => subtractLaser(cell, planes))
  assert.deepEqual(repeated, cells, 'holding still keeps fragmenting the same hole')
  const geometry = solidGeometry(cells, new THREE.Vector3())
  assert(geometry.attributes.position.array.every(Number.isFinite))
  assert(geometry.attributes.normal.array.every(Number.isFinite))
  geometry.dispose()
}
const behind = subtractLaser(source, laserPlanes(new THREE.Vector3(0, 0, 3), new THREE.Vector3(0, 0, 1), .22))
assert.equal(behind[0], source, 'beam removed material behind its origin')
const tangent = subtractLaser(source, laserPlanes(new THREE.Vector3(2.22, 0, -5), new THREE.Vector3(0, 0, 1), .22))
assert.equal(tangent[0], source, 'a tangent beam created zero-thickness fragments')
const rotatedCenter = new THREE.Vector3(-57, 2, 70)
const rotated = laserSolid(box, new THREE.Matrix4().compose(rotatedCenter,
  new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, .4), new THREE.Vector3(2, 1, 1.9)), new THREE.Color('red'))
assert(Math.abs(rotated.volume - 64 * 2 * 1.9) < .001)
const diagonal = new THREE.Vector3(1, .1, 1).normalize()
const oblique = subtractLaser(rotated, laserPlanes(rotatedCenter.clone().addScaledVector(diagonal, -10), diagonal, .22))
assert(oblique.every(cell => cell.planes.some(plane => plane.distanceToPoint(rotatedCenter) >= -1e-5)), 'oblique cut missed a rotated structure')

let cells = [source]
for (let x = -2.16; x <= 2.2; x += .24) cells = cells.flatMap(cell => subtractLaser(cell,
  laserPlanes(new THREE.Vector3(x, 0, -3), new THREE.Vector3(0, 0, 1), .22)))
const below = cells.filter(cell => cell.bounds.max.y < 0), above = cells.filter(cell => cell.bounds.min.y > 0)
assert(below.length && above.length && below.length + above.length === cells.length, 'completed cut did not split the source')
assert(below.every(a => above.every(b => !solidsTouch(a, b))), 'cut faces remain connected')
const offset = new THREE.Vector3(100, 20, -50)
const shifted = translatedSolid(source, offset)
assert(source.bounds.getCenter(new THREE.Vector3()).length() < 1e-8, 'translation mutated shared source vertices')
assert(shifted.bounds.getCenter(new THREE.Vector3()).distanceTo(offset) < 1e-8)
assert(Math.abs(shifted.volume - source.volume) < 1e-8)
assert(shifted.planes.every(plane => plane.distanceToPoint(offset) < 0), 'translated face planes diverged from the mesh')
box.dispose()
console.log(JSON.stringify({ passed: true, axes: 4, repeatedCutStable: true, completedCutSplits: true, cells: cells.length }))
