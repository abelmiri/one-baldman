// Run in the running app: playwright-cli run-code --filename tests/character-physics.js
async page => {
  await page.reload();
  await page.locator('.game-loading').waitFor({ state: 'detached' });
  return page.evaluate(async () => {
    const T = await import('/node_modules/.vite/deps/three.js');
    const { default: R } = await import('/node_modules/@dimforge/rapier3d/rapier.js');
    const { Ragdoll } = await import('/src/Ragdoll.ts');
    const assert = (condition, message) => { if (!condition) throw Error(message) };
    const root = document.getElementById('root');
    const fiber = root[Object.keys(root).find(k => k.startsWith('__reactContainer'))].stateNode.current;
    const find = f => !f ? null : f.type?.name === 'App' ? f : find(f.child) || find(f.sibling);
    let hook = find(fiber).memoizedState;
    while (hook && !hook.memoizedState?.current?.ragdoll) hook = hook.next;
    const lab = hook.memoizedState.current;
    cancelAnimationFrame(lab.raf);
    const originalSettings = { ...lab.settings };
    const results = {};
    const fixture = () => {
      const world = new R.World({ x: 0, y: -9.8, z: 0 });
      world.createCollider(R.ColliderDesc.cuboid(100, .1, 100).setTranslation(0, -.06, 0));
      const character = new Ragdoll(world, new T.Scene(), 0, true);
      const step = (flight = false, forward = 0, running = false, descend = false) => {
        character.setFlight(flight, 0, 0, .04, descend);
        character.setMovement(0, forward, running, false);
        character.step(1 / 60);
        world.step();
        character.checkForImpact();
        for (const { body } of character.parts.values()) {
          assert(Object.values(body.translation()).every(Number.isFinite), 'non-finite body');
        }
      };
      return { world, character, step, dispose: () => { character.dispose(); world.free() } };
    };
    try {
      const f = fixture();
      try {
        for (let i = 0; i < 180; i++) f.step();
        for (let i = 0; i < 180; i++) f.step(false, 1);
        assert(f.character.flightState === 'grounded', 'ordinary walking triggered ragdoll');
        const walkingZ = f.character.parts.get('pelvis').body.translation().z;
        f.step(false, 1);
        const walkSpeed = (f.character.parts.get('pelvis').body.translation().z - walkingZ) * 60;
        assert(Math.abs(walkSpeed - 2.4) < .01, 'walking speed did not increase by 50%: ' + walkSpeed);
        for (let i = 0; i < 180; i++) f.step(false, 1, true);
        assert(f.character.flightState === 'grounded', 'ordinary running triggered ragdoll');
        const runningZ = f.character.parts.get('pelvis').body.translation().z;
        f.step(false, 1, true);
        const runSpeed = (f.character.parts.get('pelvis').body.translation().z - runningZ) * 60;
        assert(Math.abs(runSpeed - 6.40332) < .01, 'running speed did not increase by 10%: ' + runSpeed);
        assert([...f.character.parts.values()].every(p => p.body.isKinematic()), 'controlled body is dynamic');
        for (let i = 0; i < 180; i++) f.step(true, 1);
        assert(f.character.flightState === 'flying', 'takeoff or flight triggered ragdoll');
        const pelvis = f.character.parts.get('pelvis').body;
        const position = new T.Vector3().copy(pelvis.translation());
        const velocity = new T.Vector3().copy(pelvis.linvel());
        f.character.release();
        assert(new T.Vector3().copy(pelvis.linvel()).distanceTo(velocity) < 1e-6, 'release lost momentum');
        assert(new T.Vector3().copy(pelvis.translation()).distanceTo(position) < 1e-6, 'release teleported body');
        assert([...f.character.parts.values()].every(p => p.body.isDynamic()), 'release did not enable body physics');
        f.step();
        assert(pelvis.linvel().y < velocity.y, 'gravity did not act after release');
        for (let i = 0; i < 360; i++) f.step();
        f.character.regainControl();
        for (let i = 0; i < 240; i++) f.step();
        assert(f.character.flightState === 'grounded', 'get-up immediately retriggered ragdoll');
        for (let i = 0; i < 120; i++) f.step(true);
        const hoverHeight = f.character.parts.get('pelvis').body.translation().y;
        for (let i = 0; i < 180; i++) f.step();
        assert(Math.abs(f.character.parts.get('pelvis').body.translation().y - hoverHeight) < .1, 'released Space did not hold altitude');
        for (let i = 0; i < 420; i++) f.step(false, 0, false, true);
        assert(f.character.flightState === 'grounded', 'controlled landing triggered ragdoll');
        results.control = { walkSpeed, runSpeed, flight: true, releaseKeepsMomentum: true, recovery: true, landing: true };
      } finally { f.dispose() }

      for (const flight of [false, true]) {
        const f = fixture();
        try {
          f.world.createCollider(R.ColliderDesc.cuboid(3, 20, .025).setTranslation(0, 20, flight ? 4 : 2));
          for (let i = 0; i < 300 && !f.character.isReleased; i++) f.step(flight, 1, flight);
          assert(f.character.isReleased, (flight ? 'flying' : 'walking') + ' wall collision did not enable physics');
          assert(f.character.parts.get('pelvis').body.translation().z < (flight ? 4 : 2), 'body tunneled through thin wall');
        } finally { f.dispose() }
      }
      const ceiling = fixture();
      try {
        ceiling.world.createCollider(R.ColliderDesc.cuboid(5, .05, 5).setTranslation(0, 4, 0));
        for (let i = 0; i < 180 && !ceiling.character.isReleased; i++) ceiling.step(true);
        assert(ceiling.character.isReleased, 'ceiling contact did not trigger physics');
      } finally { ceiling.dispose() }
      const traffic = fixture();
      try {
        const car = traffic.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(-4, .8, 0));
        traffic.world.createCollider(R.ColliderDesc.cuboid(.5, .8, .8), car);
        for (let i = 0; i < 90 && !traffic.character.isReleased; i++) {
          car.setNextKinematicTranslation({ x: -4 + i * .08, y: .8, z: 0 });
          traffic.step();
        }
        assert(traffic.character.isReleased, 'moving car did not trigger physics on idle character');
      } finally { traffic.dispose() }
      results.collisions = { walkingWall: true, flyingWall: true, ceiling: true, movingCar: true };

      const capture = (wind, gravity, released) => {
        lab.settings = { ...originalSettings, wind, gravity };
        lab.reset();
        lab.touchFlight = true;
        for (let i = 0; i < 120; i++) lab.step();
        if (released) lab.toggleRelease();
        for (let i = 0; i < 90; i++) lab.step();
        const poses = [...lab.ragdoll.parts.values()].flatMap(({ body }) => {
          const p = body.translation(), q = body.rotation();
          return [p.x, p.y, p.z, q.x, q.y, q.z, q.w];
        });
        assert(lab.clothPositions.every(Number.isFinite), 'non-finite cape');
        assert(lab.cloth.numAttachments() === Math.sqrt(lab.cloth.numParticles()), 'collar detached');
        for (let i = 0; i < lab.cloth.numAttachments(); i++) {
          assert(lab.cloth.attachmentBody(i).isKinematic(), 'cape attached to a dynamic body');
        }
        return { poses, cape: Array.from(lab.clothPositions) };
      };
      const calm = capture(0, 9.8, false), windy = capture(80, 30, false);
      assert(calm.poses.every((v, i) => Math.abs(v - windy.poses[i]) < 1e-6), 'wind/gravity changed controlled pose');
      assert(calm.cape.some((v, i) => Math.abs(v - windy.cape[i]) > .01), 'cape did not react to wind/gravity');
      const fallingCalm = capture(0, 9.8, true), fallingWind = capture(80, 9.8, true);
      assert(fallingCalm.poses.every((v, i) => Math.abs(v - fallingWind.poses[i]) < 1e-5), 'cape forces fed back into ragdoll');
      assert(fallingCalm.cape.some((v, i) => Math.abs(v - fallingWind.cape[i]) > .01), 'released cape did not react to wind');
      results.cape = { controlledBodyIndependent: true, ragdollIndependent: true, windResponse: true, collarAttached: true };
      return { passed: true, ...results };
    } finally {
      lab.settings = originalSettings;
      lab.reset();
      lab.raf = requestAnimationFrame(lab.frame);
    }
  });
}
