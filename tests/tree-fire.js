// Run with the game open: playwright-cli run-code --filename tests/tree-fire.js
async page => {
  await page.reload();
  await page.locator('.game-loading').waitFor({ state: 'detached' });
  return page.evaluate(async () => {
    const T = await import('/node_modules/.vite/deps/three.js');
    const assert = (value, message) => { if (!value) throw Error(message) };
    const root = document.getElementById('root');
    const fiber = root[Object.keys(root).find(key => key.startsWith('__reactContainer'))].stateNode.current;
    const find = f => !f ? null : f.type?.name === 'App' ? f : find(f.child) || find(f.sibling);
    let hook = find(fiber).memoizedState;
    while (hook && !hook.memoizedState?.current?.ragdoll) hook = hook.next;
    const lab = hook.memoizedState.current;
    cancelAnimationFrame(lab.raf);
    const d = lab.city.destruction;
    const tree = d.objects.find(owner => owner.kind === 'tree');
    const neighbor = d.objects.find(owner => owner.kind === 'tree' && owner !== tree);
    const originals = tree.parts.map(part => part.color.clone());
    const neighborColor = neighbor.parts[1].color.clone();
    const bounds = new T.Box3();
    for (const part of tree.parts) {
      part.geometry.computeBoundingBox();
      bounds.union(part.geometry.boundingBox.clone().applyMatrix4(part.matrix));
    }
    const point = bounds.getCenter(new T.Vector3());
    const direction = new T.Vector3(0, 0, 1), normal = direction.clone().negate();
    const ignite = () => d.ignite(tree.colliders[0], point, direction, normal);
    ignite();
    for (let i = 0; i < 20; i++) ignite();
    assert(d.fire.fires.length === 1, 'tree spawned duplicate fire emitters');
    assert(d.fire.mesh.scale.equals(new T.Vector3(1, 1, 1)), 'fire was scaled twice with city geometry');
    assert(d.burnMarks.scale.equals(new T.Vector3(1, 1, 1)), 'laser burn marks were scaled twice');
    const instanceColor = new T.Color();
    for (const [i, part] of tree.parts.entries()) {
      part.mesh.getColorAt(part.index, instanceColor);
      assert(instanceColor.r < originals[i].r && instanceColor.g < originals[i].g, 'tree instance did not become charred');
      assert(Math.abs(instanceColor.r - part.color.r) < 1e-6, 'instance and future debris colors differ');
    }
    assert(neighbor.parts[1].color.equals(neighborColor), 'fire recolored an adjacent tree');
    for (const age of [.1, .8, 2, 5]) {
      d.updateBurns(age);
      lab.scene.updateMatrixWorld(true);
      const matrix = new T.Matrix4();
      for (let i = 0; i < d.fire.mesh.count; i++) {
        d.fire.mesh.getMatrixAt(i, matrix);
        matrix.premultiply(d.fire.mesh.matrixWorld);
        const center = new T.Vector3().setFromMatrixPosition(matrix);
        assert(bounds.distanceToPoint(center) < 4.7, 'fire particles detached from the real tree');
      }
    }
    d.updateBurns(20);
    assert(d.fire.mesh.count === 0 && tree.parts[1].color.g < originals[1].g * .2, 'charred color disappeared with fire');
    lab.reset();
    assert(tree.parts.every((part, i) => part.color.equals(originals[i])), 'reset did not restore source colors');
    for (const [i, part] of tree.parts.entries()) {
      part.mesh.getColorAt(part.index, instanceColor);
      assert(Math.abs(instanceColor.g - originals[i].g) < 1e-6, 'reset did not restore instance colors');
    }
    ignite(); d.updateBurns(.3);
    lab.camera.position.copy(point).add(new T.Vector3(18, 7, 22));
    lab.camera.lookAt(point); lab.camera.updateMatrixWorld(true);
    lab.renderer.render(lab.scene, lab.camera);
    return { worldScale: true, flamesOnTree: true, charredInstances: true, permanentScorch: true, reset: true };
  });
}
