// Run with the app open: playwright-cli run-code --filename tests/performance-and-wind.js
async page => {
  await page.reload();
  await page.locator('.scene-canvas').waitFor();
  const errors = [];
  const onError = message => { if (message.type() === 'error') errors.push(message.text()) };
  page.on('console', onError);
  const result = await page.evaluate(async () => {
    const T = await import('/node_modules/.vite/deps/three.js');
    const root = document.getElementById('root');
    const fiber = root[Object.keys(root).find(k => k.startsWith('__reactContainer'))].stateNode.current;
    const find = f => !f ? null : f.type?.name === 'App' ? f : find(f.child) || find(f.sibling);
    let hook = find(fiber).memoizedState;
    while (hook && !hook.memoizedState?.current?.ragdoll) hook = hook.next;
    const lab = hook.memoizedState.current;
    cancelAnimationFrame(lab.raf);
    const settings = { ...lab.settings };
    const assert = (condition, message) => { if (!condition) throw Error(message) };
    try {
      lab.settings = { ...settings, playing: true };
      lab.reset();
      const effect = lab.windEffect, mesh = effect.mesh, uniforms = mesh.material.uniforms;
      const focus = new T.Vector3(0, 3, 0);
      effect.update(2, focus, 0, 90);
      assert(!mesh.visible, 'calm air still renders wind');
      for (const angle of [0, 90, 180, 270]) {
        effect.update(2, focus, 2, angle);
        const expected = new T.Vector3(Math.cos(angle * Math.PI / 180), 0, Math.sin(angle * Math.PI / 180));
        assert(uniforms.wind.value.clone().normalize().distanceTo(expected) < 1e-6, 'wind direction mismatch');
      }
      const gentle = { speed: uniforms.wind.value.length(), strength: uniforms.strength.value, count: mesh.geometry.instanceCount };
      effect.update(2, focus, 100, 90);
      assert(uniforms.wind.value.length() > gentle.speed && uniforms.strength.value > gentle.strength,
        'wind strength does not change speed and appearance');
      assert(mesh.geometry.instanceCount > gentle.count && mesh.geometry.instanceCount <= 320, 'unbounded wind population');
      effect.update(2, focus, 100, 90, false);
      assert(!mesh.visible, 'wind obscures city map');
      const positionBuffer = mesh.geometry.attributes.position.array, seedBuffer = mesh.geometry.attributes.windSeed.array;
      for (let i = 0; i < 600; i++) effect.update(i / 60, focus, 100, i);
      assert(positionBuffer === mesh.geometry.attributes.position.array && seedBuffer === mesh.geometry.attributes.windSeed.array,
        'wind reallocates animation buffers');
      lab.setCameraView('player');
      effect.update(2, focus, 100, 90);
      lab.renderer.render(lab.scene, lab.camera);
      const calls = lab.renderer.info.render.calls, triangles = lab.renderer.info.render.triangles;
      mesh.visible = false;
      lab.renderer.render(lab.scene, lab.camera);
      assert(calls - lab.renderer.info.render.calls === 1, 'wind requires more than one draw');
      assert(triangles - lab.renderer.info.render.triangles <= 5120, 'wind geometry exceeded budget');
      // Exercise steady full boost above the boundary walls, with finite cloth,
      // unchanged 10× speed and no accidental collision release.
      lab.touchFlight = true;
      for (let i = 0; i < 900; i++) lab.step();
      lab.touchFlight = false;
      lab.ragdoll.controlFocus(lab.focus);
      lab.camera.position.copy(lab.focus).add(new T.Vector3(0, 0, -10));
      lab.controls.target.copy(lab.focus); lab.controls.update();
      lab.keys.add('KeyW'); lab.keys.add('ShiftLeft');
      for (let i = 0; i < 240; i++) lab.step();
      const samples = [];
      for (let i = 0; i < 120; i++) {
        const start = performance.now();
        lab.step(); lab.updateMesh(.5); lab.ragdoll.sync(.5);
        samples.push(performance.now() - start);
        assert(lab.clothPositions.every(Number.isFinite), 'non-finite boosted cape');
      }
      assert(!lab.ragdoll.isReleased && lab.ragdoll.speed > 105, 'full boost changed');
      assert(lab.cloth.numParticles() === 169 && lab.cloth.numAttachments() === 13, 'physics budget or collar changed');
      const speed = lab.ragdoll.speed;
      lab.update({ ...lab.settings, playing: false });
      lab.previousTime = 0;
      lab.frame(performance.now()); cancelAnimationFrame(lab.raf);
      const windTime = uniforms.time.value, elapsed = lab.elapsed;
      lab.frame(performance.now() + 100); cancelAnimationFrame(lab.raf);
      assert(uniforms.time.value === windTime && lab.elapsed === elapsed, 'wind continues while paused');
      samples.sort((a, b) => a - b);
      return { passed: true, boostSpeed: speed, meanStepMs: samples.reduce((a, b) => a + b) / samples.length,
        p95StepMs: samples[Math.floor(samples.length * .95)], windDraws: 1, boundedBuffers: true, pause: true };
    } finally {
      lab.settings = settings; lab.reset(); lab.previousTime = 0; lab.raf = requestAnimationFrame(lab.frame);
    }
  });
  page.off('console', onError);
  if (errors.length) throw Error(errors.join('\n'));
  return result;
}
