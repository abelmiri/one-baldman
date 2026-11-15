// Run with the app open: playwright-cli run-code --filename tests/flight-destruction.js
async page => {
  await page.reload();
  await page.locator('.game-loading').waitFor({ state: 'detached' });
  return page.evaluate(async () => {
    const T = await import('/node_modules/.vite/deps/three.js');
    const { default: R } = await import('/node_modules/@dimforge/rapier3d/rapier.js');
    const { Ragdoll } = await import('/src/Ragdoll.ts');
    const { LaserDestruction } = await import('/src/LaserDestruction.ts');
    const { buildingShell } = await import('/src/BuildingShell.ts');
    const { ImpactShake } = await import('/src/ImpactShake.ts');
    const assert = (value, message) => { if (!value) throw Error(message) };
    const geometry = new T.BoxGeometry(1, 1, 1);
    const fixture = (kind = 'building') => {
      const world = new R.World({ x: 0, y: -9.81, z: 0 });
      world.createCollider(R.ColliderDesc.cuboid(100, .1, 100).setTranslation(0, -.06, 0));
      const d = new LaserDestruction(new T.Group()), owner = d.create(kind);
      d.reset(world);
      for (const cell of buildingShell(10, 9.3, 10)) {
        const center = new T.Vector3(cell.x, cell.y + 4.65, cell.z);
        owner.parts.push({ geometry, matrix: new T.Matrix4().compose(center, new T.Quaternion(), new T.Vector3(cell.w, cell.h, cell.d)), color: new T.Color('gray') });
        d.register(owner, world.createCollider(R.ColliderDesc.cuboid(cell.w / 2, cell.h / 2, cell.d / 2).setTranslation(center.x, center.y, center.z)));
      }
      const hero = new Ragdoll(world, new T.Scene(), 0, true);
      const offset = new T.Vector3(0, 4.3 - hero.supportTarget.y, -9);
      for (const { body } of hero.parts.values()) body.setTranslation(new T.Vector3().copy(body.translation()).add(offset), true);
      hero.supportTarget.add(offset); hero.airborne = true; hero.flightAge = 2; hero.flightBoost = 1;
      const hits = [], paths = [], shake = new ImpactShake();
      hero.configureFlightDestruction((collider, from, to, normal, speed) => {
        hits.push({ collider, from: new T.Vector3().copy(from), to: to.clone(), normal: new T.Vector3().copy(normal) });
        paths.push({ from: { ...from }, to: to.clone() });
        shake.hit(speed);
      }, collider => d.ownerOf(collider)?.kind === 'building');
      const cutMany = d.cutMany;
      d.cutMany = function (hits, ...rest) { assert(!hits.length, 'flight carving ran on the main thread'); return cutMany.call(this, hits, ...rest) };
      const step = fast => {
        hits.length = 0;
        hero.setFlight(false, 0, 0, .04); hero.setFlightAim(new T.Vector3(0, 0, 1), 1);
        hero.setMovement(0, 1, fast, false);
        if (!fast) { hero.flightBoost = 0; hero.moveVelocity.set(0, 0, 50) }
        hero.step(1 / 60); world.step(); hero.checkForImpact();
        for (const hit of hits) d.queueFlightPath(hit.collider, hit.from, hit.to, hit.normal);
        const from = new T.Vector3(), to = new T.Vector3();
        if (hero.copyFlightSegment(from, to)) d.continueFlightPath(from, to); else d.endFlightPath();
        d.updateBurns(1 / 60);
      };
      return { world, d, owner, hero, hits, paths, shake, step, dispose: () => { d.dispose(); hero.dispose(); world.free() } };
    };
    try {
      const fast = fixture();
      try {
        fast.hero.moveVelocity.set(0, 0, 90);
        let contacts = 0;
        for (let i = 0; i < 24; i++) {
          fast.step(true); contacts += fast.hits.length;
          assert(!fast.hero.isReleased && !fast.hero.isRecovering, 'fast building strike triggered ragdoll');
          assert([...fast.hero.parts.values()].every(part => part.body.isKinematic()), 'fast building strike enabled body physics');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert(contacts > 0 && fast.hero.parts.get('pelvis').body.translation().z > 6, 'character did not pass completely through the building');
        for (let i = 0; i < 500 && (fast.d.burns.length || fast.d.carveJob); i++) {
          fast.d.updateBurns(1 / 60); fast.world.step();
          assert(!fast.d.carveJob?.error, `flight worker failed: ${fast.d.carveJob?.error}`);
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert(!fast.d.burns.length && !fast.d.carveJob && fast.owner.damaged, 'flight worker did not finish the path');
        const ray = x => fast.world.castRay(new R.Ray({ x, y: 4.3, z: -9 }, { x: 0, y: 0, z: 1 }), 20, true,
          undefined, undefined, undefined, undefined, collider => fast.d.ownerOf(collider) === fast.owner);
        const blocked = ray(0);
        assert(!blocked, `flight corridor blocked: ${JSON.stringify({ toi: blocked?.timeOfImpact, moving: !!blocked?.collider.parent(), paths: fast.paths, chunks: fast.d.chunks.length })}`);
        assert(ray(3), 'flight strike removed the whole building');
        const camera = new T.PerspectiveCamera(); camera.position.set(2, 4, -10);
        const position = camera.position.clone(), rotation = camera.quaternion.clone();
        fast.shake.apply(camera, 1 / 60);
        assert(camera.position.distanceTo(position) > 0 && camera.position.distanceTo(position) < .1, 'impact shake missing or excessive');
        fast.shake.restore(camera);
        assert(camera.position.equals(position) && camera.quaternion.equals(rotation), 'shake altered camera control or aim');
        for (let i = 0; i < 90; i++) { fast.shake.apply(camera, 1 / 60); fast.shake.restore(camera) }
        fast.shake.apply(camera, 1 / 60);
        assert(camera.position.equals(position), 'impact shake did not decay');
      } finally { fast.dispose() }
      for (const [fast, kind] of [[false, 'building'], [true, 'tree']]) {
        const f = fixture(kind);
        try {
          f.hero.moveVelocity.set(0, 0, fast ? 90 : 50);
          for (let i = 0; i < 20 && !f.hero.isReleased; i++) f.step(fast);
          assert(f.hero.isReleased, fast ? 'fast non-building contact lost its normal collision behavior' : 'below-200 building contact did not trigger ordinary physics');
          assert(!f.owner.damaged, 'ordinary collision incorrectly destroyed the building');
        } finally { f.dispose() }
      }
      return { passed: true, thresholdKmh: 200, fastPassThrough: true, workerCorridor: true, rooms: true, lowSpeedPhysics: true, nonBuildingPhysics: true, boundedShake: true };
    } finally { geometry.dispose() }
  });
}
