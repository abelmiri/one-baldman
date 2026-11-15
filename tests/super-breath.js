// Run with the app open: playwright-cli run-code --filename tests/super-breath.js
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
    const make = (kind, x, z) => {
      const owner = system.create(kind);
      owner.parts.push({ geometry, matrix: new T.Matrix4().makeTranslation(x, 7, z), color: new T.Color('green') });
      return owner;
    };
    const building = make('building', 0, 42);
    const tree = make('tree', 0, 24);
    const car = make('car', 0, 12);
    const outsideCone = make('building', 18, 30);
    const behind = make('tree', 0, -8);
    system.reset(world);
    const axis = new T.Vector3(0, 0, 1);
    try {
      world.createCollider(R.ColliderDesc.cuboid(100, .1, 100).setTranslation(0, -.1, 0));
      for (let i = 0; i < 3; i++) system.blow(new T.Vector3(0, 7, 0), axis, 90, 80);
      for (const [owner, label] of [[building, 'building'], [tree, 'tree'], [car, 'car']]) {
        const chunks = system.chunks.filter(chunk => chunk.owner === owner);
        assert(owner.damaged && chunks.length >= (label === 'building' ? 400 : 10),
          `${label} was not shattered into the expected number of fragments`);
        assert(chunks.every(chunk => chunk.body.linvel().z > 5), `${label} debris did not fly forward`);
      }
      for (const chunk of system.chunks) chunk.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      system.blow(new T.Vector3(0, 7, 0), axis, 90, 80);
      assert(system.chunks.some(chunk => {
        const velocity = chunk.body.linvel();
        return Math.hypot(velocity.x, velocity.y, velocity.z) > 50;
      }),
        'triple-strength breath did not relaunch previously shattered debris');
      assert(!outsideCone.damaged, 'object outside the breath cone was destroyed');
      assert(!behind.damaged, 'object behind the character was destroyed');
      return { building: building.damaged, tree: tree.damaged, car: car.damaged, coneAndDirection: true, debrisThrown: true, damagedDebrisRelaunched: true };
    } finally { system.dispose(); world.free(); geometry.dispose(); }
  });
}
