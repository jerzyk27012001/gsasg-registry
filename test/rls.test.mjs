import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const db = new PGlite();
const q = (s,p) => db.query(s,p);
let pass=0, fail=0;
const ok = (cond,msg) => { if(cond){pass++; console.log('  ✓',msg);} else {fail++; console.log('  ✗',msg);} };
const expectErr = async (fn,msg) => { try{ await fn(); ok(false,msg+' (no error)'); }catch(e){ ok(true,msg+' → '+e.message.slice(0,70)); } };

/* ---- a minimal stand-in for Supabase's auth layer ---- */
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
  grant usage on schema auth to authenticated, anon;
  grant execute on function auth.uid() to authenticated, anon;
`);
await db.exec(readFileSync(new URL('../supabase/schema.sql', import.meta.url),'utf8'));
await db.exec(readFileSync(new URL('../supabase/schema.sql', import.meta.url),'utf8'));   // must be re-runnable
console.log('schema applied twice without error');

const U = {
  george:'00000000-0000-0000-0000-000000000001', pi:'00000000-0000-0000-0000-000000000002',
  lake:'00000000-0000-0000-0000-000000000003', stranger:'00000000-0000-0000-0000-000000000004',
};
const NSG='Neurosurgery & Spine Group — Santa Monica', LAKE='Lakeshore Spine Center — Chicago';
const signup = (id,email) => q(`insert into auth.users(id,email) values($1,$2)`,[id,email]);
const as = async (id, fn) => {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${id}',false);`);
  try{ return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false);`); }
};

console.log('\n1. First sign-up becomes INI admin; invites assign roles; strangers wait');
await signup(U.george,'george@example.com');
let r = await q(`select role from public.profiles where user_id=$1`,[U.george]);
ok(r.rows[0].role==='ini_admin','first account is ini_admin');
await as(U.george, ()=>q(`insert into public.invites(email,role) values('vokshoor@example.com','ini_admin')`));
await as(U.george, ()=>q(`insert into public.invites(email,role,site) values('lake@example.com','site_user',$1)`,[LAKE]));
await signup(U.pi,'Vokshoor@Example.com'); await signup(U.lake,'lake@example.com'); await signup(U.stranger,'x@example.com');
r = await q(`select email, role, site from public.profiles order by email`);
ok(r.rows.find(x=>x.email==='Vokshoor@Example.com').role==='ini_admin','invited PI is ini_admin (email case ignored)');
ok(r.rows.find(x=>x.email==='lake@example.com').site===LAKE,'invited site user is tied to Lakeshore');
ok(r.rows.find(x=>x.email==='x@example.com').role==='pending','uninvited sign-up is pending');

console.log('\n2. Writing cases');
const id1 = (await as(U.pi, ()=>q(`select public.next_case_id() as id`))).rows[0].id;
ok(/^MPSR-\d+$/.test(id1),'INI gets a case number: '+id1);
await as(U.pi, ()=>q(`insert into public.cases(id,site,data) values($1,$2,'{"name":"A"}')`,[id1,NSG]));
const id2 = (await as(U.lake, ()=>q(`select public.next_case_id() as id`))).rows[0].id;
ok(id2!==id1,'site user gets a different number: '+id2);
await as(U.lake, ()=>q(`insert into public.cases(id,site,data) values($1,$2,'{"name":"B"}')`,[id2,LAKE]));
ok(true,'site user can enroll at own site');
await expectErr(()=>as(U.lake, ()=>q(`insert into public.cases(id,site,data) values('MPSR-X',$1,'{}')`,[NSG])),
  'site user cannot enroll at another site');
r = (await as(U.stranger, ()=>q(`select public.next_case_id() as id`))).rows[0].id;
ok(r===null,'pending user gets no case number');
await expectErr(()=>as(U.stranger, ()=>q(`insert into public.cases(id,site,data) values('MPSR-Y',$1,'{}')`,[LAKE])),
  'pending user cannot enroll');

console.log('\n3. Reading cases');
r = await as(U.pi, ()=>q(`select id from public.cases`)); ok(r.rows.length===2,'INI sees both sites ('+r.rows.length+')');
r = await as(U.lake, ()=>q(`select id, site from public.cases`));
ok(r.rows.length===1 && r.rows[0].site===LAKE,'Lakeshore sees only its own case');
r = await as(U.stranger, ()=>q(`select id from public.cases`)); ok(r.rows.length===0,'pending user sees nothing');

console.log('\n4. Updating and moving');
r = await as(U.lake, ()=>q(`update public.cases set data='{"name":"hacked"}' where id=$1`,[id1]));
ok(r.affectedRows===0,'site user cannot edit another site’s case (0 rows)');
await expectErr(()=>as(U.lake, ()=>q(`update public.cases set site=$1 where id=$2`,[NSG,id2])),
  'site user cannot move a case to another site');
await as(U.lake, ()=>q(`update public.cases set data='{"name":"B","bmi":27}' where id=$1`,[id2]));
r = await q(`select data from public.cases where id=$1`,[id2]); ok(r.rows[0].data.bmi===27,'site user can edit own case');
r = await as(U.lake, ()=>q(`delete from public.cases where id=$1`,[id2])); ok(r.affectedRows===0,'site user cannot delete');

console.log('\n5. Audit trail');
r = await q(`select action, user_email, detail from public.audit_log where case_id=$1 order by id`,[id2]);
ok(r.rows.map(x=>x.action).join(',')==='record created,record updated','created + updated logged automatically');
ok(JSON.stringify(r.rows[1].detail)==='["bmi"]','update records which fields changed: '+JSON.stringify(r.rows[1].detail));
ok(r.rows[0].user_email==='lake@example.com','audit records who');
await expectErr(()=>as(U.pi, ()=>q(`delete from public.audit_log`)),'even INI cannot delete the audit log');
await expectErr(()=>as(U.pi, ()=>q(`update public.audit_log set action='x'`)),'even INI cannot edit the audit log');
await expectErr(()=>as(U.lake, ()=>q(`insert into public.audit_log(action) values('fake')`)),'nobody can forge audit entries');
r = await as(U.lake, ()=>q(`select distinct site from public.audit_log`));
ok(r.rows.every(x=>x.site===LAKE),'site user reads only its own audit entries');

console.log('\n6. Roles cannot be self-assigned');
r = await as(U.lake, ()=>q(`update public.profiles set role='ini_admin' where user_id=$1`,[U.lake]));
ok(r.affectedRows===0,'site user cannot promote themselves');
r = await as(U.stranger, ()=>q(`update public.profiles set role='ini_admin', site=null where user_id=$1`,[U.stranger]));
ok(r.affectedRows===0,'pending user cannot promote themselves');
await expectErr(()=>as(U.lake, ()=>q(`insert into public.invites(email,role) values('evil@x.com','ini_admin')`)),'site user cannot create invites');
await as(U.pi, ()=>q(`update public.profiles set role='site_user', site=$1 where user_id=$2`,[LAKE,U.stranger]));
r = await as(U.stranger, ()=>q(`select count(*)::int n from public.cases`)); ok(r.rows[0].n===1,'after INI approval, new user sees their site');
r = await as(U.lake, ()=>q(`select count(*)::int n from public.profiles`)); ok(r.rows[0].n===1,'site user sees only own profile');

console.log('\n7. Export log');
await as(U.lake, ()=>q(`insert into public.export_log(user_id,scope,what,patients) values($1,'Lakeshore','dataset',1)`,[U.lake]));
await expectErr(()=>as(U.lake, ()=>q(`insert into public.export_log(user_id,scope,what) values($1,'x','y')`,[U.pi])),'cannot log an export as someone else');
r = await as(U.pi, ()=>q(`select count(*)::int n from public.export_log`)); ok(r.rows[0].n===1,'INI sees all exports');

console.log('\n8. Published benchmarks');
await as(U.pi, ()=>q(`insert into public.benchmarks(id,data,published_by) values(1,'{"cases":3}','vokshoor')`));
r = await as(U.lake, ()=>q(`select data->>'cases' c from public.benchmarks`)); ok(r.rows[0]&&r.rows[0].c==='3','site user reads published benchmarks');
await expectErr(()=>as(U.lake, ()=>q(`insert into public.benchmarks(id,data) values(1,'{}') on conflict (id) do update set data='{}'`)),'site user cannot publish benchmarks');
r = await as(U.lake, ()=>q(`update public.benchmarks set data='{}'`)); ok(r.affectedRows===0,'site user cannot overwrite benchmarks');
await signup('00000000-0000-0000-0000-000000000009','late@example.com');
r = await as('00000000-0000-0000-0000-000000000009', ()=>q(`select count(*)::int n from public.benchmarks`)); ok(r.rows[0].n===0,'pending user cannot read benchmarks');
await as(U.pi, ()=>q(`insert into public.benchmarks(id,data) values(1,'{"cases":5}') on conflict (id) do update set data=excluded.data, published_at=now()`));
r = await q(`select data->>'cases' c from public.benchmarks`); ok(r.rows[0].c==='5','INI can republish (upsert)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
