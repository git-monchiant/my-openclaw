/** Traces tab — execution trace viewer showing orchestrator flow per message */

export function getTracesJs(): string {
  return `
// ===== TRACES =====
let tracesData = [];
let selectedTraceId = null;
let tracesRefreshTimer = null;

async function renderTraces(el){
  await loadTraces();
  el.innerHTML = renderTracesPage();
  bindTracesEvents(el);
  clearInterval(tracesRefreshTimer);
  tracesRefreshTimer = setInterval(async ()=>{
    if(activeTab !== 'traces') { clearInterval(tracesRefreshTimer); return; }
    await loadTraces();
    const listEl = document.getElementById('traces-list');
    if(listEl) listEl.innerHTML = renderTracesList();
    if(selectedTraceId){
      const detEl = document.getElementById('trace-detail');
      if(detEl) detEl.innerHTML = renderTraceDetail(selectedTraceId);
    }
  }, 2000);
}

async function loadTraces(){
  tracesData = await api('/api/traces?limit=50');
}

function refreshTracesList(){
  loadTraces().then(()=>{
    const listEl = document.getElementById('traces-list');
    if(listEl) listEl.innerHTML = renderTracesList();
    if(selectedTraceId){
      const detEl = document.getElementById('trace-detail');
      if(detEl) detEl.innerHTML = renderTraceDetail(selectedTraceId);
    }
  });
}

function renderTracesPage(){
  return '<div style="display:flex;gap:0;min-height:0">' +
    '<div style="width:340px;flex-shrink:0;border-right:1px solid var(--border)">' +
      '<div style="padding:10px 16px;border-bottom:1px solid var(--border);font-weight:600;font-size:14px">' +
        'Traces <span style="color:var(--muted);font-weight:400">('+tracesData.length+')</span>' +
      '</div>' +
      '<div id="traces-list">' + renderTracesList() + '</div>' +
    '</div>' +
    '<div style="flex:1;padding:16px 20px" id="trace-detail">' +
      (selectedTraceId ? renderTraceDetail(selectedTraceId) : renderTracesEmpty()) +
    '</div>' +
  '</div>';
}

function renderTracesList(){
  if(!tracesData.length) return '<div class="empty" style="padding:32px;font-size:13px">No traces yet.<br>Send a message to the bot.</div>';
  return tracesData.map(function(t){
    var isActive = t.id === selectedTraceId;
    var isRunning = t.status === 'running';
    var elapsed = t.totalElapsed || (Date.now() - t.startedAt);
    var agents = [];
    var seen = {};
    (t.steps||[]).forEach(function(s){ if(s.agent && s.agent!=='orchestrator' && !seen[s.agent]){ seen[s.agent]=1; agents.push(s.agent); }});
    var time = new Date(t.startedAt).toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    var dot = isRunning
      ? '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;animation:pulse-anim 1.5s infinite"></span>'
      : '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--muted)"></span>';

    return '<div onclick="selectTrace(this.dataset.id)" data-id="'+esc(t.id)+'" style="padding:10px 16px;border-bottom:1px solid var(--border);cursor:pointer;' +
      (isActive ? 'background:var(--hover);border-left:3px solid var(--accent)' : 'border-left:3px solid transparent') + '">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">' +
        dot +
        '<span style="font-weight:500;font-size:12px">'+esc(t.userId.substring(0,8))+'</span>' +
        '<span style="color:var(--muted);font-size:11px;margin-left:auto">'+time+'</span>' +
      '</div>' +
      '<div style="font-size:12px;color:var(--text);margin-bottom:3px">' +
        esc((t.message||'').substring(0,60)) +
      '</div>' +
      '<div style="display:flex;gap:4px;align-items:center">' +
        agents.map(function(a){ return '<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:var(--hover);color:var(--accent)">'+esc(a)+'</span>'; }).join('') +
        '<span style="font-size:10px;color:var(--muted);margin-left:auto">'+(elapsed/1000).toFixed(1)+'s</span>' +
      '</div>' +
    '</div>';
  }).join('');
}

function renderTracesEmpty(){
  return '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--muted)">' +
    '<div style="font-size:40px;margin-bottom:12px">&#x1F50D;</div>' +
    '<div style="font-size:14px">Select a trace to view execution flow</div>' +
  '</div>';
}

function selectTrace(idOrEl){
  var id = typeof idOrEl === 'string' ? idOrEl : idOrEl;
  selectedTraceId = id;
  var listEl = document.getElementById('traces-list');
  if(listEl) listEl.innerHTML = renderTracesList();
  var detEl = document.getElementById('trace-detail');
  if(detEl) detEl.innerHTML = renderTraceDetail(id);
}

// ===== Tree builder: group flat steps into orchestrator → agent phases =====
function buildTree(steps){
  var tree = [];
  var i = 0;
  while(i < steps.length){
    var s = steps[i];
    // Orchestrator-level steps
    if(s.type === 'receive' || s.type === 'respond'){
      tree.push({type: s.type, step: s, children: []});
      i++;
    }
    // Delegate starts an agent phase
    else if(s.type === 'delegate'){
      var agentId = s.agent || 'agent';
      var phase = {type:'agent_phase', agent: agentId, delegateStep: s, children: [], resultStep: null};
      i++;
      // Collect all steps belonging to this agent until we hit a result or next orchestrator step
      while(i < steps.length){
        var c = steps[i];
        if(c.type === 'result' && c.agent === agentId){
          phase.resultStep = c;
          i++;
          break;
        }
        if(c.type === 'error' && c.agent === agentId){
          phase.resultStep = c;
          i++;
          break;
        }
        // If we hit another delegate or respond, this phase ended without explicit result
        if(c.type === 'delegate' || c.type === 'respond' || c.type === 'receive'){
          break;
        }
        phase.children.push(c);
        i++;
      }
      tree.push(phase);
    }
    // Orchestrator thinking (between delegates)
    else if(s.type === 'thinking' && (!s.agent || s.agent === 'orchestrator')){
      tree.push({type:'thinking', step: s, children: []});
      i++;
    }
    // Agent-level thinking/tool_call outside of a delegate phase (shouldn't happen but handle gracefully)
    else {
      tree.push({type: s.type, step: s, children: []});
      i++;
    }
  }
  return tree;
}

// ===== Render tree =====
function renderTraceDetail(traceId){
  var trace = tracesData.find(function(t){ return t.id===traceId; });
  if(!trace) return renderTracesEmpty();

  var isRunning = trace.status === 'running';
  var elapsed = trace.totalElapsed || (Date.now() - trace.startedAt);
  var time = new Date(trace.startedAt).toLocaleString('th-TH');

  // Header (compact)
  var html = '<div style="margin-bottom:8px">' +
    '<div style="display:flex;align-items:center;gap:8px">' +
      (isRunning
        ? '<span style="padding:1px 8px;border-radius:8px;background:#22c55e20;color:#22c55e;font-size:10px;font-weight:600;animation:pulse-anim 1.5s infinite">RUNNING</span>'
        : '<span style="padding:1px 8px;border-radius:8px;background:var(--hover);color:var(--muted);font-size:10px;font-weight:600">COMPLETED</span>') +
      '<span style="color:var(--muted);font-size:11px">'+esc(trace.userId.substring(0,8))+' &middot; '+time+'</span>' +
      '<span style="color:var(--muted);font-size:11px;margin-left:auto;font-weight:600">'+(elapsed/1000).toFixed(1)+'s</span>' +
    '</div>' +
  '</div>';

  // Build tree from flat steps
  var tree = buildTree(trace.steps || []);

  // Render tree
  html += renderTreeNodes(tree, isRunning);

  return html;
}

function renderTreeNodes(nodes, isRunning){
  var html = '';
  for(var i=0; i<nodes.length; i++){
    var node = nodes[i];

    if(node.type === 'receive'){
      html += treeBox('&#x1F4E8;', 'Message', esc(node.step.detail || ''), '#64748b', null, fmtStepTime(node.step));
    }
    else if(node.type === 'thinking'){
      html += treeBox('&#x1F9E0;', 'Orchestrator', 'Thinking...', '#3b82f6', null, fmtStepTime(node.step));
    }
    else if(node.type === 'agent_phase'){
      html += renderAgentPhase(node);
    }
    else if(node.type === 'respond'){
      var respText = node.step.detail ? esc(node.step.detail) : 'Response sent';
      html += treeBox('&#x1F4AC;', 'Response', respText, '#06b6d4', null, fmtStepTime(node.step));
    }
    else {
      // Fallback for unrecognized
      html += treeBox('&#x2022;', node.type, esc(node.step?.detail||''), 'var(--muted)', null, node.step ? fmtStepTime(node.step) : '');
    }
  }
  // Running indicator
  if(isRunning){
    html += '<div style="display:flex;align-items:center;gap:8px;padding:8px 0;color:var(--muted);font-size:12px">' +
      '<span style="width:10px;height:10px;border-radius:50%;background:var(--accent);animation:pulse-anim 1.5s infinite;flex-shrink:0"></span>' +
      'Processing...' +
    '</div>';
  }
  return html;
}

function renderAgentPhase(phase){
  var agent = phase.agent || 'agent';
  var delegateDetail = phase.delegateStep.detail || '';
  var elapsed = phase.resultStep?.elapsed;
  var elapsedStr = elapsed ? (elapsed/1000).toFixed(1)+'s' : '';
  var isError = phase.resultStep?.type === 'error';
  var borderColor = isError ? '#ef4444' : '#8b5cf6';

  // Agent container (compact)
  var html = '<div style="margin:3px 0;border-left:3px solid '+borderColor+';border-radius:0 6px 6px 0;background:'+borderColor+'08">';

  // Agent header
  html += '<div style="padding:6px 10px;display:flex;align-items:center;gap:6px">' +
    '<span style="font-size:12px">&#x1F916;</span>' +
    '<span style="font-weight:700;font-size:12px;color:'+borderColor+'">'+esc(agent)+'</span>' +
    (elapsedStr ? '<span style="font-size:10px;color:var(--muted);margin-left:auto">'+elapsedStr+'</span>' : '') +
  '</div>';

  // Task description
  if(delegateDetail){
    html += '<div style="padding:0 10px 4px;font-size:11px;color:var(--text);opacity:0.8">' +
      esc(delegateDetail) +
    '</div>';
  }

  // Children (thinking, tool calls inside the agent)
  if(phase.children.length > 0){
    html += '<div style="padding:0 10px 2px;margin-left:10px;border-left:2px solid var(--border)">';
    for(var j=0; j<phase.children.length; j++){
      var c = phase.children[j];
      if(c.type === 'thinking'){
        html += miniStep('&#x1F9E0;', 'Thinking', '#3b82f6', fmtStepElapsed(c));
      } else if(c.type === 'tool_call'){
        html += miniStep('&#x1F527;', c.tool || 'tool', '#f59e0b', fmtStepElapsed(c), c.detail);
      } else if(c.type === 'delegate'){
        html += miniStep('&#x1F4E4;', 'delegate → '+(c.agent||'?'), '#8b5cf6', fmtStepElapsed(c), c.detail);
      } else {
        html += miniStep('&#x2022;', c.type+(c.tool?': '+c.tool:''), 'var(--muted)', fmtStepElapsed(c), c.detail);
      }
    }
    html += '</div>';
  }

  // Result (compact)
  if(phase.resultStep){
    var rs = phase.resultStep;
    if(rs.type === 'error'){
      html += '<div style="padding:2px 10px 6px">' +
        '<div style="font-size:11px;padding:4px 8px;background:#ef444415;border-radius:4px;border:1px solid #ef444430;color:#ef4444">' +
          '&#x274C; ' + esc(rs.detail || 'Error') +
        '</div></div>';
    } else if(rs.result) {
      html += '<div style="padding:2px 10px 6px">' +
        '<div style="font-size:11px;padding:4px 8px;background:var(--bg);border-radius:4px;border:1px solid var(--border);white-space:pre-wrap;word-break:break-word;color:var(--text)">' +
          '&#x2705; ' + esc(rs.result) +
        '</div></div>';
    }
  }

  html += '</div>';
  return html;
}

function treeBox(icon, label, content, color, children, timeStr){
  var html = '<div style="margin:3px 0;padding:6px 10px;border-radius:6px;background:var(--hover);border-left:3px solid '+color+'">' +
    '<div style="display:flex;align-items:center;gap:6px">' +
      '<span style="font-size:12px">'+icon+'</span>' +
      '<span style="font-weight:600;font-size:12px;color:'+color+'">'+label+'</span>' +
      (timeStr ? '<span style="font-size:10px;color:var(--muted);margin-left:auto">'+timeStr+'</span>' : '') +
    '</div>';
  if(content){
    html += '<div style="font-size:11px;color:var(--text);opacity:0.8;margin-top:2px">' + content + '</div>';
  }
  html += '</div>';
  return html;
}

function miniStep(icon, label, color, elapsed, detail){
  var html = '<div style="padding:3px 8px;display:flex;align-items:center;gap:6px">' +
    '<span style="font-size:11px">'+icon+'</span>' +
    '<span style="font-size:12px;color:'+color+';font-weight:500">'+esc(label)+'</span>' +
    (elapsed ? '<span style="font-size:10px;color:var(--muted);margin-left:auto">'+elapsed+'</span>' : '') +
  '</div>';
  if(detail){
    html += '<div style="padding:0 8px 2px 25px;font-size:10px;color:var(--muted)">' + esc(detail) + '</div>';
  }
  return html;
}

function fmtStepTime(step){
  if(!step || !step.ts) return '';
  return new Date(step.ts).toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
}

function fmtStepElapsed(step){
  if(!step || !step.elapsed) return '';
  return (step.elapsed/1000).toFixed(1)+'s';
}

function bindTracesEvents(el){
  if(tracesData.length && !selectedTraceId){
    selectTrace(tracesData[0].id);
  }
}
`;
}
