'use strict';

const {Plugin, ItemView, MarkdownRenderer, MarkdownRenderChild, Component, SuggestModal, Notice, setIcon} = require('obsidian');
const {validateSpec, buildChartDocument} = require('./visual.cjs');
const {markdownIssues, formatRendered, inspectRendered} = require('./presentation.cjs');
const VIEW_TYPE = 'pi-research-reading';
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;
const VISUAL_PATH = /^Visuals\/([a-zA-Z0-9_-]{1,80})\/(?:versions\/(\d{3,6})\/)?spec\.json$/;
const MAX_FILE_BYTES = 6 * 1024 * 1024;

function element(parent, tag, className, content) {
  const node = parent.ownerDocument.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  parent.append(node); return node;
}
function button(parent, label, icon, action, className='pi-research-button') {
  const node=element(parent,'button',className); node.type='button';
  if (icon) {const span=element(node,'span','pi-research-icon');span.setAttribute('aria-hidden','true');setIcon(span,icon);}
  element(node,'span','',label); node.addEventListener('click',action); return node;
}
function dateLabel(value) {const date=new Date(value||0);return Number.isNaN(date.valueOf())||date.valueOf()===0?'':date.toLocaleDateString(undefined,{month:'short',day:'numeric'});}
function validId(value) { return typeof value==='string' && ID_PATTERN.test(value); }
function parseVisualReference(source) {
  if (typeof source!=='string'||source.length>2048) throw new Error('Visual reference is too large.');
  const value=JSON.parse(source);
  if (!value || Array.isArray(value) || Object.keys(value).some(key=>key!=='path') || typeof value.path!=='string') throw new Error('A research visual needs a single vault-relative path.');
  const match=VISUAL_PATH.exec(value.path);
  if(!match) throw new Error('Visual path must name a saved chart under Visuals.');
  return {path:value.path,artifactId:match[1],version:match[2]};
}
function styleMessageGroups(container){
  const headings=[...container.querySelectorAll('h2')].filter(heading=>[...heading.querySelectorAll('a')].some(link=>(link.getAttribute('data-href')||link.getAttribute('href')||'').includes('/Messages/')));
  const headingSet=new Set(headings);
  for(const heading of headings){heading.classList.add('pi-research-message-heading');const role=/^(you|user)$/i.test(heading.textContent.trim())?'user':'assistant';heading.setAttribute('data-role',role);const group=container.ownerDocument.createElement('section');group.className=`pi-research-message pi-research-message-${role}`;group.setAttribute('aria-label',role==='user'?'Your message':'Assistant response');let sibling=heading.nextSibling;heading.after(group);while(sibling&&!headingSet.has(sibling)){const next=sibling.nextSibling;group.append(sibling);sibling=next;}}
}
async function readJson(app,path,optional=false) {
  try { const stat=await app.vault.adapter.stat(path);if(!stat){if(optional)return null;throw new Error(`Missing ${path}`);}if(stat.size>MAX_FILE_BYTES)throw new Error('Discover file is too large.');return JSON.parse(await app.vault.adapter.read(path)); }
  catch(error){if(optional&&!(await app.vault.adapter.exists(path)))return null;throw error;}
}
class VisualChild extends MarkdownRenderChild {
  constructor(element,plugin,reference){super(element);this.plugin=plugin;this.reference=reference;this.destroyed=false;}
  async onload(){
    const {plugin,reference}=this;
    this.containerEl.style.minHeight='460px';
    try {
      const spec=validateSpec(await readJson(plugin.app,reference.path));
      if(this.destroyed)return;
      const token=Array.from(crypto.getRandomValues(new Uint8Array(24)),n=>n.toString(16).padStart(2,'0')).join('');
      const frame=element(this.containerEl,'iframe','pi-research-visual-frame');
      frame.setAttribute('sandbox','allow-scripts');
      frame.setAttribute('referrerpolicy','no-referrer');
      frame.title=spec.title;frame.height='460';frame.setAttribute('loading',this.containerEl.closest?.('.pi-research-preflight')?'eager':'lazy');
      const win=this.containerEl.ownerDocument.defaultView;
      frame.srcdoc=buildChartDocument(spec,{token,artifactId:reference.artifactId});
      const listener=event=>{
        const data=event.data;
        if(this.destroyed||event.source!==frame.contentWindow||!data||typeof data!=='object'||data.token!==token||data.artifactId!==reference.artifactId)return;
        if(data.kind==='research-visual:resize'&&Number.isFinite(data.height)){frame.height=String(Math.max(280,Math.min(2400,Math.ceil(data.height)+2)));return;}
        if(data.kind==='research-visual:quality'&&Array.isArray(data.issues)&&data.issues.length<=30){this.containerEl.dataset.researchQuality=JSON.stringify({issues:data.issues});return;}
        if(data.kind==='research-visual:open-source'&&typeof data.url==='string'&&spec.sources?.some(source=>source.url===data.url)){win.open(data.url,'_blank','noopener,noreferrer');return;}
      };
      win.addEventListener('message',listener);this.register(()=>win.removeEventListener('message',listener));
      const fallback=element(this.containerEl,'div','pi-research-visual-fallback');
      button(fallback,'Open saved preview','image',()=>plugin.app.workspace.openLinkText(reference.path.replace(/spec\.json$/,'preview.svg'),reference.path,false),'pi-research-text-button');
      this.containerEl.style.minHeight='';
    }catch(error){if(!this.destroyed){this.containerEl.style.minHeight='';element(this.containerEl,'p','pi-research-error',`This visual could not be opened: ${error.message}`);}}
  }
  onunload(){this.destroyed=true;}
}

