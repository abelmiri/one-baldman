import * as THREE from 'three'
import { carve, reviveSolid, type CarveInput, type CarveOutput } from './LaserCarving'
import { laserSolid } from './LaserGeometry'

const scope = self as unknown as {
  onmessage: (event: MessageEvent<CarveInput[]>) => void
  postMessage: (value: { results: CarveOutput[] } | { error: string }, transfer?: ArrayBuffer[]) => void
}
scope.onmessage = event => {
  try {
    const results = event.data.map(input => {
      if (input.parts) {
        const templates = new Map<Float32Array, THREE.BufferGeometry>()
        input.solids = input.parts.map(part => {
          let geometry = templates.get(part.positions)
          if (!geometry) {
            geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(part.positions, 3))
            templates.set(part.positions, geometry)
          }
          return laserSolid(geometry, new THREE.Matrix4().fromArray(part.matrix), new THREE.Color().fromArray(part.color))
        })
        templates.forEach(geometry => geometry.dispose())
      }
      input.solids.forEach(reviveSolid)
      for (const shot of input.shots) {
        Object.setPrototypeOf(shot.point, THREE.Vector3.prototype)
        Object.setPrototypeOf(shot.direction, THREE.Vector3.prototype)
      }
      return carve(input)
    })
    const buffers = results.flatMap(result => [result.edges.buffer as ArrayBuffer,
      ...result.groupInfo.map(group => group.edges.buffer as ArrayBuffer),
      ...result.geometry.flatMap(geometry => [geometry.position.buffer, geometry.color.buffer, geometry.normal.buffer] as ArrayBuffer[]),
      ...result.physics.flatMap(group => group.flatMap(mesh => [mesh.vertices.buffer, mesh.indices.buffer] as ArrayBuffer[]))])
    scope.postMessage({ results }, buffers)
  } catch (error) { scope.postMessage({ error: String(error) }) }
}
