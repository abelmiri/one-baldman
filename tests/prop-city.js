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
    const d = lab.city.destruction;
    const assert = (value, message) => { if (!value) throw Error(message) };
    const normal = new T.Vector3(0, 0, -1), direction = normal.clone().negate();
    const tree = d.objects.find(owner => owner.kind === 'tree');
    const treePoint = new T.Vector3().setFromMatrixPosition(tree.parts[2].matrix);
    d.ignite(tree.colliders[0], treePoint, direction, normal);
    assert(d.fire.fires.length > 0 && !tree.damaged, 'real city tree failed ignition');
    const lawn = lab.city.vegetationSurfaces[0];
    const grassPoint = new T.Box3().setFromObject(lawn).getCenter(new T.Vector3());
    grassPoint.y = .09;
    const ground = (() => { let ground; lab.world.colliders.forEach(collider => { if (!ground && !d.ownerOf(collider)) ground = collider }); return ground })();
    d.ignite(ground, grassPoint, direction, normal);
    assert(d.fire.fires.length === 2, 'actual lawn failed ignition');
    for (const car of [d.objects.find(owner => owner.kind === 'car' && !owner.transform), lab.city.traffic[0].owner]) {
      const part = car.parts[0];
      car.transform?.updateWorldMatrix(true, false);
      const point = new T.Vector3().setFromMatrixPosition(car.transform ? car.transform.matrixWorld.clone().multiply(part.matrix) : part.matrix);
      d.ignite(car.colliders[0], point, direction, normal);
      const chunks = d.chunks.filter(chunk => chunk.owner === car);
      assert(chunks.length === 10 && chunks.every(chunk => chunk.body && chunk.colliders.length), 'city car failed physical fragmentation');
      const instance = new T.Matrix4(); part.mesh.getMatrixAt(part.index, instance);
      assert(instance.elements[0] === 0, 'original city instance still visible');
    }
    assert(!lab.city.traffic[0].body, 'exploded traffic still driving');
    d.updateBurns(.35);
    lab.camera.position.copy(treePoint).add(new T.Vector3(16, 8, 16));
    lab.camera.lookAt(treePoint); lab.camera.updateMatrixWorld(true);
    lab.renderer.render(lab.scene, lab.camera);
    return { realCityCars: 'parked and moving: ten physical fragments each', grass: true, tree: true, vegetationRegions: d.vegetation.length };
  });
}
