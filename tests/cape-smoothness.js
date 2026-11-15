// Run in the app: playwright-cli run-code --filename tests/cape-smoothness.js
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
    const assert = (ok, message) => { if (!ok) throw Error(message); };
    cancelAnimationFrame(lab.raf);
    try {
      lab.settings = { ...settings, mode: 'cape', standing: true, wind: 0 };
      lab.reset();
      const cloth = lab.cloth, motion = lab.capeMotion;
      const count = Math.sqrt(cloth.numParticles()), dt = lab.world.integrationParameters.dt;
      const carrier = lab.ragdoll.capeBodies.get('chest');
      carrier.setNextKinematicTranslation(carrier.translation());
      const v = new T.Vector3();
      let initialEnergy = 0, initialMomentum = 0;
      for (let i = 0; i < count * count; i++) {
        const speed = i % count === 0 ? 0 : ((Math.floor(i / count) + i % count) % 2 ? 1 : -1);
        cloth.setParticleVelocity(i, v.set(speed, 0, 0));
        initialEnergy += speed * speed; initialMomentum += speed;
      }
      motion.beforeStep(dt);
      let energy = 0, momentum = 0;
      for (let i = 0; i < count * count; i++) {
        const speed = motion.dampedVelocities[i * 3];
        energy += speed * speed; momentum += speed;
        if (i % count === 0) assert(speed === 0, 'damping moved a sewn particle');
      }
      assert(energy < initialEnergy * .8, 'short wavelength chatter was not damped');
      assert(Math.abs(momentum - initialMomentum) < 1e-4, 'internal damping changed total momentum');
      for (let i = 0; i < count * count; i++) cloth.setParticleVelocity(i, v.set(2, 0, 0));
      motion.beforeStep(dt);
      assert(motion.dampedVelocities.every((value, i) => Math.abs(value - (i % 3 === 0 ? 2 : 0)) < 1e-6),
        'internal damping resisted shared fabric motion');
      for (let i = 0; i < count * count; i++) cloth.setParticleVelocity(i, v.set(0, 0, 0));
      carrier.setNextKinematicTranslation(v.copy(carrier.translation()).add(new T.Vector3(dt * 3, 0, 0)));
      motion.beforeStep(dt);
      const velocities = cloth.particleVelocities();
      const nearCollar = velocities[3], hem = velocities[(count - 1) * 3];
      assert(nearCollar > hem && hem > 0, 'hem does not retain more inertia than the shoulders');
      assert(velocities.every(Number.isFinite), 'acceleration produced invalid velocities');
      for (let i = 0; i < count * count; i++) cloth.setParticleVelocity(i, v.set(3, 0, 0));
      carrier.setNextKinematicTranslation(carrier.translation());
      motion.beforeStep(dt);
      const braking = cloth.particleVelocities();
      assert(braking[(count - 1) * 3] > braking[3] && braking[3] > 0,
        'braking removed the hem inertia or reversed the fabric');
      return { passed: true, chatterEnergyRatio: energy / initialEnergy, nearCollar, hem,
        brakingCollar: braking[3], brakingHem: braking[(count - 1) * 3] };
    } finally {
      lab.settings = settings; lab.reset(); lab.previousTime = 0;
      lab.raf = requestAnimationFrame(lab.frame);
    }
  });
}
