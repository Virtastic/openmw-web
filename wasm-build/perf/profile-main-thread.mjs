// Capture a Chromium CPU profile of the engine's main thread (needs: npm i puppeteer-core; a visible, awake display).
// Usage: node profile-main-thread.mjs '<game url, e.g. http://localhost:8910/index.html?skipintro=1&start=Balmora>' out.json
// Then: python3 report.py openmw.js.symbols out.json   (symbols: see docs/PERF-PROFILING.md)
import puppeteer from 'puppeteer-core'; import fs from 'fs';
const [,, url, out] = process.argv;
const b = await puppeteer.launch({executablePath:'/usr/bin/chromium',headless:false,defaultViewport:{width:1280,height:720},args:['--no-first-run']});
const p = await b.newPage(); const c = await p.createCDPSession();
await p.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
await new Promise(r=>setTimeout(r,60000));
await c.send('Profiler.enable'); await c.send('Profiler.setSamplingInterval',{interval:200});
await c.send('Profiler.start');
const end=Date.now()+60000; let k=0; try{await p.mouse.click(640,360);}catch(e){}
while(Date.now()<end){ const key=['w','w','a','w','d'][k++%5]; try{await p.keyboard.down(key);await new Promise(r=>setTimeout(r,2500));await p.keyboard.up(key);}catch(e){} }
const {profile}=await c.send('Profiler.stop'); fs.writeFileSync(out,JSON.stringify(profile));
console.log('nodes',profile.nodes.length,'samples',profile.samples.length); await b.close();
