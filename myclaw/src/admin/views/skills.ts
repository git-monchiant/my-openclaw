/** Skills tab — master data for skill definitions, grouped by function */

export function getSkillsJs(): string {
  return `
// ===== SKILLS (Master Data) =====
async function renderSkills(el){
  const sd = await api('/api/skills');
  const skills = sd.skills || [];

  const aiCount = skills.filter(s=>s.toolType==='ai').length;
  const nonAiCount = skills.filter(s=>s.toolType!=='ai').length;

  // Group by function
  const groups = [
    {label:'Media', icon:'&#x1F3A8;', color:'orange', ids:['image_analysis','image_creation','audio_video','tts']},
    {label:'Research', icon:'&#x1F50D;', color:'blue', ids:['web_research','memory','browser']},
    {label:'Communication', icon:'&#x1F4AC;', color:'green', ids:['general_chat','messaging']},
    {label:'Productivity', icon:'&#x2699;&#xFE0F;', color:'purple', ids:['scheduling','coding','writing']},
    {label:'Google', icon:'&#x1F310;', color:'blue', ids:['email','calendar_mgmt','cloud_storage','spreadsheet']},
    {label:'Integration', icon:'&#x1F517;', color:'green', ids:['api_integration']},
  ];

  function skillCard(s){
    const typeBadge = s.toolType==='ai'?badge('AI','orange'):badge('non-AI','blue');
    const toolList = s.tools.length ? s.tools.map(t=>'<code style="font-size:10px">'+esc(t)+'</code>').join(' ') : '<span style="color:var(--text3);font-size:11px">No tools</span>';
    const kwList = s.keywords.length
      ? s.keywords.slice(0,5).map(k=>'<span style="background:var(--surface2);padding:2px 8px;border-radius:6px;font-size:10px;color:var(--text2)">'+esc(k)+'</span>').join(' ')
        + (s.keywords.length > 5 ? ' <span style="color:var(--text3);font-size:10px">+' + (s.keywords.length-5) + '</span>' : '')
      : '';

    return '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;transition:all .2s">'
      + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">'
        + '<div style="font-size:14px;font-weight:700;color:#fff;flex:1">'+esc(s.name)+'</div>'
        + typeBadge
      + '</div>'
      + '<div style="font-size:12px;color:var(--text2);margin-bottom:10px;line-height:1.5">'+esc(s.description)+'</div>'
      + '<div style="margin-bottom:6px">'+toolList+'</div>'
      + (kwList ? '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:8px">'+kwList+'</div>' : '')
    + '</div>';
  }

  const skillById = new Map(skills.map(s=>[s.id,s]));
  const grouped = new Set();

  const sections = groups.map(g=>{
    const items = g.ids.map(id=>skillById.get(id)).filter(Boolean);
    items.forEach(s=>grouped.add(s.id));
    if(!items.length) return '';
    return '<div class="panel" style="margin-bottom:20px">'
      + '<div class="panel-title">'+g.icon+' '+badge(g.label,g.color)+' <span style="font-weight:400;font-size:11px;color:var(--text3);text-transform:none;letter-spacing:0">'+items.length+' skills</span></div>'
      + '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">'+items.map(skillCard).join('')+'</div>'
      + '</div>';
  }).join('');

  // Ungrouped skills
  const ungrouped = skills.filter(s=>!grouped.has(s.id));
  const ungroupedHtml = ungrouped.length
    ? '<div class="panel"><div class="panel-title">&#x1F4E6; '+badge('Other','blue')+' <span style="font-weight:400;font-size:11px;color:var(--text3);text-transform:none;letter-spacing:0">'+ungrouped.length+'</span></div>'
      + '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">'+ungrouped.map(skillCard).join('')+'</div></div>'
    : '';

  el.innerHTML = \`
    <div class="page-header">
      <div class="page-title">Skills <span class="sub">\${skills.length} total</span></div>
    </div>

    <!-- Stats -->
    <div class="cards" style="grid-template-columns:repeat(3,1fr);margin-bottom:24px">
      <div class="card card-sm">
        <div class="icon">&#x1F3AF;</div>
        <div class="val" style="font-size:22px">\${skills.length}</div>
        <div class="lbl">Total Skills</div>
      </div>
      <div class="card card-sm">
        <div class="icon">&#x1F9E0;</div>
        <div class="val" style="font-size:22px">\${aiCount}</div>
        <div class="lbl">AI Skills</div>
        <div class="sub">Manual assign only</div>
      </div>
      <div class="card card-sm">
        <div class="icon">&#x26A1;</div>
        <div class="val" style="font-size:22px">\${nonAiCount}</div>
        <div class="lbl">Non-AI Skills</div>
        <div class="sub">Auto-assigned to new agents</div>
      </div>
    </div>

    <div style="font-size:12px;color:var(--text3);margin-bottom:20px;padding:0 2px">
      Skills define what an agent can do. Assign them in the <a href="#" onclick="switchTab('agents');return false" style="color:var(--accent)">Agents</a> tab.
    </div>

    \${sections}
    \${ungroupedHtml}
  \`;
}
`;
}
