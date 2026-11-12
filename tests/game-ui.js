async page => {
  const baseURL = new URL(page.url()).origin;
  const browser = page.context().browser();
  const context = await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true});
  try {
    const mobile = await context.newPage();
    const errors=[];
    mobile.on('pageerror',error=>errors.push(error.message));
    const assert=(condition,message)=>{if(!condition)throw Error(message)};
    let releaseEngine;
    await mobile.route('**/src/ClothLab.ts*', async route => {
      await new Promise(resolve=>releaseEngine=resolve);
      await route.continue();
    });
    await mobile.goto(baseURL,{waitUntil:'domcontentloaded'});
    await mobile.locator('.game-loading').waitFor();
    assert(await mobile.locator('.game-loading').isVisible(),'loading screen missing before engine');
    const deadline = Date.now() + 10000;
    while(!releaseEngine) {
      if(Date.now() > deadline) throw Error('engine module request was not intercepted');
      await mobile.waitForTimeout(20);
    }
    releaseEngine();
    await mobile.locator('.game-loading').waitFor({state:'detached'});
    await mobile.evaluate(()=>{
      const root=document.getElementById('root');
      const fiber=root[Object.keys(root).find(k=>k.startsWith('__reactContainer'))].stateNode.current;
      const find=f=>!f?null:f.type?.name==='App'?f:find(f.child)||find(f.sibling);
      let hook=find(fiber).memoizedState;
      while(hook&&!hook.memoizedState?.current?.ragdoll)hook=hook.next;
      window.uiLab=hook.memoizedState.current;
    });
    assert(await mobile.evaluate(()=>matchMedia('(pointer:coarse)').matches),'touch media not enabled');
    await mobile.screenshot({path:'output/playwright/optimization-mobile.png'});
    const center=async locator=>{const b=await locator.boundingBox();return{x:b.x+b.width/2,y:b.y+b.height/2}};
    const flight=await center(mobile.getByRole('button',{name:'برخاستن و صعود؛ نگه دارید'}));
    const forward=await center(mobile.getByRole('button',{name:'حرکت به جلو',exact:true}));
    const sprint=await center(mobile.getByRole('button',{name:'سرعت بیشتر؛ نگه دارید'}));
    const client=await context.newCDPSession(mobile);
    await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,...flight},{id:2,...forward},{id:3,...sprint}]});
    await mobile.waitForTimeout(150);
    const held=await mobile.evaluate(()=>({flight:uiLab.touchFlight,run:uiLab.touchRunning,forward:uiLab.touchDirections.has('forward')}));
    assert(held.flight&&held.run&&held.forward,'simultaneous touch controls failed: '+JSON.stringify(held));
    await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    const released=await mobile.evaluate(()=>!uiLab.touchFlight&&!uiLab.touchRunning&&uiLab.touchDirections.size===0);
    assert(released,'touch controls remained held');
    const laser=await center(mobile.getByRole('button',{name:'لیزر چشم؛ نگه دارید'}));
    await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:4,...laser}]});
    await mobile.waitForFunction(()=>uiLab.touchLaser&&uiLab.heatVision.group.visible);
    await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await mobile.waitForFunction(()=>!uiLab.touchLaser&&!uiLab.heatVision.group.visible);
    const descent=mobile.getByRole('button',{name:'فرود؛ نگه دارید'});
    assert(await descent.isEnabled(),'hover did not enable touch descent');
    const down=await center(descent);
    await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:5,...down}]});
    await mobile.waitForFunction(()=>uiLab.ragdoll.flightState==='grounded');
    await mobile.waitForFunction(()=>!uiLab.touchDescending);
    await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await mobile.getByRole('button',{name:'رهاکردن بدن'}).click();
    await mobile.getByRole('button',{name:'بازگشت کنترل'}).waitFor();
    assert(await mobile.evaluate(()=>uiLab.ragdoll.isReleased),'touch release failed');
    await mobile.getByRole('button',{name:'بازگشت کنترل'}).click();
    await mobile.waitForFunction(()=>!uiLab.ragdoll.isReleased);
    await mobile.getByRole('button',{name:'باز کردن منوی بازی'}).click();
    assert(await mobile.evaluate(()=>!uiLab.settings.playing&&document.querySelector('.game-interface').inert),'menu did not pause/inert');
    await mobile.screenshot({path:'output/playwright/optimization-menu.png'});
    await mobile.keyboard.press('Tab');
    assert(await mobile.evaluate(()=>!!document.activeElement.closest('[role="dialog"]')),'focus escaped menu');
    await mobile.getByRole('switch',{name:'حالت شب'}).click();
    await mobile.getByRole('button',{name:'ادامهٔ بازی'}).click();
    await mobile.setViewportSize({width:844,height:390});
    await mobile.screenshot({path:'output/playwright/optimization-landscape.png'});
    const sizes=await mobile.locator('.touch-movement button').evaluateAll(buttons=>buttons.map(b=>{const r=b.getBoundingClientRect();return{width:r.width,height:r.height,x:r.x,y:r.y}}));
    assert(sizes.every(b=>b.width>=44&&b.height>=44&&b.x>=0&&b.y>=0&&b.x+b.width<=844&&b.y+b.height<=390),'touch targets clipped');
    assert(errors.length===0,'browser errors: '+errors.join('; '));
    return {passed:true,loadingBeforeEngine:true,multitouch:held,touchReleased:released,touchLaser:true,touchLandingReleasesInput:true,touchReleaseRecovery:true,pause:true,focusTrap:true,landscapeTargets:sizes,errors};
  } finally {
    await context.close();
    await page.bringToFront();
  }
}
