// Run: node --experimental-strip-types tests/building-shell.mjs
import assert from 'node:assert/strict'
import { buildingShell } from '../src/BuildingShell.ts'

const cells = buildingShell(15, 12.2, 11)
const contains = (x, y, z) => cells.some(c => Math.abs(x - c.x) < c.w / 2 - 1e-6
  && Math.abs(y - c.y) < c.h / 2 - 1e-6 && Math.abs(z - c.z) < c.d / 2 - 1e-6)
const volume = cells.reduce((sum, c) => sum + c.w * c.h * c.d, 0)
assert(volume < 15 * 12.2 * 11 * .25, 'shell retained most of the solid building volume')
assert(cells.length <= 32, 'room layout created excessive detail')
assert(cells.every(c => Math.abs(c.x) + c.w / 2 <= 7.5 + 1e-6
  && Math.abs(c.y) + c.h / 2 <= 6.1 + 1e-6 && Math.abs(c.z) + c.d / 2 <= 5.5 + 1e-6))
assert(!contains(-3, -4.6, 2) && !contains(3, -4.6, 2), 'rooms are filled')
assert(contains(0, -4.6, 2), 'room divider is missing')
assert(!contains(0, -4.6, 0), 'doorway is blocked')
assert(contains(7.4, 0, 0) && contains(0, 0, 5.4), 'outer shell is not closed')
assert(!contains(-3, -6.02, 2), 'ground floor retained a separate slab')
assert(contains(-3, -3.12, 2), 'upper floor slab was removed')
assert(contains(-3, 6.02, 2), 'roof slab was removed')
const elevated = buildingShell(15, 12.2, 11, true)
assert(elevated.some(c => c.role === 'floor' && Math.abs(c.y - (-6.1 + .08)) < 1e-6), 'elevated volume lost its base')
console.log(JSON.stringify({ passed: true, cells: cells.length, materialFraction: volume / (15 * 12.2 * 11) }))
