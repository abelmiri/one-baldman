// Run with the app open: playwright-cli run-code --filename tests/prop-flight-protection.js
async page => {
  await page.reload();
  await page.locator('.game-loading').waitFor({ state: 'detached' });
  return page.evaluate(async () => {
    const T = await import('/node_modules/.vite/deps/three.js');
    const { default: R } = await import('/node_modules/@dimforge/rapier3d/rapier.js');
    const { Ragdoll } = await import('/src/Ragdoll.ts');
    const assert = (value, message) => { if (!value) throw Error(message) };
    const root = document.getElementById('root');
    const fiber = root[Object.keys(root).find(key => key.startsWith('__reactContainer'))].stateNode.current;
    const find = f => !f ? null : f.type?.name === 'App' ? f : find(f.child) || find(f.sibling);
    let hook = find(fiber).memoizedState;
    while (hook && !hook.memoizedState?.current?.ragdoll) hook = hook.next;
    const lab = hook.memoizedState.current;
    cancelAnimationFrame(lab.raf);
    const results = [];
    const geometry = new T.BoxGeometry(4, 8, 1);
    try {
      for (const [kind, fast] of [['tree', true], ['car', true], ['tree', false], ['car', false], ['building', true]]) {
        lab.reset();
        const d = lab.city.destruction, world = lab.world;
        const owner = d.create(kind);
        owner.parts.push({ geometry, matrix: new T.Matrix4().makeTranslation(0, 90, 6), color: new T.Color('green') });
        const collider = world.createCollider(R.ColliderDesc.cuboid(2, 4, .5).setTranslation(0, 90, 6));
        d.register(owner, collider);
        assert(lab.ragdoll.impactPassThrough === lab.canBreakPropWithoutFalling, 'game character did not configure prop protection');
        assert(!lab.canBreakPropWithoutFalling(collider, 50 / 3.6), 'protection started at exactly 50 km/h');
        assert(lab.canBreakPropWithoutFalling(collider, 51 / 3.6) === (kind !== 'building'), 'prop threshold or building exclusion is incorrect');
        const impacts = [];
        const hero = new Ragdoll(world, new T.Scene(), 0, true, (...args) => impacts.push(args));
        hero.configureImpactPassThrough(lab.canBreakPropWithoutFalling);
        const offset = new T.Vector3(0, 90 - hero.supportTarget.y, 0);
        for (const { body } of hero.parts.values()) body.setTranslation(new T.Vector3().copy(body.translation()).add(offset), true);
        hero.supportTarget.add(offset); hero.airborne = true; hero.flightAge = 2;
        let contactCount = 0;
        try {
          for (let i = 0; i < 100 && !hero.isReleased; i++) {
            lab.destructionContacts.length = 0;
            hero.flightBoost = fast ? .45 : 0;
            hero.moveVelocity.set(0, 0, fast ? 45 : 11);
            hero.setFlight(false, 0, 0, .04);
            hero.setFlightAim(new T.Vector3(0, 0, 1), 1);
            hero.setMovement(0, 1, false, false);
            hero.step(1 / 120, lab.recordDestructiveContact, lab.isDestructibleCollider);
            world.step();
            hero.checkForImpact(lab.recordDestructiveContact);
            for (const contact of lab.destructionContacts) {
              contactCount++;
              d.queueContact(contact.collider, contact.point, contact.normal, contact.speed);
            }
            d.sync();
            if (hero.parts.get('pelvis').body.translation().z > 10) break;
          }
          if (fast && kind !== 'building') {
            assert(owner.damaged && contactCount > 0, `${kind} did not break on contact`);
            assert(d.chunks.filter(chunk => chunk.owner === owner).length === 10, `${kind} did not produce ten pieces`);
            assert(!hero.isReleased && !hero.isRecovering, `${kind} triggered ragdoll above 50 km/h`);
            assert([...hero.parts.values()].every(part => part.body.isKinematic()), `${kind} made character dynamic`);
            assert(hero.parts.get('pelvis').body.translation().z > 10, `${kind} stopped forward motion`);
            assert(impacts.length === 0, `${kind} emitted character injury effects`);
          } else {
            assert(hero.isReleased, `${kind} unexpectedly protected a normal collision`);
            assert(!owner.damaged, `${kind} unexpectedly destroyed on a normal collision`);
          }
          results.push({ kind, above50: fast, shattered: owner.damaged, ragdoll: hero.isReleased });
        } finally { hero.dispose(); d.objects.splice(d.objects.indexOf(owner), 1) }
      }
      return results;
    } finally { geometry.dispose(); lab.reset(); }
  });
}
