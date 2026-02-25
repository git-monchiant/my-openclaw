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
  var html = '<div style="position:relative;padding-left:20px">';
  // vertical connector line
  html += '<div style="position:absolute;left:7px;top:10px;bottom:10px;width:2px;background:var(--border)"></div>';

  for(var i=0; i<nodes.length; i++){
    var node = nodes[i];
    var isLast = i === nodes.length - 1 && !isRunning;

    if(node.type === 'receive'){
      html += treeRow('&#x1F4E8;', 'Message', esc(node.step.detail||''), '#64748b', fmtStepTime(node.step), isLast);
    }
    else if(node.type === 'thinking'){
      html += treeRow('&#x1F9E0;', 'Orchestrator', 'Thinking...', '#3b82f6', fmtStepTime(node.step), isLast);
    }
    else if(node.type === 'agent_phase'){
      html += renderAgentPhase(node, isLast);
    }
    else if(node.type === 'respond'){
      html += treeRow('&#x1F4AC;', 'Response', node.step.detail ? esc(node.step.detail) : 'Response sent', '#06b6d4', fmtStepTime(node.step), isLast);
    }
    else {
      html += treeRow('&#x2022;', node.type, esc(node.step?.detail||''), 'var(--muted)', node.step ? fmtStepTime(node.step) : '', isLast);
    }
  }

  if(isRunning){
    html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 0 2px 0;color:var(--muted);font-size:12px">' +
      '<span style="position:absolute;left:2px;width:12px;height:12px;border-radius:50%;background:var(--accent);animation:pulse-anim 1.5s infinite;border:2px solid var(--bg)"></span>' +
      '<span style="margin-left:4px">Processing...</span>' +
    '</div>';
  }

  html += '</div>';
  return html;
}

function treeRow(icon, label, content, color, timeStr, isLast){
  return '<div style="position:relative;margin-bottom:'+(isLast?'0':'6px')+';padding-left:20px">' +
    // dot on the line
    '<div style="position:absolute;left:1px;top:8px;width:14px;height:14px;border-radius:50%;background:'+color+';border:2px solid var(--bg);display:flex;align-items:center;justify-content:center;font-size:8px">'+icon+'</div>' +
    '<div style="background:var(--hover);border-radius:6px;padding:6px 10px">' +
      '<div style="display:flex;align-items:center;gap:6px">' +
        '<span style="font-weight:600;font-size:12px;color:'+color+'">'+label+'</span>' +
        (timeStr ? '<span style="font-size:10px;color:var(--muted);margin-left:auto">'+timeStr+'</span>' : '') +
      '</div>' +
      (content ? '<div style="font-size:11px;color:var(--text);opacity:0.8;margin-top:2px;word-break:break-word">'+content+'</div>' : '') +
    '</div>' +
  '</div>';
}

function renderAgentPhase(phase, isLast){
  var agent = phase.agent || 'agent';
  var delegateDetail = phase.delegateStep.detail || '';
  var elapsed = phase.resultStep?.elapsed;
  var elapsedStr = elapsed ? (elapsed/1000).toFixed(1)+'s' : '';
  var isError = phase.resultStep?.type === 'error';
  var color = isError ? '#ef4444' : '#8b5cf6';

  var html = '<div style="position:relative;margin-bottom:'+(isLast?'0':'6px')+';padding-left:20px">' +
    // dot
    '<div style="position:absolute;left:1px;top:8px;width:14px;height:14px;border-radius:50%;background:'+color+';border:2px solid var(--bg);display:flex;align-items:center;justify-content:center;font-size:8px">&#x1F916;</div>' +
    // agent box
    '<div style="border:1px solid '+color+'40;border-radius:6px;background:'+color+'08">' +
      // header
      '<div style="padding:6px 10px;display:flex;align-items:center;gap:6px;border-bottom:1px solid '+color+'20">' +
        '<span style="font-weight:700;font-size:12px;color:'+color+'">'+esc(agent)+'</span>' +
        (delegateDetail ? '<span style="font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:300px">'+esc(delegateDetail)+'</span>' : '') +
        (elapsedStr ? '<span style="font-size:10px;color:var(--muted);margin-left:auto;flex-shrink:0">'+elapsedStr+'</span>' : '') +
      '</div>';

  // Children (inner steps) with own indent tree
  if(phase.children.length > 0){
    html += '<div style="position:relative;padding:4px 10px 4px 28px">' +
      '<div style="position:absolute;left:18px;top:6px;bottom:6px;width:2px;background:'+color+'30"></div>';
    for(var j=0; j<phase.children.length; j++){
      var c = phase.children[j];
      var cIsLast = j === phase.children.length - 1;
      var cIcon = c.type==='thinking' ? '&#x1F9E0;' : c.type==='tool_call' ? '&#x1F527;' : '&#x2022;';
      var cColor = c.type==='thinking' ? '#3b82f6' : c.type==='tool_call' ? '#f59e0b' : 'var(--muted)';
      var cLabel = c.type==='thinking' ? 'Thinking' : (c.tool || c.type);
      html += '<div style="position:relative;padding-left:16px;margin-bottom:'+(cIsLast?'0':'3px')+'">' +
        '<div style="position:absolute;left:1px;top:6px;width:10px;height:10px;border-radius:50%;background:'+cColor+';border:2px solid var(--bg)"></div>' +
        '<div style="display:flex;align-items:center;gap:6px;padding:3px 0">' +
          '<span style="font-size:11px;color:'+cColor+';font-weight:500">'+cIcon+' '+esc(cLabel)+'</span>' +
          (c.elapsed ? '<span style="font-size:10px;color:var(--muted);margin-left:auto">'+(c.elapsed/1000).toFixed(1)+'s</span>' : '') +
        '</div>' +
        (c.detail ? '<div style="font-size:10px;color:var(--muted);padding-left:4px;word-break:break-word">'+esc(c.detail)+'</div>' : '') +
      '</div>';
    }
    html += '</div>';
  }

  // Result
  if(phase.resultStep){
    var rs = phase.resultStep;
    if(rs.type === 'error'){
      html += '<div style="padding:4px 10px 6px">' +
        '<div style="font-size:11px;padding:4px 8px;background:#ef444415;border-radius:4px;border:1px solid #ef444430;color:#ef4444">&#x274C; '+esc(rs.detail||'Error')+'</div>' +
      '</div>';
    } else if(rs.result){
      html += '<div style="padding:4px 10px 6px">' +
        '<div style="font-size:11px;padding:6px 8px;background:var(--bg);border-radius:4px;border:1px solid var(--border);white-space:pre-wrap;word-break:break-word;color:var(--text);max-height:200px;overflow-y:auto">&#x2705; '+esc(rs.result)+'</div>' +
      '</div>';
    }
  }

  html += '</div></div>';
  return html;
}

function treeBox(icon, label, content, color, children, timeStr){
  return treeRow(icon, label, content, color, timeStr, false);
}

function miniStep(icon, label, color, elapsed, detail){
  var html = '<div style="padding:3px 8px;display:flex;align-items:center;gap:6px">' +
    '<span style="font-size:11px">'+icon+'</span>' +
    '<span style="font-size:12px;color:'+color+';font-weight:500">'+esc(label)+'</span>' +
    (elapsed ? '<span style="font-size:10px;color:var(--muted);margin-left:auto">'+elapsed+'</span>' : '') +
  '</div>';
  if(detail){
    html += '<div style="padding:0 8px 2px 25px;font-size:10px;color:var(--muted)">'+esc(detail)+'</div>';
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
