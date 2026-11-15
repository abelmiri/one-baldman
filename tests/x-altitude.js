// Run with the app open: playwright-cli run-code --filename tests/x-altitude.js
async page => {
  await page.reload();
  await page.locator('.game-loading').waitFor({ state: 'detached' });
  return page.evaluate(async () => {
    const T = await import('/node_modules/.vite/deps/three.js');
    const { default: R } = await import('/node_modules/@dimforge/rapier3d/rapier.js');
    const { Ragdoll } = await import('/src/Ragdoll.ts');
    const assert = (value, message) => { if (!value) throw Error(message) };
    const world = new R.World({ x: 0, y: -9.81, z: 0 });
    world.createCollider(R.ColliderDesc.cuboid(100, .1, 100).setTranslation(0, -.06, 0));
    const roof = world.createCollider(R.ColliderDesc.cuboid(4, 3, 4).setTranslation(0, 3, 0));
    const hero = new Ragdoll(world, new T.Scene(), 0, true);
    const offset = new T.Vector3(0, 12 - hero.supportTarget.y, 0);
    for (const { body } of hero.parts.values()) body.setTranslation(new T.Vector3().copy(body.translation()).add(offset), true);
    hero.supportTarget.add(offset); hero.airborne = true; hero.flightAge = 1;
    const step = (descend = false, movement = 0) => {
      // External support may become street height after the roof is destroyed.
      hero.setFlight(false, 0, 0, .04, descend);
      hero.setMovement(0, movement, false, false);
      hero.step(1 / 60); world.step(); hero.checkForImpact();
    };
    try {
      for (let i = 0; i < 240; i++) step(true);
      assert(hero.flightState === 'grounded', 'fixture did not land on the roof');
      const pelvis = hero.parts.get('pelvis').body;
      const height = pelvis.translation().y;
      assert(height > 7 && height < 7.5, 'fixture landed at street height');
      hero.release(true);
      assert(hero.isReleased && pelvis.isDynamic(), 'manual X did not retain physical body behavior');
      assert(Math.abs(pelvis.translation().y - height) < 1e-6, 'manual X teleported the character');
      for (let i = 0; i < 120; i++) step();
      assert(Math.abs(pelvis.translation().y - height) < 1e-3, 'released character fell from its X altitude');
      hero.regainControl(); hero.setCollisionProtection(true);
      assert(hero.isRecovering, 'X did not get up at the held roof height');
      let lowest = Infinity;
      for (let i = 0; i < 240; i++) { step(); lowest = Math.min(lowest, pelvis.translation().y) }
      assert(lowest > 6 && Math.abs(pelvis.translation().y - height) < .1, 'getting up did not stay supported on the roof');
      assert(hero.flightState === 'grounded', 'roof support did not allow normal standing');
      const position = new T.Vector3().copy(pelvis.translation());
      for (let i = 0; i < 30; i++) step(false, 1);
      assert(pelvis.translation().z > position.z + .1 && Math.abs(pelvis.translation().y - height) < .1, 'movement lost rooftop support');
      world.removeCollider(roof, true);
      for (let i = 0; i < 300; i++) step();
      assert(pelvis.translation().y < 1.5 && hero.flightState === 'grounded', 'character stayed at X altitude after losing support');

      const airborneOffset = new T.Vector3(0, 12 - pelvis.translation().y, 0);
      for (const { body } of hero.parts.values()) {
        body.setTranslation(new T.Vector3().copy(body.translation()).add(airborneOffset), true);
        body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      }
      hero.supportTarget.add(airborneOffset);
      hero.airborne = true;
      hero.flightAge = 1;
      const airborneHeight = pelvis.translation().y;
      hero.release(true);
      for (let i = 0; i < 60; i++) step();
      assert(pelvis.translation().y < airborneHeight - 1, 'X held altitude instead of allowing a free fall in the sky');
      const regainHeight = pelvis.translation().y;
      hero.regainControl(true);
      assert(hero.isAirborne && !hero.isRecovering, 'X recovery in the sky started a grounded get-up');
      for (let i = 0; i < 60; i++) step();
      assert(pelvis.translation().y < regainHeight - 1, 'regaining control in the sky stopped the free fall');
      for (let i = 0; i < 300; i++) step();
      assert(pelvis.translation().y < 1.5 && hero.flightState === 'grounded', 'free fall did not reach the ground');

      // A normal crash must still fall under gravity.
      hero.setFlight(true, 0, 0, .04);
      hero.step(1 / 60); world.step();
      hero.release();
      const before = pelvis.linvel().y;
      step();
      assert(pelvis.linvel().y < before, 'ordinary release inherited the manual altitude lock');
      // X holds altitude during recovery, then releases it to the real ground below.
      for (const { body } of hero.parts.values()) body.setTranslation(new T.Vector3().copy(body.translation()).add(new T.Vector3(0, 8, 0)), true);
      const crashHeight = pelvis.translation().y;
      hero.regainControl(true); hero.setCollisionProtection(true);
      for (let i = 0; i < 360; i++) step();
      assert(crashHeight > 8 && pelvis.translation().y < 1.5 && hero.flightState === 'grounded',
        'X recovery from an ordinary crash remained at its starting altitude');
      return { passed: true, roofHeight: height, releasedHeightHeld: true, getUpStaysOnRoof: true, roofRemovalFallsToGround: true, airborneCrashRecoveryFallsToGround: true, movement: true, ordinaryGravity: true };
    } finally { hero.dispose(); world.free() }
  });
}
