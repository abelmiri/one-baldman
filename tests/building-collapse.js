// Run with the app open: playwright-cli run-code --filename tests/building-collapse.js
async page => {
  await page.reload();
  await page.locator('.game-loading').waitFor({ state: 'detached' });
  return page.evaluate(async () => {
    const T = await import('/node_modules/.vite/deps/three.js');
    const { default: R } = await import('/node_modules/@dimforge/rapier3d/rapier.js');
    const { LaserDestruction } = await import('/src/LaserDestruction.ts');
    const { buildingShell } = await import('/src/BuildingShell.ts');
    const assert = (value, message) => { if (!value) throw Error(message) };
    const results = {};
    for (const worker of [false, true]) {
      const world = new R.World({ x: 0, y: -9.81, z: 0 });
      const root = new T.Group();
      const system = new LaserDestruction(root);
      const owner = system.create('building');
      const geometries = [];
      const add = (w, h, d, x, y, z) => {
        const geometry = new T.BoxGeometry(w, h, d);
        geometries.push(geometry);
        owner.parts.push({ geometry, matrix: new T.Matrix4().makeTranslation(x, y, z), color: new T.Color('#b97b59') });
      };
      add(14, .5, 10, 0, .25, 0);
      add(.2, 2, .2, 0, 1.5, 0);
      for (const cell of buildingShell(14, 12, 10, true)) add(cell.w, cell.h, cell.d, cell.x, cell.y + 8.5, cell.z);
      system.reset(world);
      world.createCollider(R.ColliderDesc.cuboid(50, .1, 50).setTranslation(0, -.1, 0));
      const collider = world.createCollider(R.ColliderDesc.cuboid(7, 7.25, 5).setTranslation(0, 7.25, 0));
      system.register(owner, collider);
      try {
        const point = new T.Vector3(-6.9, 12, -5), direction = new T.Vector3(0, 0, 1);
        if (worker) {
          system.queueContact(collider, point, direction.clone().negate());
          const deadline = performance.now() + 15000;
          while (!owner.damaged && performance.now() < deadline) {
            system.updateBurns(1 / 60);
            await new Promise(resolve => setTimeout(resolve, 5));
          }
          assert(owner.damaged, 'worker collapse never committed');
        } else system.cut(collider, point, direction);
        const debris = system.chunks.filter(chunk => chunk.body);
        assert(debris.length > 8, 'building remained a single rigid shell');
        assert(system.chunks.some(chunk => !chunk.body), 'foundation detached from the ground');
        const heights = debris.map(chunk => chunk.body.translation().y);
        for (let i = 0; i < 45; i++) world.step();
        system.sync();
        assert(debris.filter((chunk, i) => chunk.body.translation().y < heights[i] - .3).length > debris.length / 2,
          'most collapsed panels stayed suspended');
        assert(debris.every(chunk => Number.isFinite(chunk.body.translation().y)
          && chunk.mesh.position.distanceTo(chunk.body.translation()) < 1e-6), 'debris rendering or physics corrupted');
        results[worker ? 'worker' : 'direct'] = { panels: debris.length, falls: true, foundationStable: true };
      } finally {
        system.dispose();
        world.free();
        geometries.forEach(geometry => geometry.dispose());
      }
    }
    return results;
  });
}
