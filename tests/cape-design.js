// Run with the app open: playwright-cli run-code --filename tests/cape-design.js
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
    const assert = (condition, message) => { if (!condition) throw Error(message) };
    const settings = { ...lab.settings };
    cancelAnimationFrame(lab.raf);
    try {
      lab.settings = { ...settings, wind: 0 };
      lab.reset();
      for (let i = 0; i < 600; i++) lab.step();
      lab.updateMesh();
      const surface = lab.capeSurface;
      const attribute = surface.geometry.getAttribute('position');
      const count = surface.count, columnCount = surface.columnCount;
      assert(surface.geometry.index.count / 3 === 2 * (count - 1) ** 2 * 2,
        'cape triangle count did not double');
      const settled = Array.from(attribute.array);
      assert(settled.every(Number.isFinite), 'non-finite calm cape surface');
      const particles = Math.sqrt(lab.cloth.numParticles());
      const subdivisions = (columnCount - 1) / (particles - 1);
      assert(lab.cloth.numAttachments() === particles, 'collar lost an attachment');
      for (let column = 0; column < particles; column++) {
        const index = column * subdivisions * count * 3;
        const source = column * particles * 3;
        for (let axis = 0; axis < 3; axis++) {
          assert(Math.abs(settled[index + axis] - lab.clothPositions[source + axis]) < 1e-6,
            'render collar moved away from sewn physics collar');
        }
      }
      // Even after ten seconds without wind, cross-sections retain folds.
      const row = Math.round((count - 1) * .7);
      const depths = Array.from({ length: columnCount }, (_, column) => attribute.getZ(column * count + row));
      let turns = 0;
      for (let i = 1; i < depths.length - 1; i++) {
        if ((depths[i] - depths[i - 1]) * (depths[i + 1] - depths[i]) < 0) turns++;
      }
      assert(turns >= 4, 'calm cape flattened out: ' + turns + ' depth turns');
      surface.update(lab.clothPositions, lab.clothPositions, 1, 0);
      const still = Array.from(attribute.array);
      surface.update(lab.clothPositions, lab.clothPositions, 1, 1);
      const moving = Array.from(attribute.array);
      const motion = Math.max(...moving.map((value, i) => Math.abs(value - still[i])));
      assert(motion > .005 && motion < .03, 'idle ripple is missing or too large: ' + motion);
      surface.update(lab.clothPositions, lab.clothPositions, 1, 1);
      assert(moving.every((value, i) => value === attribute.array[i]), 'surface changes at frozen simulation time');
      // Detail must rotate with the cloth rather than remain on the world Z axis.
      const rotation = new T.Quaternion().setFromEuler(new T.Euler(.6, 1.2, -.4));
      const translation = new T.Vector3(12, 8, -7);
      const point = new T.Vector3();
      const transformed = new Float32Array(lab.clothPositions);
      for (let i = 0; i < transformed.length; i += 3) {
        point.fromArray(transformed, i).applyQuaternion(rotation).add(translation).toArray(transformed, i);
      }
      surface.update(transformed, transformed, 1, 1);
      let transformError = 0;
      for (let i = 0; i < attribute.count; i++) {
        point.fromArray(moving, i * 3).applyQuaternion(rotation).add(translation);
        transformError = Math.max(transformError, point.distanceTo(new T.Vector3().fromBufferAttribute(attribute, i)));
      }
      assert(transformError < .0001, 'cape detail did not follow cloth rotation: ' + transformError);
      const phases = [];
      for (const [phase, frames] of [['walk', 90], ['flight', 180], ['release', 90]]) {
        lab.clearMovement();
        if (phase === 'walk') lab.touchDirections.add('right');
        if (phase === 'flight') lab.touchFlight = true;
        if (phase === 'release') lab.toggleRelease();
        for (let i = 0; i < frames; i++) lab.step();
        lab.updateMesh(.5);
        assert(attribute.array.every(Number.isFinite), 'non-finite cape during ' + phase);
        phases.push(phase);
      }
      lab.reset(); lab.updateMesh(); lab.renderer.render(lab.scene, lab.camera);
      const memory = { ...lab.renderer.info.memory };
      for (let i = 0; i < 4; i++) { lab.reset(); lab.updateMesh(); lab.renderer.render(lab.scene, lab.camera) }
      assert(lab.renderer.info.memory.geometries === memory.geometries, 'cape geometry leak on reset');
      assert(lab.renderer.info.memory.textures === memory.textures, 'cape texture leak on reset');
      lab.update({ ...lab.settings, mode: 'falling' });
      for (let i = 0; i < 30; i++) lab.step();
      lab.updateMesh();
      assert(!lab.capeSurface && lab.clothMesh.geometry.getAttribute('position').array.every(Number.isFinite),
        'free sheet mode regressed');
      return { passed: true, calmFoldTurns: turns, idleMotion: motion, collarAttached: true,
        rotationError: transformError, phases, resetMemory: memory, freeSheet: true };
    } finally {
      lab.settings = settings;
      lab.reset();
      lab.raf = requestAnimationFrame(lab.frame);
    }
  });
}
