/**
 * Admin Dashboard — HTML/CSS/JS
 * Single-page dashboard served as a string
 */

export function getLoginHtml(autoToken?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MyClaw Admin</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f0f1a;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh}
.login{background:#1a1a2e;border-radius:16px;padding:48px 40px;width:380px;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.5)}
.logo{font-size:48px;margin-bottom:12px}
.login h1{font-size:22px;margin-bottom:6px;color:#fff;font-weight:700}
.login p{color:#666;margin-bottom:28px;font-size:13px}
.login input{width:100%;padding:14px 16px;border:1px solid #2a2a3e;border-radius:10px;background:#12121f;color:#e0e0e0;font-size:15px;margin-bottom:16px;outline:none;transition:border .2s}
.login input:focus{border-color:#6c63ff}
.login button{width:100%;padding:14px;border:none;border-radius:10px;background:linear-gradient(135deg,#6c63ff,#4fc3f7);color:#fff;font-size:15px;font-weight:600;cursor:pointer;transition:opacity .2s}
.login button:hover{opacity:.9}
.err{color:#ef5350;font-size:13px;margin-top:8px;display:none}
</style>
</head>
<body>
<div class="login">
<div class="logo">&#x1F99E;</div>
<h1>MyClaw Admin</h1>
<p>Enter admin token to access dashboard</p>
<form id="f">
<input type="password" id="tok" placeholder="Admin Token" autocomplete="off" autofocus>
<button type="submit">Sign In</button>
<div class="err" id="err">Invalid token. Try again.</div>
</form>
</div>
<script>
document.getElementById('f').onsubmit=async e=>{
  e.preventDefault();
  const t=document.getElementById('tok').value.trim();
  if(!t)return;
  try{
    const r=await fetch('/admin/api/status',{headers:{'Authorization':'Bearer '+t}});
    if(r.ok){localStorage.setItem('admin_token',t);location.href='/admin/?token='+encodeURIComponent(t)}
    else{document.getElementById('err').style.display='block'}
  }catch{document.getElementById('err').style.display='block'}
};
const autoToken='${autoToken||""}';
if(autoToken){document.getElementById('tok').value=autoToken;document.getElementById('f').requestSubmit()}
</script>
</body></html>`;
}

export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MyClaw Admin</title>
<style>
:root{
  --bg:#0f0f1a;--sidebar:#161625;--surface:#1a1a2e;--surface2:#222240;
  --border:#2a2a3e;--text:#d4d4e0;--text2:#7a7a8e;--text3:#4a4a5e;
  --accent:#6c63ff;--accent2:#4fc3f7;--green:#4caf50;--red:#f44336;--orange:#ff9800;--yellow:#fdd835;
  --sidebar-w:220px;
}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);font-size:14px;overflow:hidden;height:100vh}
a{color:var(--accent2);text-decoration:none}
code{font-family:'SF Mono',Menlo,monospace;font-size:12px;background:var(--surface2);padding:2px 6px;border-radius:4px}

/* ===== Layout ===== */
.app{display:flex;height:100vh}

/* Sidebar */
.sidebar{width:var(--sidebar-w);background:var(--sidebar);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0}
.sidebar-header{padding:20px 20px 16px;border-bottom:1px solid var(--border)}
.sidebar-header .logo{display:flex;align-items:center;gap:10px}
.sidebar-header .logo span{font-size:22px}
.sidebar-header .logo h1{font-size:16px;font-weight:700;color:#fff}
.sidebar-header .uptime{font-size:11px;color:var(--text2);margin-top:6px}

.nav{flex:1;padding:12px 10px;overflow-y:auto}
.nav-item{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:8px;cursor:pointer;color:var(--text2);font-size:13px;font-weight:500;transition:all .15s;margin-bottom:2px;user-select:none}
.nav-item:hover{background:var(--surface);color:var(--text)}
.nav-item.active{background:var(--accent);color:#fff}
.nav-item .icon{font-size:16px;width:20px;text-align:center}
.nav-item .count{margin-left:auto;font-size:11px;background:var(--surface2);padding:1px 7px;border-radius:10px}
.nav-item.active .count{background:rgba(255,255,255,.2)}

.sidebar-footer{padding:14px 20px;border-top:1px solid var(--border);font-size:11px;color:var(--text3)}
.sidebar-footer button{background:none;border:none;color:var(--text2);cursor:pointer;font-size:11px;padding:4px 0}
.sidebar-footer button:hover{color:var(--red)}

/* Main */
.main{flex:1;overflow-y:auto;padding:28px 32px}
.main::-webkit-scrollbar{width:6px}
.main::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}

.page-title{font-size:20px;font-weight:700;color:#fff;margin-bottom:20px}

/* ===== Cards ===== */
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px;margin-bottom:28px}
.card{background:var(--surface);border-radius:12px;padding:18px 20px;border:1px solid var(--border);transition:border-color .2s}
.card:hover{border-color:var(--accent)}
.card .icon{font-size:20px;margin-bottom:8px}
.card .val{font-size:28px;font-weight:800;color:#fff;line-height:1.1}
.card .lbl{font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-top:4px}
.card .sub{font-size:11px;color:var(--text3);margin-top:2px}
.card-sm .val{font-size:20px}

/* ===== Tables ===== */
.tbl-wrap{overflow-x:auto;border-radius:10px;border:1px solid var(--border)}
table{width:100%;border-collapse:collapse;background:var(--surface)}
th{text-align:left;padding:10px 16px;font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.4px;font-weight:600;background:var(--surface2);border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:10px 16px;border-bottom:1px solid var(--border);font-size:13px;white-space:nowrap}
td.wrap{white-space:normal;word-break:break-word}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(108,99,255,.04)}
.mono{font-family:'SF Mono',Menlo,monospace;font-size:12px}

/* ===== Badges ===== */
.b{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:600}
.b-green{background:rgba(76,175,80,.12);color:var(--green)}
.b-red{background:rgba(244,67,54,.12);color:var(--red)}
.b-orange{background:rgba(255,152,0,.12);color:var(--orange)}
.b-blue{background:rgba(79,195,247,.12);color:var(--accent2)}
.b-purple{background:rgba(108,99,255,.12);color:var(--accent)}
.dot{width:6px;height:6px;border-radius:50%;display:inline-block}
.dot-green{background:var(--green)}.dot-red{background:var(--red)}.dot-orange{background:var(--orange)}

/* ===== Filter bar ===== */
.filters{display:flex;gap:10px;margin-bottom:16px;align-items:center;flex-wrap:wrap}
.filters select,.filters input{padding:8px 14px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:13px;outline:none;transition:border .2s}
.filters input{flex:1;min-width:200px}
.filters select:focus,.filters input:focus{border-color:var(--accent)}
.filters .info{font-size:11px;color:var(--text3)}

/* ===== Buttons ===== */
.btn{padding:6px 14px;border-radius:7px;border:1px solid var(--border);background:var(--surface);color:var(--text);cursor:pointer;font-size:12px;font-weight:500;transition:all .15s}
.btn:hover{background:var(--surface2);border-color:var(--text3)}
.btn-red{border-color:rgba(244,67,54,.3);color:var(--red)}
.btn-red:hover{background:rgba(244,67,54,.1)}

/* ===== Toggle ===== */
.tog{position:relative;width:38px;height:22px;display:inline-block;vertical-align:middle}
.tog input{display:none}
.tog .sl{position:absolute;inset:0;background:#444;border-radius:22px;cursor:pointer;transition:.2s}
.tog .sl:before{content:'';position:absolute;width:18px;height:18px;left:2px;top:2px;background:#fff;border-radius:50%;transition:.2s}
.tog input:checked+.sl{background:var(--green)}
.tog input:checked+.sl:before{transform:translateX(16px)}

/* ===== Log viewer ===== */
.log-row{display:flex;gap:8px;padding:5px 12px;font-family:'SF Mono',Menlo,monospace;font-size:12px;border-bottom:1px solid rgba(42,42,62,.5);line-height:1.5}
.log-row:hover{background:rgba(108,99,255,.03)}
.log-ts{color:var(--text3);white-space:nowrap;flex-shrink:0;width:90px}
.log-lvl{flex-shrink:0;width:40px}
.log-msg{color:var(--text);white-space:pre-wrap;word-break:break-all;flex:1}
.log-err .log-msg{color:var(--red)}
.log-container{background:var(--surface);border-radius:10px;border:1px solid var(--border);max-height:calc(100vh - 220px);overflow-y:auto}
.log-container::-webkit-scrollbar{width:5px}
.log-container::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}

/* ===== Progress bar ===== */
.pbar{height:8px;background:var(--surface2);border-radius:4px;overflow:hidden;margin-top:6px}
.pbar-fill{height:100%;border-radius:4px;transition:width .3s}
.pbar-green .pbar-fill{background:var(--green)}
.pbar-orange .pbar-fill{background:var(--orange)}
.pbar-red .pbar-fill{background:var(--red)}

/* ===== Empty ===== */
.empty{text-align:center;padding:48px;color:var(--text3);font-size:14px}

/* ===== Section ===== */
.section{margin-bottom:28px}
.section-title{font-size:14px;font-weight:600;color:var(--text2);margin-bottom:12px;display:flex;align-items:center;gap:8px}

/* ===== Responsive ===== */
@media(max-width:768px){
  .sidebar{display:none}
  .main{padding:16px}
  .cards{grid-template-columns:repeat(2,1fr)}
}
</style>
</head>
<body>
<div class="app">

<!-- Sidebar -->
<aside class="sidebar">
  <div class="sidebar-header">
    <div class="logo"><span>&#x1F99E;</span><h1>MyClaw</h1></div>
    <div class="uptime" id="uptime-text">Loading...</div>
  </div>
  <nav class="nav" id="nav"></nav>
  <div class="sidebar-footer">
    <button onclick="logout()">Logout</button>
  </div>
</aside>

<!-- Main content -->
<main class="main" id="content">
  <div class="empty">Loading...</div>
</main>

</div>

<script>
const TOKEN = new URLSearchParams(location.search).get('token') || localStorage.getItem('admin_token') || '';
if(TOKEN) localStorage.setItem('admin_token', TOKEN);
if(location.search.includes('token=')) history.replaceState(null, '', '/admin/');

let activeTab = 'overview';
let refreshTimer = null;
let cachedStatus = null;

// Nav items
const NAV = [
  {id:'overview', icon:'&#x1F4CA;', label:'Overview'},
  {id:'usage',    icon:'&#x1F4B0;', label:'Usage'},
  {id:'logs',     icon:'&#x1F4DD;', label:'Logs'},
  {id:'sessions', icon:'&#x1F465;', label:'Sessions'},
  {id:'cron',     icon:'&#x23F0;',  label:'Cron Jobs'},
  {id:'memory',   icon:'&#x1F9E0;', label:'Memory'},
  {id:'agents',   icon:'&#x1F916;', label:'Agents'},
  {id:'skills',   icon:'&#x1F3AF;', label:'Skills'},
  {id:'config',   icon:'&#x2699;&#xFE0F;',  label:'Config'},
  {id:'tools',    icon:'&#x1F527;', label:'Tools'},
];

function logout(){localStorage.removeItem('admin_token');location.href='/admin/'}

async function api(path, opts){
  const o = opts||{};
  o.headers = Object.assign({'Authorization':'Bearer '+TOKEN}, o.headers||{});
  const r = await fetch('/admin'+path, o);
  if(r.status===401){logout();throw new Error('unauthorized')}
  return r.json();
}
async function apiPost(path, body){
  return api(path, {method:'POST', headers:{'Content-Type':'application/json'}, body: body?JSON.stringify(body):undefined});
}
async function apiDelete(path){
  const r = await fetch('/admin'+path, {method:'DELETE',headers:{'Authorization':'Bearer '+TOKEN}});
  if(r.status===401){logout();throw new Error('unauthorized')}
  return r.json();
}

// ===== Nav rendering =====
function renderNav(){
  const nav = document.getElementById('nav');
  nav.innerHTML = NAV.map(n=>
    '<div class="nav-item'+(activeTab===n.id?' active':'')+'" onclick="switchTab(\\''+n.id+'\\')">' +
    '<span class="icon">'+n.icon+'</span>'+n.label+'</div>'
  ).join('');
}

function switchTab(name){
  activeTab = name;
  renderNav();
  loadTab(name);
  clearInterval(refreshTimer);
  if(name==='overview') refreshTimer=setInterval(()=>loadTab('overview'),10000);
  else if(name==='usage') refreshTimer=setInterval(()=>loadTab('usage'),10000);
  else if(name==='logs') refreshTimer=setInterval(()=>loadTab('logs'),5000);
}

// ===== Helpers =====
function esc(s){return s==null?'':String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function badge(t,c){return '<span class="b b-'+c+'">'+esc(t)+'</span>'}
function dot(c){return '<span class="dot dot-'+c+'"></span>'}
function shortId(id){return !id?'-':id.length>16?id.substring(0,6)+'..'+id.slice(-4):id}

function fmtTime(ts){
  if(!ts) return '<span style="color:var(--text3)">-</span>';
  const d = typeof ts==='number'?new Date(ts):new Date(ts);
  if(isNaN(d.getTime())) return '-';
  const now = new Date();
  const diff = now.getTime()-d.getTime();
  // Relative time for recent
  if(diff<60000) return '<span title="'+d.toLocaleString()+'">just now</span>';
  if(diff<3600000) return '<span title="'+d.toLocaleString()+'">'+Math.floor(diff/60000)+'m ago</span>';
  if(diff<86400000) return '<span title="'+d.toLocaleString()+'">'+Math.floor(diff/3600000)+'h ago</span>';
  if(diff<604800000) return '<span title="'+d.toLocaleString()+'">'+Math.floor(diff/86400000)+'d ago</span>';
  return d.toLocaleDateString('th-TH');
}

function fmtTimeFull(ts){
  if(!ts) return '-';
  const d = typeof ts==='number'?new Date(ts):new Date(ts);
  return isNaN(d.getTime())?'-':d.toLocaleString('th-TH',{hour12:false});
}

function fmtTimeLog(ts){
  if(!ts) return '';
  const d=new Date(ts);
  return isNaN(d.getTime())?'':String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')+':'+String(d.getSeconds()).padStart(2,'0')+'.'+String(d.getMilliseconds()).padStart(3,'0');
}

async function loadTab(name){
  const el = document.getElementById('content');
  try{
    switch(name){
      case 'overview': await renderOverview(el); break;
      case 'usage': await renderUsage(el); break;
      case 'logs': await renderLogs(el); break;
      case 'sessions': await renderSessions(el); break;
      case 'cron': await renderCron(el); break;
      case 'agents': await renderAgents(el); break;
      case 'skills': await renderSkills(el); break;
      case 'memory': await renderMemory(el); break;
      case 'config': await renderConfig(el); break;
      case 'tools': await renderTools(el); break;
    }
  }catch(e){
    if(e.message!=='unauthorized') el.innerHTML='<div class="empty">Error: '+esc(e.message)+'</div>';
  }
}

// ===== OVERVIEW =====
async function renderOverview(el){
  const [status, mem, sessions, agentsData] = await Promise.all([
    api('/api/status'),
    api('/api/memory'),
    api('/api/sessions?limit=5'),
    api('/api/agents'),
  ]);
  cachedStatus = status;
  document.getElementById('uptime-text').textContent = 'Up '+status.uptime.human+' | PID '+status.pid;

  const pColor = (p)=> p==='gemini'?'blue':p==='ollama'?'purple':p==='anthropic'?'orange':'red';

  // Provider switch dropdown
  const availIds = (status.available||[]).map(a=>a.id);
  const provOpts = ['auto',...availIds].map(id=>{
    return '<option value="'+esc(id)+'" '+(id===status.provider?'selected':'')+'>'+esc(id)+'</option>';
  }).join('');

  const fbHtml = status.fallback
    ? '<div style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text2)"><span style="opacity:.5">Fallback</span> '+badge(status.fallback,pColor(status.fallback))+' '+esc(status.fallbackModel||'')+'</div>'
    : '<div style="font-size:12px;color:var(--text3)">No fallback configured</div>';

  // Active agent info
  const defaultAgent = (agentsData.agents||[]).find(a=>a.isDefault);
  const agentSkills = defaultAgent && defaultAgent.skills ? defaultAgent.skills : [];
  const skillNames = agentSkills.slice(0,5).map(s=>s.name);
  const moreSkills = agentSkills.length > 5 ? ' +' + (agentSkills.length - 5) + ' more' : '';
  const activeAgentHtml = defaultAgent
    ? '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">'
      + badge(defaultAgent.name, pColor(defaultAgent.provider))
      + ' <span style="font-size:13px;color:var(--text)">' + esc(defaultAgent.provider) + '/' + esc(defaultAgent.model) + '</span>'
      + '</div>'
      + '<div style="font-size:12px;color:var(--text2)">'
      + (skillNames.length ? skillNames.map(n=>badge(n,'purple')).join(' ') + esc(moreSkills) : '<span style="color:var(--text3)">No skills assigned</span>')
      + '</div>'
    : '<div style="font-size:12px;color:var(--text3)">No agent configured</div>';

  el.innerHTML = \`
    <div class="page-title">Overview</div>

    <div class="cards">
      <div class="card"><div class="icon">&#x23F1;&#xFE0F;</div><div class="val">\${esc(status.uptime.human)}</div><div class="lbl">Uptime</div></div>
      <div class="card"><div class="icon">&#x1F4BE;</div><div class="val">\${esc(status.memory.heapUsed)}</div><div class="lbl">Heap Used</div><div class="sub">RSS \${esc(status.memory.rss)}</div></div>
      <div class="card"><div class="icon">&#x1F465;</div><div class="val">\${status.db.sessions||0}</div><div class="lbl">Users</div><div class="sub">\${status.db.messages||0} messages</div></div>
      <div class="card"><div class="icon">&#x1F9E0;</div><div class="val">\${status.db.memories||0}</div><div class="lbl">Memory Chunks</div><div class="sub">\${esc(mem.searchMode||'')} search</div></div>
      <div class="card"><div class="icon">&#x23F0;</div><div class="val">\${status.db.cronJobs||0}</div><div class="lbl">Cron Jobs</div></div>
      <div class="card"><div class="icon">&#x1F916;</div><div class="val">\${(agentsData.agents||[]).length}</div><div class="lbl">Agents</div><div class="sub">\${agentSkills.length} skills</div></div>
    </div>

    <div class="section" style="margin-top:16px">
      <div class="section-title">&#x1F916; Active Agent</div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px 20px;display:flex;align-items:center;gap:24px;flex-wrap:wrap">
        <div style="flex:1;min-width:200px">
          \${activeAgentHtml}
        </div>
        <div style="width:1px;height:40px;background:var(--border);opacity:.3"></div>
        <div style="flex:1;min-width:180px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <span style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--text3)">Provider</span>
            \${badge(status.provider, pColor(status.provider))}
          </div>
          <div style="font-size:18px;font-weight:700;color:#fff">\${esc(status.model||'none')}</div>
        </div>
        <div style="width:1px;height:40px;background:var(--border);opacity:.3"></div>
        <div style="flex:1;min-width:160px">
          \${fbHtml}
        </div>
        <div style="width:1px;height:40px;background:var(--border);opacity:.3"></div>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:12px;color:var(--text3)">Switch:</span>
          <select id="provider-switch" style="background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:5px 12px;font-size:13px;cursor:pointer;outline:none">\${provOpts}</select>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">&#x1F465; Recent Sessions</div>
      <div class="tbl-wrap">
      <table>
        <thead><tr><th>User</th><th>Messages</th><th>Last Active</th><th>Last Message</th></tr></thead>
        <tbody>\${sessions.sessions.length ? sessions.sessions.map(s=>
          '<tr><td class="mono">'+esc(shortId(s.session_id))+'</td>'+
          '<td>'+s.message_count+'</td>'+
          '<td>'+fmtTime(s.last_active)+'</td>'+
          '<td class="wrap" style="max-width:300px;overflow:hidden;text-overflow:ellipsis">'+esc(s.lastMessage||'-')+'</td></tr>'
        ).join('') : '<tr><td colspan="4" class="empty">No sessions yet</td></tr>'}</tbody>
      </table>
      </div>
    </div>

    <div style="font-size:11px;color:var(--text3)">Node \${esc(status.node)} | \${esc(status.platform)} | Auto-refresh 10s</div>
  \`;

  // Provider switch handler
  const sel = document.getElementById('provider-switch');
  if(sel) sel.onchange = async function(){
    try {
      const r = await apiPost('/api/provider', {provider:this.value});
      if(r.error){ alert('Switch failed: '+r.message); return; }
      loadTab('overview');
    } catch(e){ alert('Error: '+e.message); }
  };
}

// ===== USAGE =====
function pbarColor(pct){return pct>=90?'red':pct>=70?'orange':'green'}
function fmtNum(n){return n>=1000000?(n/1000000).toFixed(1)+'M':n>=1000?(n/1000).toFixed(1)+'K':String(n)}

async function renderUsage(el){
  const [gem, lp] = await Promise.all([api('/api/gemini'), api('/api/line-push')]);
  const g = gem.current;

  const geminiCards = \`
    <div class="card">
      <div class="icon">&#x26A1;</div>
      <div class="val">\${g.rpm}<span style="font-size:14px;color:var(--text2)"> / \${gem.limits.RPM}</span></div>
      <div class="lbl">RPM (Requests/min)</div>
      <div class="pbar pbar-\${pbarColor(g.rpmPct)}"><div class="pbar-fill" style="width:\${Math.min(100,g.rpmPct)}%"></div></div>
    </div>
    <div class="card">
      <div class="icon">&#x1F4C5;</div>
      <div class="val">\${g.rpd}<span style="font-size:14px;color:var(--text2)"> / \${gem.limits.RPD}</span></div>
      <div class="lbl">RPD (Requests/day)</div>
      <div class="pbar pbar-\${pbarColor(g.rpdPct)}"><div class="pbar-fill" style="width:\${Math.min(100,g.rpdPct)}%"></div></div>
      <div class="sub">Resets in ~\${gem.resetIn.rpdHours}h</div>
    </div>
    <div class="card">
      <div class="icon">&#x1F4AC;</div>
      <div class="val">\${fmtNum(g.tpm)}<span style="font-size:14px;color:var(--text2)"> / \${fmtNum(gem.limits.TPM)}</span></div>
      <div class="lbl">TPM (Tokens/min)</div>
      <div class="pbar pbar-\${pbarColor(g.tpmPct)}"><div class="pbar-fill" style="width:\${Math.min(100,g.tpmPct)}%"></div></div>
    </div>
    <div class="card">
      <div class="icon">&#x1F4CA;</div>
      <div class="val">\${gem.totals.requests}</div>
      <div class="lbl">Total Requests</div>
      <div class="sub">\${fmtNum(gem.totals.totalTokens)} tokens</div>
    </div>
    <div class="card">
      <div class="icon">&#x274C;</div>
      <div class="val">\${gem.totals.errors}</div>
      <div class="lbl">Errors</div>
      <div class="sub">\${gem.totals.rateLimits} rate limited</div>
    </div>
  \`;

  // Per-endpoint breakdown
  const epRows = Object.entries(gem.byEndpoint).sort((a,b)=>b[1]-a[1]).map(([ep,cnt])=>
    '<tr><td><code>'+esc(ep)+'</code></td><td>'+cnt+'</td></tr>'
  ).join('');

  // Recent Gemini calls
  const recentGem = gem.recent.map(r=>
    '<tr>'+
    '<td>'+fmtTime(r.time)+'</td>'+
    '<td><code>'+esc(r.endpoint)+'</code></td>'+
    '<td class="mono" style="font-size:11px">'+esc(r.model)+'</td>'+
    '<td>'+fmtNum(r.tokens)+'</td>'+
    '<td>'+(r.error?badge('ERR '+r.status,'red'):badge('OK','green'))+'</td>'+
    '</tr>'
  ).join('');

  // LINE Push
  const lpPct = lp.pct;
  const lpColor = pbarColor(lpPct);

  const srcRows = Object.entries(lp.bySource).sort((a,b)=>b[1]-a[1]).map(([src,cnt])=>
    '<tr><td><code>'+esc(src)+'</code></td><td>'+cnt+'</td></tr>'
  ).join('');

  const recentLp = lp.recent.map(r=>
    '<tr><td>'+fmtTime(r.time)+'</td><td class="mono">'+esc(r.userId)+'</td><td><code>'+esc(r.source)+'</code></td></tr>'
  ).join('');

  el.innerHTML = \`
    <div class="page-title">Usage Monitor</div>

    <div class="section">
      <div class="section-title">&#x2728; Gemini Free Tier</div>
      <div class="cards">\${geminiCards}</div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 2fr;gap:20px;margin-bottom:28px">
      <div class="section">
        <div class="section-title">&#x1F4E6; By Endpoint</div>
        <div class="tbl-wrap">
        <table>
          <thead><tr><th>Endpoint</th><th>Calls</th></tr></thead>
          <tbody>\${epRows||'<tr><td colspan="2" class="empty">No calls</td></tr>'}</tbody>
        </table>
        </div>
      </div>
      <div class="section">
        <div class="section-title">&#x1F553; Recent Gemini Calls</div>
        <div class="tbl-wrap">
        <table>
          <thead><tr><th>Time</th><th>Endpoint</th><th>Model</th><th>Tokens</th><th>Status</th></tr></thead>
          <tbody>\${recentGem||'<tr><td colspan="5" class="empty">No calls</td></tr>'}</tbody>
        </table>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">&#x1F4E8; LINE Push Messages</div>
      <div class="cards">
        <div class="card">
          <div class="icon">&#x1F4E8;</div>
          <div class="val">\${lp.thisMonth}<span style="font-size:14px;color:var(--text2)"> / \${lp.limit}</span></div>
          <div class="lbl">This Month</div>
          <div class="pbar pbar-\${lpColor}"><div class="pbar-fill" style="width:\${Math.min(100,lpPct)}%"></div></div>
          <div class="sub">\${lp.remaining} remaining</div>
        </div>
        <div class="card">
          <div class="icon">&#x1F4C6;</div>
          <div class="val">\${lp.today}</div>
          <div class="lbl">Today</div>
        </div>
        <div class="card">
          <div class="icon">&#x1F4CA;</div>
          <div class="val">\${lp.total}</div>
          <div class="lbl">Session Total</div>
        </div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 2fr;gap:20px;margin-bottom:28px">
      <div class="section">
        <div class="section-title">&#x1F4E6; By Source</div>
        <div class="tbl-wrap">
        <table>
          <thead><tr><th>Source</th><th>Calls</th></tr></thead>
          <tbody>\${srcRows||'<tr><td colspan="2" class="empty">No calls</td></tr>'}</tbody>
        </table>
        </div>
      </div>
      <div class="section">
        <div class="section-title">&#x1F553; Recent Push</div>
        <div class="tbl-wrap">
        <table>
          <thead><tr><th>Time</th><th>User</th><th>Source</th></tr></thead>
          <tbody>\${recentLp||'<tr><td colspan="3" class="empty">No pushes</td></tr>'}</tbody>
        </table>
        </div>
      </div>
    </div>

    <div style="font-size:11px;color:var(--text3)">RPD resets at midnight Pacific | LINE push resets monthly | Auto-refresh 10s</div>
  \`;
}

// ===== LOGS =====
let logLevel = 'all';
let logSearch = '';
async function renderLogs(el){
  const d = await api('/api/logs?level='+logLevel+'&limit=300&search='+encodeURIComponent(logSearch));
  const logs = d.logs.slice().reverse();
  const rows = logs.map(l=>
    '<div class="log-row'+(l.level==='error'?' log-err':'')+'">'+
    '<span class="log-ts">'+fmtTimeLog(l.ts)+'</span>'+
    '<span class="log-lvl">'+(l.level==='error'?'<span style="color:var(--red)">ERR</span>':'<span style="color:var(--text3)">INF</span>')+'</span>'+
    '<span class="log-msg">'+esc(l.msg)+'</span>'+
    '</div>'
  ).join('');

  el.innerHTML = \`
    <div class="page-title">System Logs</div>
    <div class="filters">
      <select onchange="logLevel=this.value;loadTab('logs')">
        <option value="all" \${logLevel==='all'?'selected':''}>All</option>
        <option value="info" \${logLevel==='info'?'selected':''}>Info</option>
        <option value="error" \${logLevel==='error'?'selected':''}>Errors</option>
      </select>
      <input type="text" placeholder="Search logs..." value="\${esc(logSearch)}" oninput="logSearch=this.value" onkeydown="if(event.key==='Enter')loadTab('logs')">
      <span class="info">\${d.returned} of \${d.total} | auto-refresh 5s</span>
    </div>
    <div class="log-container">
      \${rows||'<div class="empty">No logs</div>'}
    </div>
  \`;
}

// ===== SESSIONS =====
async function renderSessions(el){
  const d = await api('/api/sessions?limit=50');
  el.innerHTML = \`
    <div class="page-title">User Sessions <span style="font-size:14px;color:var(--text2);font-weight:400">\${d.total} total</span></div>
    <div class="tbl-wrap">
    <table>
      <thead><tr><th>User ID</th><th>Total</th><th>User</th><th>Bot</th><th>First Seen</th><th>Last Active</th><th>Last Message</th></tr></thead>
      <tbody>\${d.sessions.length ? d.sessions.map(s=>
        '<tr>'+
        '<td class="mono" title="'+esc(s.session_id)+'">'+esc(shortId(s.session_id))+'</td>'+
        '<td><strong>'+s.message_count+'</strong></td>'+
        '<td>'+s.user_messages+'</td>'+
        '<td>'+s.assistant_messages+'</td>'+
        '<td>'+fmtTime(s.first_active)+'</td>'+
        '<td>'+fmtTime(s.last_active)+'</td>'+
        '<td class="wrap" style="max-width:260px;overflow:hidden;text-overflow:ellipsis" title="'+esc(s.lastMessage||'')+'">'+esc(s.lastMessage||'-')+'</td>'+
        '</tr>'
      ).join('') : '<tr><td colspan="7" class="empty">No sessions</td></tr>'}</tbody>
    </table>
    </div>
  \`;
}

// ===== CRON =====
async function renderCron(el){
  const [jd, rd] = await Promise.all([api('/api/cron/jobs'), api('/api/cron/runs?limit=20')]);

  const jobRows = jd.jobs.map(j=>{
    const st = !j.enabled ? dot('orange')+' '+badge('off','orange')
      : j.last_status==='error' ? dot('red')+' '+badge('error','red')
      : j.last_status==='success' ? dot('green')+' '+badge('ok','green')
      : badge('waiting','blue');
    const tp = j.task_type==='ai' ? badge('AI','purple') : badge('text','blue');
    return '<tr>'+
      '<td><strong>'+esc(j.name)+'</strong></td>'+
      '<td><code>'+esc(j.schedule)+'</code></td>'+
      '<td>'+tp+'</td>'+
      '<td>'+st+'</td>'+
      '<td><label class="tog"><input type="checkbox" '+(j.enabled?'checked':'')+' onchange="toggleCron(\\''+j.id+'\\')"><span class="sl"></span></label></td>'+
      '<td>'+(j.run_count||0)+'</td>'+
      '<td>'+fmtTime(j.last_run_at)+'</td>'+
      '<td><button class="btn btn-red" onclick="removeCron(\\''+j.id+'\\',\\''+esc(j.name)+'\\')">Delete</button></td>'+
    '</tr>';
  }).join('');

  const runRows = rd.runs.map(r=>
    '<tr><td>'+esc(r.job_name)+'</td>'+
    '<td>'+(r.status==='success'?badge('ok','green'):badge('error','red'))+'</td>'+
    '<td>'+fmtTimeFull(r.started_at)+'</td>'+
    '<td>'+(r.error?'<span style="color:var(--red)">'+esc(r.error)+'</span>':'-')+'</td></tr>'
  ).join('');

  el.innerHTML = \`
    <div class="page-title">Cron Jobs <span style="font-size:14px;color:var(--text2);font-weight:400">\${jd.total} jobs</span></div>
    <div class="tbl-wrap">
    <table>
      <thead><tr><th>Name</th><th>Schedule</th><th>Type</th><th>Status</th><th>On/Off</th><th>Runs</th><th>Last Run</th><th></th></tr></thead>
      <tbody>\${jobRows||'<tr><td colspan="8" class="empty">No cron jobs configured</td></tr>'}</tbody>
    </table>
    </div>

    <div class="section" style="margin-top:28px">
      <div class="section-title">&#x1F4CB; Run History</div>
      <div class="tbl-wrap">
      <table>
        <thead><tr><th>Job</th><th>Status</th><th>Time</th><th>Error</th></tr></thead>
        <tbody>\${runRows||'<tr><td colspan="4" class="empty">No runs yet</td></tr>'}</tbody>
      </table>
      </div>
    </div>
  \`;
}

async function toggleCron(id){await apiPost('/api/cron/jobs/'+id+'/toggle');loadTab('cron')}
async function removeCron(id,name){if(confirm('Delete "'+name+'"?')){await apiDelete('/api/cron/jobs/'+id);loadTab('cron')}}

// ===== MEMORY =====
async function renderMemory(el){
  const d = await api('/api/memory');
  const total = (d.chunkCount||0);
  const embedded = (d.embeddedChunks||0);
  const pct = total>0 ? Math.round(embedded/total*100) : 0;

  el.innerHTML = \`
    <div class="page-title">Memory System</div>
    <div class="cards">
      <div class="card"><div class="icon">&#x1F50C;</div><div class="val" style="font-size:20px">\${esc(d.embeddingProvider||'none')}</div><div class="lbl">Provider</div><div class="sub">\${esc(d.embeddingModel||'N/A')}</div></div>
      <div class="card"><div class="icon">&#x1F50D;</div><div class="val" style="font-size:20px">\${esc(d.searchMode||'N/A')}</div><div class="lbl">Search Mode</div></div>
      <div class="card"><div class="icon">&#x1F4E6;</div><div class="val">\${total}</div><div class="lbl">Total Chunks</div><div class="sub">\${pct}% embedded</div></div>
      <div class="card"><div class="icon">&#x2705;</div><div class="val">\${embedded}</div><div class="lbl">Embedded</div></div>
      <div class="card"><div class="icon">&#x23F3;</div><div class="val">\${d.unembeddedChunks||0}</div><div class="lbl">Pending</div></div>
      <div class="card"><div class="icon">&#x1F5C4;&#xFE0F;</div><div class="val">\${d.cacheCount||0}</div><div class="lbl">Cache Entries</div></div>
    </div>
  \`;
}

// ===== AGENTS =====
let _allSkills = []; // cache skills for assign dropdown
async function renderAgents(el){
  const [ad, sd] = await Promise.all([api('/api/agents'), api('/api/skills')]);
  const agents = ad.agents || [];
  _allSkills = sd.skills || [];
  const pColor = (p)=> p==='gemini'?'blue':p==='ollama'?'purple':p==='anthropic'?'orange':p==='openai'?'green':'red';

  const agentCards = agents.map(a=>{
    const sk = (a.skills||[]);
    const assignedIds = new Set(sk.map(s=>s.id));
    // Skill badges with remove button
    const skillBadges = sk.map(s=>
      '<span class="b b-purple" style="font-size:10px;gap:2px">'+esc(s.name)
      +' <span style="opacity:.5">p'+s.priority+'</span>'
      +' <span style="cursor:pointer;opacity:.6;margin-left:2px" onclick="removeAgentSkill(\\''+esc(a.id)+'\\',\\''+esc(s.id)+'\\')">x</span>'
      +'</span>'
    ).join(' ');
    // Unassigned skills dropdown
    const unassigned = _allSkills.filter(s=>!assignedIds.has(s.id));
    const assignHtml = unassigned.length > 0
      ? '<select id="assign-'+esc(a.id)+'" style="font-size:11px;padding:3px 8px;border:1px solid var(--border);border-radius:5px;background:var(--surface2);color:var(--text)">'
        + '<option value="">+ Assign skill...</option>'
        + unassigned.map(s=>'<option value="'+esc(s.id)+'">'+esc(s.name)+'</option>').join('')
        + '</select>'
      : '';

    return '<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px 20px;margin-bottom:12px">'
      + '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">'
        + '<div style="font-size:18px;font-weight:700;color:#fff">'+esc(a.name)+'</div>'
        + (a.isDefault ? ' '+badge('DEFAULT','green') : '')
        + (a.enabled ? '' : ' '+badge('DISABLED','red'))
        + ' '+badge(a.provider, pColor(a.provider))
        + '<span style="font-size:12px;color:var(--text2);margin-left:auto"><code>'+esc(a.model)+'</code></span>'
      + '</div>'
      + (a.description ? '<div style="font-size:12px;color:var(--text2);margin-bottom:8px">'+esc(a.description)+'</div>' : '')
      + '<div style="margin-bottom:10px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">'
        + '<span style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Skills</span> '
        + (skillBadges || '<span style="font-size:11px;color:var(--text3)">None</span>')
        + ' ' + assignHtml
      + '</div>'
      + '<div style="display:flex;gap:8px">'
        + (!a.isDefault ? '<button class="btn" onclick="setDefaultAgent(\\''+esc(a.id)+'\\')">Set Default</button>' : '')
        + (!a.isDefault ? '<button class="btn btn-red" onclick="deleteAgentConfirm(\\''+esc(a.id)+'\\',\\''+esc(a.name)+'\\')">Delete</button>' : '')
      + '</div>'
    + '</div>';
  }).join('');

  el.innerHTML = \`
    <div class="page-title">Agents <span style="font-size:14px;color:var(--text2);font-weight:400">\${agents.length} agents</span></div>

    <div class="section">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div class="section-title" style="margin-bottom:0">&#x1F916; Agents</div>
        <button class="btn" onclick="showAddAgent()">+ Add Agent</button>
      </div>
      \${agentCards || '<div class="empty">No agents configured</div>'}
    </div>

    <div id="add-agent-form" style="display:none;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;margin-top:16px">
      <div style="font-size:14px;font-weight:600;margin-bottom:12px">Add New Agent</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <input id="aa-id" placeholder="ID (e.g. claude)" style="padding:8px 12px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px">
        <input id="aa-name" placeholder="Name (e.g. Claude)" style="padding:8px 12px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px">
        <select id="aa-provider" style="padding:8px 12px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px">
          <option value="gemini">gemini</option><option value="anthropic">anthropic</option><option value="openai">openai</option><option value="ollama">ollama</option>
        </select>
        <input id="aa-model" placeholder="Model (e.g. claude-sonnet-4)" style="padding:8px 12px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px">
        <input id="aa-desc" placeholder="Description (optional)" style="grid-column:span 2;padding:8px 12px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px">
      </div>
      <div style="margin-top:12px;display:flex;gap:8px">
        <button class="btn" onclick="submitAddAgent()" style="background:var(--accent);color:#fff;border-color:var(--accent)">Create</button>
        <button class="btn" onclick="document.getElementById('add-agent-form').style.display='none'">Cancel</button>
      </div>
    </div>
  \`;

  // Bind assign skill dropdowns
  agents.forEach(a=>{
    const sel = document.getElementById('assign-'+a.id);
    if(sel) sel.onchange = async function(){
      if(!this.value) return;
      try{
        await apiPost('/api/agents/'+a.id+'/skills', {skillId:this.value, priority:5});
        loadTab('agents');
      }catch(e){alert('Error: '+e.message)}
    };
  });
}

function showAddAgent(){document.getElementById('add-agent-form').style.display='block'}
async function submitAddAgent(){
  const id=document.getElementById('aa-id').value.trim();
  const name=document.getElementById('aa-name').value.trim();
  const provider=document.getElementById('aa-provider').value;
  const model=document.getElementById('aa-model').value.trim();
  const description=document.getElementById('aa-desc').value.trim();
  if(!id||!name||!model){alert('ID, Name, Model are required');return}
  try{
    const r=await apiPost('/api/agents',{id,name,description,provider,model});
    if(r.error){alert('Error: '+(r.message||r.error));return}
    loadTab('agents');
  }catch(e){alert('Error: '+e.message)}
}
async function setDefaultAgent(id){
  try{await apiPost('/api/agents/'+id+'/default');loadTab('agents')}
  catch(e){alert('Error: '+e.message)}
}
async function deleteAgentConfirm(id,name){
  if(!confirm('Delete agent "'+name+'"?'))return;
  try{
    const r=await apiDelete('/api/agents/'+id);
    if(r.error){alert('Error: '+r.error);return}
    loadTab('agents');
  }catch(e){alert('Error: '+e.message)}
}
async function removeAgentSkill(agentId,skillId){
  try{
    await apiDelete('/api/agents/'+agentId+'/skills/'+skillId);
    loadTab('agents');
  }catch(e){alert('Error: '+e.message)}
}

// ===== SKILLS (Master Data) =====
async function renderSkills(el){
  const sd = await api('/api/skills');
  const skills = sd.skills || [];

  const skillRows = skills.map(s=>{
    const toolBadges = s.tools.length ? s.tools.map(t=>'<code>'+esc(t)+'</code>').join(' ') : '<span style="color:var(--text3)">-</span>';
    const kwBadges = s.keywords.map(k=>'<span style="background:var(--surface2);padding:2px 8px;border-radius:4px;font-size:11px">'+esc(k)+'</span>').join(' ');
    return '<tr>'
      + '<td><strong>'+esc(s.name)+'</strong><div style="font-size:11px;color:var(--text3)">'+esc(s.id)+'</div></td>'
      + '<td>'+esc(s.description)+'</td>'
      + '<td>'+(s.toolType==='ai'?badge('AI','orange'):badge('non-AI','blue'))+'</td>'
      + '<td>'+toolBadges+'</td>'
      + '<td style="max-width:300px">'+kwBadges+'</td>'
    + '</tr>';
  }).join('');

  el.innerHTML = \`
    <div class="page-title">Skills <span style="font-size:14px;color:var(--text2);font-weight:400">\${skills.length} skills (master data)</span></div>
    <div style="font-size:12px;color:var(--text3);margin-bottom:16px">Skills are predefined capabilities. Assign them to agents in the Agents tab.</div>
    <div class="tbl-wrap">
    <table>
      <thead><tr><th>Name</th><th>Description</th><th>Type</th><th>Tools</th><th>Keywords</th></tr></thead>
      <tbody>\${skillRows || '<tr><td colspan="5" class="empty">No skills</td></tr>'}</tbody>
    </table>
    </div>
  \`;
}

// ===== CONFIG =====
async function renderConfig(el){
  const d = await api('/api/config');
  const rows = d.config.map(c=>{
    let val;
    if(c.isSensitive) val = '<span style="color:var(--green)">'+esc(c.value)+'</span>';
    else if(c.isOverride) val = '<span style="color:var(--orange)">'+esc(c.value)+'</span> '+badge('override','orange');
    else val = esc(c.value);
    return '<tr><td><code>'+esc(c.key)+'</code></td><td>'+val+'</td></tr>';
  }).join('');

  el.innerHTML = \`
    <div class="page-title">Configuration</div>
    <div class="tbl-wrap">
    <table>
      <thead><tr><th style="width:260px">Key</th><th>Value</th></tr></thead>
      <tbody>\${rows||'<tr><td colspan="2" class="empty">No config</td></tr>'}</tbody>
    </table>
    </div>
  \`;
}

// ===== TOOLS =====
async function renderTools(el){
  const d = await api('/api/tools');
  const rows = d.tools.map((t,i)=>
    '<tr><td style="color:var(--text3)">'+(i+1)+'</td><td><code>'+esc(t.name)+'</code></td><td class="wrap" style="color:var(--text2)">'+esc(t.description)+'</td></tr>'
  ).join('');

  el.innerHTML = \`
    <div class="page-title">Registered Tools <span style="font-size:14px;color:var(--text2);font-weight:400">\${d.total} tools</span></div>
    <div class="tbl-wrap">
    <table>
      <thead><tr><th style="width:36px">#</th><th style="width:150px">Name</th><th>Description</th></tr></thead>
      <tbody>\${rows}</tbody>
    </table>
    </div>
  \`;
}

// ===== Init =====
if(!TOKEN){location.href='/admin/'}
else{renderNav();switchTab('overview')}
</script>
</body></html>`;
}
