import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ResearchVault } from '../src/vault.mjs';
import { checkPresentation } from '../src/presentation.mjs';
import presentation from '../obsidian/presentation.cjs';

test('format preflight catches broken Markdown, literal pipes and wide comparisons',()=>{
  assert.deepEqual(presentation.markdownIssues('| A | B |\n| --- | --- |\n| x \\| y | z |'),[]);
  assert.ok(presentation.markdownIssues('| A | B |\n| --- | --- |\n| x | y | z |').some(issue=>issue.code==='table-columns'));
  assert.ok(presentation.markdownIssues('```mermaid\nflowchart TD\nA-->B').some(issue=>issue.code==='unclosed-fence'));
  assert.ok(presentation.markdownIssues('|A|B|C|D|E|\n|---|---|---|---|---|').some(issue=>issue.code==='wide-table'));
  assert.deepEqual(presentation.markdownIssues('```text\n| A | B |\n| --- | --- |\n| malformed |\n```'),[]);
});

test('missing renderer is unverified; correlated render reports return actual issues and drafts are cleaned',async t=>{
  const root=await mkdtemp(join(tmpdir(),'research-format-'));await mkdir(join(root,'.obsidian'));t.after(()=>rm(root,{recursive:true,force:true}));
  const vault=await ResearchVault.bind(root),markdown='```mermaid\nflowchart TD\nA-->B\n```';
  assert.equal((await checkPresentation(vault,markdown,{timeoutMs:20})).status,'unverified');
  assert.deepEqual(await readdir(await vault.safePath('_Research/presentation')),[]);
  const pending=checkPresentation(vault,markdown,{timeoutMs:2000});
  let file;
  for(let i=0;i<30&&!file;i++){file=(await readdir(await vault.safePath('_Research/presentation'))).find(name=>name.endsWith('.request.json'));if(!file)await delay(10);}
  assert.ok(file);const request=await vault.readJson('_Research/presentation/'+file);
  const resultPath='_Research/presentation/'+file.replace('.request.json','.result.json');
  await vault.writeJson(resultPath,{id:request.id,digest:'wrong',status:'passed',issues:[]});
  await delay(110);
  await vault.writeJson(resultPath,{id:request.id,digest:request.digest,status:'needs-fix',widths:[360],issues:[{code:'small-label',message:'Diagram text is too small.'}]});
  const result=await pending;assert.equal(result.status,'needs-fix');assert.equal(result.issues[0].code,'small-label');
  assert.deepEqual(await readdir(await vault.safePath('_Research/presentation')),[]);
  const abort=new AbortController();const stopped=checkPresentation(vault,markdown,{signal:abort.signal});setTimeout(()=>abort.abort(new Error('Stop formatting')),20);
  await assert.rejects(stopped,/Stop formatting|aborted/);assert.deepEqual(await readdir(await vault.safePath('_Research/presentation')),[]);
});
