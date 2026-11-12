// Run in the app: playwright-cli run-code --filename tests/rooftop-support.js
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
    const city = lab.city;
    city.root.updateMatrixWorld(true);
    const down = new T.Vector3(0, -1, 0);
    const ray = new T.Raycaster(new T.Vector3(), down, 0, 150);
    const visibleHeight = (x, z) => {
      ray.ray.origin.set(x, 100, z);
      return ray.intersectObject(city.root, true)[0].point.y;
    };
    const results = {};
    const fixture = (x, z, height, withCity = true) => {
      const world = new R.World({ x: 0, y: -9.8, z: 0 });
      if (withCity) city.addColliders(world);
      else {
        world.createCollider(R.ColliderDesc.cuboid(100, .1, 100).setTranslation(0, -.06, 0));
        world.createCollider(R.ColliderDesc.cuboid(4, 3, 4).setTranslation(0, 3, 0));
      }
      const hero = new Ragdoll(world, new T.Scene(), 0, true);
      const offset = new T.Vector3(x, height - hero.supportTarget.y, z);
      for (const { body } of hero.parts.values()) {
        body.setTranslation(new T.Vector3().copy(body.translation()).add(offset), true);
      }
      hero.supportTarget.add(offset);
      hero.airborne = true;
      hero.flightAge = 1;
      const focus = new T.Vector3();
      const step = (move = 0, descend = false, ascent = false) => {
        hero.controlFocus(focus);
        hero.setFlight(ascent, 0, 0, withCity ? city.groundHeightAt(focus) : .04, descend);
        hero.setMovement(0, move, false, false);
        hero.step(1 / 60);
        world.step();
        hero.checkForImpact();
        assert(!hero.isReleased, 'roof support triggered ragdoll at ' + JSON.stringify(hero.parts.get('pelvis').body.translation()));
      };
      return { world, hero, step, dispose: () => { hero.dispose(); world.free() } };
    };
    const soleGap = (hero, side) => {
      const { body, mesh } = hero.parts.get(side + 'Foot');
      const sole = mesh.children.find(child => child.name === 'boot-sole');
      const geometry = sole.geometry.getAttribute('position');
      const q = new T.Quaternion().copy(body.rotation());
      const p = new T.Vector3();
      const center = new T.Vector3().copy(body.translation());
      const normal = new T.Vector3();
      const ground = hero.sampleGround(center, normal);
      let lowest = Infinity;
      for (let i = 0; i < geometry.count; i++) {
        p.fromBufferAttribute(geometry, i).add(sole.position).applyQuaternion(q).add(body.translation());
        const surface = ground - (normal.x * (p.x - center.x) + normal.z * (p.z - center.z)) / normal.y;
        lowest = Math.min(lowest, p.y - surface);
      }
      return lowest;
    };
    try {
      // Compare visible triangles, support sampling, and physics at representative
      // flat roofs, fixtures, slopes, rotated houses, and the civic dome.
      const samples = [[-66, -65], [-66, -66.65], [-65.85, -66.65], [39, 35], [6, -63], [8.4, -62.4], [14, -62]];
      const houseRoof = city.obstacles.find(o => o.shape instanceof R.ConvexPolyhedron
        && Math.abs(o.half.y - 1.25) < .01 && Math.abs(o.rotation.y) > .01);
      assert(houseRoof, 'rotated house fixture missing');
      for (const dx of [-3, 0, 3]) {
        const p = new T.Vector3(dx, 0, 1).applyQuaternion(houseRoof.rotation).add(houseRoof.center);
        samples.push([p.x, p.z]);
      }
      const world = new R.World({ x: 0, y: -9.8, z: 0 });
      try {
        city.addColliders(world);
        world.step();
        results.surfaces = samples.map(([x, z]) => {
          const visual = visibleHeight(x, z);
          const sampled = city.groundHeightAt(new T.Vector3(x, 100, z));
          const hit = world.castRay(new R.Ray({ x, y: 100, z }, down), 150, false);
          const physics = 100 - hit.timeOfImpact;
          assert(Math.abs(sampled - visual) < .02, 'support floats above visible roof: ' + JSON.stringify({ x, z, visual, sampled }));
          assert(Math.abs(physics - visual) < .02, 'physics differs from visible roof: ' + JSON.stringify({ x, z, visual, physics }));
          return { x, z, visual, sampled, physics };
        });
      } finally { world.free() }

      for (const [name, x, z] of [['flat', -66, -64], ['slope', houseRoof.center.x, houseRoof.center.z]]) {
        const top = visibleHeight(x, z);
        const f = fixture(x, z, top + 6);
        try {
          for (let i = 0; i < 240; i++) f.step(0, true);
          assert(f.hero.flightState === 'grounded', name + ' roof landing failed');
          for (let i = 0; i < 120; i++) f.step();
          const idleGap = ['left', 'right'].map(side => soleGap(f.hero, side));
          assert(idleGap.every(gap => Math.abs(gap) < .01), name + ' idle sole is detached from roof: ' + idleGap);
          let maximumSupportGap = -Infinity, minimumSupportGap = Infinity;
          for (let i = 0; i < 65; i++) {
            f.step(1);
            ['left', 'right'].forEach((side, j) => {
              if (!f.hero.animation.feet[j].swinging) {
                const gap = soleGap(f.hero, side);
                maximumSupportGap = Math.max(maximumSupportGap, gap);
                minimumSupportGap = Math.min(minimumSupportGap, gap);
              }
            });
          }
          assert(maximumSupportGap < .015, name + ' planted foot floats during walking: ' + maximumSupportGap);
          assert(minimumSupportGap > -.015, name + ' planted foot penetrates roof: ' + minimumSupportGap);
          assert(f.hero.flightState === 'grounded', name + ' walking lost support');
          results[name] = { idleGap, maximumSupportGap, minimumSupportGap, state: f.hero.flightState };
        } finally { f.dispose() }
      }
      const edge = fixture(0, 0, 12, false);
      try {
        for (let i = 0; i < 240; i++) edge.step(0, true);
        assert(edge.hero.flightState === 'grounded', 'physics roof landing depends on stale external height');
        let leftRoof = false;
        for (let i = 0; i < 300; i++) {
          edge.step(1);
          leftRoof ||= edge.hero.isAirborne;
        }
        assert(leftRoof, 'walking off a roof did not start falling');
        assert(edge.hero.parts.get('pelvis').body.translation().y < 1.5, 'character hovered at roof height after leaving edge');
        assert(edge.hero.flightState === 'grounded', 'falling off roof did not land on ground');
        for (let i = 0; i < 60; i++) edge.step(0, false, true);
        assert(edge.hero.flightState === 'flying', 'could not take off again after landing');
        results.edge = { falls: true, lands: true, takesOffAgain: true };
      } finally { edge.dispose() }
      return { passed: true, ...results };
    } finally {
      // Fixture worlds replace the traffic handles; restore the live city world.
      lab.reset();
      lab.raf = requestAnimationFrame(lab.frame);
    }
  });
}
