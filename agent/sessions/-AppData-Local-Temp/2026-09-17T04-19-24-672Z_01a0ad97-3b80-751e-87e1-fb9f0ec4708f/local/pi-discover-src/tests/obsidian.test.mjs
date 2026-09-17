import test from 'node:test';
import assert from 'node:assert/strict';
import {runInThisContext} from 'node:vm';
import {mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ResearchVault} from '../src/vault.mjs';
import {installCompanion} from '../src/install.mjs';
const obsidian={Plugin:class{},ItemView:class{},MarkdownRenderChild:class{constructor(el){this.containerEl=el;}register(){}},Component:class{},SuggestModal:class{},Notice:class{},MarkdownRenderer:{},setIcon(){}};
function loadCompanion(source){
  // Obsidian 1.13 evaluates main.js with a host require, not Node's
  // file-relative module loader. Only the public host API is external.
  const record={exports:{}};
  runInThisContext(`(function(require,module,exports){${source}\n})`)(id=>{
    assert.equal(id,'obsidian',`Unexpected external module: ${id}`);
    return obsidian;
  },record,record.exports);
  return record.exports;
}
const companion=loadCompanion(await readFile(new URL('../obsidian/main.js',import.meta.url),'utf8'));

test('the standalone companion loads and registers its view and visuals under the Obsidian loader contract',async()=>{
  const plugin=new companion(),views=[],processors=[];
  Object.assign(plugin,{loadData:async()=>null,registerView:(...args)=>views.push(args),addRibbonIcon(){},addCommand(){},registerMarkdownCodeBlockProcessor:(...args)=>processors.push(args),registerEvent(){},
    app:{vault:{on(){},adapter:{exists:async()=>false}}}});
  await plugin.onload();
  assert.equal(views[0][0],'pi-research-reading');
  assert.equal(processors[0][0],'research-visual');
  let opened=0;
  plugin.openReadingView=async()=>{opened++;};
  assert.equal(opened,0,'Loading an enabled plugin should not steal focus.');
  plugin.onUserEnable();
  assert.equal(opened,1,'Explicitly enabling Discover opens the reading pane.');
  plugin.onunload();
  assert.equal(plugin.stopped,true);
});

