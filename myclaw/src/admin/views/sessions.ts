/** Sessions tab — user session list */

export function getSessionsJs(): string {
  return `
// ===== SESSIONS =====
async function renderSessions(el){
  const d = await api('/api/sessions?limit=50');

  const totalMsgs = d.sessions.reduce((s,x)=>s+x.message_count,0);
  const avgMsgs = d.sessions.length ? Math.round(totalMsgs/d.sessions.length) : 0;

  el.innerHTML = \`
    <div class="page-header">
      <div class="page-title">Sessions <span class="sub">\${d.total} users</span></div>
    </div>

    <!-- Stats -->
    <div class="cards" style="grid-template-columns:repeat(4,1fr);margin-bottom:24px">
      <div class="card card-sm">
        <div class="icon">&#x1F465;</div>
        <div class="val" style="font-size:22px">\${d.total}</div>
        <div class="lbl">Total Users</div>
      </div>
      <div class="card card-sm">
        <div class="icon">&#x1F4AC;</div>
        <div class="val" style="font-size:22px">\${totalMsgs}</div>
        <div class="lbl">Messages</div>
      </div>
      <div class="card card-sm">
        <div class="icon">&#x1F4CA;</div>
        <div class="val" style="font-size:22px">\${avgMsgs}</div>
        <div class="lbl">Avg per User</div>
      </div>
      <div class="card card-sm">
        <div class="icon">&#x1F552;</div>
        <div class="val" style="font-size:22px">\${d.sessions.length ? fmtTime(d.sessions[0].last_active) : '-'}</div>
        <div class="lbl">Latest Activity</div>
      </div>
    </div>

    <!-- Session Table -->
    <div class="panel" style="padding:0;overflow:hidden">
      <div style="padding:16px 24px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
        <div class="panel-title" style="margin-bottom:0">&#x1F465; All Sessions</div>
        <span style="font-size:11px;color:var(--text3)">Showing \${d.sessions.length} of \${d.total}</span>
      </div>
      <div class="tbl-wrap" style="border:none;border-radius:0">
      <table>
        <thead><tr>
          <th>User ID</th>
          <th>Total</th>
          <th>User</th>
          <th>Bot</th>
          <th>First Seen</th>
          <th>Last Active</th>
          <th>Last Message</th>
        </tr></thead>
        <tbody>\${d.sessions.length ? d.sessions.map(s=>{
          const ratio = s.message_count > 0 ? Math.round(s.user_messages / s.message_count * 100) : 0;
          return '<tr>'+
            '<td><code style="font-size:11px" title="'+esc(s.session_id)+'">'+esc(shortId(s.session_id))+'</code></td>'+
            '<td><strong style="color:#fff">'+s.message_count+'</strong></td>'+
            '<td>'+s.user_messages+'</td>'+
            '<td>'+s.assistant_messages+'</td>'+
            '<td>'+fmtTime(s.first_active)+'</td>'+
            '<td>'+fmtTime(s.last_active)+'</td>'+
            '<td class="wrap" style="max-width:280px;overflow:hidden;text-overflow:ellipsis" title="'+esc(s.lastMessage||'')+'">'+esc(s.lastMessage||'-')+'</td>'+
          '</tr>';
        }).join('') : '<tr><td colspan="7" class="empty" style="padding:40px">No sessions yet</td></tr>'}</tbody>
      </table>
      </div>
    </div>
  \`;
}
`;
}
