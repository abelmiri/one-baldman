// Run in the app: playwright-cli run-code --filename tests/cape-falling.js
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
    const lab = hook.memoizedState.current;
    const settings = { ...lab.settings };
    const assert = (condition, message) => { if (!condition) throw Error(message) };
    const dt = lab.world.integrationParameters.dt, point = new T.Vector3(), parent = new T.Vector3();
    cancelAnimationFrame(lab.raf);
    try {
      lab.settings = { ...settings, mode: 'cape', standing: true, wind: 0, gravity: 9.8 };
      lab.reset();
      const cloth = lab.cloth, count = Math.sqrt(cloth.numParticles());
      const rest = new Float32Array(count * count);
      const initial = new Float32Array(cloth.particlePositions());
      for (let i = 0; i < count * count; i++) {
        if (i % count) rest[i] = point.fromArray(initial, i * 3).distanceTo(parent.fromArray(initial, (i - 1) * 3));
      }
      // Keep the actual cape, collar and body collision proxies, well above the
      // city. Prescribed carrier motion isolates the cloth's response to falling.
      const bodies = [...lab.ragdoll.parts.values()].map(part => part.body)
        .concat([...lab.ragdoll.capeBodies.values()]);
      for (const body of bodies) body.setTranslation(point.copy(body.translation()).add(new T.Vector3(0, 100, 0)), true);
      for (let i = 0; i < count * count; i++) {
        cloth.setParticlePosition(i, point.fromArray(initial, i * 3).add(new T.Vector3(0, 100, 0)));
        cloth.setParticleVelocity(i, new T.Vector3());
      }
      let maximumLengthRatio = 0;
      const step = velocityY => {
        for (const body of bodies) body.setNextKinematicTranslation(point.copy(body.translation()).addScaledVector(T.Object3D.DEFAULT_UP, velocityY * dt));
        lab.capeMotion.beforeStep(dt);
        cloth.resetForces(true);
        lab.world.step();
        lab.capeMotion.afterStep(dt);
        const positions = cloth.particlePositions();
        assert(positions.every(Number.isFinite), 'falling produced non-finite cape particles');
        for (let i = 0; i < count * count; i++) {
          if (i % count === 0) continue;
          const ratio = point.fromArray(positions, i * 3).distanceTo(parent.fromArray(positions, (i - 1) * 3)) / rest[i];
          maximumLengthRatio = Math.max(maximumLengthRatio, ratio);
          assert(ratio < 1.036, 'falling stretched the cape: ' + ratio);
        }
        assert(cloth.numAttachments() === count, 'falling detached the collar');
      };
      const hemOffset = () => {
        const positions = cloth.particlePositions();
        let height = 0;
        for (let column = 0; column < count; column++) {
          height += positions[(column * count + count - 1) * 3 + 1] - positions[column * count * 3 + 1];
        }
        return height / count;
      };
      for (let i = 0; i < Math.round(3 / dt); i++) step(0);
      const restingHem = hemOffset();
      assert(restingHem < -1, 'stationary cape does not hang down');
      for (let i = 0; i < Math.round(3 / dt); i++) step(-9.8 * (i + 1) * dt);
      const fallingHem = hemOffset();
      assert(fallingHem > .2, 'cape did not rise above its collar during freefall: ' + fallingHem);
      for (let i = 0; i < Math.round(5 / dt); i++) step(0);
      const stoppedHem = hemOffset();
      assert(stoppedHem < -1, 'cape did not settle after the fall stopped: ' + stoppedHem);
      return { passed: true, restingHem, fallingHem, stoppedHem, maximumLengthRatio, collarAttached: true };
    } finally {
      lab.settings = settings;
      lab.reset();
      lab.previousTime = 0;
      lab.raf = requestAnimationFrame(lab.frame);
    }
  });
}
