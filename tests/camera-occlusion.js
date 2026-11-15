// Run in the app: playwright-cli run-code --filename tests/camera-occlusion.js
async page => {
  await page.reload();
  await page.locator('.game-loading').waitFor({ state: 'detached' });
  return page.evaluate(async () => {
    const T = await import('/node_modules/.vite/deps/three.js');
    const { CameraOcclusion } = await import('/src/CameraOcclusion.ts');
    const { CITY_SCALE } = await import('/src/City.ts');
    const assert = (value, message) => { if (!value) throw Error(message) };
    const root = document.getElementById('root');
    const fiber = root[Object.keys(root).find(k => k.startsWith('__reactContainer'))].stateNode.current;
    const find = f => !f ? null : f.type?.name === 'App' ? f : find(f.child) || find(f.sibling);
    let hook = find(fiber).memoizedState;
    while (hook && !hook.memoizedState?.current?.ragdoll) hook = hook.next;
    const lab = hook.memoizedState.current;
    cancelAnimationFrame(lab.raf);
    const occlusion = new CameraOcclusion(), scene = new T.Scene();
    const geometry = new T.BoxGeometry(1, 1, 1), base = new T.MeshBasicMaterial({ color: 'white' });
    const characterMaterial = new T.MeshBasicMaterial({ color: '#ff00ff' });
    const hero = new T.Mesh(geometry, characterMaterial);
    hero.position.set(0, 1.2, 0); hero.scale.set(.8, 1.8, .6); scene.add(hero);
    const camera = new T.PerspectiveCamera(50, 1, .05, 50);
    camera.position.set(0, 1.2, 8); camera.lookAt(hero.position);
    const renderTarget = new T.WebGLRenderTarget(128, 128), pixels = new Uint8Array(128 * 128 * 4);
    const walls = [];
    const addWall = (x, z) => {
      const g = geometry.clone(), opacity = new T.InstancedBufferAttribute(new Float32Array([1]), 1);
      g.setAttribute('cameraOpacity', opacity);
      const mesh = new T.InstancedMesh(g, occlusion.material(base), 1);
      const matrix = new T.Matrix4().compose(new T.Vector3(x, 1.2, z), new T.Quaternion(), new T.Vector3(6, 4, .3));
      mesh.setMatrixAt(0, matrix); scene.add(mesh);
      const owner = { kind: 'building', parts: [], colliders: [], damaged: false };
      const part = { geometry: g, matrix, color: new T.Color('white'), mesh, index: 0 };
      owner.parts.push(part); occlusion.register(owner, part, opacity, 0);
      const wall = { owner, part, mesh, opacity }; walls.push(wall); return wall;
    };
    const wall = addWall(0, 3), rear = addWall(0, -3), side = addWall(8, 3);
    const update = (point = hero.position, enabled = true, fragments = []) => {
      for (let i = 0; i < 60; i++) occlusion.update(camera, point, 1 / 60, fragments, enabled);
    };
    const visibleHeroPixels = () => {
      scene.updateMatrixWorld(true);
      lab.renderer.setRenderTarget(renderTarget); lab.renderer.render(scene, camera);
      lab.renderer.readRenderTargetPixels(renderTarget, 0, 0, 128, 128, pixels);
      lab.renderer.setRenderTarget(null);
      let count = 0;
      for (let y = 48; y < 80; y++) for (let x = 56; x < 72; x++) {
        const index = (y * 128 + x) * 4;
        if (pixels[index] > 150 && pixels[index + 1] < 80 && pixels[index + 2] > 150) count++;
      }
      return count;
    };
    try {
      assert(visibleHeroPixels() === 0, 'test wall does not hide the hero');
      update();
      const visible = visibleHeroPixels();
      assert(wall.opacity.getX(0) < .1 && visible > 380, `wall did not reveal hero in rendered pixels: ${visible}`);
      assert(rear.opacity.getX(0) === 1 && side.opacity.getX(0) === 1, 'wall outside the camera/hero segment was faded');
      const second = addWall(0, 5); update();
      assert(second.opacity.getX(0) < .1 && visibleHeroPixels() > 380, 'layered walls hide hero');
      update(hero.position, false);
      assert(wall.opacity.getX(0) === 1 && second.opacity.getX(0) === 1, 'overview did not restore opacity');
      // A camera embedded in a wall must see through the exit face too.
      camera.position.z = 3; camera.lookAt(hero.position); update();
      assert(wall.opacity.getX(0) < .1 && second.opacity.getX(0) === 1, 'camera inside wall was not handled');
      camera.position.z = 8; camera.lookAt(hero.position);
      update(new T.Vector3(12, 1.2, 0));
      assert(wall.opacity.getX(0) === 1, 'old obstruction did not restore after camera/hero path moved');
      // The center ray can miss a narrow overhead obstruction; the head ray catches it.
      const head = addWall(0, 4);
      head.part.matrix.compose(new T.Vector3(0, 1.52, 4), new T.Quaternion(), new T.Vector3(2, .25, .2));
      // Registration uses immutable city transforms, so register a fresh controller for this layout.
      const headOcclusion = new CameraOcclusion();
      headOcclusion.register(head.owner, head.part, head.opacity, 0);
      for (let i = 0; i < 60; i++) headOcclusion.update(camera, hero.position, 1 / 60, [], true);
      assert(head.opacity.getX(0) < .1, 'head-only obstruction was missed');
      headOcclusion.dispose(); head.mesh.visible = false;
      // Visible replacement meshes use their actual triangles; destroyed original walls stay ignored.
      wall.owner.damaged = true; second.owner.damaged = true;
      wall.mesh.visible = false; second.mesh.visible = false;
      const fragment = new T.Mesh(new T.BoxGeometry(4, 4, .2), base);
      fragment.position.set(0, 1.2, 4); scene.add(fragment);
      update(hero.position, true, [fragment]);
      assert(fragment.material !== base && wall.opacity.getX(0) === 1, 'replacement mesh/original wall handoff failed');
      assert(visibleHeroPixels() > 380, 'replacement mesh shader hides hero');
      fragment.position.x = 10; update(hero.position, true, [fragment]);
      assert(fragment.material === base, 'moving fragment retained its fade material');
      fragment.position.x = 0; update(hero.position, true, [fragment]);
      fragment.removeFromParent(); update();
      assert(fragment.material === base && occlusion.fragments.size === 0, 'removed fragment leaked its fade material');
      fragment.geometry.dispose();
      occlusion.reset();
      assert([...walls].every(w => w.opacity.getX(0) === 1), 'reset left a faded wall');
      // Integration: an outside hero behind a different building still reveals correctly.
      lab.reset();
      const point = new T.Vector3(-66, 1.7, -55).multiplyScalar(CITY_SCALE);
      lab.camera.position.set(-66, 1.7, -80).multiplyScalar(CITY_SCALE); lab.camera.lookAt(point);
      assert(!lab.city.buildingAt(point), 'integration hero must be outside the building');
      for (let i = 0; i < 60; i++) lab.city.updateOcclusion(lab.camera, point, 1 / 60);
      assert(lab.city.occlusion.faded.size > 0, 'city still requires the hero inside the occluding building');
      const cityBuilding = lab.city.destruction.objects.find(owner => owner.kind === 'building');
      const registered = lab.city.occlusion.buildings.get(cityBuilding).walls;
      assert(registered.length < cityBuilding.parts.length, 'non-wall building pieces were registered for fading');
      assert(lab.city.occlusion.faded.size < registered.length, 'every wall of the building faded');
      const otherParts = cityBuilding.parts.filter(part => part.mesh && !registered.some(wall => wall.part === part));
      assert(otherParts.length > 0 && otherParts.every(part => {
        const opacity = part.mesh.geometry.getAttribute('cameraOpacity');
        return !opacity || opacity.getX(part.index) === 1;
      }), 'roof and other building details became transparent');
      let overlays = 0; lab.city.root.traverse(object => { if (object.name.startsWith('Faded building')) overlays++ });
      assert(overlays === 0, 'duplicate wall overlays remain');
      const records = [...lab.city.occlusion.faded];
      lab.reset();
      assert(records.every(record => record.attribute.getX(record.index) === 1), 'city reset did not restore fades');
      return { passed: true, visibleHeroPixels: visible, testedPixels: 512, outsideBuildings: true, layeredWalls: true,
        segmentLimits: true, cameraInsideWall: true, bodyCoverage: true, destructionFragments: true,
        movingFragments: true, restoresAndResets: true, noDuplicateWallDraws: true };
    } finally {
      lab.renderer.setRenderTarget(null); renderTarget.dispose(); occlusion.dispose();
      walls.forEach(w => { w.mesh.dispose(); w.mesh.geometry.dispose() });
      geometry.dispose(); base.dispose(); characterMaterial.dispose();
      lab.reset(); lab.previousTime = 0; lab.raf = requestAnimationFrame(lab.frame);
    }
  });
}
