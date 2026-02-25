/** Config + Tools + Memory tabs — system configuration views */

export function getConfigJs(): string {
  return `
// ===== CONFIG =====
async function renderConfig(el){
  const [d, dd] = await Promise.all([api('/api/config'), api('/api/deps')]);
  const rows = d.config.map(c=>{
    let val;
    if(c.isSensitive) val = '<span style="color:var(--green)">'+esc(c.value)+'</span>';
    else if(c.isOverride) val = '<span style="color:var(--orange)">'+esc(c.value)+'</span> '+badge('override','orange');
    else val = esc(c.value);
    return '<tr><td><code>'+esc(c.key)+'</code></td><td>'+val+'</td></tr>';
  }).join('');

  const depCards = (dd.deps||[]).map(dep=>{
    const isInstalled = dep.installed;
    return '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;transition:all .2s">'
      + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">'
        + '<strong style="font-size:14px;color:#fff;flex:1">'+esc(dep.name)+'</strong>'
        + (isInstalled ? dot('green')+' '+badge('installed','green') : dot('red')+' '+badge('missing','red'))
      + '</div>'
      + '<div style="font-size:12px;color:var(--text2);margin-bottom:8px">'
        + (isInstalled ? 'Version <code style="font-size:11px">'+esc(dep.version)+'</code>' : '<span style="color:var(--red)">Not installed</span>')
      + '</div>'
      + '<div style="display:flex;align-items:center;gap:6px">'
        + '<code style="font-size:10px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;user-select:all">'+esc(dep.installCmd)+'</code>'
        + '<button class="btn" style="padding:3px 10px;font-size:10px;flex-shrink:0" onclick="navigator.clipboard.writeText(\\''+esc(dep.installCmd)+'\\');this.textContent=\\'Copied!\\';setTimeout(()=>this.textContent=\\'Copy\\',1500)">Copy</button>'
      + '</div>'
    + '</div>';
  }).join('');

  el.innerHTML = \`
    <div class="page-header">
      <div class="page-title">Configuration</div>
    </div>

    <!-- System Dependencies -->
    <div class="panel" style="margin-bottom:24px">
      <div class="panel-title">&#x1F4E6; System Dependencies</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px">
        \${depCards||'<div class="empty" style="padding:20px">No dependencies defined</div>'}
      </div>
    </div>

    <!-- Environment Variables -->
    <div class="panel" style="padding:0;overflow:hidden">
      <div style="padding:16px 24px 12px;border-bottom:1px solid var(--border)">
        <div class="panel-title" style="margin-bottom:0">&#x2699;&#xFE0F; Environment Variables <span style="font-weight:400;font-size:11px;color:var(--text3);text-transform:none;letter-spacing:0">\${d.config.length} vars</span></div>
      </div>
      <div class="tbl-wrap" style="border:none;border-radius:0">
      <table>
        <thead><tr><th style="width:260px">Key</th><th>Value</th></tr></thead>
        <tbody>\${rows||'<tr><td colspan="2" class="empty" style="padding:32px">No config</td></tr>'}</tbody>
      </table>
      </div>
    </div>
  \`;
}

// ===== TOOLS =====
async function renderTools(el){
  const d = await api('/api/tools');

  el.innerHTML = \`
    <div class="page-header">
      <div class="page-title">Registered Tools <span class="sub">\${d.total} tools</span></div>
    </div>

    <div class="panel" style="padding:0;overflow:hidden">
      <div class="tbl-wrap" style="border:none;border-radius:0">
      <table>
        <thead><tr><th style="width:36px">#</th><th style="width:180px">Name</th><th>Description</th></tr></thead>
        <tbody>\${d.tools.map((t,i)=>
          '<tr>'
          +'<td style="color:var(--text3);font-size:12px">'+(i+1)+'</td>'
          +'<td><code style="font-size:12px">'+esc(t.name)+'</code></td>'
          +'<td class="wrap" style="color:var(--text2);font-size:12px;max-width:500px">'+esc(t.description)+'</td>'
          +'</tr>'
        ).join('')}</tbody>
      </table>
      </div>
    </div>
  \`;
}

// ===== MEMORY =====
let _kbEditingDoc = null; // currently editing doc

async function renderMemory(el){
  const [d, kb] = await Promise.all([api('/api/memory'), api('/api/knowledge')]);
  const total = (d.chunkCount||0);
  const embedded = (d.embeddedChunks||0);
  const pct = total>0 ? Math.round(embedded/total*100) : 0;
  const pctColor = pct>=90?'green':pct>=50?'orange':'red';

  const KB_CATS = {general:'blue',faq:'green',rules:'orange',docs:'purple',other:'blue'};

  function kbCard(doc){
    const catColor = KB_CATS[doc.category]||'blue';
    return '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;cursor:pointer;transition:all .2s" onclick="editKbDoc(\\''+esc(doc.id)+'\\')">'
      + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">'
        + '<div style="font-size:14px;font-weight:700;color:#fff;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(doc.title)+'">'+esc(doc.title)+'</div>'
        + badge(doc.category, catColor)
      + '</div>'
      + '<div style="display:flex;align-items:center;gap:12px;font-size:11px;color:var(--text3)">'
        + '<span>'+doc.chunk_count+' chunks</span>'
        + '<span>&middot; '+fmtTime(doc.updated_at)+'</span>'
      + '</div>'
    + '</div>';
  }

  const docCards = (kb.docs||[]).map(kbCard).join('');

  el.innerHTML = \`
    <div class="page-header">
      <div class="page-title">Memory & Knowledge</div>
    </div>

    <!-- Stats -->
    <div class="cards" style="grid-template-columns:repeat(5,1fr);margin-bottom:24px">
      <div class="card card-sm">
        <div class="icon">&#x1F50C;</div>
        <div class="val" style="font-size:18px">\${esc(d.embeddingProvider||'none')}</div>
        <div class="lbl">Provider</div>
        <div class="sub">\${esc(d.searchMode||'N/A')}</div>
      </div>
      <div class="card card-sm card-accent">
        <div class="icon">&#x1F4E6;</div>
        <div class="val" style="font-size:22px">\${total}</div>
        <div class="lbl">Total Chunks</div>
        <div class="pbar pbar-\${pctColor}"><div class="pbar-fill" style="width:\${pct}%"></div></div>
        <div class="sub">\${pct}% embedded</div>
      </div>
      <div class="card card-sm">
        <div class="icon">&#x2705;</div>
        <div class="val" style="font-size:22px">\${embedded}</div>
        <div class="lbl">Embedded</div>
      </div>
      <div class="card card-sm">
        <div class="icon">&#x1F4DA;</div>
        <div class="val" style="font-size:22px">\${kb.total||0}</div>
        <div class="lbl">KB Docs</div>
        <div class="sub">\${kb.kbChunks||0} chunks</div>
      </div>
      <div class="card card-sm">
        <div class="icon">&#x1F5C4;&#xFE0F;</div>
        <div class="val" style="font-size:22px">\${d.cacheCount||0}</div>
        <div class="lbl">Cache</div>
      </div>
    </div>

    <!-- Knowledge Base -->
    <div class="panel">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <div class="panel-title" style="margin-bottom:0">&#x1F4DA; Knowledge Base</div>
        <button class="btn btn-primary" onclick="newKbDoc()">+ New Document</button>
      </div>

      \${docCards
        ? '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px">' + docCards + '</div>'
        : '<div class="empty" style="padding:40px"><div style="font-size:24px;margin-bottom:8px">&#x1F4DA;</div><div style="font-size:14px;color:#fff;font-weight:600;margin-bottom:6px">No Documents</div><div style="color:var(--text3);font-size:12px">Create markdown documents as a knowledge base for your agents.<br>Agents will find these when using memory_search.</div></div>'
      }
    </div>

    <!-- KB Editor (hidden) -->
    <div id="kb-editor" style="display:none">
      <div class="panel">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
          <div class="panel-title" style="margin-bottom:0" id="kb-editor-title">&#x270F;&#xFE0F; New Document</div>
          <div style="margin-left:auto;display:flex;gap:8px">
            <button class="btn" onclick="closeKbEditor()">Cancel</button>
            <button class="btn btn-primary" onclick="saveKbDoc()" id="kb-save-btn">Save & Index</button>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr 180px;gap:12px;margin-bottom:12px">
          <input id="kb-id" placeholder="Document ID (e.g. faq-general)" style="padding:10px 14px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);font-size:13px;outline:none">
          <input id="kb-title" placeholder="Title" style="padding:10px 14px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);font-size:13px;outline:none">
          <select id="kb-category" style="padding:10px 14px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);font-size:13px;outline:none">
            <option value="general">General</option>
            <option value="faq">FAQ</option>
            <option value="rules">Rules</option>
            <option value="docs">Documentation</option>
            <option value="other">Other</option>
          </select>
        </div>

        <textarea id="kb-content" placeholder="Write markdown content here...\\n\\n# Heading\\n\\nYour knowledge base content that agents can search." style="width:100%;min-height:300px;padding:16px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);font-size:13px;font-family:'SF Mono','JetBrains Mono',Menlo,monospace;line-height:1.6;resize:vertical;outline:none;tab-size:2"></textarea>

        <div style="display:flex;align-items:center;gap:12px;margin-top:12px" id="kb-actions">
          <span id="kb-status" style="font-size:11px;color:var(--text3)"></span>
          <div style="margin-left:auto;display:flex;gap:8px" id="kb-extra-actions"></div>
        </div>
      </div>
    </div>
  \`;
}

function newKbDoc(){
  _kbEditingDoc = null;
  document.getElementById('kb-editor').style.display = 'block';
  document.getElementById('kb-editor-title').innerHTML = '&#x2795; New Document';
  document.getElementById('kb-id').value = '';
  document.getElementById('kb-id').disabled = false;
  document.getElementById('kb-title').value = '';
  document.getElementById('kb-category').value = 'general';
  document.getElementById('kb-content').value = '';
  document.getElementById('kb-status').textContent = '';
  document.getElementById('kb-extra-actions').innerHTML = '';
  document.getElementById('kb-save-btn').textContent = 'Save & Index';
}

async function editKbDoc(id){
  try{
    const doc = await api('/api/knowledge/'+encodeURIComponent(id));
    _kbEditingDoc = doc;
    document.getElementById('kb-editor').style.display = 'block';
    document.getElementById('kb-editor-title').innerHTML = '&#x270F;&#xFE0F; Edit: '+esc(doc.title);
    document.getElementById('kb-id').value = doc.id;
    document.getElementById('kb-id').disabled = true;
    document.getElementById('kb-title').value = doc.title;
    document.getElementById('kb-category').value = doc.category || 'general';
    document.getElementById('kb-content').value = doc.content;
    document.getElementById('kb-status').textContent = doc.chunk_count + ' chunks indexed';
    document.getElementById('kb-save-btn').textContent = 'Save & Re-index';
    document.getElementById('kb-extra-actions').innerHTML =
      '<button class="btn" onclick="reindexKbDoc(\\''+esc(id)+'\\')">Re-index</button>'
      + '<button class="btn btn-red" onclick="deleteKbDoc(\\''+esc(id)+'\\',\\''+esc(doc.title)+'\\')">Delete</button>';
  }catch(e){alert('Error: '+e.message)}
}

function closeKbEditor(){
  document.getElementById('kb-editor').style.display = 'none';
  _kbEditingDoc = null;
}

async function saveKbDoc(){
  const id = document.getElementById('kb-id').value.trim();
  const title = document.getElementById('kb-title').value.trim();
  const content = document.getElementById('kb-content').value;
  const category = document.getElementById('kb-category').value;

  if(!id||!title||!content){alert('ID, Title, and Content are required');return}

  const btn = document.getElementById('kb-save-btn');
  const oldText = btn.textContent;
  btn.textContent = 'Saving...';
  btn.disabled = true;

  try{
    let r;
    if(_kbEditingDoc){
      r = await api('/api/knowledge/'+encodeURIComponent(id), {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({title,content,category})});
    } else {
      r = await apiPost('/api/knowledge', {id,title,content,category});
    }
    if(r.error){alert('Error: '+(r.message||r.error));return}
    document.getElementById('kb-status').textContent = 'Saved! '+r.chunkCount+' chunks indexed';
    document.getElementById('kb-status').style.color = 'var(--green)';
    setTimeout(()=>{loadTab('memory')}, 800);
  }catch(e){
    alert('Error: '+e.message);
  }finally{
    btn.textContent = oldText;
    btn.disabled = false;
  }
}

async function reindexKbDoc(id){
  try{
    const r = await apiPost('/api/knowledge/'+encodeURIComponent(id)+'/reindex');
    if(r.error){alert('Error: '+(r.message||r.error));return}
    document.getElementById('kb-status').textContent = 'Re-indexed: '+r.chunkCount+' chunks';
    document.getElementById('kb-status').style.color = 'var(--green)';
  }catch(e){alert('Error: '+e.message)}
}

async function deleteKbDoc(id, title){
  if(!confirm('Delete "'+title+'"? This will remove the document and all its chunks.'))return;
  try{
    const r = await apiDelete('/api/knowledge/'+encodeURIComponent(id));
    if(r.error){alert('Error: '+(r.message||r.error));return}
    closeKbEditor();
    loadTab('memory');
  }catch(e){alert('Error: '+e.message)}
}
`;
}
