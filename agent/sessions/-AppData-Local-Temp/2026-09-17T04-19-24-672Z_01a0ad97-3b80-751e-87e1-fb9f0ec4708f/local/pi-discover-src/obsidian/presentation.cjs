'use strict';

function markdownIssues(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim() || markdown.length > 100000) throw new Error('Presentation Markdown must contain 1–100000 characters.');
  const issues = [], lines = markdown.split(/\r?\n/);
  let fence = null;
  const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').replace(/\\\|/g, ' ').replace(/`[^`]*`/g, 'code').split('|');
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (match) {
      if (!fence) fence = { character: match[1][0], length: match[1].length, line: i + 1, mermaid: match[2].trim()==='mermaid', chars: 0 };
      else if (match[1][0] === fence.character && match[1].length >= fence.length && !match[2].trim()) { if(fence.mermaid&&(fence.chars>6000||i+1-fence.line>80))issues.push({code:'dense-diagram',line:fence.line,message:'Split this Mermaid block into smaller diagrams (at most 6000 characters and 80 lines each).'}); fence = null; }
      continue;
    }
    if (fence) { fence.chars+=lines[i].length;continue; }
    if (!lines[i].includes('|') || !lines[i + 1]?.includes('-')) continue;
    const separator = cells(lines[i + 1]);
    if (!separator.every(cell => /^\s*:?-{3,}:?\s*$/.test(cell))) continue;
    const count = cells(lines[i]).length;
    if (separator.length !== count) issues.push({ code: 'table-columns', line: i + 1, message: 'Table header and separator have different column counts.' });
    if (count > 4) issues.push({ code: 'wide-table', line: i + 1, message: 'Split this table into comparisons of at most four columns for a narrow reading pane.' });
    i += 2;
    for (; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) {
      if (cells(lines[i]).length !== count) issues.push({ code: 'table-columns', line: i + 1, message: 'Table row has a different number of cells. Escape literal pipes or repair the row.' });
    }
    i--;
  }
  if (fence) issues.push({ code: 'unclosed-fence', line: fence.line, message: 'Close the fenced block before sending the answer.' });
  return issues.slice(0, 30);
}

