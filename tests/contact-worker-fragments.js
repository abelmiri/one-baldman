// Run with the app open: playwright-cli run-code --filename tests/contact-worker-fragments.js
async page => {
  await page.reload();
  await page.locator('.game-loading').waitFor({ state: 'detached' });
  return page.evaluate(async () => {
    const T = await import('/node_modules/.vite/deps/three.js');
    const { default: R } = await import('/node_modules/@dimforge/rapier3d/rapier.js');
    const { LaserDestruction } = await import('/src/LaserDestruction.ts');
    const assert = (value, message) => { if (!value) throw Error(message) };
    const world = new R.World({ x: 0, y: -9.81, z: 0 });
    const d = new LaserDestruction(new T.Group());
    const geometry = new T.BoxGeometry(1, 1, 1);
    const owner = d.create('building');
    d.reset(world);
    for (let i = 0; i < 64; i++) {
      const x = i % 8 * 1.5, y = 5 + Math.floor(i / 8) * 1.5;
      owner.parts.push({ geometry, matrix: new T.Matrix4().makeTranslation(x, y, 0), color: new T.Color('gray') });
      const collider = world.createCollider(R.ColliderDesc.cuboid(.5, .5, .5).setTranslation(x, y, 0));
      d.register(owner, collider);
      d.queueContact(collider, new T.Vector3(x, y, -.5), new T.Vector3(0, 0, -1));
    }
    let committing = false, createdDuringCommit = 0, stagedBodies = 0;
    const rebuild = d.rebuild, create = d.createCellCollider;
    d.cutMany = hits => { assert(!hits.length, 'contact carving fell back to the main thread'); return false };
    d.createCellCollider = function (...args) { if (committing) createdDuringCommit++; return create.apply(this, args) };
    d.rebuild = function (...args) {
      assert(args[4]?.groupInfo && args[4]?.connections, 'worker did not prepare fragment centers and connectivity');
      committing = true;
      try { return rebuild.apply(this, args) } finally { committing = false }
    };
    const times = [];
    try {
      for (let i = 0; i < 500; i++) {
        const start = performance.now(); d.updateBurns(1 / 60); times.push(performance.now() - start);
        assert(!d.carveJob?.error, `worker failed: ${d.carveJob?.error}`);
        for (const body of d.carveJob?.stagedBodies ?? []) {
          assert(!body.isEnabled(), 'staged body became physical before commit'); stagedBodies++;
        }
        world.step(); d.sync();
        if (!d.burns.length && !d.carveJob) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert(owner.damaged && !d.burns.length && !d.carveJob, 'fragment worker did not drain');
      assert(createdDuringCommit === 0, 'fragment colliders were created in the commit frame');
      assert(d.chunks.length === 64 && d.chunks.every(chunk => chunk.body?.isEnabled() && chunk.body.mass() > 0), 'prepared fragment bodies were lost, disabled, or massless');
      assert(d.chunks.every(chunk => chunk.mesh.position.distanceTo(chunk.body.translation()) < 1e-6), 'fragment rendering diverged from physics');
      return { passed: true, fragments: d.chunks.length, createdDuringCommit, stagedBodyObservations: stagedBodies, maxMainMs: Math.max(...times) };
    } finally { d.dispose(); geometry.dispose(); world.free() }
  });
}
