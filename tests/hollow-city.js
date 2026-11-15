// Run with the app open: playwright-cli run-code --filename tests/hollow-city.js
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
    const assert = (value, message) => { if (!value) throw Error(message) };
    try {
      lab.reset(); lab.world.step();
      const owner = lab.city.destruction.objects.find(owner => owner.kind === 'building');
      const physical = point => owner.colliders.some(collider => collider.containsPoint(point));
      const visible = point => owner.parts.some(part => {
        if (!part.geometry.boundingBox) part.geometry.computeBoundingBox();
        return part.geometry.boundingBox.containsPoint(point.clone().applyMatrix4(part.matrix.clone().invert()));
      });
      for (const x of [-69, -63]) {
        const room = new T.Vector3(x, 1.7, -63);
        assert(!physical(room) && !visible(room), 'actual city room is filled with material');
      }
      const ground = new T.Vector3(-69, .08, -63);
      assert(!physical(ground) && !visible(ground), 'building still has a separate ground slab or solid foundation');
      const { default: R } = await import('/node_modules/@dimforge/rapier3d/rapier.js');
      const hit = lab.world.castRay(new R.Ray({ x: ground.x, y: .8, z: ground.z }, { x: 0, y: -1, z: 0 }), 1, true);
      assert(hit && !lab.city.destruction.ownerOf(hit.collider), 'room is not supported by the shared game ground');
      assert(Math.abs(.8 - hit.timeOfImpact - .04) < .01, 'room floor is raised above the game ground');
      const divider = new T.Vector3(-66, 1.7, -63), doorway = new T.Vector3(-66, 1.7, -65);
      assert(physical(divider) && visible(divider), 'room partition missing from rendering or physics');
      assert(!physical(doorway) && !visible(doorway), 'internal doorway is blocked');
      assert(physical(new T.Vector3(-73.4, 1.7, -65)), 'outside wall is missing');
      return { passed: true, actualCityRoomsEmpty: true, sharedGameGround: true, partitions: true, doorway: true, physicsMatchesVisibleShell: true };
    } finally { lab.reset(); lab.previousTime = 0; lab.raf = requestAnimationFrame(lab.frame) }
  });
}
