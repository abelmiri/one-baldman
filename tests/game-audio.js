// Run with: playwright-cli run-code --filename tests/game-audio.js
async page => {
  await page.reload();
  await page.locator('.game-loading').waitFor({ state: 'detached' });
  const initial = await page.evaluate(() => {
    const root = document.getElementById('root');
    const fiber = root[Object.keys(root).find(key => key.startsWith('__reactContainer'))].stateNode.current;
    const find = f => !f ? null : f.type?.name === 'App' ? f : find(f.child) || find(f.sibling);
    let hook = find(fiber).memoizedState;
    while (hook && !hook.memoizedState?.current?.ragdoll) hook = hook.next;
    window.__audioLab = hook.memoizedState.current;
    return !window.__audioLab.audio.context;
  });
  if (!initial) throw Error('Audio context created before user interaction');
  await page.keyboard.down('f');
  await page.waitForFunction(() => window.__audioLab.heatVision.group.visible);
  await page.keyboard.up('f');
  const result = await page.evaluate(async () => {
    const lab = window.__audioLab, audio = lab.audio, context = audio.context;
    const assert = (condition, message) => { if (!condition) throw Error(message) };
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    const samples = new Float32Array(analyser.fftSize);
    const rms = () => {
      analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
    };
    assert(context.state === 'running', 'Gesture did not unlock playback');
    cancelAnimationFrame(lab.raf);
    audio.compressor.disconnect();
    audio.compressor.connect(analyser).connect(context.destination);
    try {
      audio.update(true, true, false, false, 0);
      await wait(200);
      const laser = rms();
      assert(laser > .001, 'Laser has no audible output');
      audio.update(true, true, true, false, 0);
      await wait(200);
      assert(audio.laser.filter.frequency.value > 2000, 'Surface hit does not change laser timbre');
      audio.stop();
      audio.update(true, false, false, true, 0);
      await wait(400);
      const hover = rms();
      audio.update(true, false, false, true, 110);
      await wait(500);
      const flight = rms();
      assert(hover > .0001 && flight > hover * 2, 'Flight wind does not respond to speed');
      audio.stop();
      audio.update(true, false, false, false, 0);
      const point = {x:0,y:0,z:0}, right = {x:1,y:0,z:0};
      audio.impact(point, 30, point, right);
      audio.impact(point, 4, point, right, true);
      await wait(40);
      const crash = rms();
      assert(crash > .005 && audio.voices.size === 2, 'Crash/debris sound missing');
      for (let i = 0; i < 100; i++) audio.impact(point, 30, point, right);
      assert(audio.voices.size === 2, 'Duplicate contacts flooded audio');
      await wait(700);
      assert(audio.voices.size === 0, 'Finished impact voices leaked');
      audio.impact({x:1000,y:0,z:0}, 30, point, right);
      assert(audio.voices.size === 0, 'Distant impact should be culled');
      audio.update(true, true, false, true, 110);
      audio.setMuted(true);
      await wait(100);
      assert(rms() < .00001, 'Mute left audible output');
      audio.setMuted(false);
      audio.update(true, true, false, true, 110);
      audio.update(false, false, false, false, 0);
      await wait(100);
      assert(rms() < .00001 && !audio.voices.size, 'Pause left audible output');
      audio.update(true, true, false, true, 110);
      lab.reset();
      assert(audio.laser.gain.gain.value === 0 && audio.flight.gain.gain.value === 0, 'Reset left loop sounds');
      return { laser, hover, flight, crash, gestureUnlock:true, boundedVoices:true, mute:true, pause:true, reset:true };
    } finally {
      audio.stop();
      audio.compressor.disconnect();
      analyser.disconnect();
      audio.compressor.connect(context.destination);
      lab.previousTime = 0;
      lab.raf = requestAnimationFrame(lab.frame);
    }
  });
  await page.getByRole('button', { name: 'باز کردن منوی بازی' }).click();
  const sound = page.getByRole('switch', { name: 'صدای بازی' });
  await sound.click();
  if (await sound.getAttribute('aria-checked') !== 'false') throw Error('Mute switch did not turn off');
  await sound.click();
  if (await sound.getAttribute('aria-checked') !== 'true') throw Error('Mute switch did not turn on');
  await page.evaluate(async () => {
    const { GameAudio } = await import('/src/GameAudio.ts');
    window.__audioFixture = new GameAudio();
  });
  await page.keyboard.press('Shift');
  await page.evaluate(async () => {
    const fixture = window.__audioFixture, context = fixture.context;
    if (!context) throw Error('Fixture failed to unlock');
    fixture.dispose();
    await new Promise(resolve => setTimeout(resolve, 30));
    if (context.state !== 'closed') throw Error('Disposed context leaked');
    delete window.__audioFixture;
    delete window.__audioLab;
  });
  return { passed:true, ...result, menuSwitch:true, disposal:true };
}