function hasPresentation(markdown) { return /(?:^|\n)\s*(?:```|~~~)(?:mermaid|research-visual)\b|(?:^|\n)\s*\|?.*\|.*\n\s*\|?\s*:?-{3,}/.test(markdown); }

function formatRendered(container) {
  for (const table of container.querySelectorAll('table')) {
    table.classList.add('pi-research-table');
    for (const cell of table.querySelectorAll('td')) if (/^\s*[−+\-]?[\d,.]+(?:\s*%|\s*[a-zA-Z/]+)?\s*$/.test(cell.textContent)) cell.classList.add('pi-research-number');
  }
  for (const code of container.querySelectorAll('pre')) code.classList.add('pi-research-code');
}

function inspectSvg(svg, label = 'Diagram') {
  const issues = [], frame = svg.getBoundingClientRect();
  if (frame.width < 1 || frame.height < 1) return [{ code: 'empty-visual', message: `${label} has no visible rendered area.` }];
  const natural = svg.viewBox?.baseVal;
  const scale = natural?.width ? frame.width / natural.width : 1;
  const win = svg.ownerDocument.defaultView;
  const labels = [...svg.querySelectorAll('text, .nodeLabel, .edgeLabel p')].filter(node => !node.closest('defs, title, desc') && node.textContent.trim()).map(node => ({ node, box: node.getBoundingClientRect() })).filter(item => item.box.width > 0 && item.box.height > 0);
  if (labels.length > 150) return [{ code: 'dense-diagram', message: `${label} contains too many labels. Split it into smaller diagrams.` }];
  for (let i = 0; i < labels.length; i++) {
    const { node, box } = labels[i], text = node.textContent.trim().slice(0, 65);
    if(node.hasAttribute('data-label-truncated'))issues.push({code:'truncated-label',message:`${label}: “${text}” was shortened to fit. Use a concise axis/category label and put details in the caption.`});
    const size = parseFloat(win.getComputedStyle(node).fontSize) * scale;
    if (Number.isFinite(size) && size < 10.8) issues.push({ code: 'small-label', message: `${label}: “${text}” renders at ${size.toFixed(1)} px. Use fewer nodes, shorter labels, or top-to-bottom flow.` });
    if (box.left < frame.left - 2 || box.right > frame.right + 2 || box.top < frame.top - 2 || box.bottom > frame.bottom + 2) issues.push({ code: 'clipped-label', message: `${label}: “${text}” extends beyond the visual.` });
    for (let j = 0; j < i; j++) {
      const other = labels[j];
      if (node.contains(other.node) || other.node.contains(node)) continue;
      const overlapX = Math.min(box.right, other.box.right) - Math.max(box.left, other.box.left);
      const overlapY = Math.min(box.bottom, other.box.bottom) - Math.max(box.top, other.box.top);
      if (overlapX > 2 && overlapY > 2) { issues.push({ code: 'overlapping-labels', message: `${label}: “${text}” overlaps another label. Shorten labels or simplify the visual.` }); break; }
    }
  }
  return issues.slice(0, 20);
}

function inspectRendered(container) {
  const issues = [], width = Math.round(container.getBoundingClientRect().width);
  if (container.scrollWidth > container.clientWidth + 3) issues.push({ code: 'overflow', message: `Content overflows the ${width}px reading width.` });
  for (const error of container.querySelectorAll('.pi-research-error, .mermaid-error, .error-icon, .error-text')) issues.push({ code: 'render-error', message: (error.textContent || 'A diagram failed to render.').trim().slice(0, 250) });
  for (const code of container.querySelectorAll('code.language-mermaid')) issues.push({ code: 'unrendered-mermaid', message: 'Mermaid remained a code block instead of a rendered diagram.' });
  for (const svg of container.querySelectorAll('svg')) issues.push(...inspectSvg(svg));
  const win = container.ownerDocument.defaultView;
  const rgb = value => { const match=value.match(/^rgba?\(([^)]+)\)/); if(!match)return null;const parts=match[1].split(/[,\s/]+/).filter(Boolean).map(Number);return parts.length<4||parts[3]===1?parts.slice(0,3):null; };
  const luminance = values => values.map(value=>{const c=value/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;}).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
  for(const node of [...container.querySelectorAll('p,th,td,li,summary')].slice(0,500)){
    if(!node.getBoundingClientRect().height)continue;
    const foreground=rgb(win.getComputedStyle(node).color);let background=null,ancestor=node;
    while(ancestor&&!background){background=rgb(win.getComputedStyle(ancestor).backgroundColor);ancestor=ancestor.parentElement;}
    if(foreground&&background){const a=luminance(foreground),b=luminance(background);if((Math.max(a,b)+.05)/(Math.min(a,b)+.05)<4.5){issues.push({code:'low-contrast',message:`Text has insufficient contrast against its background at ${width}px. Use the Discover theme's normal text colors.`});break;}}
  }
  for (const table of container.querySelectorAll('table')) {
    for (const cell of table.querySelectorAll('th,td')) {
      if (parseFloat(win.getComputedStyle(cell).fontSize) < 11 || cell.scrollWidth > cell.clientWidth + 3) { issues.push({ code: 'table-layout', message: `Table text is too small or clipped at ${width}px. Shorten cells or split the comparison.` }); break; }
    }
  }
  for (const frame of container.querySelectorAll('.pi-research-visual-frame')) {
    const report = frame.parentElement.dataset.researchQuality;
    if (!report) issues.push({ code: 'chart-not-ready', message: 'The chart did not finish its layout check.' });
    else { try { issues.push(...JSON.parse(report).issues); } catch { issues.push({ code: 'chart-check-failed', message: 'Chart returned an invalid layout report.' }); } }
  }
  return issues.slice(0, 30);
}

module.exports = { markdownIssues, hasPresentation, formatRendered, inspectSvg, inspectRendered };
