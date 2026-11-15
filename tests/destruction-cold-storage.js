// Run with the app open: playwright-cli run-code --filename tests/destruction-cold-storage.js
async page => page.evaluate(async () => {
  const T = await import('/node_modules/.vite/deps/three.js')
  const { default: R } = await import('/node_modules/@dimforge/rapier3d/rapier.js')
  const { LaserDestruction } = await import('/src/LaserDestruction.ts')
  const assert = (value, message) => { if (!value) throw Error(message) }
  const waitFor = async predicate => {
    const deadline = performance.now() + 3000
    while (!predicate() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    return predicate()
  }

  const world = new R.World({ x: 0, y: -9.81, z: 0 })
  const root = new T.Group(), system = new LaserDestruction(root)
  const owner = system.create('building'), geometry = new T.BoxGeometry(4, 4, 4)
  owner.parts.push({ geometry, matrix: new T.Matrix4().makeTranslation(0, 2, 0), color: new T.Color('gray') })
  system.reset(world)
  const original = world.createCollider(R.ColliderDesc.cuboid(2, 2, 2).setTranslation(0, 2, 0))
  system.register(owner, original)
  try {
    system.cut(original, new T.Vector3(-1, 2, -2), new T.Vector3(0, 0, 1))
    const chunk = system.chunks.find(candidate => !candidate.body && candidate.colliders.length)
    assert(chunk?.mesh.parent && chunk.solids.length, 'grounded replacement was not created')
    const collider = chunk.colliders[0]
    const vertices = chunk.mesh.geometry.getAttribute('position').count

    system.updateDebris(9, new T.Vector3())
    assert(await waitFor(() => !!chunk.archiveKey), 'idle CSG data was not archived')
    assert(chunk.solids.length === 0 && chunk.connections.size === 0 && chunk.cells.size === 0,
      'archived topology remained in memory')
    assert(chunk.mesh.parent && chunk.mesh.geometry.getAttribute('position').count === vertices,
      'archiving changed visible geometry')
    assert(collider.isValid() && system.ownerOf(collider) === owner, 'archiving changed collision behavior')

    system.queueContact(collider, new T.Vector3(1, 2, -2), new T.Vector3(0, 0, -1), 20)
    assert(await waitFor(() => chunk.solids.length > 0 && system.burns.length === 1),
      'a collision was lost while restoring archived topology')
    assert(!chunk.archiveKey && chunk.connections.size && chunk.cells.size, 'restored topology was incomplete')
    const deadline = performance.now() + 5000
    while ((system.burns.length || system.carveJob) && performance.now() < deadline) {
      system.updateBurns(1 / 60)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert(!system.burns.length && !system.carveJob, 'replayed collision did not finish carving')
    return { archived: true, visible: true, collidable: true, collisionReplayed: true,
      replayCompleted: true, vertices }
  } finally {
    system.dispose(); world.free(); geometry.dispose()
  }
})
