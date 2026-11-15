// Run with the app open: playwright-cli run-code --filename tests/laser-heating.js
async page => {
  await page.reload();
  await page.locator('.game-loading').waitFor({ state: 'detached' });
  return page.evaluate(async () => {
    const T = await import('/node_modules/.vite/deps/three.js');
    const { default: R } = await import('/node_modules/@dimforge/rapier3d/rapier.js');
    const { LaserDestruction } = await import('/src/LaserDestruction.ts');
    const { HeatVision } = await import('/src/HeatVision.ts');
    const assert = (value, message) => { if (!value) throw Error(message) };
    const world = new R.World({ x: 0, y: -9.81, z: 0 });
    const scene = new T.Scene(), group = new T.Group(); scene.add(group);
    const destruction = new LaserDestruction(group);
    const heat = new HeatVision(scene);
    const geometry = new T.BoxGeometry(4, 4, 4);
    const surfaceMaterial = new T.MeshBasicMaterial({ color: '#777777' });
    const surface = new T.Mesh(geometry, surfaceMaterial); surface.position.set(0, 2, 0); scene.add(surface);
    const renderer = new T.WebGLRenderer();
    renderer.debug.onShaderError = () => { throw Error('heated surface shader failed to compile') };
    const renderTarget = new T.WebGLRenderTarget(128, 128);
    const head = new T.Object3D(); head.position.set(0, 2, -10); head.updateMatrixWorld();
    const camera = new T.PerspectiveCamera();
    const aim = x => { camera.position.set(x, 2, -15); camera.lookAt(x, 2, 0); camera.updateMatrixWorld() };
    const building = destruction.create('building');
    building.parts.push({ geometry, matrix: new T.Matrix4().makeTranslation(0, 2, 0), color: new T.Color('#b97b59') });
    destruction.reset(world);
    const original = world.createCollider(R.ColliderDesc.cuboid(2, 2, 2).setTranslation(0, 2, 0));
    destruction.register(building, original);
    world.step();
    const frame = (dt = 1 / 60) => heat.update(dt, true, head, camera, world, destruction);
    const settle = async () => {
      for (let i = 0; i < 500; i++) {
        const job = destruction.carveJob;
        if (!job || job.burns.some(burn => burn.elapsed < 1.5 - 1e-8)) return;
        assert(!job.error, `worker failed: ${job.error}`);
        await new Promise(resolve => setTimeout(resolve, 10));
        destruction.updateBurns(0);
      }
      throw Error('carving worker did not finish');
    };
    try {
      aim(0);
      frame();
      assert(!building.damaged && original.isValid(), 'first contact removed building material');
      assert(destruction.burns.length === 1 && destruction.burnMarks.count === 1, 'two eyes duplicated the same burning point');
      // Check the rendered surface, with the eye beams hidden so they cannot mask a missing decal.
      [...heat.beams, ...heat.eyes, ...heat.impacts].forEach(object => { object.visible = false });
      renderer.setRenderTarget(renderTarget);
      renderer.render(scene, camera);
      const pixel = new Uint8Array(4);
      renderer.readRenderTargetPixels(renderTarget, 64, 64, 1, 1, pixel);
      assert(pixel[0] > pixel[1] * 2 && pixel[0] > pixel[2] * 2, 'heated contact was not visibly red on the wall');
      const first = destruction.burns[0];
      const firstPoint = first.worldPoint.clone();
      const firstNormal = first.worldNormal.clone();
      const axis = new T.Vector3(0, 0, 1);
      // Ignite a second point later, then release both beams entirely.
      for (let i = 0; i < 30; i++) heat.update(1 / 60, false, head, camera, world, destruction);
      assert(!building.damaged && destruction.burns[0] === first, 'release canceled the first burning point');
      assert(destruction.burnMarks.count === 1 && destruction.burnMarks.parent === group, 'burning surface disappeared with the beams');
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(renderTarget, 64, 64, 1, 1, pixel);
      assert(pixel[0] > pixel[1] * 2, 'red burn disappeared visually when the beams stopped');
      const secondPoint = new T.Vector3(1.1, 2, -2);
      destruction.ignite(original, secondPoint, axis, firstNormal);
      assert(destruction.burns.length === 2 && first.worldPoint.distanceTo(firstPoint) < 1e-8, 'new aim moved or reset the old burning point');
      // Repeated contact does not postpone the first fuse.
      destruction.ignite(original, firstPoint, axis, firstNormal);
      assert(destruction.burns.length === 2 && first.elapsed > .49, 'repeated hit restarted or duplicated a fuse');
      for (let i = 0; i < 59; i++) heat.update(1 / 60, false, head, camera, world, destruction);
      // Preparation may allocate disabled shapes, but the old wall must remain intact until the deadline.
      for (let i = 0; i < 500 && !destruction.carveJob?.prepared; i++) {
        assert(!destruction.carveJob?.error, 'worker failed while preparing a burn');
        await new Promise(resolve => setTimeout(resolve, 10));
        destruction.updateBurns(0);
      }
      assert(destruction.carveJob?.prepared, 'worker did not prepare the pending melt');
      world.step();
      assert(world.castRay(new R.Ray({ x: 0, y: 2, z: -5 }, axis), 10, true), 'disabled staged colliders changed the wall before melting');
      assert(!building.damaged && original.isValid(), 'burning point melted before 1.5 seconds');
      heat.update(1 / 60, false, head, camera, world, destruction); await settle(); world.step();
      assert(building.damaged && !original.isValid(), 'first point did not melt autonomously at 1.5 seconds');
      const ray = x => world.castRay(new R.Ray({ x, y: 2, z: -5 }, axis), 10, true);
      assert(!ray(firstPoint.x), 'autonomous melt left a solid collider at the first point');
      assert(ray(1.1), 'second point melted before its own fuse expired');
      assert(ray(.55), 'separate fuses carved unheated material between them');
      assert(destruction.burns.length === 1, 'later fuse was lost when earlier melt replaced its collider');
      for (let i = 0; i < 30; i++) heat.update(1 / 60, false, head, camera, world, destruction);
      await settle();
      world.step();
      assert(!ray(1.1) && ray(.55), 'later fuse did not melt independently or cut across cold material');
      assert(destruction.burns.length === 0 && destruction.burnMarks.count === 0, 'completed burns retained their marks');

      // A previous melt can release a still-burning section. Keep its fuse on the material.
      const floating = destruction.create('building');
      floating.parts.push({ geometry, matrix: new T.Matrix4().makeTranslation(10, 8, 0), color: new T.Color('gray') });
      const floatingCollider = world.createCollider(R.ColliderDesc.cuboid(2, 2, 2).setTranslation(10, 8, 0));
      destruction.register(floating, floatingCollider);
      destruction.ignite(floatingCollider, new T.Vector3(11, 8, -2), axis, firstNormal);
      destruction.cut(floatingCollider, new T.Vector3(10, 8, -2), axis);
      const fragment = destruction.chunks.find(chunk => chunk.owner === floating);
      const movingBurn = destruction.burns[0];
      assert(fragment.body && movingBurn.target === fragment, 'pending burn was not attached to the released fragment');
      const rotation = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), .3);
      const position = new T.Vector3().copy(fragment.body.translation()).add(new T.Vector3(3, 1, 0));
      fragment.body.setTranslation(position, true); fragment.body.setRotation(rotation, true);
      destruction.updateBurns(.5);
      const expected = movingBurn.point.clone().applyQuaternion(rotation).add(position);
      assert(movingBurn.worldPoint.distanceTo(expected) < 1e-6, 'burn stayed suspended while its fragment moved');
      destruction.updateBurns(1);
      await settle();
      assert(destruction.burns.length === 0, 'moving fragment burn did not expire');
      const remaining = destruction.chunks.find(chunk => chunk.colliders.length);
      destruction.ignite(remaining.colliders[0], new T.Vector3(-1, 2, -2), axis, firstNormal);
      heat.stop();
      assert(destruction.burns.length === 1 && !heat.group.visible, 'stopping beams canceled a pending melt');
      destruction.updateBurns(1);
      assert(destruction.carveJob, 'worker snapshot did not start');
      destruction.cut(remaining.colliders[0], new T.Vector3(-1.5, 2, -2), axis);
      destruction.updateBurns(.5);
      await settle();
      world.step();
      assert(destruction.burns.length === 0 && !ray(-1), 'a stale worker snapshot lost or stalled a pending burn');
      const latest = destruction.chunks.find(chunk => chunk.owner === building && chunk.colliders.length);
      destruction.ignite(latest.colliders[0], new T.Vector3(0, 3, -2), axis, firstNormal);
      destruction.updateBurns(1);
      assert(destruction.carveJob && destruction.carveWorker, 'reset scenario did not have an active worker');
      const replacement = new R.World({ x: 0, y: -9.81, z: 0 });
      destruction.reset(replacement);
      assert(destruction.burns.length === 0 && destruction.burnMarks.count === 0, 'world reset retained old burning points');
      destruction.updateBurns(2);
      await new Promise(resolve => setTimeout(resolve, 30));
      assert(!destruction.carveJob && !destruction.carveWorker, 'world reset retained a worker or stale result');
      assert(!building.damaged, 'old burn damaged the replacement world');
      replacement.free();
      return { passed: true, immediateRed: true, autonomousDelaySeconds: 1.5, releaseKeepsBurning: true, independentFuses: true, coldGapsPreserved: true, followsFragments: true, resetClearsBurns: true };

    } finally {
      renderer.dispose(); renderer.forceContextLoss(); renderTarget.dispose(); surfaceMaterial.dispose();
      heat.dispose(); destruction.dispose(); geometry.dispose(); world.free();
    }
  });
}
