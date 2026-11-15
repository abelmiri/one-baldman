// Run with the app open: playwright-cli run-code --filename tests/laser-burn-performance.js
// Stress autonomous melts and assert static marks do not upload matrices every frame.
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
    const originals = {};
    try {
      lab.reset();
      const d = lab.city.destruction, world = lab.world;
      const owner = d.objects.filter(o => o.kind === 'building').reduce((a,b) => a.parts.length > b.parts.length ? a : b);
      const bounds = owner.parts.reduce((bounds, part) => bounds.union(new T.Box3().setFromBufferAttribute(part.geometry.attributes.position).applyMatrix4(part.matrix)), new T.Box3());
      const collider = owner.colliders[0], axis = new T.Vector3(0,0,1), normal = new T.Vector3(0,0,-1);
      for (let y = 1; y < 8; y += .65) for (let x = bounds.min.x + 1; x < bounds.max.x - 1 && d.burns.length < 128; x += .65)
        d.ignite(collider, new T.Vector3(x,y,bounds.min.z),axis,normal);
      const samples = [], physics = [];
      const count = d.burns.length;
      const matrixVersion = d.burnMarks.instanceMatrix.version;
      const stages = {};
      for (const name of ['sourceSolids', 'startCarve', 'finishCarve', 'rebuild', 'updateColliders']) {
        const original = d[name];
        originals[name] = original;
        stages[name] = { total: 0, max: 0 };
        d[name] = function (...args) {
          const t = performance.now(); const value = original.apply(this, args); const ms = performance.now() - t;
          stages[name].total += ms; stages[name].max = Math.max(stages[name].max, ms); return value;
        };
      }
      for (let i = 0; i < 240; i++) {
        const t = performance.now(); d.updateBurns(1/60); samples.push(performance.now()-t);
        const step = performance.now(); world.step(); physics.push(performance.now()-step);
        if (!d.burns.length && !d.carveJob) break;
        if (d.carveJob?.error) throw Error(d.carveJob.error);
        if (i < 85 && d.burnMarks.instanceMatrix.version !== matrixVersion) throw Error('static burn matrices were uploaded while only heat changed');
        await new Promise(resolve => setTimeout(resolve, 16));
      }
      if (d.burns.length || d.carveJob) throw Error('worker did not drain burns');
      const chunks=d.chunks.filter(c=>c.owner===owner);
      const sorted=[...samples].sort((a,b)=>a-b);
      return { stages, count, frames:samples.length, mainTotalMs:samples.reduce((a,b)=>a+b,0), mainMaxMs:Math.max(...samples), mainP95Ms:sorted[Math.floor(sorted.length*.95)], physicsMaxMs:Math.max(...physics), cells:chunks.reduce((s,c)=>s+c.solids.length,0), colliders:chunks.reduce((s,c)=>s+c.colliders.length,0), chunks:chunks.length };

    } finally {
      for (const [name, original] of Object.entries(originals)) lab.city.destruction[name] = original;
      lab.reset(); lab.previousTime = 0; lab.raf = requestAnimationFrame(lab.frame);
    }
  });
}
