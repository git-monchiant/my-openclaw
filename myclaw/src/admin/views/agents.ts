/** Agents tab — master-detail split view with skills, usage, activity logs */

export function getAgentsJs(): string {
  return `
// ===== AGENTS =====
let _allSkills = [];
let _selectedAgent = '';
let _logOffset = 0;
let _cachedAgents = [];

async function renderAgents(el){
  const [ad, sd] = await Promise.all([api('/api/agents'), api('/api/skills')]);
  const agents = ad.agents || [];
  _allSkills = sd.skills || [];
  _cachedAgents = agents;
  const pColor = (p)=> p==='gemini'?'blue':p==='openrouter'?'green':p==='ollama'?'purple':p==='anthropic'?'orange':p==='openai'?'teal':'red';

  if(!_selectedAgent && agents.length) _selectedAgent = agents[0].id;

  // Agent list items
  const listItems = agents.map(a=>{
    const sk = (a.skills||[]);
    const isActive = _selectedAgent === a.id;
    return '<div class="agent-item'+(isActive?' active':'')+(a.enabled?'':' disabled')+'" onclick="selectAgent(\\''+esc(a.id)+'\\',event)"'+(a.enabled?'':' style="opacity:.5"')+'>'
      + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">'
        + '<div style="font-size:15px;font-weight:700;color:#fff;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(a.name)+'</div>'
        + (a.isDefault ? badge('DEFAULT','green') : '')
        + (a.enabled ? '' : badge('OFF','red'))
      + '</div>'
      + '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">'
        + badge(a.provider, pColor(a.provider))
        + '<span style="font-size:11px;color:var(--text2)"><code style="font-size:10px">'+esc(a.model)+'</code></span>'
      + '</div>'
      + '<div style="font-size:11px;color:var(--text3)">'
        + '<span>'+sk.length+' skills</span>'
        + (a.description ? ' &middot; '+esc(a.description.length>40?a.description.substring(0,40)+'...':a.description) : '')
      + '</div>'
    + '</div>';
  }).join('');

  const enabledCount = agents.filter(a=>a.enabled).length;

  el.innerHTML = \`
    <div class="page-header">
      <div class="page-title">Agents <span class="sub">\${agents.length} total &middot; \${enabledCount} active</span></div>
      <button class="btn btn-primary" onclick="showAddAgent()">+ New Agent</button>
    </div>

    <div class="agent-split">
      <!-- Left: Agent list -->
      <div class="agent-list">
        \${listItems || '<div class="empty" style="padding:40px">No agents configured</div>'}
      </div>

      <!-- Right: Detail -->
      <div class="agent-detail" id="agent-detail-panel">
        <div id="agent-detail-content">
          \${agents.length ? '<div class="empty" style="padding:60px"><div style="font-size:24px;margin-bottom:8px">&#x1F916;</div>Select an agent</div>' : '<div class="empty" style="padding:60px"><div style="font-size:24px;margin-bottom:8px">&#x2795;</div>Create an agent to get started</div>'}
        </div>
      </div>
    </div>

    <!-- Add Agent Form (hidden) -->
    <div id="add-agent-form" style="display:none;margin-top:16px">
      <div class="panel">
        <div class="panel-title">&#x2795; New Agent</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <input id="aa-id" placeholder="ID (e.g. claude)" style="padding:10px 14px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);font-size:13px;outline:none">
          <input id="aa-name" placeholder="Name (e.g. Claude)" style="padding:10px 14px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);font-size:13px;outline:none">
          <select id="aa-provider" style="padding:10px 14px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);font-size:13px;outline:none">
            <option value="gemini">gemini</option><option value="openrouter">openrouter</option><option value="anthropic">anthropic</option><option value="openai">openai</option><option value="ollama">ollama</option>
          </select>
          <input id="aa-model" placeholder="Model (e.g. claude-sonnet-4)" style="padding:10px 14px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);font-size:13px;outline:none">
          <input id="aa-desc" placeholder="Description (optional)" style="grid-column:span 2;padding:10px 14px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);font-size:13px;outline:none">
        </div>
        <div style="margin-top:14px;display:flex;gap:8px">
          <button class="btn btn-primary" onclick="submitAddAgent()">Create Agent</button>
          <button class="btn" onclick="document.getElementById('add-agent-form').style.display='none'">Cancel</button>
        </div>
      </div>
    </div>
  \`;

  if(_selectedAgent) renderAgentDetail(_selectedAgent);
}

function selectAgent(agentId, evt){
  if(evt && (evt.target.tagName==='BUTTON'||evt.target.tagName==='SELECT')) return;
  _selectedAgent = agentId;
  _logOffset = 0;
  document.querySelectorAll('.agent-item').forEach((el,i)=>{
    const a = _cachedAgents[i];
    if(a) el.classList.toggle('active', a.id===agentId);
  });
  renderAgentDetail(agentId);
}

function renderAgentDetail(agentId){
  const a = _cachedAgents.find(x=>x.id===agentId);
  if(!a) return;
  const el = document.getElementById('agent-detail-content');
  if(!el) return;

  const pColor = (p)=> p==='gemini'?'blue':p==='openrouter'?'green':p==='ollama'?'purple':p==='anthropic'?'orange':p==='openai'?'teal':'red';
  const sk = (a.skills||[]);
  const assignedIds = new Set(sk.map(s=>s.id));

  // Skill badges with remove
  const skillBadges = sk.map(s=>
    '<span class="b b-purple" style="font-size:10px;gap:3px">'+esc(s.name)
    +' <span style="opacity:.4">p'+s.priority+'</span>'
    +' <span style="cursor:pointer;opacity:.5;margin-left:2px;font-size:13px;line-height:1" onclick="removeAgentSkill(\\''+esc(a.id)+'\\',\\''+esc(s.id)+'\\')">&#x00D7;</span>'
    +'</span>'
  ).join(' ');

  // Unassigned dropdown
  const unassigned = _allSkills.filter(s=>!assignedIds.has(s.id));
  const assignHtml = unassigned.length > 0
    ? '<select id="assign-'+esc(a.id)+'" style="font-size:11px;padding:4px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface2);color:var(--text);outline:none">'
      + '<option value="">+ Add skill...</option>'
      + unassigned.map(s=>'<option value="'+esc(s.id)+'">'+esc(s.name)+'</option>').join('')
      + '</select>'
    : '<span style="font-size:11px;color:var(--text3)">All skills assigned</span>';

  el.innerHTML =
    // Header
    '<div class="agent-detail-header">'
      + '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">'
        + '<div style="font-size:20px;font-weight:800;color:#fff;letter-spacing:-.3px">'+esc(a.name)+'</div>'
        + (a.isDefault ? badge('DEFAULT','green') : '')
        + (a.enabled ? '' : badge('DISABLED','red'))
        + '<div style="margin-left:auto;display:flex;align-items:center;gap:6px">'
          + badge(a.provider, pColor(a.provider))
          + '<code style="font-size:11px">'+esc(a.model)+'</code>'
        + '</div>'
      + '</div>'
      + (a.description ? '<div style="font-size:12px;color:var(--text2);margin-bottom:12px;line-height:1.5">'+esc(a.description)+'</div>' : '')
      // Skills
      + '<div style="margin-bottom:14px">'
        + '<div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px;font-weight:700">Skills</div>'
        + '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">'
          + (skillBadges || '<span style="font-size:11px;color:var(--text3)">None assigned</span>')
          + ' ' + assignHtml
        + '</div>'
      + '</div>'
      // Actions
      + '<div style="display:flex;align-items:center;gap:12px;padding-top:14px;border-top:1px solid var(--border)">'
        + '<label class="tog"><input type="checkbox" '+(a.enabled?'checked':'')+' onchange="toggleAgent(\\''+esc(a.id)+'\\',this.checked)"><span class="sl"></span></label>'
        + '<span style="font-size:12px;font-weight:600;color:'+(a.enabled?'var(--green)':'var(--red)')+'">'+( a.enabled?'Enabled':'Disabled')+'</span>'
        + '<div style="margin-left:auto;display:flex;gap:8px">'
          + (!a.isDefault ? '<button class="btn" onclick="setDefaultAgent(\\''+esc(a.id)+'\\')">Set Default</button>' : '')
          + (!a.isDefault ? '<button class="btn btn-red" onclick="deleteAgentConfirm(\\''+esc(a.id)+'\\',\\''+esc(a.name)+'\\')">Delete</button>' : '')
        + '</div>'
      + '</div>'
    + '</div>'

    // Usage section
    + '<div style="padding:20px 24px;border-bottom:1px solid var(--border)">'
      + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">'
        + '<div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.8px">&#x1F4CA; API Usage</div>'
        + '<button class="btn" style="font-size:10px;padding:4px 10px" onclick="loadAgentUsage(\\''+esc(a.id)+'\\')">Refresh</button>'
      + '</div>'
      + '<div id="agent-usage-content"><div style="padding:12px;text-align:center;color:var(--text3);font-size:12px">Loading...</div></div>'
    + '</div>'

    // Logs section
    + '<div class="agent-detail-logs">'
      + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">'
        + '<div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.8px">&#x1F4CB; Activity Log</div>'
        + '<button class="btn" style="font-size:10px;padding:4px 10px" onclick="loadAgentLogs(\\''+esc(a.id)+'\\')">Refresh</button>'
      + '</div>'
      + '<div id="agent-logs-content"><div style="padding:20px;text-align:center;color:var(--text3);font-size:12px">Loading...</div></div>'
    + '</div>';

  // Bind assign dropdown
  const sel = document.getElementById('assign-'+a.id);
  if(sel) sel.onchange = async function(){
    if(!this.value) return;
    try{
      await apiPost('/api/agents/'+a.id+'/skills', {skillId:this.value, priority:5});
      loadTab('agents');
    }catch(e){alert('Error: '+e.message)}
  };

  loadAgentUsage(agentId);
  loadAgentLogs(agentId);
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
async function toggleAgent(id,enabled){
  try{
    const r=await api('/api/agents/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled})});
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

// ===== Agent Usage (detail panel) =====
async function loadAgentUsage(agentId){
  const el = document.getElementById('agent-usage-content');
  if(!el) return;
  try{
    const u = await api('/api/agents/'+encodeURIComponent(agentId)+'/usage');

    if(!u.totals.requests){
      el.innerHTML = '<div style="text-align:center;color:var(--text3);font-size:12px;padding:8px">No API calls recorded yet</div>';
      return;
    }

    const g = u.current;
    const pC = (pct)=> pct>=90?'var(--red)':pct>=70?'var(--orange)':'var(--green)';

    function miniBar(label, val, max, pct){
      const c = pC(pct);
      return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">'
        +'<div style="width:32px;font-size:10px;font-weight:700;color:var(--text2);text-align:right">'+label+'</div>'
        +'<div style="flex:1;position:relative;height:20px;background:rgba(255,255,255,.03);border-radius:8px;overflow:hidden">'
          +'<div style="height:100%;width:'+Math.min(100,pct)+'%;background:'+c+';opacity:.15;border-radius:8px;transition:width .4s"></div>'
          +'<div style="position:absolute;inset:0;display:flex;align-items:center;padding:0 10px;font-size:11px">'
            +'<span style="font-weight:700;color:#fff">'+val+'</span>'
            +'<span style="color:var(--text3);margin:0 3px">/</span>'
            +'<span style="color:var(--text3)">'+max+'</span>'
            +'<span style="margin-left:auto;font-size:10px;font-weight:700;color:'+c+'">'+pct+'%</span>'
          +'</div>'
        +'</div>'
      +'</div>';
    }

    el.innerHTML =
      miniBar('RPM', g.rpm, u.limits.RPM, g.rpmPct)
      + miniBar('RPD', g.rpd, u.limits.RPD, g.rpdPct)
      + miniBar('TPM', fmtNum(g.tpm), fmtNum(u.limits.TPM), g.tpmPct)
      + '<div style="display:flex;gap:16px;margin-top:12px;flex-wrap:wrap">'
        + '<div style="text-align:center;flex:1;min-width:60px">'
          + '<div style="font-size:18px;font-weight:800;color:#fff">'+u.totals.requests+'</div>'
          + '<div style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Requests</div>'
        + '</div>'
        + '<div style="text-align:center;flex:1;min-width:60px">'
          + '<div style="font-size:18px;font-weight:800;color:#fff">'+fmtNum(u.totals.totalTokens)+'</div>'
          + '<div style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Tokens</div>'
        + '</div>'
        + '<div style="text-align:center;flex:1;min-width:60px">'
          + '<div style="font-size:18px;font-weight:800;color:'+(u.totals.errors?'var(--red)':'#fff')+'">'+u.totals.errors+'</div>'
          + '<div style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Errors</div>'
        + '</div>'
        + '<div style="text-align:center;flex:1;min-width:60px">'
          + '<div style="font-size:18px;font-weight:800;color:'+(u.totals.rateLimits?'var(--orange)':'#fff')+'">'+u.totals.rateLimits+'</div>'
          + '<div style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">429s</div>'
        + '</div>'
      + '</div>';
  }catch(e){
    el.innerHTML = '<div style="text-align:center;color:var(--red);font-size:12px">'+esc(e.message)+'</div>';
  }
}

// ===== Agent Activity Logs (detail panel) =====
const _logLimit = 30;

async function loadAgentLogs(agentId){
  const el = document.getElementById('agent-logs-content');
  if(!el) return;
  el.innerHTML = '<div style="padding:16px;color:var(--text3);font-size:12px">Loading...</div>';
  try{
    const d = await api('/api/agents/'+encodeURIComponent(agentId)+'/logs?limit='+_logLimit+'&offset='+_logOffset);
    const logs = d.logs || [];

    if(!logs.length && _logOffset===0){
      el.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text3);font-size:13px">No activity logs yet</div>';
      return;
    }

    const typeIcon = (t)=> t==='delegate'?'&#x1F4E4;':t==='tool_call'?'&#x1F527;':t==='response'?'&#x2705;':'&#x2753;';
    const typeCls = (t)=> t==='delegate'?'blue':t==='tool_call'?'purple':t==='response'?'green':'orange';

    const rows = logs.map(l=>{
      const isErr = l.status==='error';
      const detail = l.detail ? (l.detail.length>80?l.detail.substring(0,80)+'...':l.detail) : '';
      return '<div style="padding:10px 0;border-bottom:1px solid var(--border);font-size:12px">'
        + '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">'
          + '<span style="font-size:13px">'+typeIcon(l.type)+'</span>'
          + badge(l.type, typeCls(l.type))
          + (isErr ? ' '+badge('error','red') : '')
          + '<code style="font-size:10px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(l.task||'-')+'</code>'
          + '<span style="color:var(--text3);font-size:10px;white-space:nowrap;flex-shrink:0">'+fmtTime(l.created_at)+'</span>'
        + '</div>'
        + (detail ? '<div style="color:var(--text2);font-size:11px;margin-left:24px;word-break:break-word;line-height:1.5" title="'+esc(l.detail||'')+'">'+esc(detail)+'</div>' : '')
      + '</div>';
    }).join('');

    const hasMore = d.total > (_logOffset + _logLimit);
    const hasPrev = _logOffset > 0;
    const showing = Math.min(_logOffset + _logLimit, d.total);

    el.innerHTML = rows
      + '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:12px;padding:6px 0;font-size:11px;color:var(--text3)">'
        + '<span>'+d.total+' total &middot; '+(_logOffset+1)+'-'+showing+'</span>'
        + '<div style="display:flex;gap:6px">'
          + (hasPrev?'<button class="btn" style="font-size:10px;padding:4px 10px" onclick="_logOffset-='+_logLimit+';loadAgentLogs(\\''+esc(agentId)+'\\')">Prev</button>':'')
          + (hasMore?'<button class="btn" style="font-size:10px;padding:4px 10px" onclick="_logOffset+='+_logLimit+';loadAgentLogs(\\''+esc(agentId)+'\\')">Next</button>':'')
        + '</div>'
      + '</div>';
  }catch(e){
    el.innerHTML = '<div style="padding:16px;text-align:center;color:var(--red);font-size:12px">Error: '+esc(e.message)+'</div>';
  }
}
`;
}