class ConversationPicker extends SuggestModal {
  constructor(plugin,conversations,onChoose){super(plugin.app);this.conversations=conversations;this.onChoose=onChoose;this.setPlaceholder('Choose a conversation…');}
  getSuggestions(query){const text=query.toLowerCase();return this.conversations.filter(item=>item.title.toLowerCase().includes(text));}
  renderSuggestion(item,node){element(node,'div','',item.title);element(node,'small','pi-research-picker-meta',dateLabel(item.updatedAt||item.createdAt));}
  onChooseSuggestion(item){this.onChoose(item.id);}
}

class ResearchView extends ItemView {
  constructor(leaf,plugin){super(leaf);this.plugin=plugin;this.conversationId=plugin.settings.conversationId||null;this.followLatest=plugin.settings.followLatest!==false;this.generation=0;this.renderComponent=null;this.refreshTimer=null;this.closed=false;this.lastRenderKey=null;this.renderedConversationId=null;this.keepBottom=false;this.restoringScroll=false;this.contentObserver=null;this.scrollHandler=()=>{if(!this.restoringScroll)this.keepBottom=this.contentEl.scrollHeight-this.contentEl.scrollTop-this.contentEl.clientHeight<96;};}
  getViewType(){return VIEW_TYPE;}
  getDisplayText(){return 'Discover';}
  getIcon(){return 'notebook-pen';}
  getState(){return {conversationId:this.conversationId,followLatest:this.followLatest};}
  async setState(state,result){if(validId(state?.conversationId))this.conversationId=state.conversationId;if(typeof state?.followLatest==='boolean')this.followLatest=state.followLatest;await this.refresh();await super.setState(state,result);}
  async onOpen(){this.closed=false;this.contentEl.classList.add('pi-research-view');this.contentEl.addEventListener('scroll',this.scrollHandler,{passive:true});await this.refresh();}
  async onClose(){this.closed=true;this.generation++;clearTimeout(this.refreshTimer);this.contentEl.removeEventListener('scroll',this.scrollHandler);this.contentObserver?.disconnect();if(this.renderComponent){this.removeChild(this.renderComponent);this.renderComponent=null;}}
  scheduleRefresh(path){
    if(this.closed)return;
    if(path?.startsWith('_Research/stream/')&&this.conversationId&&path===`_Research/stream/${this.conversationId}.json`){void this.updateStream();return;}
    clearTimeout(this.refreshTimer);this.refreshTimer=setTimeout(()=>this.refresh().catch(error=>this.plugin.reportError('Could not refresh research',error)),100);
  }
  async selectConversation(id,{followLatest=false}={}){
    this.conversationId=validId(id)?id:null;this.followLatest=followLatest;
    this.plugin.settings.conversationId=this.conversationId;this.plugin.settings.followLatest=this.followLatest;
    await this.plugin.saveData(this.plugin.settings);await this.refresh();
  }
  async toggleFollow(){this.followLatest=!this.followLatest;this.plugin.settings.followLatest=this.followLatest;await this.plugin.saveData(this.plugin.settings);await this.refresh();}
  async refresh(){
    if(this.closed)return;
    const generation=++this.generation;
    try {
      const marker=await readJson(this.app,'_Research/vault.json',true);
      if(generation!==this.generation||this.closed)return;
      if(this.followLatest){const active=await readJson(this.app,'_Research/active.json',true);if(validId(active?.conversationId))this.conversationId=active.conversationId;}
      let manifest=null,markdown='';
      if(marker?.id&&this.conversationId){manifest=await readJson(this.app,`Conversations/${this.conversationId}/manifest.json`,true);if(manifest){const path=`Conversations/${this.conversationId}/Conversation.md`;if(await this.app.vault.adapter.exists(path)){const stat=await this.app.vault.adapter.stat(path);if(stat?.size>MAX_FILE_BYTES)throw new Error('This conversation is too large for the reading pane. Open its note instead.');markdown=await this.app.vault.adapter.read(path);}}}
      if(generation!==this.generation||this.closed)return;
      const renderKey=manifest?JSON.stringify({id:this.conversationId,markdown,title:manifest.title,date:manifest.updatedAt||manifest.createdAt,marker:marker.id,follow:this.followLatest,vault:this.app.vault.getName()}):null;
      if(renderKey&&renderKey===this.lastRenderKey){this.restoringScroll=false;this.scrollHandler();await this.updateStream();return;}
      const sameConversation=this.renderedConversationId===this.conversationId;
      const scrollBefore=sameConversation?this.contentEl.scrollTop:0;
      const keepBottom=sameConversation&&this.contentEl.scrollHeight-this.contentEl.scrollTop-this.contentEl.clientHeight<96;
      this.keepBottom=keepBottom;this.restoringScroll=true;
      this.contentObserver?.disconnect();
      if(this.renderComponent)this.removeChild(this.renderComponent);
      this.renderComponent=new Component();this.addChild(this.renderComponent);
      this.contentEl.replaceChildren();
      const shell=element(this.contentEl,'div','pi-research-shell');
      this.renderHeader(shell,marker);
      if(!marker?.id){this.lastRenderKey=null;this.renderedConversationId=null;this.restoringScroll=false;this.renderUnlinked(shell);return;}
      if(!manifest){this.lastRenderKey=null;this.renderedConversationId=null;this.restoringScroll=false;this.renderEmpty(shell);return;}
      const article=element(shell,'article','pi-research-reading');
      const top=element(article,'div','pi-research-reading-top');
      element(top,'div','pi-research-eyebrow','CONVERSATION');
      element(top,'h1','pi-research-title',typeof manifest.title==='string'?manifest.title:'Untitled conversation');
      const metadata=element(top,'div','pi-research-meta');
      element(metadata,'span','',dateLabel(manifest.updatedAt||manifest.createdAt));
      element(metadata,'span','pi-research-meta-dot','·');
      element(metadata,'span','','Continue in Pi');
      const path=`Conversations/${this.conversationId}/Conversation.md`;
      button(metadata,'Open note','arrow-up-right',()=>this.app.workspace.openLinkText(path,'',false),'pi-research-text-button');
      const body=element(article,'div','pi-research-transcript markdown-rendered');
      // The source file is immutable/derived storage. This read-only surface hides metadata
      // and a duplicate title; it never rewrites the original answer or attachment embeds.
      const displayMarkdown=markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'').replace(/^\s*# [^\r\n]+\r?\n/,'');
      await MarkdownRenderer.render(this.app,displayMarkdown||'_Your conversation will appear here as Pi writes it._',body,path,this.renderComponent);
      if(generation!==this.generation||this.closed)return;
      styleMessageGroups(body);
      formatRendered(body);
      this.streamEl=element(article,'section','pi-research-stream');this.streamEl.hidden=true;this.streamEl.setAttribute('aria-label','Answer in progress');
      const footer=element(article,'footer','pi-research-reading-footer');element(footer,'span','pi-research-footer-mark','✦');element(footer,'span','','Kept in your vault. Ready to return to.');
      await this.updateStream();
      this.lastRenderKey=renderKey;this.renderedConversationId=this.conversationId;
      this.keepBottom=keepBottom;this.contentEl.scrollTop=keepBottom?this.contentEl.scrollHeight:scrollBefore;
      const win=this.contentEl.ownerDocument.defaultView;
      win.requestAnimationFrame(()=>{if(generation!==this.generation||this.closed)return;this.contentEl.scrollTop=keepBottom?this.contentEl.scrollHeight:scrollBefore;this.restoringScroll=false;this.scrollHandler();});
      this.contentObserver=new win.ResizeObserver(()=>{if(this.keepBottom&&!this.closed)this.contentEl.scrollTop=this.contentEl.scrollHeight;});this.contentObserver.observe(article);
    }catch(error){if(generation!==this.generation||this.closed)return;this.restoringScroll=false;this.contentEl.replaceChildren();const box=element(this.contentEl,'div','pi-research-empty');element(box,'h2','','Discover could not be opened');element(box,'p','pi-research-error',error.message);button(box,'Try again','refresh-cw',()=>this.refresh());}
  }
  renderHeader(shell,marker){
    const header=element(shell,'header','pi-research-header');
    const brand=element(header,'div','pi-research-brand');const icon=element(brand,'span','pi-research-icon');setIcon(icon,'notebook-pen');element(brand,'span','','Discover');
    element(brand,'span','pi-research-vault-name',this.app.vault.getName());
    const actions=element(header,'nav','pi-research-actions');actions.setAttribute('aria-label','Discover navigation');
    if(marker?.id)button(actions,'Conversations','messages-square',()=>this.plugin.chooseConversation(this));
    const follow=button(actions,'Follow Pi','radio',()=>this.toggleFollow());follow.setAttribute('aria-pressed',String(this.followLatest));follow.setAttribute('aria-label',this.followLatest?'Follow the latest Pi conversation: on':'Follow the latest Pi conversation: off');
  }
  renderUnlinked(shell){const empty=element(shell,'div','pi-research-empty');element(empty,'div','pi-research-eyebrow','YOUR SPACE TO EXPLORE');element(empty,'h1','pi-research-title','A place to think clearly.');element(empty,'p','','Connect this dedicated vault from Pi to begin. Your questions stay in Pi; the answers, photos, and visuals live here.');element(empty,'p','pi-research-muted','Use a separate vault for Discover to keep it independent of Scholar.');}
  renderEmpty(shell){const empty=element(shell,'div','pi-research-empty');element(empty,'div','pi-research-eyebrow','READY WHEN YOU ARE');element(empty,'h1','pi-research-title','A place to think clearly.');element(empty,'p','','Start a conversation in Pi, or choose a saved conversation above. Your questions, photos, and visuals will appear here.');}
  async updateStream(){
    const id=this.conversationId,target=this.streamEl;
    if(!id||!target||!target.isConnected)return;
    try {const stream=await readJson(this.app,`_Research/stream/${id}.json`,true);if(this.closed||id!==this.conversationId||target!==this.streamEl)return;target.replaceChildren();if(!stream||typeof stream.text!=='string'||(!stream.text&&!stream.phase)||['complete','completed','idle','cancelled'].includes(stream.status)){target.hidden=true;return;}target.hidden=false;element(target,'div','pi-research-stream-label',typeof stream.phase==='string'?stream.phase.slice(0,500):stream.status==='error'?'Interrupted in Pi':'Writing in Pi');if(stream.text)element(target,'div','pi-research-stream-text',stream.text.slice(0,MAX_FILE_BYTES));if(this.keepBottom)this.contentEl.scrollTop=this.contentEl.scrollHeight;}
    catch{target.hidden=true;}
  }
}

