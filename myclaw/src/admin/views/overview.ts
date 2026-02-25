/** Overview tab — monitoring dashboard with live feed, stats cards, orchestrator panel */

export function getOverviewJs(): string {
  return `
// ===== OVERVIEW =====
async function renderOverview(el){
  const [status, mem, sessions, agentsData, queue, activeTasks, traffic, googleUsers, gem] = await Promise.all([
    api('/api/status'),
    api('/api/memory'),
    api('/api/sessions?limit=5'),
    api('/api/agents'),
    api('/api/queue'),
    api('/api/active-tasks'),
    api('/api/traffic'),
    api('/api/google-users'),
    api('/api/gemini'),
  ]);
  // Active orchestrator + all candidates for dropdown
  const allAgents = agentsData.agents || [];
  const orchCandidates = allAgents.filter(a => a.type === 'orchestrator' || a.type === 'fallback');
  const activeOrch = allAgents.find(a => a.type === 'orchestrator');
  cachedStatus = status;
  document.getElementById('uptime-text').textContent = 'Up '+status.uptime.human+' | PID '+status.pid;
  updateConnectionBadge(status.sseClients);

  const pColor = (p)=> p==='gemini'?'blue':p==='openrouter'?'green':p==='ollama'?'purple':p==='anthropic'?'orange':'red';

  // Provider switch dropdown
  const availIds = (status.available||[]).map(a=>a.id);
  const provOpts = ['auto',...availIds].map(id=>{
    return '<option value="'+esc(id)+'" '+(id===status.provider?'selected':'')+'>'+esc(id)+'</option>';
  }).join('');

  const fbHtml = status.fallback
    ? badge(status.fallback,pColor(status.fallback))+' <span style="font-size:11px;color:var(--text3)">'+esc(status.fallbackModel||'')+'</span>'
    : '<span style="color:var(--text3);font-size:12px">None</span>';

  // Gemini usage bar
  function usageBar(label, val, max, pct){
    const c = pct>=90?'var(--red)':pct>=70?'var(--orange)':'var(--green)';
    return '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">'
      +'<div style="width:36px;font-size:10px;font-weight:700;color:var(--text2);text-align:right;flex-shrink:0;letter-spacing:.3px">'+label+'</div>'
      +'<div style="flex:1;position:relative;height:24px;background:rgba(255,255,255,.03);border-radius:8px;overflow:hidden">'
        +'<div style="height:100%;width:'+Math.min(100,pct)+'%;background:'+c+';opacity:.15;border-radius:8px;transition:width .4s"></div>'
        +'<div style="position:absolute;inset:0;display:flex;align-items:center;padding:0 12px;font-size:12px">'
          +'<span style="font-weight:800;color:#fff">'+val+'</span>'
          +'<span style="color:var(--text3);margin:0 4px">/</span>'
          +'<span style="color:var(--text3)">'+max+'</span>'
          +'<span style="margin-left:auto;font-size:11px;font-weight:700;color:'+c+'">'+pct+'%</span>'
        +'</div>'
      +'</div>'
    +'</div>';
  }

  // Only enabled specialist agents for the badge list
  const enabledAgents = allAgents.filter(a => a.enabled && a.type === 'agent');

  el.innerHTML = \`
    <div class="page-header">
      <div class="page-title">Dashboard</div>
      <div style="display:flex;align-items:center;gap:12px">
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:11px;color:var(--text3)">Provider:</span>
          <select id="provider-switch" style="background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:6px 14px;font-size:12px;cursor:pointer;outline:none;font-weight:600">\${provOpts}</select>
        </div>
      </div>
    </div>

    <!-- Stats Cards Row -->
    <div class="cards" style="grid-template-columns:repeat(6,1fr)">
      <div class="card card-accent" data-metric="uptime">
        <div class="icon">&#x23F1;&#xFE0F;</div>
        <div class="val">\${esc(status.uptime.human)}</div>
        <div class="lbl">Uptime</div>
      </div>
      <div class="card">
        <div class="icon">&#x1F4BE;</div>
        <div class="val" style="font-size:22px">\${esc(status.memory.heapUsed)}</div>
        <div class="lbl">Heap</div>
        <div class="sub">RSS \${esc(status.memory.rss)}</div>
      </div>
      <div class="card">
        <div class="icon">&#x1F465;</div>
        <div class="val">\${status.db.sessions||0}</div>
        <div class="lbl">Users</div>
        <div class="sub">\${status.db.messages||0} msgs</div>
      </div>
      <div class="card">
        <div class="icon">&#x1F9E0;</div>
        <div class="val">\${status.db.memories||0}</div>
        <div class="lbl">Memory</div>
        <div class="sub">\${esc(mem.searchMode||'')} search</div>
      </div>
      <div class="card" data-metric="webhook-rpm">
        <div class="icon">&#x1F4E1;</div>
        <div class="val">\${traffic.rpm}</div>
        <div class="lbl">Webhook RPM</div>
        <div class="sub">\${traffic.today} today</div>
      </div>
      <div class="card" data-metric="gemini-req">
        <div class="icon">&#x2728;</div>
        <div class="val">\${gem.totals.requests}</div>
        <div class="lbl">AI Calls</div>
        <div class="sub">\${fmtNum(gem.totals.totalTokens)} tokens</div>
      </div>
    </div>

    <!-- Two column: Orchestrator + Live Feed -->
    <div style="display:grid;grid-template-columns:1fr 360px;gap:20px;margin-bottom:24px">

      <!-- Left: Orchestrator & AI -->
      <div>
        <!-- Orchestrator Panel -->
        <div class="panel">
          <div class="panel-title" style="display:flex;align-items:center;justify-content:space-between">
            <span>&#x1F3AF; Orchestrator</span>
            \${orchCandidates.length > 1
              ? '<select style="font-size:12px;padding:4px 10px;border:1px solid rgba(255,140,0,.3);border-radius:8px;background:rgba(255,140,0,.08);color:#fff;outline:none;cursor:pointer" onchange="switchOrchestrator(this.value)">'
                + orchCandidates.map(a=>'<option value="'+esc(a.id)+'"'+(a.type==='orchestrator'?' selected':'')+'>'+esc(a.name)+'</option>').join('')
                + '</select>'
              : ''}
          </div>

          <!-- Active Orchestrator Info -->
          \${activeOrch ? \`
          <div style="padding:10px 14px;background:rgba(255,140,0,.06);border:1px solid rgba(255,140,0,.15);border-radius:var(--radius-sm);margin-bottom:16px">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
              <div style="font-size:15px;font-weight:800;color:#fff">\${esc(activeOrch.name)}</div>
              <div style="display:flex;align-items:center;gap:6px;margin-left:auto">
                \${badge(activeOrch.provider, pColor(activeOrch.provider))}
                <code style="font-size:10px;color:var(--text2)">\${esc(activeOrch.model)}</code>
                <span style="font-size:10px;color:var(--text3)">env key</span>
              </div>
            </div>
            \${(activeOrch.allowedTools||[]).length > 0 ? \`<div style="display:flex;flex-wrap:wrap;gap:4px">
              \${(activeOrch.allowedTools||[]).map(t=>'<span class="b b-orange" style="font-size:9px;opacity:.8">'+esc(t)+'</span>').join('')}
            </div>\` : ''}
          </div>\` : ''}

          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;margin-bottom:16px">
            <div>
              <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Provider</div>
              <div style="display:flex;align-items:center;gap:6px">
                \${badge(status.provider, pColor(status.provider))}
                <span style="font-size:14px;font-weight:700;color:#fff">\${esc(status.model||'none')}</span>
              </div>
            </div>
            <div>
              <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Fallback</div>
              <div>\${fbHtml}</div>
            </div>
            <div>
              <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Agents</div>
              <div style="font-size:14px;font-weight:700;color:#fff">\${enabledAgents.length} <span style="font-size:11px;color:var(--text3);font-weight:400">active</span></div>
            </div>
          </div>

          <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:16px">
            \${enabledAgents.map(a=>
              '<span class="b b-blue" style="font-size:10px">'+esc(a.name)
              +' <span style="opacity:.5">'+(a.skills||[]).length+'</span></span>'
            ).join('')}
          </div>

          <!-- Gemini Usage Bars -->
          <div style="border-top:1px solid var(--border);padding-top:14px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
              <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px">Gemini Free Tier</div>
              <div style="font-size:11px;color:var(--text3)">\${gem.totals.errors?'<span style="color:var(--red)">'+gem.totals.errors+' errors</span>':''}</div>
            </div>
            \${usageBar('RPM', gem.current.rpm, gem.limits.RPM, gem.current.rpmPct)}
            \${usageBar('RPD', gem.current.rpd, gem.limits.RPD, gem.current.rpdPct)}
            \${usageBar('TPM', fmtNum(gem.current.tpm), fmtNum(gem.limits.TPM), gem.current.tpmPct)}
          </div>
        </div>

        <!-- Queue & Agent Activity Panel -->
        <div class="panel" id="queue-section">
          <div class="panel-title">&#x1F4E8; Message Queue & Agent Activity</div>
          \${renderActiveTasksHtml(activeTasks, queue)}
        </div>

        <!-- Recent Sessions -->
        <div class="panel">
          <div class="panel-title">&#x1F465; Recent Sessions</div>
          <div class="tbl-wrap" style="border:none;border-radius:var(--radius-sm)">
          <table>
            <thead><tr><th>User</th><th>Messages</th><th>Last Active</th><th>Last Message</th></tr></thead>
            <tbody>\${sessions.sessions.length ? sessions.sessions.map(s=>
              '<tr><td class="mono">'+esc(shortId(s.session_id))+'</td>'+
              '<td>'+s.message_count+'</td>'+
              '<td>'+fmtTime(s.last_active)+'</td>'+
              '<td class="wrap" style="max-width:260px;overflow:hidden;text-overflow:ellipsis">'+esc(s.lastMessage||'-')+'</td></tr>'
            ).join('') : '<tr><td colspan="4" class="empty" style="padding:20px">No sessions yet</td></tr>'}</tbody>
          </table>
          </div>
        </div>
      </div>

      <!-- Right: Live Activity Feed -->
      <div>
        <div class="panel" style="position:sticky;top:0">
          <div class="panel-title" style="display:flex;align-items:center;justify-content:space-between">
            <span>&#x26A1; Live Activity</span>
            <span class="pulse" style="display:flex;align-items:center;gap:4px">\${dot('green')} <span style="font-size:10px;color:var(--green);font-weight:600">LIVE</span></span>
          </div>
          <div class="feed" id="live-feed" style="max-height:calc(100vh - 200px)">
            \${renderFeedItems()}
          </div>
        </div>
      </div>
    </div>

    <!-- Google Links (compact) -->
    \${(()=>{
      const gu = googleUsers.users || [];
      if(!gu.length) return '';
      return '<div class="panel"><div class="panel-title">&#x1F310; Google Links <span style="font-weight:400;color:var(--text3);font-size:11px;text-transform:none;letter-spacing:0">'+gu.length+' linked</span></div>'
        +'<div style="display:flex;flex-wrap:wrap;gap:8px">'
        +gu.map(u=>'<div style="display:flex;align-items:center;gap:6px;padding:6px 12px;background:var(--surface2);border-radius:8px;font-size:12px">'
          +'<span class="mono" style="color:var(--text2)">'+esc(shortId(u.lineUserId))+'</span>'
          +'<span style="color:var(--text3)">&rarr;</span>'
          +'<span style="color:var(--accent2)">'+esc(u.googleEmail||'-')+'</span>'
        +'</div>').join('')
        +'</div></div>';
    })()}

    <div style="font-size:11px;color:var(--text3)">Node \${esc(status.node)} | \${esc(status.platform)} | SSE \${sseConnected?'connected':'offline'}</div>
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

async function switchOrchestrator(id){
  const r = await api('/api/orchestrator/active','POST',{id});
  if(r.success){ showToast('Orchestrator switched to '+r.active.name); loadTab('overview'); }
  else showToast('Error: '+(r.error||'unknown'),'error');
}

function renderActiveTasksHtml(tasks, queue){
  const processing = (queue||[]).filter(function(q){return q.processing}).length;
  const totalPending = (queue||[]).reduce(function(s,q){return s+q.pendingCount}, 0);
  var taskCount = (tasks||[]).length;

  // Stats row
  var html = '<div style="display:flex;align-items:center;gap:16px;margin-bottom:12px">'
    +'<div style="display:flex;align-items:center;gap:6px"><span style="font-size:24px;font-weight:800;color:#fff">'+taskCount+'</span><span style="font-size:11px;color:var(--text3)">active</span></div>'
    +'<div style="display:flex;align-items:center;gap:6px"><span style="font-size:24px;font-weight:800;color:#fff">'+processing+'</span><span style="font-size:11px;color:var(--text3)">processing</span></div>'
    +'<div style="display:flex;align-items:center;gap:6px"><span style="font-size:24px;font-weight:800;color:#fff">'+totalPending+'</span><span style="font-size:11px;color:var(--text3)">pending</span></div>'
  +'</div>';

  if(!taskCount && !processing && !totalPending){
    html += '<div style="padding:12px 0;text-align:center;color:var(--text3);font-size:12px">No active tasks</div>';
    return html;
  }

  // Active tasks (agent-level detail)
  if(taskCount > 0){
    (tasks||[]).forEach(function(t){
      var elapsed = t.totalElapsedMs ? Math.round(t.totalElapsedMs/1000)+'s' : '-';
      var stepColors = {thinking:'blue',delegating:'purple',tool_call:'orange',responding:'green'};
      var stepColor = stepColors[t.step]||'blue';
      var stepLabel = t.step;
      if(t.step === 'tool_call' && t.tool) stepLabel = t.tool;
      if(t.step === 'delegating' && t.detail) stepLabel = 'delegate \u2192 ' + t.detail;

      html += '<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;margin-bottom:6px;background:rgba(124,111,255,.04);border:1px solid rgba(124,111,255,.1);border-radius:var(--radius-sm);font-size:12px">'
        +'<span class="mono" style="color:var(--text2);min-width:60px">'+esc(shortId(t.userId))+'</span>'
        +badge(t.agent||'?', t.agent==='orchestrator'?'blue':'green')
        +'<span style="color:var(--text3)">\u2192</span>'
        +badge(stepLabel, stepColor)
        +(t.detail && t.step !== 'delegating' ? '<span style="flex:1;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px" title="'+esc(t.detail)+'">'+esc(t.detail.substring(0,40))+'</span>' : '<span style="flex:1"></span>')
        +'<span class="pulse" style="display:flex;align-items:center;gap:4px"><span style="width:6px;height:6px;border-radius:50%;background:var(--green);animation:pulse-anim 1.5s infinite"></span><span style="font-weight:700;color:var(--text2)">'+elapsed+'</span></span>'
      +'</div>';
    });
  }

  // Queue items without active tasks (pending only)
  var activeUserIds = {};
  (tasks||[]).forEach(function(t){ activeUserIds[t.userId]=true; });
  var pendingOnly = (queue||[]).filter(function(q){ return !activeUserIds[q.userId] && (q.pendingCount>0 || q.processing); });

  if(pendingOnly.length > 0){
    pendingOnly.forEach(function(q){
      var elapsed = q.elapsedMs ? Math.round(q.elapsedMs/1000)+'s' : '-';
      var task = q.currentTask ? esc(q.currentTask.substring(0,50))+(q.currentTask.length>50?'...':'') : '-';
      html += '<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);font-size:12px">'
        +'<span class="mono" style="color:var(--text2);min-width:60px">'+esc(shortId(q.userId))+'</span>'
        +(q.processing?badge('Processing','green'):badge('Pending','orange'))
        +'<span style="flex:1;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+task+'</span>'
        +'<span style="color:var(--text3)">'+elapsed+'</span>'
      +'</div>';
    });
  }

  return html;
}
`;
}
