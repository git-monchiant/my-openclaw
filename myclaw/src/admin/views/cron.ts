/** Cron tab — scheduled job management */

export function getCronJs(): string {
  return `
// ===== CRON =====
async function renderCron(el){
  const [jd, rd] = await Promise.all([api('/api/cron/jobs'), api('/api/cron/runs?limit=50')]);

  const activeJobs = jd.jobs.filter(j=>j.enabled);
  const inactiveJobs = jd.jobs.filter(j=>!j.enabled);
  const totalRuns = jd.jobs.reduce((s,j)=>s+(j.run_count||0),0);
  const errorRuns = rd.runs.filter(r=>r.status==='error').length;

  function cronJobCard(j){
    const st = !j.enabled ? dot('orange')+' '+badge('Paused','orange')
      : j.last_status==='error' ? dot('red')+' '+badge('Error','red')
      : j.last_status==='success' ? dot('green')+' '+badge('OK','green')
      : dot('blue')+' '+badge('Waiting','blue');
    const tp = j.task_type==='ai' ? badge('AI Task','purple') : badge('Text','blue');
    const sched = j.scheduleType==='once' ? ' '+badge('Once','orange') : '';

    return '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;display:flex;flex-direction:column;gap:10px;transition:all .2s'
      + (!j.enabled ? ';opacity:.55' : '')
      + '">'
      // Header
      + '<div style="display:flex;align-items:center;gap:8px">'
        + '<div style="font-size:14px;font-weight:700;color:#fff;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(j.name)+'</div>'
        + st
      + '</div>'
      // Schedule + Type
      + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
        + '<code style="font-size:11px">'+esc(j.schedule)+'</code>'
        + sched
        + tp
      + '</div>'
      // Meta
      + '<div style="display:flex;align-items:center;gap:12px;font-size:11px;color:var(--text3)">'
        + '<span>&#x1F504; '+(j.run_count||0)+' runs</span>'
        + '<span>&#x1F553; '+fmtTime(j.last_run_at)+'</span>'
      + '</div>'
      // Actions
      + '<div style="display:flex;align-items:center;gap:8px;margin-top:auto;padding-top:6px;border-top:1px solid var(--border)">'
        + '<label class="tog"><input type="checkbox" '+(j.enabled?'checked':'')+' onchange="toggleCron(\\''+j.id+'\\')"><span class="sl"></span></label>'
        + '<span style="font-size:11px;color:'+(j.enabled?'var(--green)':'var(--text3)')+'">'+( j.enabled?'Active':'Paused')+'</span>'
        + '<button class="btn btn-red" style="margin-left:auto;font-size:11px;padding:4px 10px" onclick="removeCron(\\''+j.id+'\\',\\''+esc(j.name)+'\\')">Delete</button>'
      + '</div>'
    + '</div>';
  }

  const runRows = rd.runs.map(r=>{
    const isErr = r.status==='error';
    return '<tr>'
      + '<td><strong>'+esc(r.job_name)+'</strong></td>'
      + '<td>'+(isErr?badge('Error','red'):badge('OK','green'))+'</td>'
      + '<td>'+fmtTimeFull(r.started_at)+'</td>'
      + '<td class="wrap" style="max-width:300px">'+(r.error?'<span style="color:var(--red);font-size:12px">'+esc(r.error)+'</span>':'<span style="color:var(--text3)">-</span>')+'</td>'
    + '</tr>';
  }).join('');

  el.innerHTML = \`
    <div class="page-header">
      <div class="page-title">Cron Jobs <span class="sub">\${activeJobs.length} active</span></div>
    </div>

    <!-- Stats -->
    <div class="cards" style="grid-template-columns:repeat(4,1fr);margin-bottom:24px">
      <div class="card card-sm card-accent">
        <div class="icon">&#x23F0;</div>
        <div class="val" style="font-size:22px">\${activeJobs.length}</div>
        <div class="lbl">Active Jobs</div>
      </div>
      <div class="card card-sm">
        <div class="icon">&#x23F8;&#xFE0F;</div>
        <div class="val" style="font-size:22px">\${inactiveJobs.length}</div>
        <div class="lbl">Paused</div>
      </div>
      <div class="card card-sm">
        <div class="icon">&#x1F504;</div>
        <div class="val" style="font-size:22px">\${totalRuns}</div>
        <div class="lbl">Total Runs</div>
      </div>
      <div class="card card-sm">
        <div class="icon">&#x274C;</div>
        <div class="val" style="font-size:22px;color:\${errorRuns?'var(--red)':'#fff'}">\${errorRuns}</div>
        <div class="lbl">Recent Errors</div>
      </div>
    </div>

    <!-- Active Jobs Grid -->
    \${activeJobs.length ? '<div class="panel"><div class="panel-title">&#x26A1; Active Jobs</div>'
      + '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">'
      + activeJobs.map(cronJobCard).join('')
      + '</div></div>' : ''}

    <!-- Inactive Jobs Grid -->
    \${inactiveJobs.length ? '<div class="panel"><div class="panel-title">&#x23F8;&#xFE0F; Paused Jobs</div>'
      + '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">'
      + inactiveJobs.map(cronJobCard).join('')
      + '</div></div>' : ''}

    \${!jd.jobs.length ? '<div class="panel"><div class="empty" style="padding:40px">No cron jobs configured. Create jobs via chat to schedule automated tasks.</div></div>' : ''}

    <!-- Run Log -->
    <div class="panel" style="padding:0;overflow:hidden">
      <div style="padding:16px 24px 12px;border-bottom:1px solid var(--border)">
        <div class="panel-title" style="margin-bottom:0">&#x1F4CB; Run History</div>
      </div>
      <div class="tbl-wrap" style="border:none;border-radius:0">
      <table>
        <thead><tr><th>Job</th><th>Status</th><th>Time</th><th>Error</th></tr></thead>
        <tbody>\${runRows||'<tr><td colspan="4" class="empty" style="padding:32px">No runs recorded yet</td></tr>'}</tbody>
      </table>
      </div>
    </div>
  \`;
}

async function toggleCron(id){await apiPost('/api/cron/jobs/'+id+'/toggle');loadTab('cron')}
async function removeCron(id,name){if(confirm('Delete "'+name+'"?')){await apiDelete('/api/cron/jobs/'+id);loadTab('cron')}}
`;
}
