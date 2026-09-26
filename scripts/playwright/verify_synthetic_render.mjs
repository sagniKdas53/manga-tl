// Neutral text/background evidence using the existing renderer. No provider calls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { PageRenderer } from '../../services/page-renderer/src/renderer.mjs';
const out = process.argv[2] || 'docs/quality-runs/oq-20260923-synthetic/artifacts';
const fontPath='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fontSha=sha(await readFile(fontPath));
const renderer=new PageRenderer({fonts:[{fontId:'synthetic-font',family:'DejaVu Sans',path:fontPath,sha256:fontSha}],maxContexts:1});
await mkdir(out,{recursive:true});
await renderer.start();
try {
  const page=await renderer.browser.newPage();
  const source=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=320;c.height=160;const x=c.getContext('2d');x.fillStyle='#f5f5f5';x.fillRect(0,0,c.width,c.height);return c.toDataURL();});
  await page.close();
  const records=[];
  for(const [index,text] of ['initial','retry','final',''].entries()) {
    const scene={source:{href:source,width:320,height:160},cleanupAssets:[],textObjects:text?[{objectId:'synthetic-text',text,transform:{x:30,y:40,width:260,height:80,rotationDegrees:0},writingMode:'horizontal-tb',alignment:'center',style:{fontFamily:'DejaVu Sans',fill:'#000000',stroke:'',weight:400,padding:4},visible:true,zIndex:2}]:[]};
    const logical=sha(JSON.stringify(scene));
    const result=await renderer.render({contractVersion:'page-scene/v1',pageRevision:index+1,logicalSceneSha256:logical,renderInputSha256:logical,requiredFontIds:text?['synthetic-font']:[],scene});
    assert.equal(sha(result.png),result.pngSha256);
    if(text) assert.equal(result.layout[0].lines.join(' '),text);
    else assert.equal(result.layout.length,0);
    await writeFile(`${out}/${text||'hidden'}.png`,result.png);
    records.push({revision:index+1,text:text||'hidden',logicalSceneSha256:logical,pngSha256:result.pngSha256,layout:result.layout,diagnostics:result.diagnostics,playwrightVersion:result.playwrightVersion,fontSha256:fontSha});
  }
  assert.equal(new Set(records.map(r=>r.pngSha256)).size,4);
  await writeFile(`${out}/render-identities.json`,JSON.stringify(records,null,2)+'\n');
  console.log(JSON.stringify({status:'passed',cases:records.map(r=>r.text),distinctPngDigests:4,output:out,limit:'Renderer-only pixels; backend QA callback and export paths tested separately.'}));
} finally {await renderer.stop();}
