// Run with the app open: playwright-cli run-code --filename tests/laser-performance.js
// Timings are diagnostic; the collider count catches full-building rebuild regressions.
async page => {
  await page.reload();
  await page.locator('.game-loading').waitFor({ state: 'detached' });
  return page.evaluate(async () => {
    const T = await import('/node_modules/.vite/deps/three.js');
    const root = document.getElementById('root');
    const fiber = root[Object.keys(root).find(k => k.startsWith('__reactContainer'))].stateNode.current;
    const find = f => !f ? null : f.type?.name === 'App' ? f : find(f.child) || find(f.sibling);
    let hook = find(fiber).memoizedState;
    while (hook && !hook.memoizedState?.current?.ragdoll) hook = hook.next;
    const lab = hook.memoizedState.current;
    cancelAnimationFrame(lab.raf);
    const results = [];
    try {
      for (const largest of [false, true]) {
        lab.reset();
        const d = lab.city.destruction, world = lab.world;
        const buildings = d.objects.filter(o => o.kind === 'building');
        const owner = largest ? buildings.reduce((a, b) => a.parts.length > b.parts.length ? a : b) : buildings[0];
        const bounds = owner.parts.reduce((bounds, part) => bounds.union(new T.Box3().setFromBufferAttribute(part.geometry.attributes.position).applyMatrix4(part.matrix)), new T.Box3());
        const axis = new T.Vector3(0, 0, 1), timings = [];
        let creates = 0, removes = 0, steps = 0, activation = 0, rebuild = 0;
        const create = world.createCollider, remove = world.removeCollider, activate = d.activate, build = d.rebuild;
        world.createCollider = function (...args) { creates++; return create.apply(this, args) };
        world.removeCollider = function (...args) { removes++; return remove.apply(this, args) };
        d.activate = function (...args) { const t = performance.now(); const r = activate.apply(this, args); activation += performance.now() - t; return r };
        d.rebuild = function (...args) { const t = performance.now(); const r = build.apply(this, args); rebuild += performance.now() - t; return r };
        try {
          for (let x = bounds.min.x - .2; x <= bounds.max.x + .2; x += .24) {
            const collider = owner.damaged ? d.chunks.find(c => c.owner === owner && c.colliders.length)?.colliders[0] : owner.colliders[0];
            if (!collider) break;
            const t = performance.now();
            d.cut(collider, new T.Vector3(x, 2.5, bounds.min.z - .1), axis);
            timings.push(performance.now() - t);
            const step = performance.now(); world.step(); steps += performance.now() - step;
          }
          const sorted = [...timings].sort((a,b) => a-b);
          if (creates > owner.parts.length * 15) throw Error('destruction recreated too many unchanged colliders');
          results.push({ largest, parts: owner.parts.length, cuts: timings.length, totalMs: timings.reduce((a,b) => a+b,0), maxMs: Math.max(...timings), p95Ms: sorted[Math.floor(sorted.length * .95)], activation, rebuild, physicsMs: steps, creates, removes, cells: d.chunks.filter(c => c.owner === owner).reduce((s,c) => s+c.solids.length,0) });
        } finally { world.createCollider = create; world.removeCollider = remove; d.activate = activate; d.rebuild = build }
      }
      return results;
    } finally { lab.reset(); lab.previousTime = 0; lab.raf = requestAnimationFrame(lab.frame) }
  });
}
