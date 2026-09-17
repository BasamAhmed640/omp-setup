// Optional browser QA. Supply Playwright/marked through NODE_PATH and a local
// Mermaid bundle through MERMAID_BUNDLE; these are not runtime dependencies.
const {chromium}=require('playwright');
const {parse}=require('marked');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const repo=path.resolve(__dirname,'../..');
const modules=Object.fromEntries(['main.js','visual.cjs','presentation.cjs'].map(name=>[name,fs.readFileSync(path.join(repo,'obsidian',name),'utf8')]));
const css=fs.readFileSync(path.join(repo,'obsidian/styles.css'),'utf8');
const spec={type:'line',title:'A library taking shape',xLabel:'Time (weeks)',yLabel:'Items (count)',series:[{name:'Sources saved',points:[{x:1,y:4},{x:2,y:9},{x:3,y:15},{x:4,y:22},{x:5,y:31},{x:6,y:43}]},{name:'Connected notes',points:[{x:1,y:1},{x:2,y:3},{x:3,y:6},{x:4,y:10},{x:5,y:16},{x:6,y:24}]}],caption:'Illustrative data for a formatting example; not measured results.'};
const answer=`A source preserves what was said. A linked note connects it to what you already know.

\`\`\`research-visual
{"path":"Visuals/example/spec.json"}
\`\`\`

### Three ways to keep the work

| Approach | What it preserves | Ongoing work |
| --- | --- | --- |
| Source archive | Original PDFs, articles, and images | Return to each source for context |
| Topic notes | Explanations, evidence, and questions | Revise when evidence changes |
| Connected wiki | Notes linked to sources and related ideas | Maintain useful connections |

### From a question to lasting context

\`\`\`mermaid
flowchart TD
  S[Sources] --> A[Cited answer]
  A -->|save on request| N[Topic note]
  N --> Q[Next question]
  Q --> A
\`\`\`

*Design example with illustrative data.*

> Limited evidence review · 3 claims examined · [[Conversations/example/Reviews/example/Review.md|Review notes]]`;

