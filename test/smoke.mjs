import {JSDOM, VirtualConsole} from 'jsdom';
import {readFileSync} from 'node:fs';

const html = readFileSync('src/app.html','utf8');
const errors = [];
const ignore = m => /Not implemented/.test(m);
const vc = new VirtualConsole()
  .on('jsdomError', e => { const m = 'jsdomError: ' + (e.detail?.stack || e.message); if(!ignore(m)) errors.push(m); })
  .on('error', (...a) => { const m = 'console.error: ' + a.join(' '); if(!ignore(m)) errors.push(m); });

const dom = new JSDOM(html, {runScripts:'dangerously', pretendToBeVisual:true, virtualConsole:vc});
const w = dom.window;
await new Promise(r => setTimeout(r, 400));
const bail = (label) => { if(errors.length){ console.log('--- ERRORS ('+label+') ---'); errors.forEach(e=>console.log(e)); process.exit(1); } };
bail('load');

const g = w.go;
for(const s of ['pitch','dash','cases','new','radio','proms','cohort','model']){
  try{ g(s); }catch(e){ console.log('FAIL rendering '+s+': '+e.stack); process.exit(1); }
  const c = w.document.querySelector('#content');
  console.log(`${s.padEnd(7)} ok  nodes=${String(c.children.length).padEnd(2)} text=${String(c.textContent.length).padEnd(5)} svg=${c.querySelectorAll('svg').length}  "${w.document.querySelector('#scTitle').textContent}"`);
}
bail('screens');

try{
  g('cases');
  w.document.querySelector('#content tbody tr.clickable').dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
  const c = w.document.querySelector('#content');
  console.log(`case    ok  text=${c.textContent.length} svg=${c.querySelectorAll('svg').length}  "${w.document.querySelector('#scTitle').textContent}"`);
}catch(e){ console.log('FAIL case detail: '+e.stack); process.exit(1); }

try{
  g('new');
  const sels = [...w.document.querySelectorAll('.lvrow select')];
  sels[0].value='adr'; sels[0].dispatchEvent(new w.Event('change'));
  const sels2 = [...w.document.querySelectorAll('.lvrow select')];
  sels2[2].value='fusion'; sels2[2].dispatchEvent(new w.Event('change'));
  console.log('builder ok  "'+w.document.querySelector('.readout .cls').textContent+'"');
  console.log('builder ok  sig: '+w.document.querySelector('.readout .sig').textContent);
  console.log('builder ok  mobile/fused/index/adjacent/hybrid = '+
    [...w.document.querySelectorAll('.readout .mv')].map(x=>x.textContent).join(' / '));
}catch(e){ console.log('FAIL builder: '+e.stack); process.exit(1); }

try{
  w.document.querySelector('#themeBtn').dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
  console.log('theme   ok  data-theme='+w.document.documentElement.getAttribute('data-theme'));
}catch(e){ console.log('FAIL theme: '+e.stack); process.exit(1); }
bail('interactions');

// data sanity
const ev = x => w.eval(x);
console.log('\n--- data sanity ---');
console.log('cases:', ev('CASES.length'),
  '| hybrid:', ev('CASES.filter(c=>c.construct.hybrid).length'),
  '| cervical:', ev("CASES.filter(c=>c.region==='Cervical').length"),
  '| lumbar:', ev("CASES.filter(c=>c.region==='Lumbar').length"));
console.log('distinct construct types:', ev('new Set(CASES.map(c=>c.construct.type)).size'));
console.log('no index level (want 0):', ev('CASES.filter(c=>!c.construct.indexLevels.length).length'));
console.log('implant missing UDI (want 0):', ev('CASES.flatMap(c=>c.construct.indexLevels.filter(l=>c.levels[l].device&&!c.levels[l].udi)).length'));
console.log('adjacent levels computed (want >0):', ev('CASES.filter(c=>c.construct.adjacent.length).length'));
console.log('ankylosed:', ev('CASES.filter(c=>c.ankylosed).length'),
            '| ASD:', ev('CASES.filter(c=>c.asd).length'),
            '| reop:', ev('CASES.filter(c=>c.reop).length'),
            '| HO III-IV:', ev('CASES.filter(c=>c.hoGrade>=3).length'));
for(const k of ['3m','1y','2y','5y','10y']) console.log('fu '+k.padEnd(4)+': '+ev('(r=>r.n+"/"+r.d+" = "+(r.rate==null?"n/a":r.rate.toFixed(1)+"%"))(fuRate("'+k+'"))'));

// render the most mature case
const mature = ev('[...CASES].sort((a,b)=>b.daysSince-a.daysSince)[0].id');
ev('openCase("'+mature+'")');
const c = w.document.querySelector('#content');
console.log('\nmature case '+mature+': text='+c.textContent.length+' rows='+c.querySelectorAll('tbody tr').length+' svg='+c.querySelectorAll('svg').length);
console.log('ROM chart points plotted:', c.querySelectorAll('svg circle').length);
bail('sanity');
console.log('\nALL CHECKS PASS');

// ---- modal flows ----
try{
  g('cases');
  w.document.querySelector('#content tbody tr.clickable').dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
  const btns=[...w.document.querySelectorAll('.addbtn')].map(b=>b.textContent.trim());
  console.log('\nadd buttons on case record:', btns.join(' | '));
  for(const label of ['Add visit','Add surgery','Add test']){
    const b=[...w.document.querySelectorAll('.addbtn')].find(x=>x.textContent.trim()===label);
    b.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
    const m=w.document.querySelector('.ovl .mdl');
    if(!m) throw new Error(label+' did not open a modal');
    console.log(`${label.padEnd(12)} modal ok  fields=${m.querySelectorAll('input,select,textarea').length}  title="${m.querySelector('h3').textContent}"`);
    w.document.querySelector('.xbtn').dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
  }
  // test-type dependent fields
  const b=[...w.document.querySelectorAll('.addbtn')].find(x=>x.textContent.trim()==='Add test');
  b.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
  const sel=w.document.querySelector('.mdl select');
  sel.value='DEXA'; sel.dispatchEvent(new w.Event('change'));
  console.log('Add test -> DEXA reveals:', [...w.document.querySelectorAll('.mdl .subcard h5')].map(h=>h.textContent).join(', '),
    '| fields now', w.document.querySelectorAll('.mdl input,.mdl select').length);
  w.document.querySelector('.xbtn').dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
}catch(e){ console.log('FAIL modal: '+e.stack); process.exit(1); }
try{
  g('new');
  const n=w.document.querySelector('#content');
  console.log('\nenroll form: inputs='+n.querySelectorAll('input').length+' selects='+n.querySelectorAll('select').length+
    ' comorbidity boxes='+n.querySelectorAll('.chkgrid input').length+' med rows='+n.querySelectorAll('.medrow').length);
  const t=[...n.querySelectorAll('select')].find(s=>[...s.options].map(o=>o.value).join()==='Yes,No' && s.closest('label').textContent.includes('clinical trial'));
  t.value='Yes'; t.dispatchEvent(new w.Event('change'));
  console.log('trial = Yes reveals identifier field:', !!([...w.document.querySelectorAll('label.f span')].find(x=>x.textContent==='Identifier')));
}catch(e){ console.log('FAIL enroll: '+e.stack); process.exit(1); }
bail('final');
console.log('\nMODAL + ENROLL CHECKS PASS');
