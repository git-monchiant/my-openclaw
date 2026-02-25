/** Usage tab — Gemini + LINE push monitoring + per-agent breakdown + history charts */

export function getUsageJs(): string {
  return `
// ===== USAGE =====
function pbarColor(pct){return pct>=90?'red':pct>=70?'orange':'green'}

async function renderUsage(el){
  const [gem, lp, agentUsage, histApi, histTokens] = await Promise.all([
    api('/api/gemini'),
    api('/api/line-push'),
    api('/api/agents-usage'),
    api('/api/usage/history?metric=api_calls&days=30'),
    api('/api/usage/history?metric=tokens&days=30'),
  ]);
  const g = gem.current;

  function usageCard(icon, val, max, pct, label, sub){
    const c = pbarColor(pct);
    const clr = c==='green'?'var(--green)':c==='orange'?'var(--orange)':'var(--red)';
    return '<div class="card">'
      +'<div class="icon">'+icon+'</div>'
      +'<div class="val">'+val+'<span style="font-size:14px;color:var(--text3);font-weight:400"> / '+max+'</span></div>'
      +'<div class="lbl">'+esc(label)+'</div>'
      +'<div class="pbar pbar-'+c+'"><div class="pbar-fill" style="width:'+Math.min(100,pct)+'%"></div></div>'
      +(sub?'<div class="sub">'+esc(sub)+'</div>':'')
    +'</div>';
  }

  // Per-endpoint breakdown
  const epRows = Object.entries(gem.byEndpoint).sort((a,b)=>b[1]-a[1]).map(([ep,cnt])=>
    '<tr><td><code>'+esc(ep)+'</code></td><td style="font-weight:700">'+cnt+'</td></tr>'
  ).join('');

  // Recent Gemini calls
  const recentGem = gem.recent.map(r=>
    '<tr>'+
    '<td>'+fmtTime(r.time)+'</td>'+
    '<td>'+(r.agentId==='orchestrator'?badge('orch','green'):badge(r.agentId||'-','blue'))+'</td>'+
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
    '<tr><td><code>'+esc(src)+'</code></td><td style="font-weight:700">'+cnt+'</td></tr>'
  ).join('');

  const recentLp = lp.recent.map(r=>
    '<tr><td>'+fmtTime(r.time)+'</td><td class="mono">'+esc(r.userId)+'</td><td><code>'+esc(r.source)+'</code></td></tr>'
  ).join('');

  // Historical charts
  const apiHist = (histApi.data||[]);
  const tokenHist = (histTokens.data||[]);

  el.innerHTML = \`
    <div class="page-header">
      <div class="page-title">Usage Monitor</div>
    </div>

    <!-- Gemini Rate Cards -->
    <div class="section">
      <div class="section-title">&#x2728; Gemini Free Tier</div>
      <div class="cards" style="grid-template-columns:repeat(5,1fr)">
        \${usageCard('&#x26A1;', g.rpm, gem.limits.RPM, g.rpmPct, 'RPM', '')}
        \${usageCard('&#x1F4C5;', g.rpd, gem.limits.RPD, g.rpdPct, 'RPD', 'Reset ~'+gem.resetIn.rpdHours+'h')}
        \${usageCard('&#x1F4AC;', fmtNum(g.tpm), fmtNum(gem.limits.TPM), g.tpmPct, 'TPM', '')}
        <div class="card">
          <div class="icon">&#x1F4CA;</div>
          <div class="val">\${gem.totals.requests}</div>
          <div class="lbl">Total Requests</div>
          <div class="sub">\${fmtNum(gem.totals.totalTokens)} tokens</div>
        </div>
        <div class="card">
          <div class="icon">&#x274C;</div>
          <div class="val" style="color:\${gem.totals.errors?'var(--red)':'#fff'}">\${gem.totals.errors}</div>
          <div class="lbl">Errors</div>
          <div class="sub">\${gem.totals.rateLimits} rate limited</div>
        </div>
      </div>
    </div>

    <!-- History Charts -->
    \${apiHist.length || tokenHist.length ? '<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:28px">'
      + renderHistoryChart(apiHist, 'API Calls (30 days)', 'var(--accent)')
      + renderHistoryChart(tokenHist, 'Tokens (30 days)', 'var(--accent2)')
    + '</div>' : ''}

    <!-- Breakdown: Endpoints + Recent Calls -->
    <div style="display:grid;grid-template-columns:280px 1fr;gap:20px;margin-bottom:28px">
      <div class="section">
        <div class="section-title">&#x1F4E6; By Endpoint</div>
        <div class="tbl-wrap">
        <table>
          <thead><tr><th>Endpoint</th><th>Calls</th></tr></thead>
          <tbody>\${epRows||'<tr><td colspan="2" class="empty" style="padding:20px">No calls</td></tr>'}</tbody>
        </table>
        </div>
      </div>
      <div class="section">
        <div class="section-title">&#x1F553; Recent Gemini Calls</div>
        <div class="tbl-wrap">
        <table>
          <thead><tr><th>Time</th><th>Agent</th><th>Endpoint</th><th>Model</th><th>Tokens</th><th>Status</th></tr></thead>
          <tbody>\${recentGem||'<tr><td colspan="6" class="empty" style="padding:20px">No calls</td></tr>'}</tbody>
        </table>
        </div>
      </div>
    </div>

    <!-- Per-Agent Usage -->
    <div class="section">
      <div class="section-title">&#x1F916; Per-Agent Usage</div>
      <div class="tbl-wrap">
      <table>
        <thead><tr><th>Agent</th><th>Requests</th><th>Tokens</th><th>Prompt</th><th>Completion</th><th>Errors</th><th>429s</th><th>RPM</th><th>RPD</th></tr></thead>
        <tbody>\${(()=>{
          const entries = Object.entries(agentUsage||{}).sort((a,b)=>b[1].totals.requests-a[1].totals.requests);
          if(!entries.length) return '<tr><td colspan="9" class="empty" style="padding:20px">No data</td></tr>';
          return entries.map(([id,u])=>{
            const isOrch = id==='orchestrator';
            return '<tr>'
              +'<td>'+(isOrch?badge('orchestrator','green'):badge(id,'blue'))+'</td>'
              +'<td style="font-weight:700">'+u.totals.requests+'</td>'
              +'<td>'+fmtNum(u.totals.totalTokens)+'</td>'
              +'<td>'+fmtNum(u.totals.promptTokens)+'</td>'
              +'<td>'+fmtNum(u.totals.completionTokens)+'</td>'
              +'<td>'+(u.totals.errors?'<span style="color:var(--red);font-weight:700">'+u.totals.errors+'</span>':'<span style="color:var(--text3)">0</span>')+'</td>'
              +'<td>'+(u.totals.rateLimits?'<span style="color:var(--orange);font-weight:700">'+u.totals.rateLimits+'</span>':'<span style="color:var(--text3)">0</span>')+'</td>'
              +'<td>'+u.current.rpm+'</td>'
              +'<td>'+u.current.rpd+'</td>'
            +'</tr>';
          }).join('');
        })()}</tbody>
      </table>
      </div>
    </div>

    <!-- LINE Push -->
    <div class="section">
      <div class="section-title">&#x1F4E8; LINE Push Messages</div>
      <div class="cards" style="grid-template-columns:repeat(3,1fr)">
        <div class="card">
          <div class="icon">&#x1F4E8;</div>
          <div class="val">\${lp.thisMonth}<span style="font-size:14px;color:var(--text3);font-weight:400"> / \${lp.limit}</span></div>
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

    <div style="display:grid;grid-template-columns:280px 1fr;gap:20px;margin-bottom:28px">
      <div class="section">
        <div class="section-title">&#x1F4E6; By Source</div>
        <div class="tbl-wrap">
        <table>
          <thead><tr><th>Source</th><th>Calls</th></tr></thead>
          <tbody>\${srcRows||'<tr><td colspan="2" class="empty" style="padding:20px">No calls</td></tr>'}</tbody>
        </table>
        </div>
      </div>
      <div class="section">
        <div class="section-title">&#x1F553; Recent Push</div>
        <div class="tbl-wrap">
        <table>
          <thead><tr><th>Time</th><th>User</th><th>Source</th></tr></thead>
          <tbody>\${recentLp||'<tr><td colspan="3" class="empty" style="padding:20px">No pushes</td></tr>'}</tbody>
        </table>
        </div>
      </div>
    </div>

    <div style="font-size:11px;color:var(--text3)">RPD resets at midnight Pacific | LINE push resets monthly</div>
  \`;
}

function renderHistoryChart(data, title, color){
  if(!data.length) return '';
  const maxVal = Math.max(...data.map(d=>d.value), 1);
  const bars = data.map(d=>{
    const pct = Math.max(3, Math.round(d.value / maxVal * 100));
    const day = d.date.substring(8); // DD
    return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;min-width:0" title="'+esc(d.date)+': '+fmtNum(d.value)+'">'
      + '<div style="width:100%;max-width:20px;height:80px;display:flex;align-items:flex-end">'
        + '<div style="width:100%;height:'+pct+'%;background:'+color+';opacity:.4;border-radius:3px 3px 0 0;transition:height .3s"></div>'
      + '</div>'
      + '<div style="font-size:8px;color:var(--text3)">'+day+'</div>'
    + '</div>';
  }).join('');
  return '<div class="panel" style="margin-bottom:0">'
    + '<div class="panel-title" style="font-size:11px">'+esc(title)+'</div>'
    + '<div style="display:flex;gap:1px;align-items:flex-end">'
    + bars
    + '</div></div>';
}
`;
}
