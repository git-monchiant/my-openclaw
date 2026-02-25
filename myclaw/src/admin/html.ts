/**
 * Admin Dashboard — HTML/CSS/JS
 * Composed from view modules, served as a single HTML string
 */

import { getOverviewJs } from "./views/overview.js";
import { getUsageJs } from "./views/usage.js";
import { getLogsJs } from "./views/logs.js";
import { getSessionsJs } from "./views/sessions.js";
import { getAgentsJs } from "./views/agents.js";
import { getSkillsJs } from "./views/skills.js";
import { getCronJs } from "./views/cron.js";
import { getAppsJs } from "./views/apps.js";
import { getConfigJs } from "./views/config.js";
import { getTracesJs } from "./views/traces.js";

// ===== Login page =====
export function getLoginHtml(autoToken?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MyClaw Admin</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#07070e;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh;background-image:radial-gradient(ellipse at 50% 0%,rgba(108,99,255,.08) 0%,transparent 60%)}
.login{background:rgba(18,18,32,.8);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,.06);border-radius:24px;padding:48px 40px;width:400px;text-align:center;box-shadow:0 24px 80px rgba(0,0,0,.5)}
.logo{font-size:56px;margin-bottom:16px;filter:drop-shadow(0 4px 12px rgba(108,99,255,.3))}
.login h1{font-size:24px;margin-bottom:6px;color:#fff;font-weight:800;letter-spacing:-.3px}
.login p{color:#555;margin-bottom:32px;font-size:13px}
.login input{width:100%;padding:14px 18px;border:1px solid rgba(255,255,255,.08);border-radius:12px;background:rgba(255,255,255,.03);color:#e0e0e0;font-size:15px;margin-bottom:16px;outline:none;transition:all .2s}
.login input:focus{border-color:rgba(108,99,255,.5);box-shadow:0 0 0 3px rgba(108,99,255,.1)}
.login button{width:100%;padding:14px;border:none;border-radius:12px;background:linear-gradient(135deg,#6c63ff,#4fc3f7);color:#fff;font-size:15px;font-weight:700;cursor:pointer;transition:all .2s;letter-spacing:.3px}
.login button:hover{transform:translateY(-1px);box-shadow:0 8px 24px rgba(108,99,255,.3)}
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

// ===== CSS Design System =====
function getStyles(): string {
  return `
:root{
  --bg:#07070e;--bg2:#0c0c18;--sidebar:#0a0a16;--surface:rgba(18,18,32,.6);--surface-solid:#12121f;
  --surface2:rgba(34,34,60,.5);--surface-hover:rgba(40,40,70,.5);
  --border:rgba(255,255,255,.06);--border-hover:rgba(255,255,255,.12);
  --text:#e2e2ef;--text2:#8888a0;--text3:#555570;
  --accent:#7c6fff;--accent-glow:rgba(124,111,255,.15);--accent2:#4fc3f7;
  --green:#22c55e;--green-bg:rgba(34,197,94,.1);--red:#ef4444;--red-bg:rgba(239,68,68,.1);
  --orange:#f59e0b;--orange-bg:rgba(245,158,11,.1);--yellow:#fbbf24;
  --blue:#3b82f6;--blue-bg:rgba(59,130,246,.1);--purple:#8b5cf6;--purple-bg:rgba(139,92,246,.1);
  --sidebar-w:240px;--radius:14px;--radius-sm:10px;
}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);font-size:14px;overflow:hidden;height:100vh;-webkit-font-smoothing:antialiased}
a{color:var(--accent2);text-decoration:none}
code{font-family:'SF Mono','JetBrains Mono',Menlo,monospace;font-size:12px;background:var(--surface2);padding:2px 7px;border-radius:6px;color:var(--accent2)}

/* === Layout === */
.app{display:flex;height:100vh}

/* === Sidebar === */
.sidebar{width:var(--sidebar-w);background:var(--sidebar);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0}
.sidebar-header{padding:24px 22px 20px}
.sidebar-header .logo{display:flex;align-items:center;gap:12px}
.sidebar-header .logo span{font-size:28px;filter:drop-shadow(0 2px 8px rgba(124,111,255,.3))}
.sidebar-header .logo h1{font-size:18px;font-weight:800;color:#fff;letter-spacing:-.3px}
.sidebar-header .version{font-size:10px;color:var(--text3);margin-top:8px;letter-spacing:.5px;text-transform:uppercase}

.nav{flex:1;padding:8px 12px;overflow-y:auto}
.nav::-webkit-scrollbar{width:0}
.nav-group{margin-bottom:4px}
.nav-group-label{font-size:10px;text-transform:uppercase;letter-spacing:1.5px;color:var(--text3);padding:16px 14px 6px;font-weight:700}
.nav-item{display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:var(--radius-sm);cursor:pointer;color:var(--text2);font-size:13px;font-weight:500;transition:all .15s;margin-bottom:1px;user-select:none;position:relative}
.nav-item:hover{background:var(--surface);color:var(--text)}
.nav-item.active{background:linear-gradient(135deg,rgba(124,111,255,.15),rgba(79,195,247,.08));color:#fff;font-weight:600}
.nav-item.active::before{content:'';position:absolute;left:0;top:50%;transform:translateY(-50%);width:3px;height:20px;background:var(--accent);border-radius:0 3px 3px 0}
.nav-item .icon{font-size:16px;width:22px;text-align:center;opacity:.8}
.nav-item.active .icon{opacity:1}

.sidebar-footer{padding:16px 20px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.sidebar-footer button{background:none;border:none;color:var(--text3);cursor:pointer;font-size:11px;padding:4px 0;transition:color .2s}
.sidebar-footer button:hover{color:var(--red)}

/* === Main === */
.main{flex:1;overflow-y:auto;padding:32px 36px;background:var(--bg);background-image:radial-gradient(ellipse at 70% 0%,rgba(124,111,255,.03) 0%,transparent 50%)}
.main::-webkit-scrollbar{width:6px}
.main::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
.main::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.1)}

.page-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:28px}
.page-title{font-size:22px;font-weight:800;color:#fff;letter-spacing:-.3px}
.page-title .sub{font-size:14px;font-weight:400;color:var(--text2);margin-left:10px}

/* === Cards === */
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px;margin-bottom:28px}
.card{background:var(--surface);backdrop-filter:blur(10px);border-radius:var(--radius);padding:20px;border:1px solid var(--border);transition:all .2s;position:relative;overflow:hidden}
.card:hover{border-color:var(--border-hover);transform:translateY(-1px);box-shadow:0 8px 32px rgba(0,0,0,.2)}
.card .icon{font-size:22px;margin-bottom:10px;opacity:.9}
.card .val{font-size:30px;font-weight:800;color:#fff;line-height:1;letter-spacing:-.5px}
.card .lbl{font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.8px;margin-top:6px;font-weight:600}
.card .sub{font-size:11px;color:var(--text3);margin-top:3px}
.card-sm .val{font-size:22px}
.card-accent{border-color:rgba(124,111,255,.2)}
.card-accent:hover{border-color:rgba(124,111,255,.4);box-shadow:0 8px 32px rgba(124,111,255,.1)}

/* === Tables === */
.tbl-wrap{overflow-x:auto;border-radius:var(--radius);border:1px solid var(--border);background:var(--surface);backdrop-filter:blur(10px)}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:12px 18px;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.6px;font-weight:700;background:var(--surface2);border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:12px 18px;border-bottom:1px solid var(--border);font-size:13px;white-space:nowrap}
td.wrap{white-space:normal;word-break:break-word}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(124,111,255,.02)}
.mono{font-family:'SF Mono','JetBrains Mono',Menlo,monospace;font-size:12px}

/* === Badges === */
.b{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:8px;font-size:11px;font-weight:600;letter-spacing:.2px}
.b-green{background:var(--green-bg);color:var(--green)}
.b-red{background:var(--red-bg);color:var(--red)}
.b-orange{background:var(--orange-bg);color:var(--orange)}
.b-blue{background:var(--blue-bg);color:var(--accent2)}
.b-purple{background:var(--purple-bg);color:var(--purple)}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block}
.dot-green{background:var(--green);box-shadow:0 0 6px var(--green)}
.dot-red{background:var(--red);box-shadow:0 0 6px var(--red)}
.dot-orange{background:var(--orange);box-shadow:0 0 6px var(--orange)}

/* === Buttons === */
.btn{padding:7px 16px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--surface);color:var(--text);cursor:pointer;font-size:12px;font-weight:600;transition:all .15s;backdrop-filter:blur(10px)}
.btn:hover{background:var(--surface-hover);border-color:var(--border-hover);transform:translateY(-1px)}
.btn-primary{background:linear-gradient(135deg,var(--accent),#5a52e0);color:#fff;border-color:transparent}
.btn-primary:hover{box-shadow:0 4px 16px rgba(124,111,255,.3)}
.btn-red{border-color:rgba(239,68,68,.2);color:var(--red)}
.btn-red:hover{background:var(--red-bg)}

/* === Toggle === */
.tog{position:relative;width:40px;height:22px;display:inline-block;vertical-align:middle}
.tog input{display:none}
.tog .sl{position:absolute;inset:0;background:rgba(255,255,255,.1);border-radius:22px;cursor:pointer;transition:.2s}
.tog .sl:before{content:'';position:absolute;width:18px;height:18px;left:2px;top:2px;background:#fff;border-radius:50%;transition:.2s}
.tog input:checked+.sl{background:var(--green)}
.tog input:checked+.sl:before{transform:translateX(18px)}

/* === Filter bar === */
.filters{display:flex;gap:10px;margin-bottom:16px;align-items:center;flex-wrap:wrap}
.filters select,.filters input[type="text"]{padding:8px 14px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:13px;outline:none;transition:all .2s;backdrop-filter:blur(10px)}
.filters select:focus,.filters input[type="text"]:focus{border-color:rgba(124,111,255,.4);box-shadow:0 0 0 3px rgba(124,111,255,.08)}
.filters input[type="text"]{flex:1;min-width:200px}
.filters .info{font-size:11px;color:var(--text3)}

/* === Log viewer === */
.log-row{display:flex;gap:8px;padding:6px 14px;font-family:'SF Mono','JetBrains Mono',Menlo,monospace;font-size:12px;border-bottom:1px solid rgba(255,255,255,.02);line-height:1.6;transition:background .15s}
.log-row:hover{background:rgba(124,111,255,.03)}
.log-ts{color:var(--text3);white-space:nowrap;flex-shrink:0;width:90px}
.log-lvl{flex-shrink:0;width:40px}
.log-msg{color:var(--text);white-space:pre-wrap;word-break:break-all;flex:1}
.log-err .log-msg{color:var(--red)}
.log-container{background:var(--surface-solid);border-radius:var(--radius);border:1px solid var(--border);max-height:calc(100vh - 220px);overflow-y:auto}
.log-container::-webkit-scrollbar{width:5px}
.log-container::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}

/* === Progress bar === */
.pbar{height:6px;background:rgba(255,255,255,.04);border-radius:3px;overflow:hidden;margin-top:8px}
.pbar-fill{height:100%;border-radius:3px;transition:width .4s ease}
.pbar-green .pbar-fill{background:linear-gradient(90deg,var(--green),#4ade80)}
.pbar-orange .pbar-fill{background:linear-gradient(90deg,var(--orange),#fbbf24)}
.pbar-red .pbar-fill{background:linear-gradient(90deg,var(--red),#f87171)}

/* === Panel === */
.panel{background:var(--surface);backdrop-filter:blur(10px);border:1px solid var(--border);border-radius:var(--radius);padding:20px 24px;margin-bottom:20px}
.panel-title{font-size:13px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.8px;margin-bottom:14px;display:flex;align-items:center;gap:8px}

/* === Empty === */
.empty{text-align:center;padding:48px;color:var(--text3);font-size:14px}

/* === Agent master-detail === */
.agent-split{display:grid;grid-template-columns:320px 1fr;gap:16px;height:calc(100vh - 160px)}
.agent-list{overflow-y:auto;padding-right:4px}
.agent-list::-webkit-scrollbar{width:5px}
.agent-list::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
.agent-item{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px;margin-bottom:10px;cursor:pointer;transition:all .2s}
.agent-item:hover{border-color:var(--border-hover);background:var(--surface-hover)}
.agent-item.active{border-color:rgba(124,111,255,.3);background:rgba(124,111,255,.06);box-shadow:0 0 0 1px rgba(124,111,255,.15)}
.agent-detail{overflow-y:auto;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);display:flex;flex-direction:column;backdrop-filter:blur(10px)}
.agent-detail::-webkit-scrollbar{width:5px}
.agent-detail::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
.agent-detail-header{padding:24px;border-bottom:1px solid var(--border);flex-shrink:0}
.agent-detail-logs{flex:1;overflow-y:auto;padding:20px 24px}
@media(max-width:900px){.agent-split{grid-template-columns:1fr;height:auto}}

/* === Section === */
.section{margin-bottom:28px}
.section-title{font-size:13px;font-weight:700;color:var(--text2);margin-bottom:14px;display:flex;align-items:center;gap:8px;text-transform:uppercase;letter-spacing:.5px}

/* === Live Feed === */
.feed{background:var(--surface-solid);border:1px solid var(--border);border-radius:var(--radius);max-height:300px;overflow-y:auto}
.feed::-webkit-scrollbar{width:4px}
.feed::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
.feed-item{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid rgba(255,255,255,.02);font-size:12px;transition:background .15s}
.feed-item:hover{background:rgba(124,111,255,.02)}
.feed-item:last-child{border-bottom:none}
.feed-icon{font-size:14px;width:20px;text-align:center;flex-shrink:0}
.feed-text{flex:1;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.feed-time{color:var(--text3);font-size:11px;flex-shrink:0;font-family:'SF Mono',monospace}

/* === Animations === */
@keyframes flash{0%{box-shadow:0 0 0 2px rgba(124,111,255,.3)}100%{box-shadow:none}}
.flash{animation:flash .4s ease-out}
@keyframes fadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
.log-new{animation:fadeIn .2s ease-out}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
@keyframes pulse-anim{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.7)}}
.pulse{animation:pulse 2s ease-in-out infinite}
@keyframes slideIn{from{opacity:0;transform:translateX(-8px)}to{opacity:1;transform:translateX(0)}}
.slide-in{animation:slideIn .2s ease-out}

/* === Connection indicator === */
.conn-badge{display:flex;align-items:center;gap:5px;font-size:11px;padding:4px 10px;border-radius:8px;font-weight:600;transition:all .3s}
.conn-live{background:var(--green-bg);color:var(--green)}
.conn-offline{background:var(--red-bg);color:var(--red)}

/* === Responsive === */
@media(max-width:768px){
  .sidebar{display:none}
  .main{padding:16px}
  .cards{grid-template-columns:repeat(2,1fr)}
}
`;
}

// ===== Core JS =====
function getCoreJs(): string {
  return `
const TOKEN = new URLSearchParams(location.search).get('token') || localStorage.getItem('admin_token') || '';
if(TOKEN) localStorage.setItem('admin_token', TOKEN);
if(location.search.includes('token=')) history.replaceState(null, '', '/admin/');

let activeTab = 'overview';
let refreshTimer = null;
let cachedStatus = null;

// Nav items
const NAV = [
  { group: 'Monitor', items: [
    {id:'overview', icon:'&#x1F4CA;', label:'Overview'},
    {id:'traces',   icon:'&#x1F50D;', label:'Traces'},
    {id:'usage',    icon:'&#x1F4B0;', label:'Usage'},
    {id:'logs',     icon:'&#x1F4DD;', label:'Logs'},
  ]},
  { group: 'Users', items: [
    {id:'sessions', icon:'&#x1F465;', label:'Sessions'},
  ]},
  { group: 'AI', items: [
    {id:'agents',   icon:'&#x1F916;', label:'Agents'},
    {id:'skills',   icon:'&#x1F3AF;', label:'Skills'},
    {id:'memory',   icon:'&#x1F9E0;', label:'Memory'},
    {id:'tools',    icon:'&#x1F527;', label:'Tools'},
  ]},
  { group: 'System', items: [
    {id:'cron',     icon:'&#x23F0;',  label:'Cron Jobs'},
    {id:'apps',     icon:'&#x1F4F1;', label:'Apps'},
    {id:'config',   icon:'&#x2699;&#xFE0F;',  label:'Config'},
  ]},
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

// ===== Nav =====
function renderNav(){
  const nav = document.getElementById('nav');
  let html = '';
  NAV.forEach((g,i) => {
    html += '<div class="nav-group">';
    html += '<div class="nav-group-label">'+g.group+'</div>';
    g.items.forEach(n => {
      html += '<div class="nav-item'+(activeTab===n.id?' active':'')+'" onclick="switchTab(\\''+n.id+'\\')">' +
        '<span class="icon">'+n.icon+'</span>'+n.label+'</div>';
    });
    html += '</div>';
  });
  nav.innerHTML = html;
}

function switchTab(name){
  activeTab = name;
  renderNav();
  loadTab(name);
  clearInterval(refreshTimer);
  if(['overview','usage','cron','traces'].includes(name)){
    refreshTimer = setInterval(()=>loadTab(name), 60000);
  } else if(name==='logs'){
    refreshTimer = setInterval(()=>loadTab('logs'), 60000);
  }
}

// ===== Helpers =====
function esc(s){return s==null?'':String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function badge(t,c){return '<span class="b b-'+c+'">'+esc(t)+'</span>'}
function dot(c){return '<span class="dot dot-'+c+'"></span>'}
function shortId(id){return !id?'-':id.length>16?id.substring(0,6)+'..'+id.slice(-4):id}

function fmtNum(n){return n>=1000000?(n/1000000).toFixed(1)+'M':n>=1000?(n/1000).toFixed(1)+'K':String(n)}

function fmtTime(ts){
  if(!ts) return '<span style="color:var(--text3)">-</span>';
  const d = typeof ts==='number'?new Date(ts):new Date(ts);
  if(isNaN(d.getTime())) return '-';
  const now = new Date();
  const diff = now.getTime()-d.getTime();
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
  const main = el.closest('.main');
  const isRefresh = el.dataset.tab === name;
  const scrollTop = isRefresh && main ? main.scrollTop : 0;
  el.dataset.tab = name;
  try{
    switch(name){
      case 'overview': await renderOverview(el); break;
      case 'usage': await renderUsage(el); break;
      case 'logs': await renderLogs(el, isRefresh); break;
      case 'sessions': await renderSessions(el); break;
      case 'cron': await renderCron(el); break;
      case 'agents': await renderAgents(el); break;
      case 'skills': await renderSkills(el); break;
      case 'memory': await renderMemory(el); break;
      case 'traces': await renderTraces(el); break;
      case 'config': await renderConfig(el); break;
      case 'tools': await renderTools(el); break;
      case 'apps': await renderApps(el); break;
    }
  }catch(e){
    if(e.message!=='unauthorized') el.innerHTML='<div class="empty">Error: '+esc(e.message)+'</div>';
  }
  if(isRefresh && main) main.scrollTop = scrollTop;
}

// ===== SSE =====
let eventSource = null;
let sseConnected = false;
let sseRetryDelay = 1000;
const liveFeed = []; // recent events for live feed

function connectSSE(){
  if(eventSource) eventSource.close();
  eventSource = new EventSource('/admin/api/events?token='+encodeURIComponent(TOKEN));

  eventSource.addEventListener('connected', function(e){
    sseConnected = true;
    sseRetryDelay = 1000;
    updateConnectionBadge();
  });

  eventSource.addEventListener('gemini_call', function(e){
    try{
      const data = JSON.parse(e.data);
      addToLiveFeed('&#x2728;', 'Gemini '+data.endpoint+' '+fmtNum(data.tokens||0)+' tokens'+(data.error?' [ERR]':''), data.agentId);
      if(activeTab === 'overview'){
        const card = document.querySelector('[data-metric="gemini-req"]');
        if(card){card.closest('.card').classList.add('flash');setTimeout(()=>card.closest('.card').classList.remove('flash'),400)}
      }
    }catch{}
  });

  eventSource.addEventListener('webhook', function(e){
    try{
      const data = JSON.parse(e.data);
      addToLiveFeed('&#x1F4E8;', data.eventType+' from '+data.userId, '');
      if(activeTab === 'overview'){
        const card = document.querySelector('[data-metric="webhook-rpm"]');
        if(card){card.classList.add('flash');setTimeout(()=>card.classList.remove('flash'),400)}
      }
    }catch{}
  });

  eventSource.addEventListener('line_push', function(e){
    try{
      const data = JSON.parse(e.data);
      addToLiveFeed('&#x1F4E4;', 'Push ['+data.source+'] to '+data.userId, '');
    }catch{}
  });

  eventSource.addEventListener('log', function(e){
    try{
      const data = JSON.parse(e.data);
      if(typeof appendLogEntry === 'function') appendLogEntry(data);
    }catch{}
  });

  eventSource.addEventListener('queue_change', function(e){
    try{
      const data = JSON.parse(e.data);
      const icon = data.action==='start'?'&#x25B6;&#xFE0F;':'&#x2705;';
      addToLiveFeed(icon, 'Queue '+data.action+' '+data.userId, data.task||'');
      if(activeTab === 'overview') refreshActiveTasksPanel();
    }catch{}
  });

  eventSource.addEventListener('agent_activity', function(e){
    try{
      const data = JSON.parse(e.data);
      const icons = {start:'&#x1F3AF;',update:'&#x2699;&#xFE0F;',end:'&#x2705;'};
      const icon = icons[data.action]||'&#x1F916;';
      const stepLabel = data.tool ? data.agent+' → '+data.tool : (data.step||data.action);
      addToLiveFeed(icon, 'Agent '+stepLabel, data.detail||data.userId||'');
      if(activeTab === 'overview') refreshActiveTasksPanel();
      if(activeTab === 'traces' && typeof refreshTracesList === 'function') refreshTracesList();
    }catch{}
  });

  eventSource.onerror = function(){
    sseConnected = false;
    updateConnectionBadge();
    setTimeout(connectSSE, sseRetryDelay);
    sseRetryDelay = Math.min(sseRetryDelay * 2, 30000);
  };
}

function addToLiveFeed(icon, text, sub){
  liveFeed.unshift({icon, text, sub, ts:Date.now()});
  if(liveFeed.length>50) liveFeed.length=50;
  // Update feed on overview
  if(activeTab === 'overview'){
    const feedEl = document.getElementById('live-feed');
    if(feedEl) feedEl.innerHTML = renderFeedItems();
  }
}

function renderFeedItems(){
  if(!liveFeed.length) return '<div style="padding:20px;text-align:center;color:var(--text3);font-size:12px">Waiting for events...</div>';
  return liveFeed.slice(0,30).map(f=>
    '<div class="feed-item slide-in">'
    +'<span class="feed-icon">'+f.icon+'</span>'
    +'<span class="feed-text">'+esc(f.text)+'</span>'
    +'<span class="feed-time">'+fmtTimeLog(new Date(f.ts).toISOString())+'</span>'
    +'</div>'
  ).join('');
}

function updateConnectionBadge(sseClients){
  const el = document.getElementById('conn-badge');
  if(!el) return;
  if(sseConnected){
    el.className = 'conn-badge conn-live';
    el.innerHTML = dot('green') + ' Live' + (sseClients ? ' ('+sseClients+')' : '');
  } else {
    el.className = 'conn-badge conn-offline';
    el.innerHTML = dot('red') + ' Offline';
  }
}

function refreshActiveTasksPanel(){
  Promise.all([api('/api/active-tasks'), api('/api/queue')]).then(function(results){
    var tasks = results[0];
    var queue = results[1];
    var section = document.getElementById('queue-section');
    if(section){
      section.innerHTML = '<div class="panel-title">&#x1F4E8; Message Queue & Agent Activity</div>' + renderActiveTasksHtml(tasks, queue);
    }
  }).catch(function(){});
}
`;
}

// ===== Dashboard page =====
export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MyClaw Admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>${getStyles()}</style>
</head>
<body>
<div class="app">

<!-- Sidebar -->
<aside class="sidebar">
  <div class="sidebar-header">
    <div class="logo"><span>&#x1F99E;</span><h1>MyClaw</h1></div>
    <div class="version" id="uptime-text">Loading...</div>
  </div>
  <nav class="nav" id="nav"></nav>
  <div class="sidebar-footer">
    <div id="conn-badge" class="conn-badge" style="color:var(--text3)">${"<span class='dot dot-orange'></span> Connecting..."}</div>
    <button onclick="logout()">Logout</button>
  </div>
</aside>

<!-- Main content -->
<main class="main" id="content">
  <div class="empty">Loading...</div>
</main>

</div>

<script>
${getCoreJs()}
${getOverviewJs()}
${getUsageJs()}
${getLogsJs()}
${getSessionsJs()}
${getAgentsJs()}
${getSkillsJs()}
${getCronJs()}
${getAppsJs()}
${getConfigJs()}
${getTracesJs()}

// ===== Init =====
if(!TOKEN){location.href='/admin/'}
else{renderNav();switchTab('overview');connectSSE()}
</script>
</body></html>`;
}
