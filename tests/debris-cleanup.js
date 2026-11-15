// Run with the app open: playwright-cli run-code --filename tests/debris-cleanup.js
async page => {
  await page.locator('.game-loading').waitFor({ state: 'detached' });
  return page.evaluate(async () => {
    const T = await import('/node_modules/.vite/deps/three.js');
    const { default: R } = await import('/node_modules/@dimforge/rapier3d/rapier.js');
    const { LaserDestruction } = await import('/src/LaserDestruction.ts');
    const assert = (value, message) => { if (!value) throw Error(message) };
    const results = {};
    const cases = ['building', 'tree', 'car'].flatMap(kind =>
      ['age', 'distance', 'settled', 'recut'].map(mode => [kind, mode]));
    cases.push(['building', 'worker'], ['building', 'foundation'], ['tree', 'foundation']);
    for (const [kind, mode] of cases) {
      const world = new R.World({ x: 0, y: -9.81, z: 0 });
      const root = new T.Group(), system = new LaserDestruction(root);
      const owner = system.create(kind);
      const y = mode === 'foundation' ? 2 : 7;
      const geometry = new T.BoxGeometry(4, 4, 4);
      owner.parts.push({ geometry, matrix: new T.Matrix4().makeTranslation(0, y, 0), color: new T.Color('brown') });
      system.reset(world);
      const original = world.createCollider(R.ColliderDesc.cuboid(2, 2, 2).setTranslation(0, y, 0));
      system.register(owner, original);
      try {
        if (kind !== 'building' && mode !== 'foundation') {
          system.queueContact(original, new T.Vector3(-1, y, -2), new T.Vector3(0, 0, -1), 20);
          assert(system.chunks.length === 10, 'prop fixture did not shatter');
        } else system.cut(original, new T.Vector3(-1, y, -2), new T.Vector3(0, 0, 1));
        assert(system.chunks.length, 'fixture created no chunks');
        if (mode === 'foundation') {
          system.updateDebris(31, new T.Vector3(1000, 0, 0));
          assert(system.chunks.length && system.chunks.every(chunk => !chunk.body), `${kind} foundation was removed`);
        } else {
          if (mode === 'settled') {
            for (const chunk of system.chunks) chunk.body.sleep();
            system.sync();
            assert(system.chunks.every(chunk => chunk.settled), 'fixture did not settle');
          }
          system.updateDebris(29, new T.Vector3(0, y, 0));
          assert(system.chunks.length, 'debris removed before 30 seconds');
          if (mode === 'recut') {
            const chunk = system.chunks[0];
            const point = chunk.solids[0].bounds.getCenter(new T.Vector3());
            if (chunk.body) point.applyQuaternion(new T.Quaternion().copy(chunk.body.rotation())).add(chunk.body.translation());
            system.cut(chunk.colliders[0], point, new T.Vector3(0, 0, 1));
            assert(system.chunks.every(chunk => chunk.debrisAge === 29), 'recut restarted debris lifetime');
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
        results[`${kind}-${mode}`] = 'passed';
      } finally {
        system.dispose(); world.free(); geometry.dispose();
      }
    }
    return results;
  });
}
