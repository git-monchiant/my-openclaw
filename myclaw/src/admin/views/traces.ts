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

function renderTracesPage(){
  return '<div style="display:flex;gap:0;min-height:0">' +
    '<div style="width:340px;flex-shrink:0;border-right:1px solid var(--border)">' +
      '<div style="padding:10px 16px;border-bottom:1px solid var(--border);font-weight:600;font-size:14px">' +
        'Traces <span style="color:var(--muted);font-weight:400">('+tracesData.length+')</span>' +
      '</div>' +
      '<div id="traces-list">' + renderTracesList() + '</div>' +
    '</div>' +
    '<div style="flex:1;padding:16px 20px;overflow-y:auto" id="trace-detail">' +
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

    return '<div onclick="selectTrace(\\''+esc(t.id)+'\\')\" style="padding:10px 16px;border-bottom:1px solid var(--border);cursor:pointer;' +
      (isActive ? 'background:var(--hover);border-left:3px solid var(--accent)' : 'border-left:3px solid transparent') + '">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">' +
        dot +
        '<span style="font-weight:500;font-size:12px">'+esc(t.userId.substring(0,8))+'</span>' +
        '<span style="color:var(--muted);font-size:11px;margin-left:auto">'+time+'</span>' +
      '</div>' +
      '<div style="font-size:12px;color:var(--text);margin-bottom:3px">'+esc((t.message||'').substring(0,60))+'</div>' +
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

function selectTrace(id){
  selectedTraceId = id;
  var listEl = document.getElementById('traces-list');
  if(listEl) listEl.innerHTML = renderTracesList();
  var detEl = document.getElementById('trace-detail');
  if(detEl) detEl.innerHTML = renderTraceDetail(id);
}

// ===== Build orchestrator-centric tree =====
// โครงสร้าง:
//   Orchestrator (container)
//     ├─ thinking
//     ├─ Agent phase (nested)
//     │    ├─ thinking / tool_call
//     │    └─ result
//     ├─ thinking
//     └─ Response
function buildOrchestratorTree(steps){
  // กรอง receive + duplicate orchestrator-level delegate
  var inner = steps.filter(function(s){
    if(s.type === 'receive') return false;
    if(s.type === 'delegate' && (!s.agent || s.agent === 'orchestrator')) return false;
    return true;
  });

  var children = [];
  var i = 0;
  while(i < inner.length){
    var s = inner[i];
    if(s.type === 'delegate'){
      var agentId = s.agent || 'agent';
      var phase = {type:'agent_phase', agent:agentId, delegateStep:s, children:[], resultStep:null};
      i++;
      while(i < inner.length){
        var c = inner[i];
        if((c.type==='result' || c.type==='error') && c.agent === agentId){
          phase.resultStep = c; i++; break;
        }
        if(c.type==='delegate' || c.type==='respond') break;
        phase.children.push(c); i++;
      }
      children.push(phase);
    } else {
      children.push(s); i++;
    }
  }
  return children;
}

// ===== Render =====
function renderTraceDetail(traceId){
  var trace = tracesData.find(function(t){ return t.id===traceId; });
  if(!trace) return renderTracesEmpty();

  var isRunning = trace.status === 'running';
  var elapsed = trace.totalElapsed || (Date.now() - trace.startedAt);
  var time = new Date(trace.startedAt).toLocaleString('th-TH');

  // Header
  var html = '<div style="margin-bottom:12px;display:flex;align-items:center;gap:8px">' +
    (isRunning
      ? '<span style="padding:2px 8px;border-radius:8px;background:#22c55e20;color:#22c55e;font-size:10px;font-weight:700;animation:pulse-anim 1.5s infinite">RUNNING</span>'
      : '<span style="padding:2px 8px;border-radius:8px;background:var(--hover);color:var(--muted);font-size:10px;font-weight:700">COMPLETED</span>') +
    '<span style="color:var(--muted);font-size:11px">'+esc(trace.userId.substring(0,8))+' &middot; '+time+'</span>' +
    '<span style="color:var(--muted);font-size:11px;margin-left:auto;font-weight:600">'+(elapsed/1000).toFixed(1)+'s</span>' +
  '</div>';

  // User message card — wide rectangle, same visual level as Orchestrator box
  if(trace.message){
    html += '<div style="margin-bottom:6px;padding:8px 14px;background:var(--hover);border-radius:8px;border:1px solid var(--border);display:flex;align-items:center;gap:10px">' +
      renderUserMessageContent(trace.message) +
      '<span style="font-size:10px;color:var(--muted);flex-shrink:0">'+time+'</span>' +
    '</div>';
  }

  // Orchestrator container
  var children = buildOrchestratorTree(trace.steps || []);
  html += renderOrchestratorBox(children, isRunning);

  return html;
}

function renderOrchestratorBox(children, isRunning){
  var html = '<div style="border:1px solid #3b82f640;border-radius:8px;background:#3b82f608">' +
    // OR header
    '<div style="padding:7px 12px;border-bottom:1px solid #3b82f620;display:flex;align-items:center;gap:6px">' +
      '<span style="font-size:11px">&#x1F9E0;</span>' +
      '<span style="font-weight:700;font-size:12px;color:#3b82f6">Orchestrator</span>' +
    '</div>' +
    // children
    '<div style="padding:8px 12px">';

  for(var i=0; i<children.length; i++){
    var child = children[i];
    var isLast = i === children.length-1 && !isRunning;
    html += renderOrchestratorChild(child, isLast);
  }

  if(isRunning){
    html += treeItem(
      pulseDot('#22c55e'),
      '<span style="font-size:12px;color:var(--muted)">Processing...</span>',
      '', true
    );
  }

  html += '</div></div>';
  return html;
}

function renderOrchestratorChild(node, isLast){
  // thinking
  if(node.type === 'thinking'){
    return treeItem(
      colorDot('#3b82f6'),
      '<span style="font-size:11px;font-weight:500;color:#3b82f6">Thinking</span>' +
      (node.detail ? '&nbsp;<span style="font-size:10px;color:var(--muted)">'+esc(node.detail.substring(0,60))+'</span>' : ''),
      fmtTime(node), isLast
    );
  }
  // respond
  if(node.type === 'respond'){
    var txt = node.detail ? esc(node.detail.substring(0,100)) : 'Response sent';
    return treeItem(
      colorDot('#06b6d4'),
      '<span style="font-size:11px;font-weight:600;color:#06b6d4">Response</span>&nbsp;' +
      '<span style="font-size:11px;color:var(--muted)">'+txt+'</span>',
      fmtTime(node), isLast
    );
  }
  // agent phase (nested box)
  if(node.type === 'agent_phase'){
    return treeItem(
      colorDot('#8b5cf6'),
      renderAgentBox(node),
      '', isLast
    );
  }
  // tool_call or other
  var tcColor = node.type==='tool_call' ? '#f59e0b' : node.type==='error' ? '#ef4444' : 'var(--muted)';
  var tcLabel = node.tool || node.type;
  return treeItem(
    colorDot(tcColor),
    '<span style="font-size:11px;font-weight:500;color:'+tcColor+'">'+esc(tcLabel)+'</span>' +
    (node.detail ? '&nbsp;<span style="font-size:10px;color:var(--muted)">'+esc(node.detail.substring(0,60))+'</span>' : ''),
    fmtTime(node), isLast
  );
}

function renderAgentBox(phase){
  var agent = phase.agent || 'agent';
  var isError = phase.resultStep && phase.resultStep.type === 'error';
  var color = isError ? '#ef4444' : '#8b5cf6';
  var elapsed = phase.resultStep && phase.resultStep.elapsed ? (phase.resultStep.elapsed/1000).toFixed(1)+'s' : '';

  var html = '<div style="flex:1;border:1px solid '+color+'35;border-radius:7px;background:'+color+'06;overflow:hidden">' +
    // agent header
    '<div style="padding:5px 10px;background:'+color+'10;display:flex;align-items:center;gap:6px;border-bottom:1px solid '+color+'20">' +
      '<span style="font-size:10px">&#x1F916;</span>' +
      '<span style="font-weight:700;font-size:12px;color:'+color+'">'+esc(agent)+'</span>' +
      (phase.delegateStep.detail
        ? '<span style="font-size:10px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0">'+esc(phase.delegateStep.detail.substring(0,80))+'</span>'
        : '') +
      (elapsed ? '<span style="font-size:10px;color:var(--muted);flex-shrink:0">'+elapsed+'</span>' : '') +
    '</div>';

  // agent's internal steps
  if(phase.children.length > 0){
    html += '<div style="padding:6px 10px 2px">';
    for(var j=0; j<phase.children.length; j++){
      var c = phase.children[j];
      var isLastC = j === phase.children.length-1 && !phase.resultStep;
      var cColor = c.type==='thinking' ? '#3b82f6' : c.type==='tool_call' ? '#f59e0b' : c.type==='error' ? '#ef4444' : 'var(--muted)';
      var cLabel = c.type==='thinking' ? 'Thinking' : (c.tool || c.type);
      html += treeItem(
        miniDot(cColor),
        '<span style="font-size:11px;font-weight:500;color:'+cColor+'">'+esc(cLabel)+'</span>' +
        (c.detail ? '&nbsp;<span style="font-size:10px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;display:inline-block;vertical-align:middle;max-width:200px">'+esc(c.detail.substring(0,80))+'</span>' : ''),
        c.elapsed ? (c.elapsed/1000).toFixed(1)+'s' : '',
        isLastC
      );
    }
    html += '</div>';
  }

  // result
  if(phase.resultStep){
    var rs = phase.resultStep;
    if(rs.type === 'error'){
      html += '<div style="margin:0 8px 8px;padding:5px 8px;background:#ef444415;border-radius:5px;border:1px solid #ef444430;color:#ef4444;font-size:11px">&#x274C; '+esc(rs.detail||'Error')+'</div>';
    } else if(rs.result){
      html += '<div style="margin:0 8px 8px;padding:5px 8px;background:var(--bg);border-radius:5px;border:1px solid var(--border);font-size:11px;white-space:pre-wrap;word-break:break-word;color:var(--text);max-height:160px;overflow-y:auto">&#x2705; '+esc(rs.result)+'</div>';
    }
  }

  html += '</div>';
  return html;
}

// ===== treeItem: dot + vertical connector + content =====
function treeItem(dotHtml, contentHtml, timeStr, isLast){
  return '<div style="display:flex;gap:0;margin-bottom:'+(isLast?'0':'4px')+'">' +
    '<div style="display:flex;flex-direction:column;align-items:center;width:20px;flex-shrink:0">' +
      '<div style="margin-top:6px">'+dotHtml+'</div>' +
      (!isLast ? '<div style="flex:1;width:2px;background:var(--border);margin-top:3px;min-height:10px"></div>' : '') +
    '</div>' +
    '<div style="flex:1;padding:3px 0 3px 8px;display:flex;align-items:flex-start;gap:4px;min-width:0">' +
      '<div style="flex:1;min-width:0">'+contentHtml+'</div>' +
      (timeStr ? '<span style="font-size:10px;color:var(--muted);flex-shrink:0;padding-top:2px">'+timeStr+'</span>' : '') +
    '</div>' +
  '</div>';
}

// ===== Parse user message format =====
function renderUserMessageContent(msg){
  // [media:video messageId=xxx mimeType=... size=...KB]
  var mediaMatch = msg.match(/\\[media:(image|video|audio|file)\\s+([^\\]]*)\\]/);
  if(mediaMatch){
    var mtype = mediaMatch[1];
    var attrs = mediaMatch[2];
    var sizeMatch = attrs.match(/size=([^\\s\\]]+)/);
    var mimeMatch = attrs.match(/mimeType=([^\\s\\]]+)/);
    var fnMatch  = attrs.match(/filename="([^"]+)"/);
    var icon = mtype==='image' ? '&#x1F5BC;' : mtype==='video' ? '&#x1F3AC;' : mtype==='audio' ? '&#x1F3A4;' : '&#x1F4CE;';
    var label = mtype.charAt(0).toUpperCase()+mtype.slice(1);
    var meta = (fnMatch ? fnMatch[1]+' ' : '') + (mimeMatch ? mimeMatch[1]+' ' : '') + (sizeMatch ? sizeMatch[1] : '');
    // check if there's extra text after the media tag (e.g. re-requested or user command)
    var extra = msg.replace(/\\[media:[^\\]]+\\]/, '').replace(/^\\s*\\n+/, '').trim();
    return '<span style="font-size:16px;flex-shrink:0">'+icon+'</span>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:12px;font-weight:600;color:var(--text)">'+label+'</div>' +
        '<div style="font-size:10px;color:var(--muted)">'+esc(meta)+'</div>' +
        (extra ? '<div style="font-size:11px;color:var(--text);margin-top:2px">'+esc(extra.substring(0,100))+'</div>' : '') +
      '</div>';
  }
  // [User is quoting/replying to this message: "..."]
  var quoteMatch = msg.match(/\\[User is (?:quoting|replying)[^\\]]*"([^"]{0,80})"/);
  if(quoteMatch){
    var quoted = quoteMatch[1];
    var userText = msg.replace(/\\[[^\\]]+\\]\\s*/g,'').trim();
    return '<span style="font-size:16px;flex-shrink:0">&#x1F4AC;</span>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:10px;color:var(--muted);margin-bottom:2px">Reply to: "'+esc(quoted)+'"</div>' +
        (userText ? '<div style="font-size:12px;color:var(--text)">'+esc(userText.substring(0,100))+'</div>' : '') +
      '</div>';
  }
  // [SYSTEM: ...] — size limit or error
  var sysMatch = msg.match(/\\[SYSTEM:\\s*([^\\]]+)\\]/);
  if(sysMatch){
    return '<span style="font-size:16px;flex-shrink:0">&#x26A0;&#xFE0F;</span>' +
      '<span style="font-size:12px;color:#f59e0b;flex:1">'+esc(sysMatch[1].substring(0,120))+'</span>';
  }
  // Plain text
  return '<span style="font-size:16px;flex-shrink:0">&#x1F464;</span>' +
    '<span style="font-size:12px;color:var(--text);flex:1;word-break:break-word">'+esc(msg.substring(0,200))+'</span>';
}

function colorDot(color){
  return '<div style="width:12px;height:12px;border-radius:50%;background:'+color+';border:2px solid var(--bg);flex-shrink:0"></div>';
}
function miniDot(color){
  return '<div style="width:10px;height:10px;border-radius:50%;background:'+color+';border:2px solid var(--bg);flex-shrink:0"></div>';
}
function pulseDot(color){
  return '<div style="width:12px;height:12px;border-radius:50%;background:'+color+';animation:pulse-anim 1.5s infinite;flex-shrink:0"></div>';
}
function fmtTime(step){
  if(!step || !step.ts) return '';
  return new Date(step.ts).toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
}

function bindTracesEvents(el){
  if(tracesData.length && !selectedTraceId){
    selectTrace(tracesData[0].id);
  }
}
`;
}
