// Run with the app open: playwright-cli run-code --filename tests/cape-forward-limit.js
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
    const settings = { ...lab.settings };
    const assert = (condition, message) => { if (!condition) throw Error(message) };
    const count = Math.sqrt(lab.cloth.numParticles()), dt = 1 / 60;
    const point = new T.Vector3(), parent = new T.Vector3(), forward = new T.Vector3();
    const up = new T.Vector3(), velocity = new T.Vector3(), boundaryVelocity = new T.Vector3();
    const rotation = new T.Quaternion();
    let maximumForwardExcess = -Infinity, maximumLengthRatio = 0, maximumSpeed = 0;
    const phases = [];
    cancelAnimationFrame(lab.raf);
    try {
      lab.settings = { ...settings, mode: 'cape', standing: true, wind: 100, windDirection: 90 };
      lab.reset();
      const rest = new Float32Array(count * count);
      for (let column = 0; column < count; column++) {
        for (let row = 1; row < count; row++) {
          const i = column * count + row;
          rest[i] = point.fromArray(lab.clothPositions, i * 3)
            .distanceTo(parent.fromArray(lab.clothPositions, (i - 1) * 3));
        }
      }
      const check = label => {
        const positions = lab.cloth.particlePositions();
        const carrier = lab.ragdoll.capeBodies.get('chest');
        const origin = carrier.translation();
        forward.set(0, 0, 1).applyQuaternion(rotation.copy(carrier.rotation()));
        let limit = -Infinity;
        for (let column = 0; column < count; column++) {
          limit = Math.max(limit, point.fromArray(positions, column * count * 3).sub(origin).dot(forward));
        }
        limit += .025;
        assert(positions.every(Number.isFinite), label + ': non-finite cape');
        for (let i = 0; i < count * count; i++) {
          if (i % count === 0) continue;
          point.fromArray(positions, i * 3);
          const depth = parent.copy(point).sub(origin).dot(forward);
          maximumForwardExcess = Math.max(maximumForwardExcess, depth - limit);
          assert(depth <= limit + .00005, label + ': cape crossed the forward boundary');
          const ratio = point.distanceTo(parent.fromArray(positions, (i - 1) * 3)) / rest[i];
          maximumLengthRatio = Math.max(maximumLengthRatio, ratio);
          assert(ratio < 1.036, label + ': forward correction stretched the cape');
          if (depth >= limit - 1e-5) {
            lab.cloth.particleVelocity(i, velocity);
            boundaryVelocity.copy(point).sub(origin).cross(carrier.angvel()).negate()
              .add(lab.capeMotion.carrierVelocity);
            assert(velocity.sub(boundaryVelocity).dot(forward) < .001,
              label + ': forward velocity still pushes through the boundary');
          }
        }
        assert(lab.cloth.numAttachments() === count, label + ': collar detached');
      };
      const forceFlip = label => {
        const carrier = lab.ragdoll.capeBodies.get('chest');
        rotation.copy(carrier.rotation());
        forward.set(0, 0, 1).applyQuaternion(rotation);
        up.set(0, 1, 0).applyQuaternion(rotation);
        const before = new Float32Array(lab.cloth.particlePositions());
        for (let i = 0; i < count * count; i++) {
          if (i % count === 0) continue;
          point.fromArray(before, Math.floor(i / count) * count * 3)
            .addScaledVector(forward, .8).addScaledVector(up, i % count * .06);
          lab.cloth.setParticlePosition(i, point);
          lab.cloth.setParticleVelocity(i, velocity.copy(forward).multiplyScalar(80));
        }
        lab.capeMotion.afterStep(dt);
        const after = lab.cloth.particlePositions();
        for (let column = 0; column < count; column++) {
          for (let axis = 0; axis < 3; axis++) {
            const at = column * count * 3 + axis;
            assert(after[at] === before[at], label + ': correction moved the sewn collar');
          }
        }
        check(label);
      };
      const step = (label, frames) => {
        for (let i = 0; i < frames; i++) {
          lab.step();
          check(label);
          maximumSpeed = Math.max(maximumSpeed, lab.ragdoll.speed);
        }
        phases.push(label);
      };
      forceFlip('forced overhead fold while upright');
      step('strong forward wind', 120);
      lab.touchDirections.add('backward');
      step('backward movement into wind', 90);
      lab.clearMovement();
      // Clear the city's boundary walls before exercising boosted flight.
      lab.touchFlight = true;
      step('vertical ascent', 900);
      lab.touchFlight = false;
      const aim = (x, y, z) => {
        lab.ragdoll.controlFocus(lab.focus);
        lab.controls.target.copy(lab.focus);
        lab.camera.position.copy(lab.focus).add(new T.Vector3(x, y, z));
        lab.controls.update();
      };
      aim(0, 0, -8);
      lab.keys.add('KeyW'); lab.keys.add('ShiftLeft');
      step('boosted flight', 330);
      assert(maximumSpeed > 105, 'full flight boost was not exercised');
      forceFlip('forced overhead fold while pitched for flight');
      aim(-8, -4, 0);
      step('banked diving turn', 120);
      lab.clearMovement();
      step('abrupt braking', 90);
      lab.toggleRelease();
      step('released ragdoll', 90);
      lab.updateMesh(.5);
      assert(lab.capeSurface.geometry.getAttribute('position').array.every(Number.isFinite), 'non-finite cape surface');
      return { passed: true, maximumForwardExcess, maximumLengthRatio, maximumSpeed, phases };
    } finally {
      lab.settings = settings;
      lab.reset();
      lab.previousTime = 0;
      lab.raf = requestAnimationFrame(lab.frame);
    }
  });
}