class PiResearchPlugin extends Plugin {
  async onload(){
    this.checks=new Set();this.checkQueue=Promise.resolve();this.stopped=false;
    this.settings={followLatest:true,conversationId:null,...await this.loadData()};
    this.registerView(VIEW_TYPE,leaf=>new ResearchView(leaf,this));
    this.addRibbonIcon('notebook-pen','Open Discover',()=>this.openReadingView());
    this.addCommand({id:'open-reading-view',name:'Open reading view',callback:()=>this.openReadingView()});
    this.addCommand({id:'choose-conversation',name:'Choose conversation',callback:async()=>this.chooseConversation(await this.openReadingView())});
    this.addCommand({id:'toggle-follow-latest',name:'Toggle follow latest Pi conversation',callback:async()=>{const view=await this.openReadingView();await view.toggleFollow();}});
    this.registerMarkdownCodeBlockProcessor('research-visual',(source,el,context)=>{try{const reference=parseVisualReference(source);context.addChild(new VisualChild(el,this,reference));}catch(error){element(el,'p','pi-research-error',`Invalid research visual: ${error.message}`);}});
    const watch=file=>{const path=file?.path;if(/^_Research\/presentation\/[a-f0-9-]{36}\.request\.json$/.test(path||'')){this.queuePresentation(path);return;}if(!path||(!path.startsWith('Conversations/')&&!path.startsWith('_Research/stream/')&&path!=='_Research/active.json'&&path!=='_Research/vault.json'))return;for(const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE))leaf.view.scheduleRefresh(path);};
    for(const event of ['create','modify','delete'])this.registerEvent(this.app.vault.on(event,watch));
    this.registerEvent(this.app.vault.on('rename',(file,oldPath)=>{watch(file);watch({path:oldPath});}));
    // Only inspect the small request directory, never the vault's note collection.
    if(await this.app.vault.adapter.exists('_Research/presentation')){const pending=await this.app.vault.adapter.list('_Research/presentation');for(const path of pending.files)watch({path});}
  }
  onunload(){this.stopped=true;}
  onUserEnable(){this.openReadingView().catch(error=>this.reportError('Could not open Discover',error));}
  queuePresentation(path){if(this.checks.has(path)||this.stopped)return;this.checks.add(path);this.checkQueue=this.checkQueue.then(()=>this.checkPresentation(path)).catch(()=>{}).finally(()=>this.checks.delete(path));}
  async checkPresentation(path){
    const request=await readJson(this.app,path,true);
    if(!request||request.version!==1||request.id!==path.split('/').pop().replace('.request.json','')||typeof request.digest!=='string'||typeof request.markdown!=='string'||request.markdown.length>100000||!Number.isFinite(request.expiresAt)||request.expiresAt<Date.now()||request.expiresAt>Date.now()+30000||this.stopped)return;
    const sourcePath=typeof request.sourcePath==='string'&&/^(?:Conversations|Knowledge)\/[A-Za-z0-9_./-]+\.md$/.test(request.sourcePath)&&!request.sourcePath.includes('..')?request.sourcePath:'Knowledge/Preview.md';
    const issues=markdownIssues(request.markdown),widths=[];
    const doc=this.app.workspace.containerEl?.ownerDocument||globalThis.document;
    if(!doc)return;
    for(const width of [360,760]){
      if(issues.length||this.stopped||Date.now()>request.expiresAt)break;
      const host=element(doc.body,'div','pi-research-view pi-research-preflight');host.style.width=width+'px';host.setAttribute('aria-hidden','true');
      const article=element(host,'article','pi-research-reading'),body=element(article,'div','pi-research-transcript markdown-rendered');
      const component=new Component();this.addChild(component);
      try{
        await MarkdownRenderer.render(this.app,request.markdown,body,sourcePath,component);
        formatRendered(body);
        const deadline=Math.min(request.expiresAt,Date.now()+2500);
        while(Date.now()<deadline&&[...body.querySelectorAll('.pi-research-visual-frame')].some(frame=>!frame.parentElement.dataset.researchQuality))await new Promise(resolve=>setTimeout(resolve,60));
        await new Promise(resolve=>setTimeout(resolve,100));
        widths.push(width);issues.push(...inspectRendered(body).map(issue=>({...issue,width})));
      }catch(error){issues.push({code:'render-error',width,message:String(error.message||error).slice(0,300)});}
      finally{this.removeChild(component);host.remove();}
    }
    if(!this.stopped&&Date.now()<=request.expiresAt&&await this.app.vault.adapter.exists(path))await this.app.vault.adapter.write(path.replace('.request.json','.result.json'),JSON.stringify({id:request.id,digest:request.digest,status:issues.length?'needs-fix':widths.length===2?'passed':'unverified',checked:'Obsidian rendered layout',widths,issues:issues.slice(0,30)}));
  }
  async openReadingView(){let leaf=this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];if(!leaf){leaf=this.app.workspace.getLeaf('tab');await leaf.setViewState({type:VIEW_TYPE,active:true});}await this.app.workspace.revealLeaf(leaf);return leaf.view;}
  async listConversations(){
    if(!(await this.app.vault.adapter.exists('Conversations')))return[];
    const listing=await this.app.vault.adapter.list('Conversations');const conversations=[];
    for(const folder of listing.folders.slice(0,2000)){const id=folder.split('/').pop();if(!validId(id))continue;try{const manifest=await readJson(this.app,`${folder}/manifest.json`,true);if(manifest?.id===id)conversations.push({...manifest,id,title:typeof manifest.title==='string'?manifest.title:'Untitled conversation'});}catch{/* A partially synchronized manifest is skipped until its next vault event. */}}
    return conversations.sort((a,b)=>String(b.updatedAt||b.createdAt||'').localeCompare(String(a.updatedAt||a.createdAt||'')));
  }
  async chooseConversation(view){const conversations=await this.listConversations();if(!conversations.length){new Notice('No research conversations yet. Start one in Pi.');return;}new ConversationPicker(this,conversations,id=>view.selectConversation(id)).open();}
  reportError(prefix,error){new Notice(`${prefix}: ${error.message||String(error)}`);}
}

module.exports=PiResearchPlugin;
module.exports.ResearchView=ResearchView;
module.exports.VisualChild=VisualChild;
module.exports.parseVisualReference=parseVisualReference;
module.exports.VIEW_TYPE=VIEW_TYPE;
