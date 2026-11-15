// Run with the app open: playwright-cli run-code --filename tests/debris-cleanup.js
async page => {
  await page.locator('.game-loading').waitFor({ state: 'detached' });
  return page.evaluate(async () => {
    const T = await import('/node_modules/.vite/deps/three.js');
    const { default: R } = await import('/node_modules/@dimforge/rapier3d/rapier.js');
    const { LaserDestruction } = await import('/src/LaserDestruction.ts');
    const assert = (value, message) => { if (!value) throw Error(message) };
    const results = {};
    for (const mode of ['age', 'distance', 'settled', 'recut', 'worker', 'foundation', 'tree']) {
      const world = new R.World({ x: 0, y: -9.81, z: 0 });
      const root = new T.Group(), system = new LaserDestruction(root);
      const owner = system.create(mode === 'tree' ? 'tree' : 'building');
      const y = mode === 'foundation' ? 2 : 7;
      const geometry = new T.BoxGeometry(4, 4, 4);
      owner.parts.push({ geometry, matrix: new T.Matrix4().makeTranslation(0, y, 0), color: new T.Color('brown') });
      system.reset(world);
      const original = world.createCollider(R.ColliderDesc.cuboid(2, 2, 2).setTranslation(0, y, 0));
      system.register(owner, original);
      try {
        system.cut(original, new T.Vector3(-1, y, -2), new T.Vector3(0, 0, 1));
        assert(system.chunks.length, 'fixture created no chunks');
        if (mode === 'foundation' || mode === 'tree') {
          system.updateDebris(31, new T.Vector3(1000, 0, 0));
          assert(system.chunks.length, `${mode} was removed`);
        } else {
          if (mode === 'settled') {
            for (const chunk of system.chunks) chunk.body.sleep();
            system.sync();
            assert(system.chunks.every(chunk => chunk.settled), 'fixture did not settle');
          }
          system.updateDebris(29, new T.Vector3(0, y, 0));
          assert(system.chunks.length, 'debris removed before 30 seconds');
          if (mode === 'recut') {
            const collider = system.chunks[0].colliders[0];
            system.cut(collider, new T.Vector3(1, y, -2), new T.Vector3(0, 0, 1));
          }
          if (mode === 'worker') {
            system.ignite(system.chunks[0].colliders[0], new T.Vector3(1, y, -2),
              new T.Vector3(0, 0, 1), new T.Vector3(0, 0, -1));
            system.updateBurns(1.1);
            assert(system.carveJob, 'worker job did not start');
          }
          const chunks = [...system.chunks];
          const handles = chunks.flatMap(chunk => chunk.colliders.map(collider => collider.handle));
          const bodies = chunks.map(chunk => chunk.body.handle);
          let disposed = 0;
          chunks.forEach(chunk => chunk.mesh.geometry.addEventListener('dispose', () => disposed++));
          if (mode === 'distance') {
            system.updateDebris(0, new T.Vector3(100, y, 0));
            assert(system.chunks.length, 'nearby debris removed');
            system.updateDebris(0, new T.Vector3(200, y, 0));
          } else system.updateDebris(1, new T.Vector3(0, y, 0));
          assert(!system.chunks.length, `${mode}: debris survived cleanup`);
          assert(chunks.every(chunk => !chunk.mesh.parent), 'mesh survived cleanup');
          assert(disposed === chunks.length, 'geometry not disposed');
          assert(handles.every(handle => !world.getCollider(handle) && !system.targets.has(handle)), 'collider survived cleanup');
          assert(bodies.every(handle => !world.getRigidBody(handle)), 'body survived cleanup');
          assert(!system.carveJob && !system.burns.length, 'pending burn or worker survived cleanup');
        }
        results[mode] = 'passed';
      } finally {
        system.dispose(); world.free(); geometry.dispose();
      }
    }
    return results;
  });
}
