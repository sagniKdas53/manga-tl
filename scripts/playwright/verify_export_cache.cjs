const { createServer } = require('node:http');
const { chromium } = require(process.cwd() + '/node_modules/playwright');
const assert = require('node:assert/strict');
(async () => {
  let revision = 'initial'; let hits = 0;
  const server = createServer((req,res) => {
    if (req.url === '/') { res.end('<html><body>Synthetic export cache test</body></html>'); return; }
    hits++;
    res.writeHead(200, {'Content-Type':'text/plain', 'Cache-Control': req.url === '/fixed' ? 'private, no-store' : 'max-age=31536000, public, immutable'});
    res.end(revision);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let browser;
  try {
    browser = await chromium.launch({headless:true});
    const page=await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForLoadState('networkidle');
    const read=(path,cache)=>page.evaluate(async ({path,cache})=>(await fetch(path,cache?{cache}:{})).text(),{path,cache});
    assert.equal(await read('/old'),'initial'); revision='final';
    const cached=await read('/old'); assert.equal(cached,'initial');
    assert.equal(await read('/old','no-store'),'final');
    revision='initial'; assert.equal(await read('/fixed'),'initial');
    revision='final'; assert.equal(await read('/fixed'),'final');
    console.log(JSON.stringify({oldDefaultFetch:cached,newClientFetch:'final',newServerDefaultFetch:'final',serverHits:hits,scope:'isolated Chromium HTTP cache reproduction; neutral text only'}));
  } finally { await browser?.close(); await new Promise(r=>server.close(r)); }
})().catch(e=>{console.error(e);process.exitCode=1});
