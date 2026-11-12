async page => {
  const baseURL = new URL(page.url()).origin;
  await page.bringToFront();
  await page.goto(baseURL);
  await page.locator('.scene-canvas').waitFor();
  return page.evaluate(async () => {
    const T = await import('/node_modules/.vite/deps/three.js');
    const { default: R } = await import('/node_modules/@dimforge/rapier3d/rapier.js');
    const root = document.getElementById('root');
    const fiber = root[Object.keys(root).find(k => k.startsWith('__reactContainer'))].stateNode.current;
    const find = f => !f ? null : f.type?.name === 'App' ? f : find(f.child) || find(f.sibling);
    let hook = find(fiber).memoizedState;
    while (hook && !hook.memoizedState?.current?.ragdoll) hook = hook.next;
    const lab = hook.memoizedState.current;
    const assert = (condition, message) => { if (!condition) throw Error(message) };
    cancelAnimationFrame(lab.raf);
    const results = {};
    const city = lab.city;
    const original = (position, direction) => {
      const local = new T.Vector3(), step = direction.clone().multiplyScalar(.7);
      for (const o of city.obstacles) {
        if (o.center.y + o.half.y < position.y - 1.25 || o.center.y - o.half.y > position.y + 1.1) continue;
        local.copy(position).add(step).sub(o.center).applyQuaternion(o.inverse);
        if (Math.abs(local.x) < o.half.x + .5 && Math.abs(local.z) < o.half.z + .5) {
          const localStep = step.clone().applyQuaternion(o.inverse);
          const dx = o.half.x + .5 - Math.abs(local.x), dz = o.half.z + .5 - Math.abs(local.z);
          if (dx < dz) { if (localStep.x * (local.x - localStep.x) < 0) localStep.x = 0 }
          else if (localStep.z * (local.z - localStep.z) < 0) localStep.z = 0;
          direction.copy(localStep.applyQuaternion(o.rotation)).divideScalar(.7);
          step.copy(direction).multiplyScalar(.7);
        }
      }
      return direction;
    };
    let seed = 7123;
    const random = () => ((seed = (Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
    let candidateCount = 0;
    for (let i = 0; i < 5000; i++) {
      const o = city.obstacles[i % city.obstacles.length];
      const p = new T.Vector3((random()*2-1)*(o.half.x+1.5), 0, (random()*2-1)*(o.half.z+1.5)).applyQuaternion(o.rotation).add(o.center);
      p.y = i%3 ? 1.25 : o.center.y + o.half.y + .9;
      const direction = new T.Vector3(random()*2-1, 0, random()*2-1).normalize();
      const expected = original(p, direction.clone()), actual = direction.clone();
      city.constrainMovement(p, actual);
      assert(actual.distanceTo(expected)<1e-8, 'spatial collision mismatch at '+JSON.stringify(p));
      let expectedHeight = .04;
      const supportRay = new R.Ray(p, { x: 0, y: -1, z: 0 });
      // Roofs use their actual collision shape (including slopes), rather than
      // the former padded bounding box. Compare against every obstacle so this
      // remains an independent check of the spatial candidate index.
      for (const o of city.obstacles) {
        if (!o.landing) continue;
        const hit = o.shape.castRayAndGetNormal(supportRay, o.center, o.rotation, p.y - expectedHeight, false);
        if (hit && hit.normal.y > .65) expectedHeight = Math.max(expectedHeight, p.y - hit.timeOfImpact);
      }
      assert(Math.abs(city.groundHeightAt(p)-expectedHeight)<1e-8,'roof height mismatch');
      candidateCount += city.nearby(p,1.5).length;
    }
    results.spatial = {cases:5000, obstacles:city.obstacles.length, averageCandidates:candidateCount/5000};
    const simulate = renderPasses => {
      lab.reset();
      for (let i=0;i<120;i++) {
        lab.step();
        for(let j=0;j<renderPasses;j++) city.update(lab.elapsed-(j+1)/(60*(renderPasses+1)));
      }
      return city.traffic.map(car=>({...car.body.translation()}));
    };
    const a = simulate(1), b = simulate(4);
    assert(a.every((p,i)=>Math.hypot(p.x-b[i].x,p.y-b[i].y,p.z-b[i].z)<1e-6),'traffic depends on render frequency');
    assert(city.traffic.every(car=>Object.values(car.body.linvel()).every(Number.isFinite)),'invalid traffic velocity');
    results.traffic = {renderRatesIndependent:true};
    lab.reset();
    const phases = [['idle',180],['walk',90],['run',90],['takeoff',120],['flight',180],['landing',420],['release',120],['recover',240]];
    results.physics = [];
    for (const [phase,frames] of phases) {
      lab.clearMovement();
      if (phase==='walk' || phase==='run') lab.touchDirections.add('right');
      lab.touchRunning = phase==='run';
      if (phase==='takeoff' || phase==='flight') lab.touchFlight=true;
      // Landing is explicit; releasing Space must keep the hero hovering.
      lab.touchDescending = phase === 'landing';
      if (phase==='release' || phase==='recover') lab.toggleRelease();
      for(let i=0;i<frames;i++) {
        lab.step();
        if(i%30===0) {
          assert(lab.clothPositions.every(Number.isFinite),'non-finite cape in '+phase);
          for(const part of lab.ragdoll.parts.values()) assert(Object.values(part.body.translation()).every(Number.isFinite),'invalid body in '+phase);
          if(['idle','walk','run'].includes(phase)) assert([...lab.ragdoll.parts.values()].every(p=>p.body.isKinematic()),'controlled body is dynamic');
        }
      }
      const pelvis = lab.ragdoll.parts.get('pelvis').body;
      if(['idle','walk','run'].includes(phase)) assert(pelvis.translation().y>.8,'body collapsed in '+phase);
      if(phase==='takeoff') assert(lab.ragdoll.flightState==='flying' && pelvis.translation().y>4,'takeoff failed');
      if(phase==='landing' || phase==='recover') assert(lab.ragdoll.flightState==='grounded','did not return to ground in '+phase);
      if(phase==='release') assert(lab.ragdoll.flightState==='released','release failed');
      results.physics.push({phase,state:lab.ragdoll.flightState,pelvis:{...pelvis.translation()}});
    }
    lab.reset();lab.ragdoll.sync();lab.updateMesh();city.update(0);lab.renderer.render(lab.scene,lab.camera);
    const memoryStart = {...lab.renderer.info.memory};
    for(let i=0;i<5;i++) {lab.reset();lab.renderer.render(lab.scene,lab.camera)}
    assert(lab.renderer.info.memory.geometries===memoryStart.geometries,'geometry leak across reset');
    assert(lab.renderer.info.memory.textures===memoryStart.textures,'texture leak across reset');
    results.resetMemory = {...lab.renderer.info.memory};
    // Resume the real frame loop, pause it, then verify no simulation or GPU work continues.
    lab.update({...lab.settings,playing:false});lab.previousTime=0;lab.raf=requestAnimationFrame(lab.frame);
    const frames = async n => {for(let i=0;i<n;i++)await new Promise(requestAnimationFrame)};
    await frames(3);
    const elapsed=lab.elapsed, renderFrame=lab.renderer.info.render.frame;
    const cloth=Array.from(lab.clothMesh.geometry.getAttribute('position').array);
    const car=city.traffic[0].mesh.position.clone();
    await frames(12);
    assert(elapsed===lab.elapsed,'physics advanced while paused');
    assert(renderFrame===lab.renderer.info.render.frame,'paused game still renders');
    assert(cloth.every((v,i)=>v===lab.clothMesh.geometry.getAttribute('position').array[i]),'cape changed on pause');
    assert(car.distanceTo(city.traffic[0].mesh.position)===0,'car moved on pause');
    lab.setNight(true);await frames(3);
    assert(lab.renderer.info.render.frame===renderFrame+1,'night change should render once while paused');
    results.pause = {physicsFrozen:true,renderFrozen:true,nightRendersOnce:true};
    const hiddenDescriptor = Object.getOwnPropertyDescriptor(document,'hidden');
    Object.defineProperty(document,'hidden',{configurable:true,value:true});
    document.dispatchEvent(new Event('visibilitychange'));
    assert(lab.raf===0,'hidden page kept its animation loop');
    if(hiddenDescriptor) Object.defineProperty(document,'hidden',hiddenDescriptor);
    else delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
    assert(lab.raf!==0,'visible page did not restart its loop');
    results.visibility = {loopStops:true,loopRestarts:true};
    // Automatic resolution changes must not reset the map's chosen camera angle.
    lab.setCameraView('city');
    lab.camera.position.multiplyScalar(.9);
    const beforeCamera=lab.camera.position.clone();
    lab.qualityTime=2;lab.frameAverage=.03;lab.adaptResolution(.03,.03);
    assert(lab.camera.position.distanceTo(beforeCamera)===0,'resolution change reset map camera');
    assert(lab.renderScale<1,'slow frames did not lower resolution');
    lab.frameAverage=1/60;lab.qualityTime=2;lab.adaptResolution(1/60,1/60);
    assert(lab.renderScale>.9,'resolution failed to recover');
    lab.renderScale=1;lab.resize();lab.setCameraView('player');
    results.resolution = {adapts:true,recovers:true,preservesCamera:true};
    lab.setNight(false);lab.update({...lab.settings,playing:true});
    lab.reset();lab.accumulator=0;lab.previousTime=1000;cancelAnimationFrame(lab.raf);lab.frame(2000);cancelAnimationFrame(lab.raf);
    assert(lab.elapsed<=2/60+1e-8,'physics catchup exceeded budget');
    results.catchup = {steps:Math.round(lab.elapsed*60)};
    lab.reset();lab.previousTime=0;lab.raf=requestAnimationFrame(lab.frame);
    return {passed:true,...results};
  });
}
