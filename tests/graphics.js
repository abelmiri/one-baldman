// Run with the Playwright CLI against the Vite dev server, as documented in README.
async page => {
  const errors = [];
  const onError = message => { if (message.type() === 'error') errors.push(message.text()) };
  page.on('console', onError);
  await page.goto(new URL(page.url()).origin);
  await page.locator('.scene-canvas').waitFor();
  const results = await page.evaluate(async () => {
    const T = await import('/node_modules/.vite/deps/three.js');
    const { CapeSurface } = await import('/src/CapeSurface.ts');
    const root = document.getElementById('root');
    const fiber = root[Object.keys(root).find(k => k.startsWith('__reactContainer'))].stateNode.current;
    const find = f => !f ? null : f.type?.name === 'App' ? f : find(f.child) || find(f.sibling);
    let hook = find(fiber).memoizedState;
    while (hook && !hook.memoizedState?.current?.ragdoll) hook = hook.next;
    const lab = hook.memoizedState.current;
    const assert = (condition, message) => { if (!condition) throw Error(message) };
    lab.update({ ...lab.settings, playing: false });
    cancelAnimationFrame(lab.raf);
    await lab.city.textures.atlas.image.decode();
    assert(lab.city.textures.ready.value === 1, 'texture not ready');
    const atlas = lab.city.textures.atlas;
    assert(atlas.image.width === 1024 && atlas.image.height === 1024, 'oversized atlas');
    assert(!atlas.flipY && atlas.anisotropy <= 4, 'incorrect atlas orientation or filtering');
    lab.setCameraView('city');
    lab.renderer.render(lab.scene, lab.camera);
    const calls = lab.renderer.info.render.calls, triangles = lab.renderer.info.render.triangles;
    const textured = [];
    lab.city.root.traverse(mesh => {
      if (!mesh.geometry?.hasAttribute('citySurface')) return;
      textured.push([mesh, mesh.material]);
      mesh.material = lab.city.material;
    });
    lab.renderer.render(lab.scene, lab.camera);
    assert(lab.renderer.info.render.calls === calls, 'texture increased draw calls');
    assert(lab.renderer.info.render.triangles === triangles, 'texture increased triangle count');
    textured.forEach(([mesh, material]) => { mesh.material = material });
    assert(textured.length > 10, 'city surfaces not textured');
    lab.renderer.render(lab.scene, lab.camera);
    const memory = { ...lab.renderer.info.memory };
    for (let i = 0; i < 4; i++) { lab.reset(); lab.renderer.render(lab.scene, lab.camera) }
    assert(lab.renderer.info.memory.textures === memory.textures, 'reset leaked textures');
    assert(lab.renderer.info.memory.geometries === memory.geometries, 'reset leaked geometries');
    // Compare the optimized two-pass interpolation and cached waves against
    // direct 16-tap evaluation on a deformed, moving particle grid.
    const surface = new CapeSurface(19), reference = surface.geometry.clone();
    const previous = new Float32Array(19 * 19 * 3), current = new Float32Array(previous.length);
    for (let x = 0; x < 19; x++) for (let y = 0; y < 19; y++) {
      const i = (x * 19 + y) * 3;
      previous.set([x / 18, 2 - y / 12, .08 * Math.sin(x * .7 + y * .3)], i);
      current.set([x / 18 + .02 * Math.sin(y), 2 - y / 12, .15 * Math.sin(x * .7 + y * .3 + .5)], i);
    }
    let maxError = 0;
    for (const [alpha, time] of [[0, 0], [.37, 1.5], [1, 9]]) {
      const positions = reference.attributes.position.array;
      for (let x = 0; x < 55; x++) for (let y = 0; y < 55; y++) {
        const a = surface.samples[x], b = surface.samples[y];
        for (let axis = 0; axis < 3; axis++) {
          let value = 0;
          for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
            const source = (a.indices[i] * 19 + b.indices[j]) * 3 + axis;
            value += (previous[source] + (current[source] - previous[source]) * alpha) * a.weights[i] * b.weights[j];
          }
          positions[(x * 55 + y) * 3 + axis] = value;
        }
      }
      reference.computeVertexNormals();
      const normals = reference.attributes.normal.array;
      for (let x = 0; x < 55; x++) for (let y = 1; y < 55; y++) {
        const u = x / 54, v = y / 54, index = x * 55 + y;
        const envelope = T.MathUtils.smoothstep(v, .04, .3) * (.45 + .55 * v);
        const fold = Math.cos(u * Math.PI * 8 + .28 * Math.sin(v * 3.7)) * .038;
        const ripple = Math.sin(u * Math.PI * 6 - v * 7 + time * 1.65) * .012 * v;
        for (let axis = 0; axis < 3; axis++) positions[index * 3 + axis] += normals[index * 3 + axis] * (fold + ripple - .052) * envelope;
      }
      surface.update(previous, current, alpha, time);
      const actual = surface.geometry.attributes.position.array;
      for (let i = 0; i < actual.length; i++) maxError = Math.max(maxError, Math.abs(actual[i] - positions[i]));
    }
    assert(maxError < 1e-5, 'cape surface changed: ' + maxError);
    surface.dispose(); reference.dispose();
    lab.setNight(true); lab.renderer.render(lab.scene, lab.camera);
    lab.setNight(false); lab.setCameraView('player'); lab.renderer.render(lab.scene, lab.camera);
    return { calls, triangles, memory, texturedMeshes: textured.length, capeMaxError: maxError };
  });
  await page.screenshot({ path: 'output/playwright/graphics-day.png' });
  if (errors.length) throw Error(errors.join('\n'));
  page.off('console', onError);
  // The visual upgrade must remain optional if the image request fails.
  const atlasPattern = '**/src/assets/city-surfaces.webp';
  await page.route(atlasPattern, route => route.abort());
  try {
    await page.reload();
    await page.locator('.game-loading').waitFor({ state: 'detached' });
    results.fallback = await page.evaluate(() => {
      const root = document.getElementById('root');
      const fiber = root[Object.keys(root).find(k => k.startsWith('__reactContainer'))].stateNode.current;
      const find = f => !f ? null : f.type?.name === 'App' ? f : find(f.child) || find(f.sibling);
      let hook = find(fiber).memoizedState;
      while (hook && !hook.memoizedState?.current?.ragdoll) hook = hook.next;
      const lab = hook.memoizedState.current;
      lab.renderer.render(lab.scene, lab.camera);
      if (lab.city.textures.ready.value !== 0) throw Error('failed texture became ready');
      if (lab.renderer.info.programs.some(p => p.diagnostics?.runnable === false)) throw Error('fallback shader failed');
      return { gameLoads: true, flatColors: true };
    });
    await page.screenshot({ path: 'output/playwright/graphics-fallback.png' });
  } finally {
    await page.unroute(atlasPattern);
    await page.reload();
  }
  return results;
}