test('fresh installs need only three files and repeated setup repairs corruption without rewriting unchanged files',async t=>{
  const root=await mkdtemp(join(tmpdir(),'discover-install-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'.obsidian'));
  const vault=await ResearchVault.bind(root),dest=await installCompanion(vault);
  assert.deepEqual((await readdir(dest)).sort(),['main.js','manifest.json','styles.css']);
  assert.equal(typeof loadCompanion(await readFile(join(dest,'main.js'),'utf8')),'function');
  const files=['main.js','manifest.json','styles.css'],modified=new Map();
  for(const file of files){await utimes(join(dest,file),1000,1000);modified.set(file,(await stat(join(dest,file))).mtimeMs);}
  await installCompanion(vault);
  for(const file of files)assert.equal((await stat(join(dest,file))).mtimeMs,modified.get(file));
  await writeFile(join(dest,'main.js'),'broken');
  await installCompanion(vault);
  assert.equal(typeof loadCompanion(await readFile(join(dest,'main.js'),'utf8')),'function');
  assert.equal((await stat(join(dest,'styles.css'))).mtimeMs,modified.get('styles.css'));
});

test('upgrading the companion to Discover preserves the existing plugin identity and Obsidian preferences',async t=>{
  const root=await mkdtemp(join(tmpdir(),'discover-upgrade-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const pluginPath=join(root,'.obsidian','plugins','pi-research');
  await mkdir(pluginPath,{recursive:true});
  const preferences='{"conversationId":"existing-conversation","followLatest":false}\n';
  const enabled='["pi-research"]\n';
  const workspace='{"main":{"type":"pi-research-reading","state":{"conversationId":"existing-conversation"}}}\n';
  await writeFile(join(pluginPath,'data.json'),preferences);
  await writeFile(join(pluginPath,'manifest.json'),'{"id":"pi-research","name":"Pi Research","version":"0.3.0"}');
  await writeFile(join(root,'.obsidian','community-plugins.json'),enabled);
  await writeFile(join(root,'.obsidian','workspace.json'),workspace);
  const vault=await ResearchVault.bind(root);
  const identity=await vault.readText('_Research/vault.json');
  assert.equal(await installCompanion(vault),pluginPath);
  const manifest=JSON.parse(await readFile(join(pluginPath,'manifest.json'),'utf8'));
  assert.equal(manifest.id,'pi-research');
  assert.equal(manifest.name,'Discover');
  assert.equal(await readFile(join(pluginPath,'data.json'),'utf8'),preferences);
  assert.equal(await readFile(join(root,'.obsidian','community-plugins.json'),'utf8'),enabled);
  assert.equal(await readFile(join(root,'.obsidian','workspace.json'),'utf8'),workspace);
  assert.equal(await vault.readText('_Research/vault.json'),identity);
  assert.deepEqual(await readdir(join(root,'.obsidian','plugins')),['pi-research']);
});

test('visual references accept flat snapshots and legacy versions, with no other paths',()=>{
  assert.deepEqual(companion.parseVisualReference('{"path":"Visuals/artifact-a/spec.json"}'),{path:'Visuals/artifact-a/spec.json',artifactId:'artifact-a',version:undefined});
  assert.deepEqual(companion.parseVisualReference('{"path":"Visuals/artifact-a/versions/001/spec.json"}'),{path:'Visuals/artifact-a/versions/001/spec.json',artifactId:'artifact-a',version:'001'});
  for(const path of ['../../private.json','Visuals/../spec.json','file:///etc/passwd','Visuals/a/versions/001/../../other.json','Visuals/a/versions/001/evil.js','Visuals/a/versions/001/spec.json?x=1','Visuals/a/spec.json?x=1'])assert.throws(()=>companion.parseVisualReference(JSON.stringify({path})),/Visual path/);
  assert.throws(()=>companion.parseVisualReference('{"path":"Visuals/a/spec.json","code":"evil"}'),/single/);
});

test('current and legacy chart embeds render without reading corrupted preferences or writing to the vault',async()=>{
  for(const path of ['Visuals/chart-a/spec.json','Visuals/chart-a/versions/001/spec.json']){
    const reads=[],writes=[],listeners=new Map();
    const files=new Map([
      [path,JSON.stringify({type:'line',title:'Saved chart',xLabel:'Time',yLabel:'Value',series:[{name:'A',points:[{x:0,y:1}]}]})],
      ['_Research/view-state/chart-a.json','{interrupted JSON'],
    ]);
    const doc={defaultView:{addEventListener:(type,listener)=>listeners.set(type,listener),removeEventListener(){},open(){}}};
    doc.createElement=tag=>({tagName:tag,ownerDocument:doc,children:[],style:{},attributes:{},contentWindow:{},append(child){this.children.push(child);},setAttribute(name,value){this.attributes[name]=value;},addEventListener(){}});
    const container=doc.createElement('div');
    const plugin={app:{vault:{adapter:{
      stat:async path=>files.has(path)?{size:files.get(path).length}:null,
      read:async path=>{reads.push(path);return files.get(path);},
      write:async(...args)=>writes.push(args),
    }},workspace:{openLinkText(){}}}};
    const child=new companion.VisualChild(container,plugin,companion.parseVisualReference(JSON.stringify({path})));
    await child.onload();
    const frame=container.children.find(node=>node.tagName==='iframe');
    assert.ok(frame,'A chart frame should be rendered.');
    assert.match(frame.srcdoc,/<title>Saved chart<\/title>/);
    assert.equal(frame.attributes.sandbox,'allow-scripts');
    assert.deepEqual(reads,[path]);
    const token=frame.srcdoc.match(/script-src 'nonce-([^']+)'/)[1];
    listeners.get('message')({source:frame.contentWindow,data:{kind:'research-visual:state',artifactId:'chart-a',token,state:{hiddenSeries:['A']}}});
    assert.deepEqual(writes,[]);
  }
});
