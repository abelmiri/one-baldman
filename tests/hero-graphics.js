// Run against Vite: playwright-cli run-code --filename tests/hero-graphics.js
async page => {
  const failures = [];
  const watch = message => { if (/GL_INVALID|WebGL.*ERROR|shader error/i.test(message.text())) failures.push(message.text()) };
  page.on('console', watch);
  const inspect = async fallback => {
    await page.reload();
    await page.locator('.game-loading').waitFor({ state: 'detached' });
    await page.evaluate(() => {
      const root = document.getElementById('root');
      const fiber = root[Object.keys(root).find(k => k.startsWith('__reactContainer'))].stateNode.current;
      const find = f => !f ? null : f.type?.name === 'App' ? f : find(f.child) || find(f.sibling);
      let hook = find(fiber).memoizedState;
      while (hook && !hook.memoizedState?.current?.ragdoll) hook = hook.next;
      window.graphicsLab = hook.memoizedState.current;
      graphicsLab.update({ ...graphicsLab.settings, playing: false });
      cancelAnimationFrame(graphicsLab.raf);
    });
    if (!fallback) await page.waitForFunction(() => {
      const parts = graphicsLab.ragdoll.parts;
      const skin = parts.get('head').mesh.material, suit = parts.get('chest').mesh.material;
      return [skin.map, skin.bumpMap, suit.map, suit.normalMap, suit.roughnessMap]
        .every(t => t.image instanceof HTMLImageElement && t.image.complete);
    });
    return page.evaluate(fallback => {
      const lab = graphicsLab;
      const assert = (condition, message) => { if (!condition) throw Error(message) };
      const skin = lab.ragdoll.parts.get('head').mesh.material, suit = lab.ragdoll.parts.get('chest').mesh.material;
      const textures = [skin.map, skin.bumpMap, suit.map, suit.normalMap, suit.roughnessMap];
      assert(new Set(textures).size === 5, 'incorrect shared texture set');
      assert(textures.every(t => t.image.width === 512 && t.image.height === 512), 'incorrect texture resolution');
      assert(skin.map.colorSpace === 'srgb' && suit.map.colorSpace === 'srgb', 'color map is not sRGB');
      assert([skin.bumpMap, suit.normalMap, suit.roughnessMap].every(t => t.colorSpace === ''), 'data maps are gamma encoded');
      assert(lab.ragdoll.parts.get('leftHand').mesh.material === skin, 'hands do not share skin material');
      assert(lab.ragdoll.parts.get('leftUpperArm').mesh.material === suit, 'limbs do not share suit material');
      if (fallback) assert(textures.every(t => t.image instanceof HTMLCanvasElement), 'failed load lost neutral fallback');
      lab.renderer.render(lab.scene,lab.camera);
      const before = {...lab.renderer.info.memory};
      for(let i=0;i<4;i++) {lab.reset();lab.renderer.render(lab.scene,lab.camera)}
      const after = {...lab.renderer.info.memory};
      assert(after.textures === before.textures && after.geometries === before.geometries, 'reset leaked GPU resources');
      assert(lab.ragdoll.parts.get('head').mesh.material.map === skin.map, 'reset reallocated shared maps');
      assert(lab.renderer.info.programs.every(p => p.diagnostics?.runnable !== false), 'invalid material shader');
      return { fallback, maps: textures.length, before, after };
    }, fallback);
  };
  try {
    const loaded = await inspect(false);
    // Vite appends cache-busting queries to edited assets. Abort image fetches
    // while allowing the ?import JavaScript modules to load normally.
    const pattern = url => url.pathname.startsWith('/src/assets/hero-') && !url.searchParams.has('import');
    await page.route(pattern, route => route.abort());
    let fallback;
    try { fallback = await inspect(true) } finally { await page.unroute(pattern); await page.reload() }
    if (failures.length) throw Error(failures.join('\n'));
    return { passed: true, loaded, fallback };
  } finally { page.off('console', watch) }
}
