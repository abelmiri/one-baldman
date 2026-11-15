// Run with the app open: playwright-cli run-code --filename tests/settled-debris.js
async page => {
  await page.reload();
  await page.locator('.game-loading').waitFor({ state: 'detached' });
  return page.evaluate(async () => {
    const T = await import('/node_modules/.vite/deps/three.js');
    const { default: R } = await import('/node_modules/@dimforge/rapier3d/rapier.js');
    const { LaserDestruction } = await import('/src/LaserDestruction.ts');
    const assert = (value, message) => { if (!value) throw Error(message) };
    const results = {};
    for (const worker of [false, true]) {
      const world = new R.World({ x: 0, y: -9.81, z: 0 });
      const root = new T.Group(), system = new LaserDestruction(root);
      const owner = system.create('building'), geometry = new T.BoxGeometry(4, 4, 4);
      owner.parts.push({ geometry, matrix: new T.Matrix4().makeTranslation(0, 7, 0), color: new T.Color('brown') });
      system.reset(world);
      world.createCollider(R.ColliderDesc.cuboid(50, .1, 50).setTranslation(0, -.1, 0));
      const original = world.createCollider(R.ColliderDesc.cuboid(2, 2, 2).setTranslation(0, 7, 0));
      system.register(owner, original);
      try {
        system.cut(original, new T.Vector3(-1, 7, -2), new T.Vector3(0, 0, 1));
        assert(system.chunks.some(chunk => chunk.body?.isDynamic()), 'unsupported debris did not start dynamic');
        for (let i = 0; i < 1800 && system.chunks.some(chunk => chunk.body?.isDynamic()); i++) {
          world.step(); system.sync();
        }
        const chunks = system.chunks;
        assert(chunks.length && chunks.every(chunk => chunk.settled && chunk.body.isFixed()), 'resting rubble stayed in dynamic simulation');
        const chunk = chunks[0], position = new T.Vector3().copy(chunk.body.translation());
        const rotation = new T.Quaternion().copy(chunk.body.rotation());
        const direction = new T.Vector3(0, 0, 1).applyQuaternion(rotation);
        const origin = new T.Vector3(1, 0, -5).applyQuaternion(rotation).add(position);
        world.step();
        const predicate = collider => system.ownerOf(collider) === owner;
        const ray = new R.Ray(origin, direction);
        const hit = world.castRay(ray, 10, true, undefined, undefined, undefined, undefined, predicate);
        assert(hit, 'settled rubble disappeared from laser queries');
        assert(world.castShape(origin, rotation, direction, new R.Capsule(.5, .3), 0, 10, true,
          undefined, undefined, undefined, undefined, predicate), 'character capsule passed through settled rubble');
        const volume = chunks.reduce((sum, chunk) => sum + chunk.solids.reduce((v, cell) => v + cell.volume, 0), 0);
        const point = origin.clone().addScaledVector(direction, hit.timeOfImpact);
        if (worker) {
          system.ignite(hit.collider, point, direction, direction.clone().negate());
          const deadline = performance.now() + 15000;
          do {
            system.updateBurns(.05);
            await new Promise(resolve => setTimeout(resolve, 5));
          } while ((system.burns.length || system.carveJob) && performance.now() < deadline);
          assert(!system.burns.length && !system.carveJob, 'worker cut did not complete');
        } else system.cut(hit.collider, point, direction);
        world.step();
        assert(system.chunks.reduce((sum, chunk) => sum + chunk.solids.reduce((v, cell) => v + cell.volume, 0), 0) < volume,
          'laser did not remove settled rubble');
        assert(!world.castRay(ray, 10, true, undefined, undefined, undefined, undefined, predicate), 'laser hole retained a collider');
        assert(system.chunks.every(chunk => chunk.settled && chunk.body.isFixed()), 'laser reactivated settled debris');
        // A full severing cut must also keep every resulting body fixed.
        const collider = system.chunks.find(chunk => chunk.colliders.length).colliders[0];
        const shots = [];
        for (let x = -2.2; x <= 2.2; x += .24) shots.push({ collider,
          point: new T.Vector3(x, 0, -3).applyQuaternion(rotation).add(position), direction, eye: -1 });
        if (worker) {
          for (const shot of shots) system.ignite(collider, shot.point, direction, direction.clone().negate());
          const deadline = performance.now() + 15000;
          do {
            system.updateBurns(.05);
            await new Promise(resolve => setTimeout(resolve, 5));
          } while ((system.burns.length || system.carveJob) && performance.now() < deadline);
          assert(!system.burns.length && !system.carveJob, 'worker severing cut did not complete');
        } else system.cutMany(shots, false);
        assert(system.chunks.length > 1, 'test cut did not split settled debris');
        assert(system.chunks.every(chunk => chunk.settled && chunk.body.isFixed()), 'split rubble became dynamic');
        const poses = system.chunks.map(chunk => new T.Vector3().copy(chunk.body.translation()));
        for (let i = 0; i < 60; i++) { world.step(); system.sync() }
        assert(system.chunks.every((chunk, i) => poses[i].distanceTo(chunk.body.translation()) < 1e-6), 'settled rubble moved after cutting');
        results[worker ? 'worker' : 'direct'] = { fixed: true, characterCollision: true, laserHole: true, splitStaysFixed: true };
      } finally {
        system.dispose(); world.free(); geometry.dispose();
      }
    }
    return results;
  });
}
