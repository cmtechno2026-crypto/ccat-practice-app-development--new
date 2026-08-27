// Smoke the expanded admin API. GATEWAY=http://localhost:8080 node scripts/admin-smoke.mjs
const BASE = process.env.GATEWAY || 'http://localhost:8080';
let pass=0, fail=0; const out=[];
const ok=(n,c,d='')=>{ out.push(`${c?'✅':'❌'}  ${n}${d?'  ('+d+')':''}`); c?pass++:fail++; };
async function api(method,path,{body,token}={}){
  const h={}; if(token)h.authorization='Bearer '+token; if(body!==undefined)h['content-type']='application/json';
  const r=await fetch(BASE+path,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body)});
  let j=null; const t=await r.text(); try{j=t?JSON.parse(t):null}catch{} return {status:r.status,json:j};
}
const login=(email)=>api('POST','/v1/admin/auth/login',{body:{email,password:'Passw0rd!'}});
async function run(){
  const su=(await login('super@cm.ca')).json.access_token;
  const sup=(await login('support@cm.ca')).json.access_token;
  const ce=(await login('content@cm.ca')).json.access_token;
  ok('3 admin logins', !!su&&!!sup&&!!ce);

  const dash=await api('GET','/v1/admin/dashboard',{token:su});
  ok('Dashboard KPIs', dash.status===200 && typeof dash.json.students.total==='number', `students=${dash.json?.students?.total}`);
  const health=await api('GET','/v1/admin/health',{token:su});
  ok('Health console', health.status===200 && Array.isArray(health.json.indicators), `overall=${health.json?.overall}, ${health.json?.indicators?.length} indicators`);

  const dir=await api('GET','/v1/admin/students?limit=100',{token:su});
  const sid = dir.json.items[0]?.id;
  const detail=await api('GET',`/v1/admin/students/${sid}/detail`,{token:su});
  ok('Student detail (guardians/devices/history)', detail.status===200 && Array.isArray(detail.json.guardians));

  // Content workflow
  const tax=await api('GET','/v1/admin/content/taxonomy',{token:ce});
  ok('Content taxonomy', tax.status===200 && tax.json.categories.length>=3);
  const qlist=await api('GET','/v1/admin/content/questions?state=approved',{token:ce});
  ok('Questions list (approved)', qlist.status===200 && qlist.json.items.length>=1);
  const approvedQ = qlist.json.items[0]?.id;
  const pub=await api('POST',`/v1/admin/content/questions/${approvedQ}/publish`,{token:ce});
  ok('Content editor can publish approved question', pub.status===200 && pub.json.state==='published');
  // support admin cannot publish
  const draftList=await api('GET','/v1/admin/content/questions?state=draft',{token:ce});
  const draftQ=draftList.json.items[0]?.id;
  const review=await api('POST',`/v1/admin/content/questions/${draftQ}/review`,{token:ce,body:{decision:'approved',feedback:'looks good'}});
  ok('Review moves draft → approved', review.status===200 && review.json.state==='approved');
  const create=await api('POST','/v1/admin/content/questions',{token:ce,body:{
    category_id:tax.json.categories[0].id, subcategory_id:tax.json.subcategories[0].id,
    grade_id:tax.json.grades.find(g=>g.grade_number===5).id, difficulty_id:tax.json.difficulties[0].id,
    question_type:'analogy', prompt_blocks:[{type:'text',value:'Up is to Down as Left is to ?'}],
    option_blocks:[{option_id:'o1',content:[{type:'text',value:'Right'}]},{option_id:'o2',content:[{type:'text',value:'Under'}]}],
    correct_option_ids:['o1'] }});
  ok('Create draft question', create.status===200 && create.json.state==='draft');
  const sets=await api('GET','/v1/admin/content/sets',{token:ce});
  ok('Sets list', sets.status===200 && sets.json.items.length>=2);

  // Config
  const grades=await api('GET','/v1/admin/config/grades',{token:su});
  ok('Config grades', grades.status===200 && grades.json.items.length===4);
  const g5=grades.json.items.find(g=>g.grade_number===5);
  const patchG=await api('PATCH',`/v1/admin/config/grades/${g5.id}`,{token:su,body:{practice_enabled:true}});
  ok('Super can edit grade config', patchG.status===200);
  const patchDenied=await api('PATCH',`/v1/admin/config/grades/${g5.id}`,{token:ce,body:{practice_enabled:true}});
  ok('Content editor denied grade config (RBAC)', patchDenied.status===403);
  const flags=await api('GET','/v1/admin/config/flags',{token:su});
  ok('Global flags list', flags.status===200 && flags.json.items.length>=8);
  const setFlag=await api('POST','/v1/admin/config/flags',{token:su,body:{key:'maintenance_mode',value:true,reason:'test'}});
  ok('Super can set emergency flag', setFlag.status===200 && setFlag.json.value===true);
  const flagDenied=await api('POST','/v1/admin/config/flags',{token:sup,body:{key:'maintenance_mode',value:true}});
  ok('Support denied emergency flag (RBAC)', flagDenied.status===403);

  // Rewards
  const ach=await api('GET','/v1/admin/rewards/achievements',{token:su});
  ok('Achievements list', ach.status===200 && ach.json.items.length>=3);
  const adj=await api('POST','/v1/admin/rewards/adjust',{token:sup,body:{student_id:sid,kind:'coins',delta:10,reason:'goodwill',reference:'CASE-1'}});
  ok('Reward adjustment (compensating ledger)', adj.status===200);
  const avatars=await api('GET','/v1/admin/rewards/avatars',{token:su});
  ok('Avatars list', avatars.status===200 && avatars.json.items.length>=1);

  // Comms
  const anns=await api('GET','/v1/admin/announcements',{token:sup});
  ok('Announcements list', anns.status===200 && anns.json.items.length>=2);
  const newAnn=await api('POST','/v1/admin/announcements',{token:sup,body:{title:'Test notice',body_text:'Hello everyone'}});
  ok('Create announcement', newAnn.status===200);
  const campaigns=await api('GET','/v1/admin/push/campaigns',{token:su});
  ok('Push campaigns list', campaigns.status===200 && campaigns.json.items.length>=1);
  const requested=campaigns.json.items.find(c=>c.state==='requested');
  const approve=await api('POST',`/v1/admin/push/campaigns/${requested.id}/approval`,{token:su,body:{decision:'approved'}});
  ok('Super approves push campaign', approve.status===200 && approve.json.state==='approved');
  const approveDenied=await api('POST',`/v1/admin/push/campaigns/${requested.id}/approval`,{token:sup,body:{decision:'approved'}});
  ok('Support denied push approval (SA-only)', approveDenied.status===403);
  const books=await api('GET','/v1/admin/books',{token:su});
  ok('Books list', books.status===200 && books.json.items.length>=2);

  // Accounts
  const accts=await api('GET','/v1/admin/accounts',{token:su});
  ok('Admin accounts list', accts.status===200 && accts.json.items.length>=3);
  const acctsDenied=await api('GET','/v1/admin/accounts',{token:sup});
  ok('Support denied accounts (RBAC)', acctsDenied.status===403);
  const created=await api('POST','/v1/admin/accounts',{token:su,body:{email:'newadmin'+Date.now()+'@cm.ca',display_name:'New Admin',role:'admin',permissions:['student.directory']}});
  ok('Create admin returns temp password once', created.status===200 && !!created.json.temp_password);
  // last super admin protection
  const perms=await api('GET','/v1/admin/permissions',{token:su});
  ok('Permission catalog', perms.status===200 && perms.json.items.length>=25);
  const demoteSuper=await api('PATCH','/v1/admin/accounts/a9000000-0000-0000-0000-000000000001',{token:su,body:{status:'disabled'}});
  ok('Cannot disable the last active Super-Admin', demoteSuper.status===409 && demoteSuper.json.error.code==='LAST_SUPER_ADMIN');

  console.log('\n============= ADMIN API SMOKE =============');
  out.forEach(l=>console.log(l));
  console.log('------------------------------------------');
  console.log(`${pass} passed, ${fail} failed, ${pass+fail} total`);
  process.exit(fail?1:0);
}
run().catch(e=>{console.error('CRASH',e);process.exit(2)});
