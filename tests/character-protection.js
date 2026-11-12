// Run against the Vite app: playwright-cli run-code --filename tests/character-protection.js
async page => {
  await page.reload();
  await page.locator('.game-loading').waitFor({ state: 'detached' });
  return page.evaluate(async () => {
    const T = await import('/node_modules/.vite/deps/three.js');
    const { default: R } = await import('/node_modules/@dimforge/rapier3d/rapier.js');
    const { Ragdoll } = await import('/src/Ragdoll.ts');
    const assert = (condition, message) => { if (!condition) throw Error(message) };
    const results = [];
    const fixture = (gravity = -9.8) => {
      const world = new R.World({ x: 0, y: gravity, z: 0 });
      const character = new Ragdoll(world, new T.Scene(), 0, true);
      const tick = () => {
        character.step(1 / 60); world.step(); character.checkForImpact();
        for (const { body } of character.parts.values()) {
          assert([...Object.values(body.translation()), ...Object.values(body.rotation()), ...Object.values(body.linvel())].every(Number.isFinite), 'non-finite physical body');
        }
      };
      const center = () => {
        let mass = 0; const p = new T.Vector3(), velocity = new T.Vector3();
        for (const { body } of character.parts.values()) {
          mass += body.mass(); p.addScaledVector(body.translation(), body.mass()); velocity.addScaledVector(body.linvel(), body.mass());
        }
        return { position: p.divideScalar(mass), velocity: velocity.divideScalar(mass) };
      };
      const handDistance = () => {
        const head = character.parts.get('head').body.translation();
        return ['leftHand', 'rightHand'].reduce((sum, id) => sum + new T.Vector3().copy(character.parts.get(id).body.translation()).distanceTo(head), 0) / 2;
      };
      return { world, character, tick, center, handDistance, dispose: () => { character.dispose(); world.free() } };
    };

    const falling = fixture();
    try {
      for (let i = 0; i < 15; i++) falling.tick();
      const before = falling.handDistance();
      const momentum = falling.center().velocity.clone();
      falling.character.release();
      assert(falling.center().velocity.distanceTo(momentum) < 1e-6, 'release changed linear momentum');
      let peak = 0;
      for (let i = 0; i < 60; i++) { falling.tick(); peak = Math.max(peak, falling.character.protectionStrength) }
      const after = falling.handDistance();
      assert(peak > .6, 'freefall did not engage the protective reflex');
      assert(after < before * .7, `hands did not move toward the head: ${before} -> ${after}`);
      assert(after < .6, 'hands stayed outside the head guard');
      assert(falling.center().velocity.y < -7, 'protective muscles prevented gravitational falling');
      assert([...falling.character.parts.values()].every(({ body }) => body.isDynamic()), 'guard made physical limbs kinematic');
      results.push({ freefall: true, before, after, peak, velocityY: falling.center().velocity.y });
    } finally { falling.dispose() }

    const drift = fixture(0);
    try {
      drift.character.release();
      for (const { body } of drift.character.parts.values()) body.setLinvel({x:2,y:-2,z:3},true);
      for (let i = 0; i < 90; i++) drift.tick();
      const velocity = drift.center().velocity;
      const damping = (1 / (1 + .2 / 60)) ** 90;
      assert(Math.abs(velocity.x - 2 * damping) < .02 && Math.abs(velocity.z - 3 * damping) < .02,
        'protective muscles changed the center-of-mass travel momentum');
      results.push({ rootMomentum: true });
    } finally { drift.dispose() }

    const obstacle = fixture(0);
    try {
      for (let i = 0; i < 15; i++) obstacle.tick();
      obstacle.world.createCollider(R.ColliderDesc.cuboid(4, 5, .1).setTranslation(0, 3, 2));
      obstacle.character.release();
      for (const { body } of obstacle.character.parts.values()) body.setLinvel({x:0,y:0,z:8}, true);
      // Refresh Rapier's query acceleration structure after adding the wall.
      obstacle.world.step();
      obstacle.tick();
      assert(obstacle.character.protectionStrength > .1, 'imminent obstacle did not trigger anticipation');
      for (let i = 0; i < 45; i++) obstacle.tick();
      assert(obstacle.character.protectionStrength > .5, 'collision did not sustain protection');
      results.push({ obstacleAnticipation: true, collisionStrength: obstacle.character.protectionStrength });
    } finally { obstacle.dispose() }

    const rest = fixture();
    try {
      rest.world.createCollider(R.ColliderDesc.cuboid(100, .1, 100).setTranslation(0, -.06, 0));
      for (let i = 0; i < 30; i++) rest.tick();
      assert(rest.character.protectionStrength === 0, 'ordinary standing engaged protection');
      rest.character.release();
      let peak = 0;
      for (let i = 0; i < 900; i++) { rest.tick(); peak = Math.max(peak, rest.character.protectionStrength) }
      assert(peak > .3, 'ground impact did not engage protection');
      assert(rest.character.protectionStrength < .08, 'resting body never relaxed');
      rest.character.regainControl();
      for (let i = 0; i < 240; i++) rest.tick();
      assert(rest.character.flightState === 'grounded', 'protective reflex broke recovery');
      assert(rest.character.protectionStrength === 0, 'guard was not cleared on recovery');
      results.push({ groundImpact: true, peak, relaxed: true, recovery: true });
    } finally { rest.dispose() }
    return { passed: true, results };
  });
}
