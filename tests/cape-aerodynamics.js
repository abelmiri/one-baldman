// Run in the app: playwright-cli -s=cape120 run-code --filename tests/cape-aerodynamics.js
async page => {
  await page.reload();
  await page.locator('.scene-canvas').waitFor();
  await page.locator('.game-loading').waitFor({ state: 'detached' });
  return page.evaluate(async () => {
    const T = await import('/node_modules/.vite/deps/three.js');
    const root = document.getElementById('root');
    const fiber = root[Object.keys(root).find(k => k.startsWith('__reactContainer'))].stateNode.current;
    const find = f => !f ? null : f.type?.name === 'App' ? f : find(f.child) || find(f.sibling);
    let hook = find(fiber).memoizedState;
    while (hook && !hook.memoizedState?.current?.ragdoll) hook = hook.next;
    const lab = hook.memoizedState.current, settings = { ...lab.settings };
    const assert = (ok, message) => { if (!ok) throw Error(message) };
    cancelAnimationFrame(lab.raf);
    const render = lab.renderer.render;
    try {
      lab.settings = { ...settings, mode: 'cape', standing: true, wind: 0, playing: true };
      lab.reset();
      const dt = lab.world.integrationParameters.dt;
      assert(Math.abs(dt - 1 / 120) < 1e-8, 'physics is not running at 120 Hz');
      const cloth = lab.cloth, count = Math.sqrt(cloth.numParticles());
      const initial = new Float32Array(cloth.particlePositions());
      const v = new T.Vector3();
      const sample = (x, z, wind, direction) => {
        for (let i = 0; i < count * count; i++) {
          cloth.setParticlePosition(i, v.fromArray(initial, i * 3));
          cloth.setParticleVelocity(i, v.set(x, 0, z));
        }
        lab.capeMotion.beforeStep(dt, wind, direction, 0);
        let meanX = 0, meanZ = 0, n = 0;
        const velocities = cloth.particleVelocities();
        for (let i = 0; i < count * count; i++) {
          if (i % count === 0) continue;
          meanX += velocities[i * 3]; meanZ += velocities[i * 3 + 2]; n++;
        }
        assert(velocities.every(Number.isFinite), 'aerodynamics produced non-finite velocities');
        return { x: meanX / n, z: meanZ / n };
      };
      const calm = sample(0, 0, 0, 0);
      assert(Math.hypot(calm.x, calm.z) < 1e-6, 'calm air adds energy to stationary cloth');
      const normal = sample(0, 10, 0, 0), tangent = sample(10, 0, 0, 0);
      assert(10 - normal.z > (10 - tangent.x) * 2, 'pressure does not depend on fabric orientation');
      const east = sample(0, 0, 100, 0), west = sample(0, 0, 100, 180);
      assert(east.x > .01 && west.x < -.01, 'cloth does not follow wind direction');
      const gentle = sample(0, 0, 10, 90), strong = sample(0, 0, 100, 90);
      assert(strong.z > gentle.z * 2, 'wind strength does not affect fabric pressure');
      sample(0, 1000, 100, 90);
      const maxSpeed = Math.max(...Array.from(cloth.particleVelocities(), Math.abs));
      assert(maxSpeed <= 1000, 'drag overshoots at extreme speed');
      // Drive the real frame accumulator at several display rates. Each second
      // must advance the same 120 fixed steps, including four steps at 30 fps.
      lab.renderer.render = () => {};
      const cadences = [];
      for (const fps of [30, 60, 120, 144]) {
        lab.reset(); lab.accumulator = 0; lab.previousTime = 1000;
        for (let frame = 1; frame <= fps; frame++) {
          lab.frame(1000 + frame * 1000 / fps);
          cancelAnimationFrame(lab.raf);
        }
        assert(Math.abs(lab.elapsed + lab.accumulator - 1) < 1e-6,
          'simulation time lost at ' + fps + ' fps: ' + lab.elapsed);
        cadences.push({ fps, simulationSeconds: lab.elapsed + lab.accumulator });
      }
      return { passed: true, physicsHz: Math.round(1 / dt), normal, tangent, east, west, gentle, strong, cadences };
    } finally {
      lab.renderer.render = render;
      lab.settings = settings; lab.reset(); lab.previousTime = 0;
      lab.raf = requestAnimationFrame(lab.frame);
    }
  });
}
