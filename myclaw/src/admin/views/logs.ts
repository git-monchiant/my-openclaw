/** Logs tab — real-time system log viewer with SSE append */

export function getLogsJs(): string {
  return `
// ===== LOGS =====
let logLevel = 'all';
let logSearch = '';
let logAutoScroll = true;

async function renderLogs(el, isRefresh){
  const d = await api('/api/logs?level='+logLevel+'&limit=300&search='+encodeURIComponent(logSearch));
  const logs = d.logs.slice().reverse();
  const rows = logs.map(l=>logRowHtml(l)).join('');

  // Incremental update: only replace log rows + count, preserve filter bar
  if (isRefresh) {
    const logBox = el.querySelector('.log-container');
    if (logBox) {
      const logScroll = logBox.scrollTop;
      logBox.innerHTML = rows || '<div class="empty" style="padding:40px">No logs matching filters</div>';
      logBox.scrollTop = logScroll;
    }
    const info = el.querySelector('.log-info');
    if (info) info.textContent = d.returned + ' of ' + d.total + (sseConnected ? ' — Live' : ' — Offline');
    return;
  }

  const errCount = d.logs.filter(l=>l.level==='error').length;

  el.innerHTML = \`
    <div class="page-header">
      <div class="page-title">System Logs</div>
      <div style="display:flex;align-items:center;gap:12px">
        <span class="log-info" style="font-size:11px;color:var(--text3)">\${d.returned} of \${d.total} \${sseConnected ? '— Live' : '— Offline'}</span>
        <div class="conn-badge \${sseConnected?'conn-live':'conn-offline'}" style="font-size:10px">
          \${sseConnected ? dot('green')+' SSE Connected' : dot('red')+' Disconnected'}
        </div>
      </div>
    </div>

    <!-- Stats Row -->
    <div class="cards" style="grid-template-columns:repeat(4,1fr);margin-bottom:20px">
      <div class="card card-sm">
        <div class="icon">&#x1F4DD;</div>
        <div class="val" style="font-size:22px">\${d.total}</div>
        <div class="lbl">Total Entries</div>
      </div>
      <div class="card card-sm">
        <div class="icon">&#x274C;</div>
        <div class="val" style="font-size:22px;color:\${errCount?'var(--red)':'#fff'}">\${errCount}</div>
        <div class="lbl">Errors</div>
      </div>
      <div class="card card-sm">
        <div class="icon">&#x1F50D;</div>
        <div class="val" style="font-size:22px">\${d.returned}</div>
        <div class="lbl">Showing</div>
      </div>
      <div class="card card-sm">
        <div class="icon">&#x26A1;</div>
        <div class="val" style="font-size:22px">\${sseConnected?'Live':'Off'}</div>
        <div class="lbl">Stream</div>
      </div>
    </div>

    <!-- Filter Bar -->
    <div class="panel" style="padding:14px 20px;margin-bottom:16px">
      <div class="filters" style="margin-bottom:0">
        <div style="display:flex;gap:4px">
          <button class="btn \${logLevel==='all'?'btn-primary':''}" onclick="logLevel='all';loadTab('logs')" style="font-size:11px;padding:5px 12px">All</button>
          <button class="btn \${logLevel==='info'?'btn-primary':''}" onclick="logLevel='info';loadTab('logs')" style="font-size:11px;padding:5px 12px">Info</button>
          <button class="btn \${logLevel==='error'?'btn-primary':''}" onclick="logLevel='error';loadTab('logs')" style="font-size:11px;padding:5px 12px;color:\${logLevel==='error'?'#fff':'var(--red)'}">Errors</button>
        </div>
        <input type="text" placeholder="Search logs..." value="\${esc(logSearch)}" oninput="logSearch=this.value" onkeydown="if(event.key==='Enter')loadTab('logs')" style="flex:1">
        <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text2);cursor:pointer;white-space:nowrap">
          <input type="checkbox" \${logAutoScroll?'checked':''} onchange="logAutoScroll=this.checked" style="accent-color:var(--accent)"> Auto-scroll
        </label>
      </div>
    </div>

    <!-- Log Container -->
    <div class="log-container" id="log-container">
      \${rows||'<div class="empty" style="padding:40px">No logs matching filters</div>'}
    </div>
  \`;
}

function logRowHtml(l){
  const isErr = l.level==='error';
  return '<div class="log-row'+(isErr?' log-err':'')+'">'
    +'<span class="log-ts">'+fmtTimeLog(l.ts)+'</span>'
    +'<span class="log-lvl">'+(isErr?'<span class="b b-red" style="font-size:9px;padding:2px 6px">ERR</span>':'<span class="b b-blue" style="font-size:9px;padding:2px 6px;opacity:.6">INF</span>')+'</span>'
    +'<span class="log-msg">'+esc(l.msg)+'</span>'
    +'</div>';
}

function appendLogEntry(data){
  if(activeTab !== 'logs') return;
  if(logLevel !== 'all' && data.level !== logLevel) return;
  if(logSearch && !data.msg.toLowerCase().includes(logSearch.toLowerCase())) return;

  const container = document.getElementById('log-container');
  if(!container) return;

  const row = document.createElement('div');
  row.className = 'log-row log-new' + (data.level==='error'?' log-err':'');
  row.innerHTML =
    '<span class="log-ts">'+fmtTimeLog(data.ts)+'</span>'
    +'<span class="log-lvl">'+(data.level==='error'?'<span class="b b-red" style="font-size:9px;padding:2px 6px">ERR</span>':'<span class="b b-blue" style="font-size:9px;padding:2px 6px;opacity:.6">INF</span>')+'</span>'
    +'<span class="log-msg">'+esc(data.msg)+'</span>';

  container.insertBefore(row, container.firstChild);

  while(container.children.length > 500){
    container.removeChild(container.lastChild);
  }

  // Update info
  const info = document.querySelector('.log-info');
  if(info) info.textContent = container.children.length + ' entries — Live';
}
`;
}
