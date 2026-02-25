/** Apps tab — web apps/games created by webapp tool */

export function getAppsJs(): string {
  return `
// ===== APPS =====
const APP_CATS = {
  game:  {icon:'&#x1F3AE;', label:'Games',  color:'purple'},
  tool:  {icon:'&#x1F527;', label:'Tools',  color:'blue'},
  quiz:  {icon:'&#x2753;',  label:'Quiz',   color:'green'},
  art:   {icon:'&#x1F3A8;', label:'Art',    color:'orange'},
  data:  {icon:'&#x1F4CA;', label:'Data',   color:'blue'},
  other: {icon:'&#x1F4E6;', label:'Other',  color:'purple'},
};

function appCard(a){
  const cat = APP_CATS[a.category] || APP_CATS.other;
  const pinLabel = a.pinned ? 'Unpin' : 'Pin';
  const pinStyle = a.pinned ? 'background:var(--green-bg);border-color:var(--green);color:var(--green)' : '';
  const deadStyle = a.fileExists===false ? 'opacity:.4;' : '';
  return '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:18px;display:flex;flex-direction:column;gap:10px;position:relative;transition:all .2s;'+deadStyle
    +(a.pinned?'border-color:rgba(34,197,94,.2);box-shadow:0 0 0 1px rgba(34,197,94,.08);':'')
    +'">'
    // Title + pin
    + '<div style="display:flex;align-items:center;gap:8px">'
      + '<span style="font-size:20px">'+cat.icon+'</span>'
      + '<div style="flex:1;overflow:hidden">'
        + '<div style="font-size:14px;font-weight:700;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="'+esc(a.title)+'">'+esc(a.title)+'</div>'
      + '</div>'
      + (a.pinned ? '<span title="Pinned" style="font-size:14px;opacity:.7">&#x1F4CC;</span>' : '')
    + '</div>'
    // Meta
    + '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">'
      + badge(a.language, a.language==='python'?'orange':'blue')
      + '<span style="font-size:11px;color:var(--text3)">'+esc(a.sizeHuman)+'</span>'
      + '<span style="font-size:11px;color:var(--text3)">&middot; '+fmtTime(a.createdAt)+'</span>'
    + '</div>'
    + (a.fileExists===false ? '<div style="font-size:11px;color:var(--red);display:flex;align-items:center;gap:4px">'+dot('red')+' File missing</div>' : '')
    // Actions
    + '<div style="display:flex;gap:8px;margin-top:auto;padding-top:8px;border-top:1px solid var(--border)">'
      + (a.fileExists!==false ? '<a href="'+esc(a.url)+'" target="_blank" class="btn" style="flex:1;text-align:center;text-decoration:none;font-size:11px">&#x1F517; Open</a>' : '')
      + '<button class="btn" style="font-size:11px;'+pinStyle+'" onclick="pinApp(\\''+esc(a.id)+'\\')">'+pinLabel+'</button>'
      + '<button class="btn btn-red" style="font-size:11px" onclick="deleteApp(\\''+esc(a.id)+'\\')">Delete</button>'
    + '</div>'
  + '</div>';
}

async function renderApps(el){
  const d = await api('/api/apps');
  const apps = d.apps || [];

  if(!apps.length){
    el.innerHTML = \`
      <div class="page-header"><div class="page-title">Apps</div></div>
      <div class="panel">
        <div class="empty" style="padding:60px">
          <div style="font-size:32px;margin-bottom:12px">&#x1F4F1;</div>
          <div style="font-size:16px;font-weight:600;color:#fff;margin-bottom:8px">No Apps Yet</div>
          <div style="color:var(--text3)">Use the webapp tool in chat to create games, tools, quizzes, and more.</div>
        </div>
      </div>
    \`;
    return;
  }

  // Group by category
  const groups = {};
  const catOrder = ['game','tool','quiz','art','data','other'];
  apps.forEach(a=>{
    const cat = a.category || 'other';
    if(!groups[cat]) groups[cat]=[];
    groups[cat].push(a);
  });

  const pinnedCount = apps.filter(a=>a.pinned).length;

  let html = '<div class="page-header">'
    + '<div class="page-title">Apps <span class="sub">'+apps.length+' total &middot; '+pinnedCount+' pinned</span></div>'
    + '</div>';

  // Stats
  html += '<div class="cards" style="grid-template-columns:repeat('+Math.min(catOrder.filter(c=>groups[c]).length+1, 6)+',1fr);margin-bottom:24px">';
  html += '<div class="card card-sm card-accent"><div class="icon">&#x1F4F1;</div><div class="val" style="font-size:22px">'+apps.length+'</div><div class="lbl">Total Apps</div><div class="sub">'+pinnedCount+' pinned</div></div>';
  catOrder.forEach(cat=>{
    if(!groups[cat]) return;
    const ci = APP_CATS[cat] || APP_CATS.other;
    html += '<div class="card card-sm"><div class="icon">'+ci.icon+'</div><div class="val" style="font-size:22px">'+groups[cat].length+'</div><div class="lbl">'+ci.label+'</div></div>';
  });
  html += '</div>';

  // Category sections
  catOrder.forEach(cat=>{
    const items = groups[cat];
    if(!items || !items.length) return;
    const ci = APP_CATS[cat] || APP_CATS.other;
    html += '<div class="panel" style="margin-bottom:20px">'
      + '<div class="panel-title">'+ci.icon+' '+badge(ci.label, ci.color)+' <span style="font-weight:400;font-size:11px;color:var(--text3);text-transform:none;letter-spacing:0">'+items.length+' apps</span></div>'
      + '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px">'
      + items.map(appCard).join('')
      + '</div></div>';
  });

  el.innerHTML = html;
}

async function pinApp(id){
  try{
    await apiPost('/api/apps/'+id+'/pin');
    loadTab('apps');
  }catch(e){alert('Error: '+e.message)}
}

async function deleteApp(id){
  if(!confirm('Delete app "'+id+'"?'))return;
  try{
    const r=await apiDelete('/api/apps/'+id);
    if(r.error){alert('Error: '+r.error);return}
    loadTab('apps');
  }catch(e){alert('Error: '+e.message)}
}
`;
}
