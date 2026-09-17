'use strict';
const {inspectSvg} = require('./presentation.cjs');

// This module is shared by the Pi package and the offline Obsidian companion.
// Only this declarative schema reaches the chart renderer. No generated code or HTML.
const MAX_NUMBER = 1e15;
function text(value, name, max, required = true) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must be a nonempty string of at most ${max} characters.`);
  return value;
}
function keys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unsupported ${name} field: ${key}`);
}
function number(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_NUMBER) throw new Error(`${name} must be finite and between -1e15 and 1e15.`);
  return value;
}
function validateSpec(input) {
  keys(input, ['type', 'title', 'xLabel', 'yLabel', 'series', 'sources', 'caption'], 'chart');
  if (!['line', 'bar', 'scatter'].includes(input.type)) throw new Error('Chart type must be line, bar, or scatter.');
  const output = {type: input.type, title: text(input.title, 'title', 160), xLabel: text(input.xLabel, 'xLabel', 120), yLabel: text(input.yLabel, 'yLabel', 120)};
  if (!Array.isArray(input.series) || !input.series.length || input.series.length > 8) throw new Error('Provide between 1 and 8 series.');
  const names = new Set(); let count = 0;
  output.series = input.series.map((series, i) => {
    keys(series, ['name', 'points'], `series ${i + 1}`);
    const name = text(series.name, 'series name', 80);
    if (names.has(name)) throw new Error('Series names must be unique.');
    names.add(name);
    if (!Array.isArray(series.points) || !series.points.length || series.points.length > 1000) throw new Error('Each series needs between 1 and 1000 points.');
    const seen = new Set();
    const points = series.points.map((point, j) => {
      keys(point, ['x', 'y'], `point ${j + 1}`);
      const x = typeof point.x === 'string' && input.type === 'bar' ? text(point.x, 'category', 80) : number(point.x, 'x');
      if (input.type === 'bar') {
        const category = String(x);
        if (seen.has(category)) throw new Error('Each bar series must have unique categories.');
        seen.add(category);
      }
      count++;
      return {x, y: number(point.y, 'y')};
    });
    if (input.type === 'line') { points.sort((a, b) => a.x - b.x); if (points.some((point,index)=>index&&point.x===points[index-1].x)) throw new Error('Line series need unique x values; use scatter for repeated observations.'); }
    return {name, points};
  });
  if (count > 4000) throw new Error('A chart can contain at most 4000 points.');
  if (input.type === 'bar' && new Set(output.series.flatMap(s => s.points.map(p => String(p.x)))).size > 60) throw new Error('A bar chart can contain at most 60 categories.');
  if (input.sources !== undefined) {
    if (!Array.isArray(input.sources) || input.sources.length > 12) throw new Error('Sources must be a list of at most 12 links.');
    output.sources = input.sources.map(source => {
      keys(source, ['title', 'url'], 'source');
      const title = text(source.title, 'source title', 200), url = text(source.url, 'source URL', 2048);
      let parsed;
      try { parsed = new URL(url); } catch { throw new Error('Source URLs must be valid HTTP or HTTPS URLs.'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Source URLs must use HTTP or HTTPS without credentials.');
      return {title, url: parsed.href};
    });
  }
  if (input.caption !== undefined) output.caption = text(input.caption, 'caption', 1000);
  return output;
}
function escapeXml(value) { return String(value).replace(/[&<>"']/g, character => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[character])); }
function scriptJson(value) { return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }
function formatNumber(value) { return Math.abs(value) >= 1e6 || (value !== 0 && Math.abs(value) < 0.001) ? value.toExponential(1) : Number(value.toPrecision(4)).toLocaleString('en-US'); }
function niceStep(low,high,count=5) {const raw=(high-low)/Math.max(1,count-1),unit=10**Math.floor(Math.log10(raw)),fraction=raw/unit;return (fraction<1.5?1:fraction<2.25?2:fraction<3.5?2.5:fraction<7.5?5:10)*unit;}
function niceTicks(low,high,count=5) {const step=niceStep(low,high,count),start=Math.ceil(low/step)*step,values=[];for(let i=0;i<12;i++){const value=start+i*step;if(value>high+step*1e-7)break;values.push(Math.abs(value)<step*1e-8?0:value);}return values.length<2?[low,high]:values;}
function chartLayout(spec, width, height) {
  const margin = {left:76, right:18, top:22, bottom:70};
  const points = spec.series.flatMap(series => series.points);
  let loY = Math.min(...points.map(point => point.y)), hiY = Math.max(...points.map(point => point.y));
  if (spec.type === 'bar') { loY = Math.min(loY, 0); hiY = Math.max(hiY, 0); }
  if (loY === hiY) { const pad = Math.max(Math.abs(loY) * 0.1, 1); loY -= pad; hiY += pad; }
  else if (spec.type !== 'bar') { const pad = (hiY - loY) * .08, positive=loY>=0, negative=hiY<=0; loY=positive?Math.max(0,loY-pad):loY-pad; hiY=negative?Math.min(0,hiY+pad):hiY+pad; }
  const yStep=niceStep(loY,hiY);loY=Math.floor(loY/yStep)*yStep;hiY=Math.ceil(hiY/yStep)*yStep;
  const categories = spec.type === 'bar' ? [...new Set(points.map(point => String(point.x)))] : [];
  let loX = spec.type === 'bar' ? 0 : Math.min(...points.map(point => point.x));
  let hiX = spec.type === 'bar' ? categories.length : Math.max(...points.map(point => point.x));
  if (loX === hiX) { const pad = Math.max(Math.abs(loX) * .1, 1); loX -= pad; hiX += pad; }
  const left = margin.left, top = margin.top, right = width - margin.right, bottom = height - margin.bottom;
  const band = (right-left) / Math.max(categories.length,1);
  const x = value => spec.type === 'bar' ? left + (categories.indexOf(String(value)) + .5) * band : left + 5 + ((value-loX)/(hiX-loX)) * (right-left-10);
  const y = value => bottom - 5 - ((value-loY)/(hiY-loY)) * (bottom-top-10);
  return {left,top,right,bottom,loY,hiY,loX,hiX,categories,band,x,y};
}
function renderPlotSvg(spec, width, height, hiddenSeries = []) {
  const l = chartLayout(spec, width, height), e = escapeXml;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="chart-title chart-description" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><title id="chart-title">${e(spec.title)}</title><desc id="chart-description">${e(`${spec.type} chart. ${spec.xLabel}; ${spec.yLabel}. ${spec.series.map(s=>s.name).join(', ')}. Data table follows the interactive chart.`)}</desc><defs><clipPath id="chart-clip"><rect x="${l.left}" y="${l.top}" width="${l.right-l.left}" height="${l.bottom-l.top}"/></clipPath></defs><style>svg{color-scheme:dark;color:#dadada;font:12px Arial,sans-serif;background:#1e1e1e}text{fill:currentColor}.grid{stroke:#363636;stroke-width:1}.axis{stroke:#737373;stroke-width:1}.series-0{--series:#a3c7aa}.series-1{--series:#bba6d7}.series-2{--series:#dab06d}.series-3{--series:#9cbfd7}.series-4{--series:#dba2a0}.series-5{--series:#8fc4c0}.series-6{--series:#c5b682}.series-7{--series:#cca3c4}</style>`];
  for (const value of niceTicks(l.loY,l.hiY,6)) { const y=l.y(value); parts.push(`<line class="grid" x1="${l.left}" y1="${y}" x2="${l.right}" y2="${y}"/><text x="${l.left-9}" y="${y+4}" text-anchor="end">${e(formatNumber(value))}</text>`); }
  parts.push(`<path class="axis" fill="none" d="M${l.left} ${l.top}V${l.bottom}H${l.right}"/>`);
  const maxTicks = width < 500 ? 3 : 5;
  const xTicks = spec.type === 'bar' ? l.categories.filter((_,i) => i % Math.max(1,Math.ceil(l.categories.length/maxTicks)) === 0) : niceTicks(l.loX,l.hiX,maxTicks);
  const tickCharacters=Math.max(5,Math.floor((l.right-l.left)/maxTicks/7)-1);
  xTicks.forEach((value,index)=> { let label=spec.type==='bar'?String(value):formatNumber(value);const truncated=label.length>tickCharacters;if(truncated) label=label.slice(0,tickCharacters-1)+'…';const anchor=spec.type==='bar'?'middle':index===0?'start':index===xTicks.length-1?'end':'middle'; parts.push(`<text${truncated?' data-label-truncated="true"':''} x="${l.x(value)}" y="${l.bottom+20}" text-anchor="${anchor}">${e(label)}</text>`); });
  const truncate=(value,max)=>value.length>max?value.slice(0,max-1)+'…':value;
  parts.push(`<text${spec.xLabel.length>Math.floor((l.right-l.left)/7)?' data-label-truncated="true"':''} x="${(l.left+l.right)/2}" y="${height-12}" text-anchor="middle"><title>${e(spec.xLabel)}</title>${e(truncate(spec.xLabel,Math.floor((l.right-l.left)/7)))}</text><text${spec.yLabel.length>Math.floor((l.bottom-l.top)/7)?' data-label-truncated="true"':''} transform="translate(17 ${(l.top+l.bottom)/2}) rotate(-90)" text-anchor="middle"><title>${e(spec.yLabel)}</title>${e(truncate(spec.yLabel,Math.floor((l.bottom-l.top)/7)))}</text>`);
  spec.series.forEach((series,si)=> {
    if (hiddenSeries.includes(series.name)) return;
    parts.push(`<g class="series-${si}" clip-path="url(#chart-clip)">`);
    if (spec.type === 'line') parts.push(`<polyline fill="none" stroke="var(--series)" stroke-width="2"${si%3?` stroke-dasharray="${si%3===1?'6 4':'2 4'}"`:''} points="${series.points.map(point=>`${l.x(point.x)},${l.y(point.y)}`).join(' ')}"/>`);
    series.points.forEach((point,pi)=> {
      const x=l.x(point.x),y=l.y(point.y),label=e(`${series.name}: ${point.x}, ${point.y}`);
      if(spec.type==='bar') { const bw=Math.max(.5,l.band*.76/spec.series.length),bx=x-l.band*.38+si*bw,zero=l.y(0); parts.push(`<rect data-series="${si}" data-point="${pi}" x="${bx}" y="${Math.min(y,zero)}" width="${bw}" height="${Math.max(.5,Math.abs(zero-y))}" fill="var(--series)"><title>${label}</title></rect>`); }
      else { parts.push(`<circle cx="${x}" cy="${y}" r="${spec.type==='scatter'?3.5:2.5}" fill="var(--series)"/><circle data-series="${si}" data-point="${pi}" cx="${x}" cy="${y}" r="13" fill="transparent"><title>${label}</title></circle>`); }
    });
    parts.push('</g>');
  });
  parts.push('</svg>'); return parts.join('');
}
function dimensions(options={}) { return {width:Number.isFinite(options.width)?Math.max(320,Math.min(1600,Math.round(options.width))):720,height:Number.isFinite(options.height)?Math.max(260,Math.min(900,Math.round(options.height))):360}; }
function renderPreviewSvg(input, options={}) { const spec=validateSpec(input),{width,height}=dimensions(options); return renderPlotSvg(spec,width,height); }
function chartRuntime(spec, config) {
  const plot=document.getElementById('plot'), legend=document.getElementById('legend'), tooltip=document.getElementById('tooltip');
  let hidden=[];
  const buttons=[];
  function post(kind, extra) { if(config.token) parent.postMessage({kind,token:config.token,artifactId:config.artifactId,...extra},'*'); }
  function render() {
    const width=Math.max(240,Math.floor(plot.getBoundingClientRect().width)),height=width<500?320:360;
    plot.innerHTML=renderPlotSvg(spec,width,height,hidden);
    buttons.forEach((button,i)=>button.setAttribute('aria-pressed',String(!hidden.includes(spec.series[i].name))));
    tooltip.hidden=true;
    setTimeout(()=>{const svg=plot.querySelector('svg');if(svg){const issues=inspectSvg(svg,'Chart');if(document.body.scrollWidth>document.documentElement?.clientWidth+3)issues.push({code:'chart-overflow',message:'Chart title, legend or caption overflows its frame. Shorten the text.'});post('research-visual:quality',{issues,width});}},100);
  }
  spec.series.forEach((series,i)=> {const button=document.createElement('button');button.type='button';button.textContent=series.name;button.className=`series-toggle series-${i}`;button.style.setProperty('--series',['#a3c7aa','#bba6d7','#dab06d','#9cbfd7','#dba2a0','#8fc4c0','#c5b682','#cca3c4'][i]);button.setAttribute('aria-pressed','true');button.addEventListener('click',()=>{hidden=hidden.includes(series.name)?hidden.filter(name=>name!==series.name):[...hidden,series.name];render();});legend.append(button);buttons.push(button);});
  function showPoint(event) {const target=event.target.closest('[data-point]'); if(!target){tooltip.hidden=true;return;} const series=spec.series[Number(target.dataset.series)],point=series?.points[Number(target.dataset.point)];if(!point)return; tooltip.textContent=`${series.name} · ${spec.xLabel}: ${point.x} · ${spec.yLabel}: ${point.y}`;tooltip.hidden=false;}
  plot.addEventListener('pointermove',showPoint);plot.addEventListener('click',showPoint);plot.addEventListener('pointerleave',()=>{tooltip.hidden=true;});
  document.addEventListener('click',event=>{const link=event.target.closest('a');if(link&&config.token){event.preventDefault();post('research-visual:open-source',{url:link.href});}});
  new ResizeObserver(render).observe(plot);render();
  new ResizeObserver(()=>post('research-visual:resize',{height:Math.ceil(document.documentElement.getBoundingClientRect().height)})).observe(document.body);
}
function buildChartDocument(input, options={}) {
  const spec=validateSpec(input),token=typeof options.token==='string'&&/^[a-zA-Z0-9_-]{8,128}$/.test(options.token)?options.token:'',artifactId=typeof options.artifactId==='string'?options.artifactId:'';
  const nonce=token||'offline-research-chart';
  const config={token,artifactId};
  const sources=(spec.sources||[]).map(source=>`<li><a href="${escapeXml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeXml(source.title)}</a></li>`).join('');
  const rows=spec.series.flatMap(series=>series.points.map(point=>`<tr><th scope="row">${escapeXml(series.name)}</th><td>${escapeXml(point.x)}</td><td>${escapeXml(point.y)}</td></tr>`)).join('');
  const runtime=[escapeXml,formatNumber,niceStep,niceTicks,chartLayout,renderPlotSvg,inspectSvg,chartRuntime].map(fn=>fn.toString()).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'"><title>${escapeXml(spec.title)}</title><style>:root{color-scheme:dark;font:14px/1.5 system-ui,sans-serif;color:#dadada;background:#1e1e1e}*{box-sizing:border-box}body{margin:0;padding:16px}h1{font:400 23px/1.3 Georgia,serif;margin:0 0 14px}#legend{display:flex;gap:8px 18px;flex-wrap:wrap;margin-bottom:6px}.series-toggle{font:inherit;color:inherit;background:transparent;border:0;border-bottom:2px solid transparent;padding:5px 0;cursor:pointer}.series-toggle::before{content:"";display:inline-block;width:13px;height:2px;margin-right:6px;vertical-align:middle;background:var(--series,currentColor)}.series-toggle[aria-pressed=true]{border-color:currentColor}.series-toggle[aria-pressed=false]{opacity:.55}#plot{width:100%;min-width:0}#plot>svg{display:block;width:100%;height:auto}#tooltip{min-height:22px;font-size:12px;margin:5px 0}#tooltip[hidden]{display:block;visibility:hidden}p{margin:10px 0}a{color:inherit}details{margin-top:14px}summary{cursor:pointer}table{border-collapse:collapse;width:100%;font-size:12px}th,td{text-align:left;overflow-wrap:anywhere;padding:6px;border-bottom:1px solid #363636}th{font-weight:500}ul{padding-left:18px}.table-wrap{overflow-x:auto}button:focus-visible{outline:2px solid currentColor;outline-offset:3px}@media(max-width:400px){body{padding:10px}}</style></head><body><h1>${escapeXml(spec.title)}</h1><div id="legend" aria-label="Visible series"></div><div id="plot">${renderPreviewSvg(spec)}</div><p id="tooltip" role="status" hidden></p>${spec.caption?`<p>${escapeXml(spec.caption)}</p>`:''}${sources?`<details><summary>Sources</summary><ul>${sources}</ul></details>`:''}<details><summary>View data</summary><div class="table-wrap"><table><thead><tr><th>Series</th><th>${escapeXml(spec.xLabel)}</th><th>${escapeXml(spec.yLabel)}</th></tr></thead><tbody>${rows}</tbody></table></div></details><script nonce="${nonce}">${runtime}\nchartRuntime(${scriptJson(spec)},${scriptJson(config)});</script></body></html>`;
}
module.exports={validateSpec,renderPreviewSvg,buildChartDocument};
