import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { ResearchVault } from '../src/vault.mjs';
import { readPdf, extractPdf } from '../src/pdf.mjs';
import { createResearchTools } from '../src/tools.mjs';

export function samplePdf() {
  const stream = text => `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 400] /Resources << >> /Contents 7 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',stream('BT /F1 18 Tf 30 350 Td (A cited research finding.) Tj ET\n0.3 0.5 0.8 rg 30 80 240 120 re f'),stream('0.7 0.3 0.2 rg 40 100 240 180 re f')];
  let text = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(text));text+=`${index+1} 0 obj\n${object}\nendobj\n`;});
  const start = Buffer.byteLength(text);
  text+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(text);
}
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'research-pdf-')); await mkdir(join(root,'.obsidian'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const vault=await ResearchVault.bind(root), attachment=await vault.importAttachment({data:samplePdf().toString('base64'),mimeType:'application/pdf',name:'Evidence.pdf'});
  return {vault,attachment};
}

test('real PDFs yield page citations, bounded text, rendered figures and reusable vault caches',async t=>{
  const {vault,attachment}=await fixture(t);
  const first=await readPdf(vault,{path:attachment.path,pageCount:2,includeImages:true});
  assert.equal(first.details.totalPages,2);assert.match(first.details.pages[0].text,/A cited research finding/);
  assert.match(first.details.pages[0].citation,/#page=1/);assert.equal(first.details.pages[1].needsVisualInspection,true);
  const images=first.content.filter(part=>part.type==='image');assert.equal(images.length,2);
  const decoded=PNG.sync.read(Buffer.from(images[0].data,'base64'));assert.equal(decoded.width,640);assert.equal(decoded.height,800);
  assert.ok(decoded.data.some((value,index)=>index%4!==3&&value<200),'Page has visible text and vector marks.');
  const second=await readPdf(vault,{path:attachment.path,pageCount:2,includeImages:true,maxChars:6});
  assert.equal(second.details.cached,true);assert.equal(second.details.pages[0].text.length,6);assert.equal(second.details.pages[0].truncated,true);
  assert.equal(second.content.find(part=>part.type==='image').data,images[0].data);
  await writeFile(await vault.safePath(first.details.pages[0].imagePath),'broken cache');
  const repaired=await readPdf(vault,{path:attachment.path,includeImages:true});assert.equal(repaired.details.cached,false);
  assert.equal(repaired.content.find(part=>part.type==='image').data,images[0].data);
  const metaPath=`Sources/${first.details.sourceId}/metadata.json`,metadata=await vault.readJson(metaPath);
  await vault.writeJson(metaPath,{...metadata,totalPages:-1});
  const repairedCount=await readPdf(vault,{path:attachment.path});assert.equal(repairedCount.details.totalPages,2);assert.equal(repairedCount.details.pages.length,2);
  await readPdf(vault,{path:attachment.path},undefined,{sourceUrl:'https://example.org/original.pdf'});
  assert.equal((await vault.readJson(metaPath)).url,'https://example.org/original.pdf','A cached PDF can acquire its original public source URL.');
  assert.deepEqual(await readFile(await vault.safePath(attachment.path)),samplePdf());
});

test('PDF reads refuse internal paths, changed originals, excessive pages and unsupported vision',async t=>{
  const {vault,attachment}=await fixture(t);
  for(const path of ['../secret.pdf','_Research/private.pdf','Attachments/../private.pdf'])await assert.rejects(readPdf(vault,{path}),/Attachments/);
  await assert.rejects(readPdf(vault,{path:attachment.path,pageCount:3,includeImages:true}),/at most 2/);
  await assert.rejects(readPdf(vault,{path:attachment.path,startPage:3}),/out of range/);
  await assert.rejects(readPdf(vault,{path:attachment.path,includeImages:true},null,{canReadImages:()=>false}),/vision model/);
  await writeFile(await vault.safePath(attachment.path),Buffer.concat([samplePdf(),Buffer.from('changed')]));
  await assert.rejects(readPdf(vault,{path:attachment.path}),/integrity/);
  await truncate(await vault.safePath(attachment.path),51*1024*1024);
  await assert.rejects(readPdf(vault,{path:attachment.path}),/50 MiB/);
});

test('malformed PDF, timeout and cancellation stop parsing cleanly',async()=>{
  await assert.rejects(extractPdf(Buffer.from('%PDF-1.4\ninvalid'),{pages:[1]}),/Could not read PDF/);
  const workerUrl=new URL('data:text/javascript,while(true){}');
  await assert.rejects(extractPdf(samplePdf(),{pages:[1],workerUrl,timeoutMs:30}),/timed out/);
  const stop=new AbortController();setTimeout(()=>stop.abort(new Error('Stopped PDF')),30);
  await assert.rejects(extractPdf(samplePdf(),{pages:[1],workerUrl,signal:stop.signal}),/Stopped PDF/);
});

test('public PDF retrieval preserves the original and supports source-linked charts',async t=>{
  const {vault}=await fixture(t);
  const tools=new Map(createResearchTools(vault,{lookupImpl:async()=>[{address:'93.184.216.34',family:4}],fetchImpl:async()=>new Response(samplePdf(),{headers:{'content-type':'application/pdf'}}),presentationTimeoutMs:5}).map(tool=>[tool.name,tool]));
  const read=await tools.get('fetch_source').execute('pdf',{url:'https://example.org/paper.pdf'},undefined);
  assert.equal(read.details.totalPages,2);assert.match(read.details.sourceId,/^pdf-/);
  const metadata=await vault.readJson(`Sources/${read.details.sourceId}/metadata.json`);assert.equal(metadata.url,'https://example.org/paper.pdf');
  const chart=await tools.get('save_visual').execute('chart',{sourceIds:[read.details.sourceId],spec:{type:'bar',title:'Document pages',xLabel:'Document',yLabel:'Pages (count)',series:[{name:'Pages',points:[{x:'Paper',y:2}]}]}},undefined);
  assert.equal(chart.details.illustrative,false);
});