(async()=>{
  assert.ok(process.env.MERMAID_BUNDLE,'Set MERMAID_BUNDLE to a local mermaid.min.js');
  const browser=await chromium.launch({channel:process.env.QA_BROWSER||'msedge',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:760,height:1600}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    // Obsidian handles internal wiki links; emulate that host behavior here.
    await page.exposeFunction('parseMarkdown',markdown=>parse(markdown.replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g,'[$2]($1)')));
    await page.setContent('<style>body{margin:0;--font-interface:Arial,sans-serif;--font-monospace:Consolas,monospace}.view-content{height:auto}</style><body></body>');
    await page.addStyleTag({content:css});await page.addScriptTag({path:process.env.MERMAID_BUNDLE});
    await page.evaluate(async({modules,spec,answer})=>{
      mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'dark',flowchart:{htmlLabels:true},fontFamily:'Arial'});
      class Component{constructor(){this.children=[];this.cleanup=[];}load(){this.onload?.();}unload(){this.onunload?.();this.children.forEach(child=>child.unload());this.cleanup.forEach(fn=>fn());}addChild(child){this.children.push(child);child.load();return child;}removeChild(child){child.unload();this.children=this.children.filter(item=>item!==child);}register(fn){this.cleanup.push(fn);}registerEvent(){}}
      class Plugin extends Component{constructor(app){super();this.app=app;}async loadData(){return null;}async saveData(){}registerView(){}addRibbonIcon(){}addCommand(){}registerMarkdownCodeBlockProcessor(name,handler){this.processors??={};this.processors[name]=handler;}}
      class ItemView extends Component{constructor(leaf){super();this.app=leaf.app;this.contentEl=document.createElement('main');this.contentEl.className='view-content';document.body.append(this.contentEl);}async setState(){}}
      class MarkdownRenderChild extends Component{constructor(el){super();this.containerEl=el;}}
      let plugin;
      const mock={Plugin,ItemView,MarkdownRenderChild,Component,SuggestModal:class{},Notice:class{},setIcon(){},MarkdownRenderer:{async render(app,markdown,el,sourcePath,component){
        el.innerHTML=await parseMarkdown(markdown);
        for(const code of [...el.querySelectorAll('code.language-research-visual')]){const host=document.createElement('div');code.parentElement.replaceWith(host);plugin.processors['research-visual'](code.textContent,host,{addChild:child=>component.addChild(child)});}
        for(const code of [...el.querySelectorAll('code.language-mermaid')]){const host=document.createElement('div');host.className='mermaid';host.textContent=code.textContent;code.parentElement.replaceWith(host);await mermaid.run({nodes:[host]});}
      }}};
      const loaded={obsidian:mock};
      for(const name of ['presentation.cjs','main.js']){const module={exports:{}};new Function('require','module','exports',modules[name])(id=>{if(id!=='obsidian')throw Error('Unexpected host import: '+id);return mock;},module,module.exports);loaded['./'+name]=module.exports;}
      const files=new Map([['_Research/vault.json',JSON.stringify({id:'test-vault'})],['_Research/active.json',JSON.stringify({conversationId:'example'})],['Conversations/example/manifest.json',JSON.stringify({id:'example',title:'From sources to connected ideas',updatedAt:'2026-09-10'})],['Conversations/example/Conversation.md','# Example\n\n'+answer],['Visuals/example/spec.json',JSON.stringify(spec)]]);
      const app={vault:{getName:()=> 'Discover vault',on:()=>({}),adapter:{exists:async path=>files.has(path),stat:async path=>files.has(path)?{size:files.get(path).length}:null,read:async path=>{if(!files.has(path))throw Error('Missing '+path);return files.get(path);},write:async(path,text)=>files.set(path,text),list:async()=>({folders:[],files:[]})}},workspace:{containerEl:document.body,getLeavesOfType:()=>[],openLinkText(){}}};
      plugin=new loaded['./main.js'](app);await plugin.onload();
      window.plugin=plugin;window.files=files;window.answer=answer;
      window.view=new loaded['./main.js'].ResearchView({app},plugin);await view.onOpen();
      window.inspectRendered=loaded['./presentation.cjs'].inspectRendered;
    },{modules,spec,answer});
    await page.frameLocator('main iframe').locator('#legend button').first().waitFor();
    for(const phase of ['Researching','Checking evidence','Refining answer','Checking layout','Draft saved · <unfinished>']){
      const state=await page.evaluate(async phase=>{
        files.set('_Research/stream/example.json',JSON.stringify({text:'',phase,status:phase.startsWith('Draft')?'error':'working'}));await view.updateStream();
        return {hidden:view.streamEl.hidden,label:view.streamEl.querySelector('.pi-research-stream-label')?.textContent,body:!!view.streamEl.querySelector('.pi-research-stream-text'),injected:!!view.streamEl.querySelector('unfinished')};
      },phase);
      assert.deepEqual(state,{hidden:false,label:phase,body:false,injected:false});
    }
    await page.evaluate(async()=>{files.set('_Research/stream/example.json',JSON.stringify({text:'',phase:'Checking evidence',status:'completed'}));await view.updateStream();});
    assert.equal(await page.locator('.pi-research-stream').evaluate(el=>el.hidden),true);
    assert.equal(await page.locator('main blockquote a').textContent(),'Review notes');
    async function check(markdown,id){return page.evaluate(async({markdown,id})=>{const request={version:1,id,digest:'fixture-digest',markdown,sourcePath:'Knowledge/Preview.md',expiresAt:Date.now()+25000};const p=`_Research/presentation/${id}.request.json`;files.set(p,JSON.stringify(request));await plugin.checkPresentation(p);return JSON.parse(files.get(p.replace('.request.json','.result.json')));},{markdown,id});}
    const good=await check(answer,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    assert.equal(good.status,'passed',JSON.stringify(good));assert.deepEqual(good.widths,[360,760]);
    const bad=await check('```mermaid\nflowchart LR\nA[An extremely long source label]-->B[Another very long processing stage]-->C[A third long explanatory label]-->D[The final result with more words]\n```','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    assert.equal(bad.status,'needs-fix');assert.ok(bad.issues.some(issue=>issue.code==='small-label'),JSON.stringify(bad));
    const invalid=await check('```mermaid\nflowchart TD\nA[unfinished\n```','cccccccc-cccc-cccc-cccc-cccccccccccc');assert.equal(invalid.status,'needs-fix');
    const contrastStyle=await page.addStyleTag({content:'.pi-research-transcript td{color:#222!important}'});
    const contrast=await check('| A | B |\n| --- | --- |\n| One | Two |','dddddddd-dddd-dddd-dddd-dddddddddddd');assert.ok(contrast.issues.some(issue=>issue.code==='low-contrast'),JSON.stringify(contrast));await contrastStyle.evaluate(el=>el.remove());
    const screenshots=[];
    for(const width of [360,760]){
      await page.setViewportSize({width,height:1800});await page.waitForTimeout(200);
      const report=await page.locator('main .pi-research-transcript').evaluate(el=>inspectRendered(el));assert.deepEqual(report,[],JSON.stringify({width,report}));
      const dest=path.join(repo,'docs',`formatting-preview-${width}.png`);await page.locator('main').screenshot({path:dest});screenshots.push(dest);
    }
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({good,bad,invalid,contrast,screenshots,errors},null,2));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
