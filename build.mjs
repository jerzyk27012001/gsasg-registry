// Builds index.html (what GitHub Pages serves) from src/app.html.
//   node build.mjs          -> live build if config.json has url + anonKey, otherwise the demo build
//   node build.mjs --mock   -> dist-mock/index.html with an in-memory fake backend, for tests
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
const mock = process.argv.includes('--mock');
const app = readFileSync('src/app.html','utf8');
let cfg = null;
if (mock) cfg = {url:'https://mock.local', anonKey:'mock'};
else if (existsSync('config.json')) cfg = JSON.parse(readFileSync('config.json','utf8'));
const live = !!(cfg && cfg.url && cfg.anonKey);
let out = app;
if (live) {
  const lib = readFileSync(mock ? 'test/mock-supabase.js' : 'vendor/supabase.bundle.js','utf8').replace(/<\/script/gi,'<\\/script');
  const inject = `<script>window.GSASG_CONFIG=${JSON.stringify({url:cfg.url, anonKey:cfg.anonKey})};</script>\n<script>${lib}</script>\n`;
  const marker = '<script>\n/* ===================================================================\n   MPSR prototype';
  const i = app.indexOf(marker);
  if (i < 0) { console.error('main script marker not found'); process.exit(1); }
  out = app.slice(0,i) + inject + app.slice(i);
  out = out.replace(/<title>[^<]*<\/title>/, '<title>GSASG Registry</title>');
}
const file = mock ? 'dist-mock/index.html' : 'index.html';
if (mock) mkdirSync('dist-mock',{recursive:true});
writeFileSync(file, out);
console.log(`${file}: ${live ? 'LIVE (Supabase '+cfg.url+')' : 'DEMO (synthetic data, no backend)'} — ${(out.length/1024).toFixed(0)} KB`);
