// Run against the Vite dev server with playwright-cli run-code --filename tests/superman-flight.js.
async page => {
  await page.reload();
  await page.locator('.game-loading').waitFor({ state: 'detached' });
  return page.evaluate(async () => {
    const T = await import('/node_modules/.vite/deps/three.js');
    const { default: R } = await import('/node_modules/@dimforge/rapier3d/rapier.js');
    const { Ragdoll } = await import('/src/Ragdoll.ts');
    const { HeatVision } = await import('/src/HeatVision.ts');
    const assert = (condition, message) => { if (!condition) throw Error(message) };
    const world = new R.World({x:0,y:-9.8,z:0});
    world.createCollider(R.ColliderDesc.cuboid(2000,.1,2000).setTranslation(0,-.06,0));
    const scene = new T.Scene();
    const hero = new Ragdoll(world,scene,0,true);
    const direction = new T.Vector3(0,0,1);
    const movement = new T.Vector3();
    let ascend = false, descend = false, sprint = false, throttle = 0;
    const step = (frames=1) => {
      for(let i=0;i<frames;i++) {
        hero.setFlightAim(direction,throttle);
        hero.setFlight(ascend,0,0,.04,descend);
        hero.setMovement(movement.x,movement.z,sprint,false,movement.y);
        hero.step(1/60); world.step(); hero.checkForImpact(); hero.sync();
        assert([...hero.parts.values()].every(p=>Object.values(p.body.translation()).every(Number.isFinite)), 'non-finite joint');
      }
    };
    const pelvis = hero.parts.get('pelvis').body;
    const results = {};
    let vision;
    try {
      ascend=true; step(120); ascend=false; step(60);
      const height = pelvis.translation().y;
      step(600);
      assert(hero.flightState==='flying', 'releasing Space ended flight');
      assert(Math.abs(pelvis.translation().y-height)<.002, 'hover lost altitude');
      results.hover={height,afterTenSeconds:pelvis.translation().y};
      throttle=1; movement.copy(direction); step(240);
      const cruise=hero.speed;
      sprint=true;step();
      const firstBoostFrame=hero.speed;
      assert(firstBoostFrame<cruise*1.05, 'Shift caused an immediate speed jump');
      step(29);
      const earlyBoost=hero.speed;
      assert(earlyBoost>cruise && earlyBoost<cruise*2, 'boost did not ease in slowly');
      step(75);
      const midwayBoost=hero.speed;
      assert(midwayBoost>cruise*3 && midwayBoost<cruise*7, 'boost reached full speed before its 3.5 second ramp');
      step(105);
      const endOfRamp=hero.speed;
      assert(endOfRamp>cruise*9.8, 'boost did not reach near-full speed after 3.5 seconds');
      step(30);
      const boosted=hero.speed;
      assert(Math.abs(boosted/cruise-10)<.01, 'forward boost is not 10x');
      sprint=false;step(90);
      assert(Math.abs(hero.speed-cruise)<.1, 'released Shift did not return to cruise speed');
      sprint=true;step();
      assert(hero.speed<cruise*1.05, 'boost did not reset after releasing Shift');
      results.boost={cruise,firstBoostFrame,earlyBoost,midwayBoost,endOfRamp,boosted,ratio:boosted/cruise,easeSeconds:3.5};
      // A camera pitch must drive all three world-space movement components.
      sprint=false;direction.set(.6,.5,.6244998).normalize();movement.copy(direction);step(150);
      const climbVelocity=new T.Vector3().copy(pelvis.linvel()).normalize();
      assert(climbVelocity.dot(direction)>.999, 'flight did not follow upward mouse aim');
      direction.set(-.7,-.3,.648074).normalize();movement.copy(direction);step(150);
      const diveVelocity=new T.Vector3().copy(pelvis.linvel()).normalize();
      assert(diveVelocity.dot(direction)>.999, 'flight did not follow downward mouse aim');
      results.aim={up:climbVelocity.toArray(),down:diveVelocity.toArray()};
      // Letting go of W stops vertical movement immediately, including after a dive.
      throttle=0;movement.set(0,0,0);step(60);
      const stopped=pelvis.translation().y;step(300);
      assert(Math.abs(pelvis.translation().y-stopped)<.002, 'dive continued without W');
      descend=true;step(600);
      assert(hero.flightState==='grounded', 'C did not land the hero safely');
      assert(!hero.isReleased, 'controlled landing triggered ragdoll');
      results.landing=true;
      // A close wall clips both beams; firing repeatedly reuses the same meshes.
      vision=new HeatVision(scene);
      const head=hero.parts.get('head').mesh;
      head.position.set(0,2,0);head.quaternion.identity();head.updateMatrixWorld(true);
      const camera=new T.PerspectiveCamera();camera.position.set(0,2,-5);camera.lookAt(0,2,5);camera.updateMatrixWorld(true);
      world.createCollider(R.ColliderDesc.cuboid(2,3,.05).setTranslation(0,2,5));
      world.step();
      vision.update(1/60,true,head,camera,world);
      assert(vision.group.visible, 'F did not show heat vision');
      const beams=vision.group.children.filter(o=>o instanceof T.Group);
      assert(beams.length===2, 'heat vision must have one beam per eye');
      assert(beams.every(beam=>beam.scale.y>4 && beam.scale.y<5), 'laser tunneled through wall');
      const objects=vision.group.children.length;
      for(let i=0;i<120;i++) vision.update(1/60,true,head,camera,world);
      assert(vision.group.children.length===objects, 'laser allocates scene objects while held');
      vision.stop();assert(!vision.group.visible,'released F did not stop laser');
      results.laser={beams:2,lengths:beams.map(b=>b.scale.y),pooled:true};
      assert(hero.parts.size===21, 'main anatomical joints were lost');
      const names=new Set();for(const p of hero.parts.values())p.mesh.traverse(o=>names.add(o.name));
      for(const name of ['skyward-emblem','nose-bridge','cape-clasp','boot-gold-edge','finger-knuckle'])
        assert(names.has(name),'missing reference detail: '+name);
      results.model={parts:hero.parts.size,referenceDetails:true};
      // Exercise the real input routing as well as the isolated physics fixture.
      const root=document.getElementById('root');
      const fiber=root[Object.keys(root).find(k=>k.startsWith('__reactContainer'))].stateNode.current;
      const find=f=>!f?null:f.type?.name==='App'?f:find(f.child)||find(f.sibling);
      let hook=find(fiber).memoizedState;
      while(hook&&!hook.memoizedState?.current?.ragdoll)hook=hook.next;
      const lab=hook.memoizedState.current;
      const settings={...lab.settings};
      cancelAnimationFrame(lab.raf);
      const key=(code,down)=>window.dispatchEvent(new KeyboardEvent(down?'keydown':'keyup',{code,bubbles:true,cancelable:true}));
      try {
        lab.update({...settings,playing:true});lab.reset();
        key('Space',true);for(let i=0;i<180;i++)lab.step();key('Space',false);
        for(let i=0;i<60;i++)lab.step();
        const altitude=lab.ragdoll.altitude;
        for(let i=0;i<120;i++)lab.step();
        assert(Math.abs(lab.ragdoll.altitude-altitude)<.002,'keyboard Space did not latch hover');
        lab.ragdoll.controlFocus(lab.focus);
        lab.camera.position.copy(lab.focus).add(new T.Vector3(0,0,-8));
        lab.camera.lookAt(lab.focus.clone().add(new T.Vector3(3,4,8)));
        key('KeyW',true);key('ShiftRight',true);lab.step();
        const aimed=new T.Vector3();lab.camera.getWorldDirection(aimed);
        assert(lab.ragdoll.direction.dot(aimed)>.999,'W flattened camera pitch');
        assert(lab.ragdoll.running&&lab.ragdoll.direction.dot(aimed)>.999,'Shift+W did not route boost');
        key('KeyF',true);lab.step();
        lab.ragdoll.sync();
        lab.heatVision.update(1/60,lab.keys.has('KeyF'),lab.ragdoll.parts.get('head').mesh,lab.camera,lab.world);
        assert(lab.heatVision.group.visible,'keyboard F did not activate both eye beams');
        key('KeyF',false);
        lab.heatVision.update(1/60,lab.keys.has('KeyF'),lab.ragdoll.parts.get('head').mesh,lab.camera,lab.world);
        assert(!lab.heatVision.group.visible,'keyup F did not stop heat vision');
        lab.setTouchLaser(true);lab.setTouchDescending(true);
        key('KeyF',true);lab.update({...settings,playing:false});
        assert(lab.keys.size===0&&!lab.touchLaser&&!lab.touchDescending&&!lab.heatVision.group.visible,'pause left powers held');
        results.keyboard={hover:true,mousePitch:true,shiftW:true,firing:true,keyUp:true,pauseClearsPowers:true};
      } finally {
        lab.update(settings);lab.reset();lab.previousTime=0;lab.raf=requestAnimationFrame(lab.frame);
      }
      return {passed:true,...results};
    } finally {vision?.dispose();hero.dispose();world.free()}
  });
}
