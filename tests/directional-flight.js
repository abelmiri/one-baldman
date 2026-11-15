// Run with playwright-cli run-code --filename tests/directional-flight.js.
async page => {
  await page.reload();
  await page.locator('.game-loading').waitFor({state:'detached'});
  return page.evaluate(async () => {
    const T = await import('/node_modules/.vite/deps/three.js');
    const {default:R} = await import('/node_modules/@dimforge/rapier3d/rapier.js');
    const {Ragdoll} = await import('/src/Ragdoll.ts');
    const assert = (value, message) => { if (!value) throw Error(message); };
    const results = [];
    for (const pitch of [0, -.45, .45]) for (const boosted of [false,true]) for (let octant=0;octant<8;octant++) {
      const world = new R.World({x:0,y:-9.8,z:0});
      world.createCollider(R.ColliderDesc.cuboid(3000,.1,3000).setTranslation(0,-.06,0));
      const hero = new Ragdoll(world,new T.Scene(),0,true);
      const heading = 1.2;
      const facing = new T.Quaternion().setFromAxisAngle(T.Object3D.DEFAULT_UP,heading);
      const aimRotation = new T.Quaternion().setFromEuler(new T.Euler(pitch,heading,0,'YXZ'));
      const aim = new T.Vector3(0,0,1).applyQuaternion(aimRotation);
      const angle = octant*Math.PI/4;
      const travel = new T.Vector3(Math.sin(angle),0,Math.cos(angle)).applyQuaternion(facing);
      const label = `pitch=${pitch} boost=${boosted} direction=${octant}`;
      const step = (moving, ascend=false, turnBank=0) => {
        hero.setFlightAim(aim,Math.cos(angle));
        hero.setFlight(ascend,0,turnBank,.04);
        hero.setMovement(moving?travel.x:0,moving?travel.z:0,boosted,false);
        hero.step(1/60); world.step(); hero.checkForImpact(); hero.sync();
        assert(hero.flightState==='flying',label+': lost controlled flight');
        for (const pose of [hero.animation.left,hero.animation.right]) {
          assert(Object.values(pose).every(Number.isFinite),label+': non-finite pose');
          assert(pose.knee>=0&&pose.knee<=2.45,label+': invalid knee');
        }
      };
      try {
        for(let i=0;i<120;i++) step(false,true);
        for(let i=0;i<330;i++) step(true);
        assert(Math.abs(hero.speed-(boosted?110:11))<(boosted?1:.1),label+': wrong flight speed '+hero.speed);
        const actual = new T.Vector3().copy(hero.parts.get('pelvis').body.linvel()).normalize();
        assert(actual.dot(travel)>.999,label+': travel direction changed with facing');
        const look = new T.Vector3(0,0,1).applyQuaternion(hero.parts.get('head').mesh.quaternion);
        const alignment = look.dot(aim);
        assert(alignment>.99,label+': head lost camera aim '+alignment);
        if(!boosted) assert(Math.abs(hero.animation.pitch)<.35,label+': slow flight used sprint tilt');
        // Bank must be compensated by the head as well as forward body pitch.
        for(let i=0;i<90;i++) step(true,false,1);
        const bankLook = new T.Vector3(0,0,1).applyQuaternion(hero.parts.get('head').mesh.quaternion);
        assert(bankLook.dot(aim)>.99,label+': banking displaced head aim');
        const up = new T.Vector3(0,1,0).applyQuaternion(hero.parts.get('head').mesh.quaternion);
        const aimUp = new T.Vector3(0,1,0).applyQuaternion(aimRotation);
        assert(up.dot(aimUp)>.98,label+': head inherited body roll');
        travel.negate();
        for(let i=0;i<120;i++) {
          step(true);
          const changingLook = new T.Vector3(0,0,1).applyQuaternion(hero.parts.get('head').mesh.quaternion);
          assert(changingLook.dot(aim)>.995,label+': head drifted during direction reversal');
        }
        for(let i=0;i<180;i++) step(false);
        assert(hero.speed<.01,label+': flight did not stop');
        assert(Math.abs(hero.animation.pitch)<.1&&Math.abs(hero.animation.roll)<.02,label+': hover did not settle');
        results.push({octant,boosted,pitch,alignment});
      } finally {hero.dispose();world.free();}
    }
    return {passed:true,cases:results.length,minHeadAlignment:Math.min(...results.map(r=>r.alignment))};
  });
}
