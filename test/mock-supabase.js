/* In-memory stand-in for the Supabase client, enforcing the same access rules
   as supabase/schema.sql, so the app's live mode can be tested offline. */
(function(){
  const SITES=['Neurosurgery & Spine Group — Santa Monica','Pacific Coast Spine Institute — San Diego','Lakeshore Spine Center — Chicago','Riverbend Neurosurgery — Austin','Harborview Spine Associates — Boston'];
  const ls = k => { try{ return JSON.parse(localStorage.getItem('mock_'+k)); }catch(e){ return null; } };
  const ss = (k,v) => { try{ localStorage.setItem('mock_'+k, JSON.stringify(v)); }catch(e){} };
  const DB = ls('db') || {users:[], profiles:[], invites:[], cases:[], export_log:[], audit:[], seq:1000};
  const persist = () => ss('db', DB);
  window.__mockDB = DB;
  let session = ls('session');
  const listeners=[];
  const me = () => session && DB.profiles.find(p=>p.user_id===session.user.id);
  const canSee = site => { const p=me(); return !!p && (p.role==='ini_admin' || (p.role==='site_user' && p.site===site)); };
  const ok = data => Promise.resolve({data, error:null});
  const err = m => Promise.resolve({data:null, error:{message:m}});
  const uid = () => 'u'+Math.random().toString(36).slice(2,10);

  function table(name){
    let filters=[], range=null, op='select', payload=null, single=false;
    const visible = rows => {
      if(name==='cases') return rows.filter(r=>canSee(r.site));
      if(name==='profiles'){ const p=me(); return rows.filter(r=>p && (r.user_id===p.user_id || p.role==='ini_admin')); }
      if(name==='invites'){ const p=me(); return p&&p.role==='ini_admin'? rows : []; }
      if(name==='export_log'){ const p=me(); return rows.filter(r=>p&&(p.role==='ini_admin'||r.user_id===p.user_id)); }
      return rows;
    };
    const src = () => DB[name];
    const match = r => filters.every(f=>f(r));
    const run = () => {
      const p=me();
      if(op==='select'){
        let rows = visible(src()).filter(match);
        if(range) rows = rows.slice(range[0], range[1]+1);
        rows = JSON.parse(JSON.stringify(rows));
        return single? ok(rows[0]||null) : ok(rows);
      }
      if(op==='upsert' || op==='insert'){
        const rows=Array.isArray(payload)?payload:[payload];
        for(const r of rows){
          if(name==='cases'){
            if(!canSee(r.site)) return err('new row violates row-level security policy for table "cases"');
            const ex=DB.cases.find(c=>c.id===r.id);
            if(ex){ if(op==='insert') return err('duplicate key value violates unique constraint "cases_pkey"');
              if(!canSee(ex.site)) return err('new row violates row-level security policy for table "cases"');
              Object.assign(ex, r, {updated_at:new Date().toISOString()}); DB.audit.push({case_id:r.id, action:'record updated', by:p.email}); }
            else { DB.cases.push({...r, created_at:new Date().toISOString()}); DB.audit.push({case_id:r.id, action:'record created', by:p.email}); }
          } else if(name==='invites'){
            if(!p||p.role!=='ini_admin') return err('new row violates row-level security policy for table "invites"');
            const i=DB.invites.findIndex(x=>x.email===r.email); if(i>-1) DB.invites[i]=r; else DB.invites.push(r);
          } else if(name==='export_log'){
            if(!p || r.user_id!==p.user_id) return err('new row violates row-level security policy for table "export_log"');
            DB.export_log.push({...r, at:new Date().toISOString()});
          } else return err('permission denied for table '+name);
        }
        persist(); return ok(null);
      }
      if(op==='update'){
        if(name==='profiles'){ if(!p||p.role!=='ini_admin') return ok(null);
          DB.profiles.filter(match).forEach(r=>Object.assign(r,payload)); persist(); return ok(null); }
        return err('permission denied');
      }
      if(op==='delete'){
        if(name==='cases'){ if(!p||p.role!=='ini_admin') return ok(null); DB.cases=DB.cases.filter(r=>!match(r)); }
        else if(name==='invites'){ if(!p||p.role!=='ini_admin') return ok(null); DB.invites=DB.invites.filter(r=>!match(r)); }
        else return err('permission denied');
        persist(); return ok(null);
      }
    };
    const q = {
      select(){ op='select'; return q; },
      eq(col,v){ filters.push(r=>r[col]===v); return q; },
      like(col,pat){ const re=new RegExp('^'+pat.replace(/%/g,'.*')+'$'); filters.push(r=>re.test(r[col])); return q; },
      order(){ return q; },
      range(a,b){ range=[a,b]; return q; },
      maybeSingle(){ single=true; return q; },
      single(){ single=true; return q; },
      upsert(v){ op='upsert'; payload=v; return q; },
      insert(v){ op='insert'; payload=v; return q; },
      update(v){ op='update'; payload=v; return q; },
      delete(){ op='delete'; return q; },
      then(res,rej){ return run().then(res,rej); },
    };
    return q;
  }
  window.SupabaseLib = { createClient(){ return {
    from: table,
    rpc(fn){ if(fn==='next_case_id'){ const p=me(); if(!p||p.role==='pending') return ok(null); const id='MPSR-'+(DB.seq++); persist(); return ok(id); } return err('no such function'); },
    auth: {
      getSession(){ return ok({session}); },
      onAuthStateChange(cb){ listeners.push(cb); return {data:{subscription:{unsubscribe(){}}}}; },
      async signUp({email,password,options}){
        if(DB.users.find(u=>u.email.toLowerCase()===email.toLowerCase())) return err('User already registered');
        if(!password || password.length<8) return err('Password should be at least 8 characters.');
        const id=uid(); DB.users.push({id,email,password});
        const inv=DB.invites.find(i=>i.email.toLowerCase()===email.toLowerCase());
        const name=options&&options.data&&options.data.full_name;
        if(inv) DB.profiles.push({user_id:id,email,full_name:inv.full_name||name,role:inv.role,site:inv.site||null,created_at:new Date().toISOString()});
        else if(!DB.profiles.some(p=>p.role==='ini_admin')) DB.profiles.push({user_id:id,email,full_name:name,role:'ini_admin',site:null,created_at:new Date().toISOString()});
        else DB.profiles.push({user_id:id,email,full_name:name,role:'pending',site:null,created_at:new Date().toISOString()});
        session={user:{id,email}}; ss('session',session); persist();
        return {data:{session, user:session.user}, error:null};
      },
      async signInWithPassword({email,password}){
        const u=DB.users.find(u=>u.email.toLowerCase()===email.toLowerCase() && u.password===password);
        if(!u) return err('Invalid login credentials');
        session={user:{id:u.id,email:u.email}}; ss('session',session); return {data:{session},error:null};
      },
      async signOut(){ session=null; ss('session',null); return {error:null}; },
      async resetPasswordForEmail(){ return {data:{},error:null}; },
      async updateUser({password}){ const u=session&&DB.users.find(x=>x.id===session.user.id); if(u) u.password=password; persist(); return {data:{},error:null}; },
    },
  }; } };
})();
