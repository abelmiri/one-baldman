// Run in the app: playwright-cli run-code --filename tests/walkable-steps.js
async page => {
  await page.reload();
  await page.locator('.game-loading').waitFor({ state: 'detached' });
  return page.evaluate(async () => {
    const T = await import('/node_modules/.vite/deps/three.js');
    const { default: R } = await import('/node_modules/@dimforge/rapier3d/rapier.js');
    const { Ragdoll } = await import('/src/Ragdoll.ts');
    const assert = (value, message) => { if (!value) throw Error(message) };
    const fixture = (height, protectedControl = false, roof = 0) => {
      const world = new R.World({ x: 0, y: -9.81, z: 0 });
      world.createCollider(R.ColliderDesc.cuboid(100, .1, 100).setTranslation(0, roof - .06, 0));
      const obstacle = world.createCollider(R.ColliderDesc.cuboid(2, height / 2, 3).setTranslation(0, roof + .04 + height / 2, 4));
      const hero = new Ragdoll(world, new T.Scene(), 0, true);
      if (roof) {
        for (const { body } of hero.parts.values()) body.setTranslation(new T.Vector3().copy(body.translation()).add(new T.Vector3(0, roof, 0)), true);
        hero.supportTarget.y += roof;
      }
      let damage = 0, impacts = 0;
      const contact = collider => { if (collider.handle === obstacle.handle) damage++ };
      hero.onImpact = () => { impacts++ };
      const step = (forward = 1) => {
        hero.setCollisionProtection(protectedControl);
        hero.setFlight(false, 0, 0, roof + .04); hero.setMovement(0, forward, false, false);
        hero.step(1 / 60, contact, collider => collider.handle === obstacle.handle);
        world.step(); hero.checkForImpact(contact);
      };
      return { world, obstacle, hero, step, get damage() { return damage }, get impacts() { return impacts },
        dispose: () => { hero.dispose(); world.free() } };
    };
    const results = [];
    for (const [height, protectedControl, roof] of [[.16, false, 0], [.38, false, 0], [.16, true, 0], [.38, true, 0], [.16, true, 12]]) {
      const f = fixture(height, protectedControl, roof);
      try {
        let highest = 0;
        for (let i = 0; i < 120; i++) {
          f.step();
          const position = f.hero.parts.get('pelvis').body.translation();
          highest = Math.max(highest, position.y - roof);
          assert(!f.hero.isReleased && !f.hero.isAirborne, `step ${height} triggered physics at frame ${i}, z=${position.z}, y=${position.y}`);
        }
        const position = f.hero.parts.get('pelvis').body.translation();
        assert(position.z > 3.5, `character did not walk onto step ${height}`);
        assert(highest > 1.18 + height - .04, `character passed through step instead of climbing: ${JSON.stringify({height, protectedControl, roof, highest, position, ground:f.hero.groundHeight})}`);
        assert(Math.abs(position.y - roof - height - 1.23) < .1, `character is not supported on top of step ${height}`);
        for (let i = 0; i < 90; i++) f.step(0);
        assert(f.damage === 0, `walking/standing damaged the step ${height}: ${f.damage}`);
        assert(f.impacts === 0, 'walkable step emitted a collision impact');
        results.push({ height, protectedControl, roof, climbed: true, damage: f.damage });
      } finally { f.dispose() }
    }
    for (const protectedControl of [false, true]) {
      const f = fixture(2, protectedControl);
      try {
        for (let i = 0; i < 90 && !f.hero.isReleased; i++) f.step();
        if (protectedControl) assert(f.damage > 0 && !f.hero.isReleased, 'tall obstacle lost contact destruction during protection');
        else assert(f.hero.isReleased, 'tall wall was treated as a walkable step');
      } finally { f.dispose() }
    }
    return { passed: true, steps: results, tallWallPhysics: true, tallWallDestruction: true };
  });
}
