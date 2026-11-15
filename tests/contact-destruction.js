// Run with the app open: playwright-cli run-code --filename tests/contact-destruction.js
async page => {
  await page.reload();
  await page.locator('.game-loading').waitFor({ state: 'detached' });
  return page.evaluate(async () => {
    const T = await import('/node_modules/.vite/deps/three.js');
    const { default: R } = await import('/node_modules/@dimforge/rapier3d/rapier.js');
    const { LaserDestruction } = await import('/src/LaserDestruction.ts');
    const assert = (value, message) => { if (!value) throw Error(message) };
    const root = document.getElementById('root');
    const fiber = root[Object.keys(root).find(k => k.startsWith('__reactContainer'))].stateNode.current;
    const find = f => !f ? null : f.type?.name === 'App' ? f : find(f.child) || find(f.sibling);
    let hook = find(fiber).memoizedState;
    while (hook && !hook.memoizedState?.current?.ragdoll) hook = hook.next;
    const lab = hook.memoizedState.current;
    cancelAnimationFrame(lab.raf);
    const settings = { ...lab.settings };
    const settle = async d => {
      for (let i = 0; i < 500; i++) {
        d.updateBurns(1 / 60);
        assert(!d.carveJob?.error, `worker failed: ${d.carveJob?.error}`);
        if (!d.burns.length && !d.carveJob) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw Error('contact damage did not finish');
    };
    const geometry = new T.BoxGeometry(4, 4, 4);
    try {
      for (const kind of ['building', 'tree', 'car']) {
        const world = new R.World({ x: 0, y: -9.81, z: 0 });
        const d = new LaserDestruction(new T.Group());
        const owner = d.create(kind);
        owner.parts.push({ geometry, matrix: new T.Matrix4().makeTranslation(10, 2, 0), color: new T.Color('gray') });
        d.reset(world);
        const collider = world.createCollider(R.ColliderDesc.cuboid(2, 2, 2).setTranslation(10, 2, 0));
        d.register(owner, collider);
        try {
          const point = new T.Vector3(10, 2, -2), normal = new T.Vector3(0, 0, -1);
          d.queueContact(collider, point, normal); d.queueContact(collider, point, normal);
          assert(d.burns.length === 1 && d.burns[0].duration === 0, 'contact was duplicated or inherited the laser fuse');
          assert(d.burnMarks.count === 0, 'physical impact created a laser heat mark');
          if (kind === 'building') {
            const cutMany = d.cutMany;
            d.cutMany = function (hits, ...rest) {
              assert(!hits.length, 'worker failure ran synchronous contact carving');
              return cutMany.call(this, hits, ...rest);
            };
            d.updateBurns(0);
            d.carveJob.error = 'injected worker failure';
            const log = console.error;
            try { console.error = () => {}; d.updateBurns(0) } finally { console.error = log }
            assert(d.burns[0].workerFailures === 1 && d.carveJob, 'contact worker did not retry asynchronously');
          }
          await settle(d); world.step();
          const hit = world.castRay(new R.Ray({ x: 10, y: 2, z: -5 }, { x: 0, y: 0, z: 1 }), 10, true);
          assert(owner.damaged && hit && hit.timeOfImpact > 3.5 && hit.timeOfImpact < 4, `${kind} contact did not create a shallow cavity`);
          const side = world.castRay(new R.Ray({ x: 11, y: 2, z: -5 }, { x: 0, y: 0, z: 1 }), 10, true);
          assert(side && side.timeOfImpact < 3.1, `${kind} contact removed material away from the collision`);
          if (kind === 'building') {
            const chunk = d.chunks.find(chunk => chunk.colliders.length);
            d.ignite(chunk.colliders[0], new T.Vector3(11.5, 2, -2), new T.Vector3(0, 0, 1), normal);
            d.updateBurns(1);
            assert(d.carveJob, 'laser fuse did not prepare a background job');
            d.queueContact(chunk.colliders[0], new T.Vector3(9, 2, -2), normal);
            assert(!d.carveJob, 'fresh contact did not preempt a cold laser fuse');
            d.updateBurns(0);
            assert(d.carveJob.burns.every(burn => burn.duration === 0), 'contact damage waited for laser heating');
            await settle(d); world.step();
            const contactHit = world.castRay(new R.Ray({ x: 9, y: 2, z: -5 }, { x: 0, y: 0, z: 1 }), 10, true);
            assert(contactHit && contactHit.timeOfImpact > 3.5, 'prioritized contact did not damage its point');
            assert(!world.castRay(new R.Ray({ x: 11.5, y: 2, z: -5 }, { x: 0, y: 0, z: 1 }), 10, true), 'preempting a laser job lost its independent melt');
          }
        } finally { d.dispose(); world.free() }
      }

      lab.update({ ...settings, playing: true, standing: true }); lab.reset();
      const d = lab.city.destruction;
      const wallGeometry = new T.BoxGeometry(4, 3, 2);
      const getUpGeometry = new T.BoxGeometry(.6, .6, .6);
      let getUpOwner;
      let floatingOwner;
      let protectedOwner;
      const owner = d.create('building');
      owner.parts.push({ geometry: wallGeometry, matrix: new T.Matrix4().makeTranslation(0, 1.5, 1.15), color: new T.Color('gray') });
      const wall = lab.world.createCollider(R.ColliderDesc.cuboid(2, 1.5, 1).setTranslation(0, 1.5, 1.15));
      d.register(owner, wall);
      try {
        assert(!lab.impactDestruction, 'destructive collisions started enabled');
        lab.onKeyDown(new KeyboardEvent('keydown', { code: 'KeyX' }));
        assert(!lab.impactDestruction && lab.ragdoll.isReleased, 'releasing the body armed destructive contacts');
        let contacts = 0;
        let physicalContacts = 0;
        for (let i = 0; i < 5; i++) {
          lab.step(); contacts += lab.destructionContacts.length;
          for (const { body } of lab.ragdoll.parts.values()) for (let j = 0; j < body.numColliders(); j++)
            lab.world.contactPairsWith(body.collider(j), other => { if (other.handle === wall.handle) physicalContacts++ });
        }
        assert(physicalContacts > 0, 'released body did not physically contact the test wall');
        assert(contacts === 0 && !d.burns.length && !owner.damaged && wall.isValid(), 'ragdoll collision damaged the wall');
        lab.onKeyDown(new KeyboardEvent('keydown', { code: 'KeyX' }));
        assert(lab.impactDestruction && lab.ragdoll.isRecovering, 'second X stopped destructive contacts during recovery');
        assert(lab.impactDestructionUntil === null, 'three-second window started before the character stood up');
        const getUpPoint = new T.Vector3().copy(lab.ragdoll.parts.get('head').body.translation()).add(new T.Vector3(0, 0, .2));
        getUpOwner = d.create('building');
        getUpOwner.parts.push({ geometry: getUpGeometry, matrix: new T.Matrix4().makeTranslation(getUpPoint.x, getUpPoint.y, getUpPoint.z), color: new T.Color('gray') });
        const getUpCollider = lab.world.createCollider(R.ColliderDesc.cuboid(.3, .3, .3).setTranslation(getUpPoint.x, getUpPoint.y, getUpPoint.z));
        d.register(getUpOwner, getUpCollider);
        for (let i = 0; i < 3; i++) lab.step();
        assert(lab.ragdoll.isRecovering && d.burns.some(burn => burn.owner === getUpOwner), 'contact during the get-up animation did not queue destruction');
        await settle(d);
        assert(getUpOwner.damaged && lab.ragdoll.isRecovering, `contacting scenery did not break during get-up: ${JSON.stringify({ damaged: getUpOwner.damaged, recovering: lab.ragdoll.isRecovering, released: lab.ragdoll.isReleased, burns: d.burns.length, job: !!d.carveJob })}`);
        assert(!getUpCollider.isValid(), 'get-up contact left the original scenery collider intact');
        assert(owner.damaged, 'get-up contacts did not damage the nearby wall');
        assert(lab.impactDestructionUntil === null, 'get-up contact prematurely started the three-second timer');
        for (let i = 0; i < 300 && lab.impactDestructionUntil === null; i++) lab.step();
        assert(lab.impactDestructionUntil !== null && lab.impactDestruction, 'standing up did not start the destructive contact window');
        assert(Math.abs(lab.impactDestructionUntil - lab.elapsed - 3) < 1e-6, 'destructive contact window is not three seconds');
        assert(lab.ragdoll.isCollisionProtected && !lab.ragdoll.isReleased && !lab.ragdoll.isRecovering, 'standing up did not preserve normal control and collision protection');
        await settle(d);
        const protectedPoint = new T.Vector3().copy(lab.ragdoll.parts.get('head').body.translation()).add(new T.Vector3(0, 0, .2));
        protectedOwner = d.create('building');
        protectedOwner.parts.push({ geometry: getUpGeometry, matrix: new T.Matrix4().makeTranslation(protectedPoint.x, protectedPoint.y, protectedPoint.z), color: new T.Color('gray') });
        const protectedCollider = lab.world.createCollider(R.ColliderDesc.cuboid(.3, .3, .3).setTranslation(protectedPoint.x, protectedPoint.y, protectedPoint.z));
        d.register(protectedOwner, protectedCollider);
        const start = new T.Vector3().copy(lab.ragdoll.parts.get('pelvis').body.translation());
        lab.settings.sitting = false; lab.keys.add('KeyW');
        let protectedContacts = 0;
        for (let i = 0; i < 12; i++) {
          lab.step(); protectedContacts += lab.destructionContacts.length;
          assert(!lab.ragdoll.isReleased && !lab.ragdoll.isRecovering && lab.ragdoll.isCollisionProtected, 'collision interrupted protected character control');
          assert([...lab.ragdoll.parts.values()].every(part => part.body.isKinematic()), 'protected character became a dynamic ragdoll');
        }
        lab.keys.delete('KeyW');
        const end = lab.ragdoll.parts.get('pelvis').body.translation();
        assert(Math.hypot(end.x - start.x, end.z - start.z) > .03, 'movement input stopped working during collision protection');
        assert(protectedContacts > 0, 'protected character did not register contacts');
        await settle(d);
        assert(protectedOwner.damaged && !lab.ragdoll.isReleased, 'protected collision stopped scenery destruction or knocked down the character');
        // A crash during the three-second window must disable damage while the body is released.
        lab.ragdoll.release();
        const floatingPoint = new T.Vector3().copy(lab.ragdoll.parts.get('head').body.translation()).add(new T.Vector3(0, 0, .2));
        floatingOwner = d.create('building');
        floatingOwner.parts.push({ geometry: getUpGeometry, matrix: new T.Matrix4().makeTranslation(floatingPoint.x, floatingPoint.y, floatingPoint.z), color: new T.Color('gray') });
        const floatingCollider = lab.world.createCollider(R.ColliderDesc.cuboid(.3, .3, .3).setTranslation(floatingPoint.x, floatingPoint.y, floatingPoint.z));
        d.register(floatingOwner, floatingCollider);
        let floatingContacts = 0;
        for (let i = 0; i < 3; i++) {
          lab.step();
          for (const { body } of lab.ragdoll.parts.values()) for (let j = 0; j < body.numColliders(); j++)
            lab.world.contactPairsWith(body.collider(j), other => { if (other.handle === floatingCollider.handle) floatingContacts++ });
          assert(lab.destructionContacts.length === 0, 'released body queued damage during the standing timer');
        }
        assert(floatingContacts > 0 && !floatingOwner.damaged && !d.burns.some(burn => burn.owner === floatingOwner), 'falling during the three-second window damaged scenery');
        for (let i = 0; i < 164; i++) lab.step();
        assert(lab.impactDestruction, 'destructive contacts expired before three seconds');
        lab.step();
        assert(!lab.impactDestruction && lab.impactDestructionUntil === null, 'destructive contacts did not expire after three seconds');
        assert(!lab.ragdoll.isCollisionProtected, 'collision protection did not expire');
        lab.reset();
        assert(!lab.impactDestruction && lab.destructionContacts.length === 0, 'reset retained destructive contacts');
      } finally {
        d.objects.splice(d.objects.indexOf(owner), 1);
        if (getUpOwner) d.objects.splice(d.objects.indexOf(getUpOwner), 1);
        if (floatingOwner) d.objects.splice(d.objects.indexOf(floatingOwner), 1);
        if (protectedOwner) d.objects.splice(d.objects.indexOf(protectedOwner), 1);
        wallGeometry.dispose(); getUpGeometry.dispose();
      }
      return { passed: true, kinds: ['building', 'tree', 'car'], localizedContactDamage: true, noLaserDelay: true, ragdollDoesNotDamage: true, duringGetUp: true, afterStandingSeconds: 3, protectedControl: true, releasedDuringTimerDoesNotDamage: true, reset: true };
    } finally {
      geometry.dispose(); lab.update(settings); lab.reset(); lab.previousTime = 0; lab.raf = requestAnimationFrame(lab.frame);
    }
  });
}
