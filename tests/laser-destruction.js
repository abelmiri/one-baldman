// Run with the app open: playwright-cli run-code --filename tests/laser-destruction.js
async page => {
  await page.reload();
  await page.locator('.game-loading').waitFor({ state: 'detached' });
  return page.evaluate(async () => {
    const T = await import('/node_modules/.vite/deps/three.js');
    const { default: R } = await import('/node_modules/@dimforge/rapier3d/rapier.js');
    const { LaserDestruction } = await import('/src/LaserDestruction.ts');
    const assert = (value, message) => { if (!value) throw Error(message) };
    const root = document.getElementById('root');
    const fiber = root[Object.keys(root).find(k => k.startsWith('__reactContainer'))].stateNode.current;
    const find = f => !f ? null : f.type?.name === 'App' ? f : find(f.child) || find(f.sibling);
    let hook = find(fiber).memoizedState;
    while (hook && !hook.memoizedState?.current?.ragdoll) hook = hook.next;
    const lab = hook.memoizedState.current;
    cancelAnimationFrame(lab.raf);
    const world = new R.World({ x: 0, y: -9.81, z: 0 });
    const group = new T.Group();
    const system = new LaserDestruction(group);
    const geometry = new T.BoxGeometry(4, 4, 4);
    const material = new T.MeshStandardMaterial();
    const mesh = new T.InstancedMesh(geometry, material, 1);
    const matrix = new T.Matrix4().makeTranslation(0, 2, 0);
    mesh.setMatrixAt(0, matrix); group.add(mesh);
    const owner = system.create('building');
    owner.parts.push({ geometry, matrix, color: new T.Color('#b97b59'), mesh, index: 0 });
    system.reset(world);
    world.createCollider(R.ColliderDesc.cuboid(50, .1, 50).setTranslation(0, -.1, 0));
    const original = world.createCollider(R.ColliderDesc.cuboid(2, 2, 2).setTranslation(0, 2, 0));
    system.register(owner, original);
    world.step();
    const axis = new T.Vector3(0, 0, 1);
    const ray = x => world.castRay(new R.Ray({ x, y: 2, z: -5 }, axis), 10, true);
    const results = {};
    try {
      assert(ray(0), 'initial building collider missing');
      assert(system.cut(original, new T.Vector3(0, 2, -2), axis), 'laser did not cut');
      world.step(); system.sync();
      assert(!ray(0), 'laser hole still has a solid physics collider');
      assert(ray(.7), 'material outside the laser hole was deleted');
      assert(system.chunks.every(chunk => !chunk.body), 'a partial hole collapsed a connected building');
      group.updateMatrixWorld(true);
      const visible = new T.Raycaster(new T.Vector3(0, 2, -5), axis, 0, 10);
      assert(visible.intersectObject(group, true).length === 0, 'visual geometry did not open at the hit');
      results.hole = { visual: true, physics: true, staysSupported: true };
      const start = performance.now();
      let firstReleaseX;
      for (let x = -2.16; x < 2.2; x += .24) {
        const collider = system.chunks.find(chunk => chunk.colliders.length)?.colliders[0];
        assert(collider, 'all material disappeared during the sweep');
        system.cut(collider, new T.Vector3(x, 2, -2), axis);
        if (firstReleaseX === undefined && system.chunks.some(chunk => chunk.body)) firstReleaseX = x;
      }
      assert(firstReleaseX !== undefined && firstReleaseX + .22 < 2, 'upper section waited for every narrow attachment to be cut');
      const top = system.chunks.filter(chunk => chunk.body);
      assert(top.length > 0, 'completed cut did not release an unsupported section');
      assert(system.chunks.some(chunk => !chunk.body), 'grounded foundation was released');
      const heights = top.map(chunk => chunk.body.translation().y);
      for (let i = 0; i < 45; i++) world.step();
      system.sync();
      assert(top.some((chunk, i) => chunk.body.translation().y < heights[i] - .3), 'detached section did not fall under gravity');
      assert(top.every(chunk => chunk.mesh.position.distanceTo(chunk.body.translation()) < 1e-6), 'debris rendering diverged from physics');
      results.sweep = { detached: top.length, chunks: system.chunks.length, firstReleaseX, elapsedMs: performance.now() - start };
      // Repeated cuts on a moving fragment must transform the beam into its local frame.
      const moving = top.find(chunk => chunk.colliders.length);
      const localPoint = moving.solids[0].bounds.getCenter(new T.Vector3());
      const worldPoint = localPoint.clone().applyQuaternion(new T.Quaternion().copy(moving.body.rotation())).add(moving.body.translation());
      system.cut(moving.colliders[0], worldPoint, axis);
      for (let i = 0; i < 10; i++) world.step();
      assert(system.chunks.every(chunk => !chunk.body || Number.isFinite(chunk.body.translation().y)), 'recutting debris corrupted physics');
      const replacement = new R.World({ x: 0, y: -9.81, z: 0 });
      system.reset(replacement);
      const restored = new T.Matrix4(); mesh.getMatrixAt(0, restored);
      assert(!owner.damaged && system.chunks.length === 0 && restored.equals(matrix), 'reset did not restore intact source instances');
      replacement.free();
      results.reset = true;

      // Both eyes may hit the same collider. Keep both hits valid and rebuild once.
      const batchWorld = new R.World({ x: 0, y: -9.81, z: 0 });
      system.reset(batchWorld);
      try {
        const intact = batchWorld.createCollider(R.ColliderDesc.cuboid(2, 2, 2).setTranslation(0, 2, 0));
        system.register(owner, intact);
        let rebuilds = 0;
        const rebuild = system.rebuild;
        system.rebuild = function (...args) { rebuilds++; return rebuild.apply(this, args) };
        try {
          assert(system.cutMany([
            { collider: intact, point: new T.Vector3(-.7, 2, -2), direction: axis, eye: 0 },
            { collider: intact, point: new T.Vector3(.7, 2, -2), direction: axis, eye: 1 },
          ]), 'batched eye beams did not cut');
          assert(rebuilds === 1, 'same-frame hits rebuilt the same chunk more than once');
          batchWorld.step();
          const batchRay = x => batchWorld.castRay(new R.Ray({ x, y: 2, z: -5 }, axis), 10, true);
          assert(!batchRay(-.7) && !batchRay(.7), 'one of the eye hits was lost when its collider was replaced');
          assert(batchRay(0), 'batching deleted material between separate eye beams');
          rebuilds = 0;
          assert(!system.cutMany([]) && rebuilds === 0, 'empty batch rebuilt geometry');
          const chunk = system.chunks.find(chunk => chunk.colliders.length);
          assert(!system.cut(chunk.colliders[0], new T.Vector3(-.7, 2, -2), axis), 'stationary beam changed an existing hole');
          assert(rebuilds === 0, 'stationary beam rebuilt geometry');
          const originalShapes = new Map(chunk.cells);
          system.cut(chunk.colliders[0], new T.Vector3(.5, 2, -2), axis);
          assert(rebuilds === 1, 'interpolated stroke rebuilt geometry for each sample');
          let retained = 0;
          for (const [cell, shape] of originalShapes) if (chunk.cells.has(cell)) {
            assert(chunk.cells.get(cell) === shape && shape.isValid(), 'unchanged material lost its physics collider');
            retained++;
          }
          assert(retained > 0, 'incremental cut retained no unchanged colliders');
          batchWorld.step();
          for (const x of [-.5, -.25, 0, .25, .5]) assert(!batchRay(x), 'batched stroke left a gap');
          results.batching = { bothEyes: true, rebuildsPerChunk: 1, stationaryStable: true, continuousStroke: true };
        } finally { system.rebuild = rebuild }
        const carOwner = system.create('car');
        carOwner.parts.push({ geometry, matrix: new T.Matrix4().makeTranslation(10, 2, 0), color: new T.Color('red') });
        const carCollider = batchWorld.createCollider(R.ColliderDesc.cuboid(2, 2, 2).setTranslation(10, 2, 0));
        system.register(carOwner, carCollider);
        system.cut(carCollider, new T.Vector3(10, 2, -2), axis);
        const carChunk = system.chunks.find(chunk => chunk.owner === carOwner);
        const body = carChunk.body;
        assert(body, 'car fragment has no dynamic body');
        const spin = { x: .1, y: .2, z: .3 };
        body.setAngvel(spin, true);
        system.cut(carChunk.colliders[0], new T.Vector3(10.15, 2, -2), axis);
        assert(system.chunks.find(chunk => chunk.owner === carOwner).body === body && body.isValid(), 'connected fragment recreated its rigid body');
        assert(Number.isFinite(body.mass()) && body.mass() > 0, 'incremental collider updates corrupted mass');
      } finally { system.reset(world); batchWorld.free() }

      // Exercise actual city ownership, parked/moving cars, canopy and eye-beam integration.
      lab.reset();
      const city = lab.city, destruction = city.destruction;
      assert(destruction.objects.filter(owner => owner.kind === 'building').length > 15, 'city buildings were not registered');
      const tree = destruction.objects.find(owner => owner.kind === 'tree');
      assert(tree.colliders.length === tree.parts.length, 'tree crown has no laser collision');
      const treeBounds = new T.Box3().setFromBufferAttribute(tree.parts[0].geometry.attributes.position).applyMatrix4(tree.parts[0].matrix);
      const center = treeBounds.getCenter(new T.Vector3());
      const trunkHit = tree.colliders[0];
      destruction.cut(trunkHit, new T.Vector3(center.x, .8, center.z - 1), axis);
      lab.world.step();
      assert(tree.damaged, 'actual tree did not activate');
      for (let x = treeBounds.min.x - .2; x <= treeBounds.max.x + .2; x += .2) {
        const trunk = destruction.chunks.find(chunk => chunk.owner === tree && chunk.colliders.length);
        destruction.cut(trunk.colliders[0], new T.Vector3(x, .8, center.z - 1), axis);
      }
      assert(destruction.chunks.some(chunk => chunk.owner === tree && chunk.body), 'a fully severed tree trunk kept the crown suspended');
      const car = city.traffic[0];
      city.root.updateMatrixWorld(true);
      const carPoint = new T.Vector3(0, .8, -2).applyMatrix4(car.mesh.matrixWorld);
      destruction.cut(car.owner.colliders[0], carPoint, new T.Vector3(0, 0, 1).applyQuaternion(car.mesh.quaternion));
      assert(car.owner.damaged && !car.body, 'damaged traffic still follows a kinematic route');
      const frozen = car.mesh.position.clone(); city.update(50); city.stepTraffic(50);
      assert(car.mesh.position.equals(frozen), 'traffic animation moved the damaged car');
      lab.world.step(); city.update(50);
      assert(destruction.chunks.some(chunk => chunk.owner === car.owner && chunk.body), 'car did not become physical debris');
      results.city = { buildings: true, trees: true, movingCars: true };
      lab.reset();
      const building = city.destruction.objects.find(owner => owner.kind === 'building');
      const bounds = building.parts.reduce((bounds, part) => bounds.union(new T.Box3().setFromBufferAttribute(part.geometry.attributes.position).applyMatrix4(part.matrix)), new T.Box3());
      const aim = bounds.getCenter(new T.Vector3());
      const head = new T.Object3D(); head.position.copy(aim).add(new T.Vector3(0, 0, -12)); head.updateMatrixWorld();
      const camera = new T.PerspectiveCamera(); camera.position.copy(head.position).add(new T.Vector3(0, 0, -5)); camera.lookAt(aim); camera.updateMatrixWorld();
      lab.world.step();
      for (let i = 0; i < 4; i++) { lab.heatVision.update(1 / 30, true, head, camera, lab.world, city.destruction); lab.world.step() }
      assert(!building.damaged, 'eye beams destroyed a building before its surface heated up');
      assert(city.destruction.burnMarks.count > 0, 'building surface did not glow red while burning');
      for (let i = 4; i < 47; i++) { lab.heatVision.update(1 / 30, true, head, camera, lab.world, city.destruction); lab.world.step() }
      for (let i = 0; !building.damaged && i < 500; i++) {
        assert(!destruction.carveJob?.error, `carving worker failed: ${destruction.carveJob?.error}`);
        await new Promise(resolve => setTimeout(resolve, 10));
        destruction.updateBurns(0);
      }
      assert(building.damaged, 'eye beams never called city destruction');
      lab.heatVision.update(1 / 30, false, head, camera, lab.world, city.destruction);
      assert(!lab.heatVision.group.visible && city.destruction.previous.size === 0, 'releasing laser retained its stroke');
      results.eyeBeams = true;
      const sweepStart = performance.now();
      for (let x = bounds.min.x - .2; x <= bounds.max.x + .2; x += .24) {
        const chunk = destruction.chunks.find(chunk => chunk.owner === building && chunk.colliders.length);
        destruction.cut(chunk.colliders[0], new T.Vector3(x, 2.5, bounds.min.z - .1), axis);
      }
      const upper = destruction.chunks.filter(chunk => chunk.owner === building && chunk.body);
      assert(upper.length > 1 && upper.reduce((volume, chunk) => volume + chunk.solids.reduce((sum, cell) => sum + cell.volume, 0), 0) > 100,
        'complete city building cut did not collapse its upper floors into independent debris');
      const upperHeights = upper.map(chunk => chunk.body.translation().y);
      for (let i = 0; i < 30; i++) lab.world.step();
      assert(upper.some((chunk, i) => chunk.body.translation().y < upperHeights[i] - .2), 'city building did not collapse after severing');
      results.cityBuildingSweep = { detached: upper.length, elapsedMs: performance.now() - sweepStart };
      return { passed: true, ...results };
    } finally {
      system.dispose(); world.free(); geometry.dispose(); material.dispose(); mesh.dispose();
      lab.reset(); lab.previousTime = 0; lab.raf = requestAnimationFrame(lab.frame);
    }
  });
}
