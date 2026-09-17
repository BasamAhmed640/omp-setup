import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const {validateSpec,renderPreviewSvg,buildChartDocument}=require('../obsidian/visual.cjs');
const base=()=>({type:'line',title:'Observed values',xLabel:'Elapsed time (minutes)',yLabel:'Distance (m)',series:[{name:'Trial A',points:[{x:0,y:1},{x:2,y:4}]}],sources:[{title:'Source record',url:'https://example.org/data'}]});

test('schema normalizes a copy and sorts numeric line data without changing input',()=>{const input=base();input.series[0].points.reverse();const output=validateSpec(input);assert.deepEqual(output.series[0].points.map(p=>p.x),[0,2]);assert.equal(input.series[0].points[0].x,2);assert.notEqual(input.series,output.series);});
test('schema rejects unsupported execution/configuration fields',()=>{for(const extra of [{html:'<script>bad()</script>'},{script:'evil()'},{renderer:'https://example.org/evil.js'}])assert.throws(()=>validateSpec({...base(),...extra}),/Unsupported/);assert.throws(()=>validateSpec({...base(),type:'function'}),/type/);});
test('schema checks finite values, numeric continuous axes and unique categorical bars',()=>{for(const value of [NaN,Infinity,-Infinity,1e16,'5']){const spec=base();spec.series[0].points[0].y=value;assert.throws(()=>validateSpec(spec),/finite/);}const line=base();line.series[0].points[0].x='Tuesday';assert.throws(()=>validateSpec(line),/finite/);const bar={...base(),type:'bar'};bar.series[0].points=[{x:'A',y:1},{x:'A',y:3}];assert.throws(()=>validateSpec(bar),/unique categories/);});
test('schema bounds input size and rejects duplicate series names',()=>{const spec=base();spec.series.push({...spec.series[0]});assert.throws(()=>validateSpec(spec),/unique/);spec.series=Array.from({length:5},(_,i)=>({name:String(i),points:Array.from({length:1000},(_,x)=>({x,y:x}))}));assert.throws(()=>validateSpec(spec),/4000/);assert.throws(()=>validateSpec({...base(),title:'x'.repeat(161)}),/160/);});
test('source links only allow HTTP(S), without credential-bearing URLs',()=>{for(const url of ['javascript:alert(1)','file:///etc/passwd','data:text/html,evil','https://user:pass@example.org'])assert.throws(()=>validateSpec({...base(),sources:[{title:'Source',url}]}),/HTTP/);});
test('preview escapes untrusted labels and finite charts never contain NaN or Infinity',()=>{for(const type of ['line','bar','scatter']){const spec=base();spec.type=type;spec.title='</title><script>alert(1)</script>';spec.series[0].name='<img onerror="evil">';spec.series[0].points=[{x:0,y:0}];const svg=renderPreviewSvg(spec,{width:360});assert.ok(!svg.includes('<script>'));assert.ok(svg.includes('&lt;script&gt;'));assert.ok(!svg.includes('NaN'));assert.ok(!svg.includes('Infinity'));assert.match(svg,/viewBox="0 0 360 360"/);}});
test('chart document has a restrictive CSP and cannot close its script through chart data',()=>{const spec=base();spec.title='</script><script>globalThis.pwned=true</script>';spec.caption='<img src=x onerror=evil()>';const html=buildChartDocument(spec,{token:'testtoken1234',artifactId:'chart-a'});assert.match(html,/default-src 'none'/);assert.match(html,/script-src 'nonce-testtoken1234'/);assert.match(html,/connect-src 'none'/);assert.ok(!html.includes('<script>globalThis.pwned'));assert.equal((html.match(/<script nonce=/g)||[]).length,1);assert.equal((html.match(/<\/script>/g)||[]).length,1);const script=html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];assert.doesNotThrow(()=>new vm.Script(script));});
test('artifact documents include accessible tables, all observations, and sources',()=>{const html=buildChartDocument(base());assert.match(html,/<summary>View data<\/summary>/);assert.match(html,/<td>2<\/td><td>4<\/td>/);assert.match(html,/https:\/\/example.org\/data/);assert.match(html,/aria-pressed/);});

test('chart controls and hover work locally and reset when reopened, without state messages',()=>{
  const run=()=>{
    const messages=[];
    const node=()=>({children:[],attributes:{},listeners:{},style:{setProperty(){}},querySelector(){return {getBoundingClientRect:()=>({width:600,height:360}),querySelectorAll:()=>[],ownerDocument:{defaultView:{}}};},append(child){this.children.push(child);},setAttribute(name,value){this.attributes[name]=value;},addEventListener(name,fn){this.listeners[name]=fn;},getBoundingClientRect(){return{width:600};}});
    const nodes={plot:node(),legend:node(),tooltip:node()},listeners={};
    const document={getElementById:id=>nodes[id],createElement:node,addEventListener:(name,fn)=>{listeners[name]=fn;},body:{}};
    const html=buildChartDocument(base(),{token:'testtoken1234',artifactId:'chart-a'});
    const script=html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
    vm.runInNewContext(script,{document,setTimeout:fn=>fn(),parent:{postMessage:message=>messages.push(message)},ResizeObserver:class{observe(){}}});
    return{nodes,messages,listeners};
  };
  const {nodes,messages,listeners}=run(),toggle=nodes.legend.children[0];
  assert.equal(toggle.attributes['aria-pressed'],'true');
  toggle.listeners.click();
  assert.equal(toggle.attributes['aria-pressed'],'false');
  assert.doesNotMatch(nodes.plot.innerHTML,/data-point="0"/);
  assert.ok(messages.every(message=>message.kind==='research-visual:quality'));
  assert.equal(run().nodes.legend.children[0].attributes['aria-pressed'],'true');
  toggle.listeners.click();
  nodes.plot.listeners.pointermove({target:{closest:()=>({dataset:{series:'0',point:'1'}})}});
  assert.equal(nodes.tooltip.hidden,false);
  assert.match(nodes.tooltip.textContent,/Distance \(m\): 4/);
  listeners.click({target:{closest:()=>({href:'https://example.org/data'})},preventDefault(){}});
  assert.equal(messages.at(-1).kind,'research-visual:open-source');
  assert.equal(messages.at(-1).url,'https://example.org/data');
});
