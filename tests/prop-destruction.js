// Run with the app open: playwright-cli run-code --filename tests/prop-destruction.js
async page => {
  await page.locator('.game-loading').waitFor({ state: 'detached' });
  return page.evaluate(async () => {
    const T = await import('/node_modules/.vite/deps/three.js');
    const { default: R } = await import('/node_modules/@dimforge/rapier3d/rapier.js');
    const { LaserDestruction } = await import('/src/LaserDestruction.ts');
    const assert = (value, message) => { if (!value) throw Error(message) };
    const root = new T.Group(), system = new LaserDestruction(root);
    const world = new R.World({ x: 0, y: -9.81, z: 0 });
    const geometry = new T.BoxGeometry(3, 5, 3);
    const make = (kind, x) => {
      const owner = system.create(kind);
      owner.parts.push({ geometry, matrix: new T.Matrix4().makeTranslation(x, 7, 0), color: new T.Color('green') });
      const collider = world.createCollider(R.ColliderDesc.cuboid(1.5, 2.5, 1.5).setTranslation(x, 7, 0));
      system.register(owner, collider);
      return { owner, collider, point: new T.Vector3(x, 7, -1.5) };
    };
    system.reset(world);
    const normal = new T.Vector3(0, 0, -1), direction = normal.clone().negate();
    try {
      world.createCollider(R.ColliderDesc.cuboid(100, .1, 100).setTranslation(0, -.1, 0));
      for (const [kind, x] of [['tree', 0], ['car', 12]]) {
        const { owner, collider, point } = make(kind, x);
        system.queueContact(collider, point, normal, 50 / 3.6);
        assert(!owner.damaged, `${kind} shattered at exactly 50 km/h`);
        let stopped = 0;
        owner.stop = () => stopped++;
        system.queueContact(collider, point, normal, 51 / 3.6);
        const chunks = system.chunks.filter(chunk => chunk.owner === owner);
        assert(owner.damaged && chunks.length === 10 && stopped === 1, `${kind} did not shatter into ten pieces`);
        const volume = chunks.reduce((total, chunk) => total + chunk.solids.reduce((sum, cell) => sum + cell.volume, 0), 0);
        assert(Math.abs(volume - 45) < .001, 'fragmentation lost original volume');
        assert(chunks.every(chunk => chunk.body.isDynamic() && chunk.colliders.length), 'fragments missing physics');
        assert(!system.ownerOf(collider), 'original collider retained');
        system.queueContact(chunks[0].colliders[0], point, normal, 30);
        assert(system.chunks.filter(chunk => chunk.owner === owner).length === 10, 'debris shattered repeatedly');
      }
      const car = make('car', 25);
      system.ignite(car.collider, car.point, direction, normal);
      assert(car.owner.damaged && system.chunks.filter(chunk => chunk.owner === car.owner).length === 10, 'laser did not explode car');
      assert(system.fire.fires.some(fire => fire.explosion), 'explosion flash missing');
      const tree = make('tree', 40);
      system.ignite(tree.collider, tree.point, direction, normal);
      assert(!tree.owner.damaged && system.fire.fires.some(fire => fire.point.distanceTo(tree.point) < .01), 'tree not burning');
      const ground = world.createCollider(R.ColliderDesc.cuboid(2, .1, 2).setTranslation(55, 0, 0));
      system.registerVegetation(new T.Box3(new T.Vector3(53, -.1, -2), new T.Vector3(57, .1, 2)));
      system.ignite(ground, new T.Vector3(55, .1, 0), direction, normal);
      assert(system.fire.fires.some(fire => fire.point.x === 55), 'ground vegetation not burning');
      const count = system.fire.fires.length;
      for (let i = 0; i < 100; i++) system.ignite(tree.collider, tree.point, direction, normal);
      assert(system.fire.fires.length === count, 'laser created unbounded duplicate fires');
      system.updateBurns(.5);
      assert(system.fire.mesh.count > 0, 'fire not rendered without active laser');
      for (let i = 0; i < 120; i++) { world.step(); system.sync(); }
      assert(system.chunks.every(chunk => Number.isFinite(chunk.body.translation().y)
        && chunk.mesh.position.distanceTo(chunk.body.translation()) < 1e-6), 'debris physics/rendering diverged');
      system.updateBurns(20);
      assert(system.fire.mesh.count === 0, 'expired fire particles retained');
      const chunks = system.chunks.length;
      system.reset(world);
      assert(system.chunks.length === 0 && system.fire.mesh.count === 0 && !car.owner.damaged, 'reset retained destruction');
      return { fragments: chunks, threshold: 'strictly above 50 km/h', volumePreserved: true, laserExplosion: true, vegetationFire: true, reset: true };
    } finally { system.dispose(); world.free(); geometry.dispose(); }
  });
}
