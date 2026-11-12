// Run in the app: playwright-cli run-code --filename tests/impacts-and-cape.js
async page => {
  await page.reload();
  await page.locator('.game-loading').waitFor({state:'detached'});
  return page.evaluate(async()=>{
    const T=await import('/node_modules/.vite/deps/three.js');
    const {default:R}=await import('/node_modules/@dimforge/rapier3d/rapier.js');
    const {Ragdoll}=await import('/src/Ragdoll.ts');
    const {ImpactDust}=await import('/src/ImpactDust.ts');
    const assert=(condition,message)=>{if(!condition)throw Error(message)};
    const fixture=()=>{
      const world=new R.World({x:0,y:-9.8,z:0});
      world.createCollider(R.ColliderDesc.cuboid(500,.1,500).setTranslation(0,-.06,0));
      const impacts=[];
      const scene=new T.Scene();
      const dust=new ImpactDust(scene);
      const hero=new Ragdoll(world,scene,0,true,(p,n,s)=>{
        impacts.push({point:{...p},normal:{...n},speed:s});dust.burst(p,n,s);
      });
      const step=(ascend=false,move=0,descend=false)=>{
        hero.setFlight(ascend,0,0,.04,descend);hero.setMovement(0,move,true,false);
        hero.step(1/60);world.step();hero.checkForImpact();dust.step(1/60);
      };
      return {world,hero,dust,impacts,step,dispose:()=>{hero.dispose();dust.dispose();world.free()}};
    };
    const results={};
    const landing=fixture();
    try {
      for(let i=0;i<120;i++)landing.step(true);
      for(let i=0;i<180;i++)landing.step(false,0,true);
      assert(landing.hero.flightState==='grounded','controlled landing failed');
      assert(landing.impacts.some(e=>Math.abs(e.point.y-.04)<.1&&e.normal.y>.8&&e.speed>2),'landing did not emit ground dust');
      results.landing=landing.impacts.length;
    } finally{landing.dispose()}
    const wall=fixture();
    try {
      wall.world.createCollider(R.ColliderDesc.cuboid(3,5,.025).setTranslation(0,5,3));
      for(let i=0;i<120&&!wall.hero.isReleased;i++)wall.step(false,1);
      assert(wall.hero.isReleased,'wall did not trigger a crash');
      assert(wall.impacts.some(e=>Math.abs(e.point.z-2.975)<.15&&Math.abs(e.normal.z)>.8),'wall collision did not emit dust on the wall');
      results.wall=wall.impacts.length;
    } finally{wall.dispose()}
    const fall=fixture();
    try {
      for(let i=0;i<120;i++)fall.step(true);
      fall.hero.release();
      for(let i=0;i<480;i++)fall.step();
      assert(fall.impacts.some(e=>e.point.y<.2&&e.speed>3),'dynamic ragdoll did not emit dust on ground impact');
      const settled=fall.impacts.length;
      for(let i=0;i<120;i++)fall.step();
      assert(fall.impacts.length===settled,'resting contact repeatedly emitted dust');
      results.fall={bursts:settled,restingQuiet:true};
    } finally{fall.dispose()}
    const root=document.getElementById('root');
    const fiber=root[Object.keys(root).find(k=>k.startsWith('__reactContainer'))].stateNode.current;
    const find=f=>!f?null:f.type?.name==='App'?f:find(f.child)||find(f.sibling);
    let hook=find(fiber).memoizedState;
    while(hook&&!hook.memoizedState?.current?.ragdoll)hook=hook.next;
    const lab=hook.memoizedState.current;
    cancelAnimationFrame(lab.raf);
    const settings={...lab.settings};
    try {
      lab.reset();
      const count = Math.sqrt(lab.cloth.numParticles());
      const rest=Array.from({length:count},(_,column)=>{
        let length=0;const a=new T.Vector3(),b=new T.Vector3();
        for(let row=1;row<count;row++)length+=a.fromArray(lab.clothPositions,(column*count+row)*3).distanceTo(b.fromArray(lab.clothPositions,(column*count+row-1)*3));
        return length;
      });
      // The city has tall invisible boundary walls; fly above them for this test.
      lab.touchFlight=true;for(let i=0;i<900;i++)lab.step();lab.touchFlight=false;
      const aim=(x,y,z)=>{lab.ragdoll.controlFocus(lab.focus);lab.controls.target.copy(lab.focus);lab.camera.position.copy(lab.focus).add(new T.Vector3(x,y,z));lab.controls.update()};
      aim(0,0,-8);lab.keys.add('KeyW');lab.keys.add('ShiftLeft');
      let maximumLengthRatio=0,maximumSpeed=0;
      const a=new T.Vector3(),b=new T.Vector3();
      for(let i=0;i<660;i++){
        if(i===300)aim(-8,0,0);
        if(i===420)lab.keys.delete('ShiftLeft');
        if(i===480)aim(-8,-4,0);
        if(i===540)lab.keys.delete('KeyW');
        lab.step();
        assert(lab.clothPositions.every(Number.isFinite),'non-finite high-speed cape');
        assert(!lab.ragdoll.isReleased,'high-speed test crashed at frame '+i+' at '+JSON.stringify(lab.ragdoll.parts.get('pelvis').body.translation()));
        maximumSpeed=Math.max(maximumSpeed,lab.ragdoll.speed);
        for(let column=0;column<count;column++){
          let length=0;
          for(let row=1;row<count;row++)length+=a.fromArray(lab.clothPositions,(column*count+row)*3).distanceTo(b.fromArray(lab.clothPositions,(column*count+row-1)*3));
          maximumLengthRatio=Math.max(maximumLengthRatio,length/rest[column]);
        }
      }
      assert(maximumSpeed>105,'test did not exercise full flight boost');
      assert(maximumLengthRatio<1.04,'cape stretched at speed: '+maximumLengthRatio);
      assert(lab.cloth.numAttachments()===count,'collar detached at speed');
      lab.ragdoll.sync();lab.updateMesh();
      assert(lab.capeSurface.geometry.getAttribute('position').array.every(Number.isFinite),'non-finite rendered cape');
      results.cape={maximumSpeed,maximumLengthRatio,turnsAndBraking:true,collarAttached:true};
      lab.reset();
      lab.impactDust.burst(new T.Vector3(0,.04,0),T.Object3D.DEFAULT_UP,14);
      lab.impactDust.step(.15);lab.impactDust.render(lab.camera);
      assert(lab.impactDust.mesh.visible,'dust burst invisible');
      const geometries=lab.renderer.info.memory.geometries;
      for(let i=0;i<200;i++)lab.impactDust.burst(new T.Vector3(0,.04,0),T.Object3D.DEFAULT_UP,30);
      lab.impactDust.render(lab.camera);
      assert(lab.impactDust.mesh.count===240,'dust pool grew without bound');
      lab.renderer.render(lab.scene,lab.camera);
      for(let i=0;i<120;i++)lab.impactDust.step(1/60);
      lab.impactDust.render(lab.camera);
      assert(!lab.impactDust.mesh.visible,'dust did not fade out');
      lab.reset();assert(!lab.impactDust.mesh.visible,'reset left old dust');
      results.dust={pooled:true,expires:true,resets:true,previousGeometryCount:geometries};
      return {passed:true,...results};
    } finally {lab.settings=settings;lab.reset();lab.previousTime=0;lab.raf=requestAnimationFrame(lab.frame)}
  });
}
