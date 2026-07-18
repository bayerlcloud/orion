    (function(){
      const sb=document.getElementById('sbMain')
      if(!sb) return
      // collapsed só se não estiver em modo painel (sess/files já vêm do servidor sem collapsed)
      if(!sb.classList.contains('sess-mode')&&!sb.classList.contains('files-mode')){
        if(localStorage.getItem('sbCollapsed')==='1') sb.classList.add('collapsed')
      }
      // reativa transição depois do primeiro paint (sem flash na troca de página)
      requestAnimationFrame(()=>requestAnimationFrame(()=>{ sb.style.transition='' }))
      // ── Drag resize ──────────────────────────────────────────────────────────
      ;(function(){
        const handle=document.getElementById('sb-resize-handle')
        if(!handle) return
        const MIN=208, MAX=480
        const saved=parseInt(localStorage.getItem('orion_sb_w'),10)
        if(saved>=MIN&&saved<=MAX) sb.style.setProperty('--sb-w',saved+'px')
        let dragging=false, startX=0, startW=0
        handle.addEventListener('mousedown',function(e){
          if(e.button!==0) return
          dragging=true
          startX=e.clientX
          startW=sb.getBoundingClientRect().width
          handle.classList.add('dragging')
          sb.style.transition='none'
          document.body.style.cursor='col-resize'
          document.body.style.userSelect='none'
          e.preventDefault()
        })
        document.addEventListener('mousemove',function(e){
          if(!dragging) return
          const w=Math.min(MAX,Math.max(MIN,startW+(e.clientX-startX)))
          sb.style.setProperty('--sb-w',w+'px')
        })
        document.addEventListener('mouseup',function(){
          if(!dragging) return
          dragging=false
          handle.classList.remove('dragging')
          sb.style.transition=''
          document.body.style.cursor=''
          document.body.style.userSelect=''
          const w=parseInt(getComputedStyle(sb).getPropertyValue('--sb-w'),10)
          if(w>=MIN&&w<=MAX) localStorage.setItem('orion_sb_w',w)
        })
      })()
      const ovl=document.getElementById('sb-overlay')
      const ham=document.getElementById('mob-ham')
      function sbOpenMob(){sb.classList.add('mob-open');if(ovl)ovl.classList.add('show')}
      function sbCloseMob(){sb.classList.remove('mob-open','open');if(ovl)ovl.classList.remove('show');document.getElementById('overlay')?.classList.remove('show')}
      window.sbOpenMob=sbOpenMob; window.sbCloseMob=sbCloseMob
      if(ovl) ovl.addEventListener('click',sbCloseMob)
      if(ham) ham.addEventListener('click',sbOpenMob)
      window.sbToggle=function(){
        if(window.innerWidth<=768){ sbCloseMob(); return }
        if(sb.classList.contains('sess-mode')||sb.classList.contains('files-mode')){
          sb.classList.remove('sess-mode','files-mode')
          sb.classList.add('collapsed')
          localStorage.setItem('sbCollapsed','1')
          return
        }
        sb.classList.toggle('collapsed')
        localStorage.setItem('sbCollapsed', sb.classList.contains('collapsed')?'1':'0')
      }

      // ── Mode switching: sessões / arquivos / menu principal ──────────────────
      const curSess = location.pathname.indexOf('/sessions/')===0 ? location.pathname.split('/').pop() : null
      let _allSess=[]
      let _sbQuery=''
      const esc=s=>String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      const isLive=s=>s.status==='active'
      const titleOf=s=>s.custom_title||s.ai_title||s.first_user_msg||(s.id||'').slice(0,8)
      const xIcon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" width="12" height="12"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'

      window.sbSessions=function(e){
        e.preventDefault()
        sb.classList.add('sess-mode')
        sb.classList.remove('files-mode')
        if(sb.classList.contains('collapsed')){
          sb.classList.remove('collapsed')
          localStorage.setItem('sbCollapsed','0')
        }
        if(!_allSess.length) loadSessions()
        else renderSessList()
        return false
      }
      window.sbFiles=function(e){
        e.preventDefault()
        sb.classList.add('files-mode')
        sb.classList.remove('sess-mode')
        if(sb.classList.contains('collapsed')){
          sb.classList.remove('collapsed')
          localStorage.setItem('sbCollapsed','0')
        }
        if(!window._ftLoaded){ window._ftLoaded=true; ftLoad('') }
        return false
      }
      window.sbBackMenu=function(){
        sb.classList.remove('sess-mode','files-mode')
        if(sb.classList.contains('collapsed')){
          sb.classList.remove('collapsed')
          localStorage.setItem('sbCollapsed','0')
        }
      }
      window.sbFilter=function(q){
        _sbQuery=q.toLowerCase()
        renderSessList()
      }

      // Não chama /open enquanto a página está sendo pré-renderizada em background
      // (o prerender rodaria o script e marcaria sessões como abertas sem o usuário ter clicado)
      if(curSess){
        if(document.prerendering){
          document.addEventListener('prerenderingchange',()=>{
            fetch('/api/claude-sessions/'+curSess+'/open',{method:'PUT'}).catch(()=>{})
          },{once:true})
        } else {
          fetch('/api/claude-sessions/'+curSess+'/open',{method:'PUT'}).catch(()=>{})
        }
      }

      // Speculation Rules API — prerender sessões abertas + prefetch ao hover
      function updateSpecRules(){
        const old=document.getElementById('_specr'); if(old) old.remove()
        /* Speculation Rules DESATIVADO inteiro — o SPA loadSession cuida da troca; prerender/prefetch serviam paginas em cache (stale) e sequestravam o clique. */
      }

      let _trashSess=[]
      let _trashOpen=false
      const _trashIcon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>'
      const _xIcon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
      const _chevDn='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>'
      const _dotsIcon='<svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><circle cx="4" cy="10" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="16" cy="10" r="1.5"/></svg>'
      const _projColors={'TRACKINGM':'#0ea5e9','BRANDSPA':'#6366f1','RALAB':'#10b981','FISIOEYPE':'#f59e0b','FISIOEXPE':'#f59e0b','BRANDSPAC':'#6366f1'}
      function _projColor(label){ return _projColors[label]||_projColors[label.slice(0,8)]||null }
      function projOf(s){
        try{
          // 1. Config explícito do popup (prioridade)
          const meta=JSON.parse(s.config_meta||'{}')
          if(meta.project){
            const w=meta.project.replace(/-WT\d+$/i,'').trim().split(/[\s-]/)[0]||''
            return w.toUpperCase().slice(0,20)||null
          }
          // 2. Fallback: prefixo [Projeto] no título
          const m=titleOf(s).match(/^\[([^\]]+)\]/)
          if(!m) return null
          const word=(m[1].replace(/-WT\d+$/i,'').trim().split(/[\s-]/)||[''])[0]||''
          return word.toUpperCase().slice(0,20)||null
        }catch(e){ return null }
      }
      function shortT(s){
        // Remove prefixo [Projeto] do título exibido
        const t=titleOf(s).replace(/^\[[^\]]+\]\s*/,'').trim()
        if(t) return t
        // Se sem prefixo limpo, garante que não sobra lixo "]..."
        return titleOf(s).replace(/^[^\[]*\]\s*/,'').trim()||titleOf(s)
      }
      function _actorAvatar(s){
        const name=s.actor_name||s.actor_username||''
        if(!name) return ''
        const color=s.actor_color||'#6366f1'
        const initial=(name.charAt(0)||'?').toUpperCase()
        const title=esc('Última atividade: '+name)
        return '<span class="sb-actor-av" style="background:'+color+'" title="'+title+'">'+initial+'</span>'
      }
      ;(function(){
        const st=document.createElement('style')
        st.textContent='.sb-sec-lbl{font-size:9.5px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#4b5563;padding:8px 14px 4px}'
          +'.sb-sess.drag-over{box-shadow:inset 0 2px 0 #6366f1}'
          +'.sb-sess[draggable=true]{cursor:grab}'
        document.head.appendChild(st)
      })()
      function sbSessRow(s,inTrash){
        const t=shortT(s); const full=titleOf(s); const isCur=s.id===curSess
        const dot=s.status==='active'?' live':s.status==='finished'?' done':s.status==='waiting'?' idle':''
        const p=projOf(s)
        const pc=p?_projColor(p):null
        const badgeHtml=p?'<span class="sb-badge"'+(pc?' style="background:'+pc+';color:#fff"':'')+'>'+esc(p)+'</span>':''
        const ctx=inTrash?'trash':'normal'
        const dotsBtn='<button class="sb-trash sb-hdots" title="Opções" data-sid="'+s.id+'" onclick="event.preventDefault();event.stopPropagation();sbShowSessMenu(this,\''+s.id+'\',\''+ctx+'\')">'+_dotsIcon+'</button>'
        const actorHtml=_actorAvatar(s)
        // Abertas: arrastáveis p/ ordenar · Stand-by: duplo-clique promove p/ Abertas
        const isOpenGrp=!inTrash&&!!s.opened_at
        const isStandby=!inTrash&&!s.opened_at
        const dragAttrs=isOpenGrp?' draggable="true" ondragstart="sbDragStart(event,\''+s.id+'\')" ondragover="sbDragOver(event)" ondragleave="sbDragLeave(event)" ondrop="sbDrop(event,\''+s.id+'\')"':''
        const clickAttrs=isStandby?' onclick="return sbStandbyClick(event,\''+s.id+'\')" ondblclick="sbStandbyDbl(event,\''+s.id+'\')"':''
        return '<a href="/sessions/'+s.id+'" class="sb-sess'+(isCur?' active':'')+(s.visibility==='team'?' sess-team':'')+'" title="'+esc(full)+'" data-sid="'+s.id+'"'+dragAttrs+clickAttrs+'>'
          +'<span class="sb-dot'+dot+'"></span>'
          +badgeHtml
          +'<span class="sb-sess-t">'+esc(t)+'</span>'
          +actorHtml
          +dotsBtn
          +'</a>'
      }
      // Stand-by: 1 clique navega (com pequeno delay p/ detectar duplo) · 2 cliques = vira Aberta no FINAL
      let _sbNavT=null
      window.sbStandbyClick=function(e,id){
        e.preventDefault()
        clearTimeout(_sbNavT)
        _sbNavT=setTimeout(function(){ location.href='/sessions/'+id },260)
        return false
      }
      window.sbStandbyDbl=function(e,id){
        e.preventDefault(); clearTimeout(_sbNavT)
        try{ fetch('/api/claude-sessions/'+id+'/open',{method:'PUT',keepalive:true}) }catch(err){}
        location.href='/sessions/'+id
      }
      // Abrir/Encerrar manualmente (menu ⋯)
      window.sbSessSetOpen=function(id,open){
        fetch('/api/claude-sessions/'+id+'/open',{method:open?'PUT':'DELETE'}).catch(function(){})
        const s=_allSess.find(function(x){return x.id===id})
        if(s){ if(open){ s.opened_at=Math.floor(Date.now()/1000); s.sort_order=9999 } else s.opened_at=null }
        renderSessList()
      }
      // Drag-and-drop das Abertas (ordem manual persistida em sort_order)
      let _sbDragId=null
      function _sbAlpha(a,b){ return shortT(a).localeCompare(shortT(b),'pt-BR',{sensitivity:'base'}) }
      function _sbOpenedSorted(){ return _allSess.filter(function(s){return s.opened_at}).sort(function(a,b){ return (a.sort_order||0)-(b.sort_order||0)||_sbAlpha(a,b) }) }
      window.sbDragStart=function(e,id){ _sbDragId=id; e.dataTransfer.effectAllowed='move' }
      window.sbDragOver=function(e){ if(!_sbDragId) return; e.preventDefault(); e.currentTarget.classList.add('drag-over') }
      window.sbDragLeave=function(e){ e.currentTarget.classList.remove('drag-over') }
      window.sbDrop=function(e,targetId){
        e.preventDefault(); e.currentTarget.classList.remove('drag-over')
        if(!_sbDragId||_sbDragId===targetId){ _sbDragId=null; return }
        const opened=_sbOpenedSorted()
        const si=opened.findIndex(function(s){return s.id===_sbDragId}), di=opened.findIndex(function(s){return s.id===targetId})
        if(si<0||di<0){ _sbDragId=null; return }
        const moved=opened.splice(si,1)[0]; opened.splice(di,0,moved)
        opened.forEach(function(s,i){ s.sort_order=i })
        _sbDragId=null
        renderSessList()
        fetch('/api/claude-sessions/reorder',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:opened.map(function(s){return s.id})})}).catch(function(){})
      }
      window.sbShowSessMenu=function(btn,id,ctx){
        sbCloseMenu()
        const sess=ctx==='trash'?_trashSess.find(function(s){return s.id===id}):_allSess.find(function(s){return s.id===id})
        const rect=btn.getBoundingClientRect()
        const menu=document.createElement('div')
        menu.className='sb-dots-menu'
        menu.style.cssText='position:fixed;top:'+(rect.bottom+4)+'px;left:'+Math.max(4,rect.left-160+rect.width)+'px;z-index:9999'
        if(ctx==='trash'){
          menu.innerHTML=
            '<button onclick="event.stopPropagation();sbRestoreSession(\''+id+'\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>Restaurar</button>'+
            '<button class="danger" onclick="event.stopPropagation();sbHardDeleteFromMenu(\''+id+'\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M9 6V4h6v2"/></svg>Excluir permanentemente</button>'
        } else {
          const isTeam=sess&&sess.visibility==='team'
          const visNewVal=isTeam?'personal':'team'
          const lockIc='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'
          const globeIc='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><circle cx="12" cy="12" r="10"/><ellipse cx="12" cy="12" rx="4" ry="10"/><line x1="2" y1="12" x2="22" y2="12"/></svg>'
          const isOpened=sess&&!!sess.opened_at
          const powerIc='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>'
          menu.innerHTML=
            '<button onclick="event.stopPropagation();sbSessSetOpen(\''+id+'\','+(isOpened?'0':'1')+');sbCloseMenu()">'+powerIc+(isOpened?' Encerrar sessão':' Abrir sessão')+'</button>'+
            '<button onclick="event.stopPropagation();sbToggleVis(\''+id+'\',\''+visNewVal+'\');sbCloseMenu()">'+(isTeam?lockIc:globeIc)+(isTeam?' Tornar pessoal':' Compartilhar')+'</button>'+
            '<button onclick="event.stopPropagation();sbOpenSessConfig(\''+id+'\');sbCloseMenu()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg> Configurações</button>'+
            '<button class="danger" onclick="event.stopPropagation();sbTrash(\''+id+'\',this);sbCloseMenu()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M9 6V4h6v2"/></svg>Mover para lixeira</button>'
        }
        document.body.appendChild(menu)
        setTimeout(function(){
          document.addEventListener('click',function close(e){
            if(!menu.contains(e.target)){ sbCloseMenu(); document.removeEventListener('click',close) }
          })
        },0)
      }
      window.sbActBtn=function(btn){
        const id=btn.dataset.sid
        const act=btn.dataset.act
        if(act==='trash') window.sbTrash(id,btn)
        else if(act==='del') window.sbHardDelete(id,btn)
      }
      function renderSessList(){
        const box=document.getElementById('sb-sess-list'); if(!box) return
        try{
          const q=_sbQuery
          const items=(q?_allSess.filter(s=>titleOf(s).toLowerCase().includes(q)):_allSess).filter(s=>s.status!=='deleted')
          // Grupos MANUAIS (opened_at), não por status — a bolinha indica atividade
          // mas NÃO muda a posição (acabou o "pula-pula" na lista).
          // Ordem: alfabética; nas Abertas o drag manual (sort_order) tem prioridade.
          const opened=items.filter(s=>s.opened_at).sort(function(a,b){ return (a.sort_order||0)-(b.sort_order||0)||_sbAlpha(a,b) })
          const standby=items.filter(s=>!s.opened_at).sort(_sbAlpha)
          let html=''
          html+='<div class="sb-sec-lbl">Abertas'+(opened.length?' · '+opened.length:'')+'</div>'
          html+=opened.length?opened.map(s=>sbSessRow(s,false)).join(''):'<div class="sb-sess-empty" style="padding:4px 14px 8px">Nenhuma aberta</div>'
          html+='<div class="sb-sec-lbl" style="margin-top:6px">Stand-by'+(standby.length?' · '+standby.length:'')+'</div>'
          html+=standby.length?standby.map(s=>sbSessRow(s,false)).join(''):'<div class="sb-sess-empty" style="padding:4px 14px 8px">Nenhuma</div>'
          const tc=_trashSess.length
          html+='<div class="sb-trash-hdr'+(_trashOpen?' open':'')+'" onclick="sbToggleTrash()">'
            +_trashIcon+'<span>Lixeira'+(tc?' · '+tc:'')+'</span>'
            +'<span class="sb-chev">'+_chevDn+'</span></div>'
          if(_trashOpen){
            if(tc) html+=_trashSess.map(s=>sbSessRow(s,true)).join('')
            else html+='<div class="sb-sess-empty" style="padding-left:14px">Vazia</div>'
          }
          box.innerHTML=html
        }catch(err){
          box.innerHTML='<div class="sb-sess-empty" style="color:#ef4444">Erro: '+String(err.message||err)+'</div>'
        }
      }
      window.sbToggleTrash=function(){
        _trashOpen=!_trashOpen
        if(_trashOpen&&!_trashSess.length) loadTrash()
        else renderSessList()
      }
      async function loadTrash(){
        try{
          const d=await fetch('/api/claude-sessions?limit=100&showHidden=true').then(r=>r.json())
          const all=(d.sessions||[]).filter(s=>s.hidden&&!s.deleted_at)
          // sessões ativas na lixeira → auto-restaurar imediatamente
          const toRestore=all.filter(s=>s.status==='active')
          if(toRestore.length){
            toRestore.forEach(s=>{
              fetch('/api/claude-sessions/'+s.id+'/show',{method:'PATCH'}).catch(()=>{})
              if(!_allSess.find(x=>x.id===s.id)) _allSess.unshift(s)
            })
          }
          _trashSess=all.filter(s=>s.status!=='active')
          renderSessList()
        }catch(e){}
      }
      window.sbTrash=function(id,btn){
        fetch('/api/claude-sessions/'+id+'/hide',{method:'PATCH'}).catch(()=>{})
        const el=btn&&btn.closest&&btn.closest('.sb-sess'); if(el) el.remove()
        _allSess=_allSess.filter(s=>s.id!==id)
        renderSessList()
      }
      window.sbHardDelete=function(id,btn){
        fetch('/api/claude-sessions/'+id,{method:'DELETE'}).catch(()=>{})
        const el=btn&&btn.closest&&btn.closest('.sb-sess')
        if(el){el.style.opacity='.3';el.style.pointerEvents='none'}
        setTimeout(function(){
          _trashSess=_trashSess.filter(s=>s.id!==id)
          renderSessList()
        },300)
      }
      function sbCloseMenu(){ document.querySelectorAll('.sb-dots-menu').forEach(m=>m.remove()) }

      const _inp='width:100%;padding:8px 10px;background:#0f0f1a;border:1px solid #2d2d44;border-radius:8px;color:#e2e8f0;font-size:13px;box-sizing:border-box'
      const _lbl='font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:5px'
      function _cfgField(label,inner){ return '<div><label style="'+_lbl+'">'+label+'</label>'+inner+'</div>' }

      window.sbOpenSessConfig=async function(id){
        const sess=_allSess.find(s=>s.id===id)||{}
        // Buscar dados completos da sessão e lista de usuários em paralelo
        let full=sess, users=[]
        const [sessR, usersR]=await Promise.allSettled([
          fetch('/api/claude-sessions/'+id).then(r=>r.ok?r.json():null),
          fetch('/api/users').then(r=>r.ok?r.json():null)
        ])
        if(sessR.status==='fulfilled'&&sessR.value) full=sessR.value.session||sessR.value
        if(usersR.status==='fulfilled'&&usersR.value) users=usersR.value.users||[]
        const m=JSON.parse(full.config_meta||'{}')
        // Título limpo: strip artefatos malformados tipo "rackingMachine] "
        const rawTitle=full.custom_title||full.ai_title||full.first_user_msg||(full.id||'').slice(0,8)
        const currentTitle=rawTitle.replace(/^[a-z][^\]]*\]\s*/,'').trim()||rawTitle
        const consumo=((full.total_tokens||0)/1000).toFixed(1)+'k tokens'
        const modal=document.createElement('div')
        modal.id='sb-sess-cfg-modal'
        modal.style.cssText='position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);backdrop-filter:blur(3px)'
        const projects=['','Orion','TrackingMachine','Brandspace','Ralab','FisioExpert','BayerlPress','ABCPrime','Outro']
        const models=['','claude-haiku-4-5-20251001','claude-sonnet-4-6','claude-opus-4-8']
        const modelLabel={'claude-haiku-4-5-20251001':'Haiku (econômico)','claude-sonnet-4-6':'Sonnet (padrão)','claude-opus-4-8':'Opus (máximo)'}
        const projOpts=projects.map(p=>'<option value="'+p+'"'+(m.project===p?' selected':'')+'>'+((p||'Sem projeto'))+'</option>').join('')
        const modelOpts=models.map(v=>'<option value="'+v+'"'+(m.preferred_model===v?' selected':'')+'>'+(modelLabel[v]||'Padrão herdado')+'</option>').join('')
        // Seletor de dono com usuários reais
        const ownerOpts='<option value="">Sem dono</option>'+users.map(u=>{
          const av=(u.display_name||u.username||'?').charAt(0).toUpperCase()
          const sel=(m.owner_id&&m.owner_id===u.id)||(m.owner&&m.owner===u.username)?'selected':''
          return '<option value="'+u.id+'" '+sel+'>'+esc(u.display_name||u.username)+'</option>'
        }).join('')

        modal.innerHTML='<div style="background:#1c1c2e;border:1px solid #2d2d44;border-radius:12px;width:min(520px,95vw);max-height:90vh;overflow-y:auto;box-shadow:0 24px 64px rgba(0,0,0,.6);font-family:inherit">'+
          '<div style="display:flex;align-items:center;justify-content:space-between;padding:18px 20px 14px;border-bottom:1px solid #2d2d44">'+
          '<div style="font-size:15px;font-weight:600;color:#e2e8f0">⚙ Configurações da Sessão</div>'+
          '<button onclick="document.getElementById(\'sb-sess-cfg-modal\').remove()" style="background:none;border:none;color:#64748b;cursor:pointer;padding:4px;border-radius:6px;line-height:1">'+
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="16" height="16"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>'+
          '<div style="padding:18px 20px;display:grid;gap:14px">'+
          // Nome da sessão
          _cfgField('Nome da Sessão','<input id="cfg-title" type="text" value="'+esc(currentTitle)+'" placeholder="Nome desta sessão" style="'+_inp+'">')+
          // Projeto + Dono em grid
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">'+
          _cfgField('Projeto','<select id="cfg-project" style="'+_inp+'">'+projOpts+'</select>')+
          _cfgField('Dono / Responsável','<select id="cfg-owner-id" style="'+_inp+'">'+ownerOpts+'</select>')+
          '</div>'+
          // Visibilidade + Modelo
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">'+
          _cfgField('Visibilidade','<select id="cfg-vis" style="'+_inp+'">'+
            '<option value="personal"'+(full.visibility==='personal'||!full.visibility?' selected':'')+'>Pessoal (só eu)</option>'+
            '<option value="team"'+(full.visibility==='team'?' selected':'')+'>Equipe</option>'+
            '<option value="public"'+(full.visibility==='public'?' selected':'')+'>Público</option>'+
            '</select>')+
          _cfgField('Modelo Preferido','<select id="cfg-model" style="'+_inp+'">'+modelOpts+'</select>')+
          '</div>'+
          // Limites
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">'+
          _cfgField('Limite de Tokens','<input id="cfg-tok-limit" type="number" min="0" step="1000" placeholder="Sem limite" value="'+(m.token_limit||'')+'" style="'+_inp+'">')+
          _cfgField('Horas/Mês (colabs)','<input id="cfg-hours-limit" type="number" min="0" step="1" placeholder="Sem limite" value="'+(m.hours_limit||'')+'" style="'+_inp+'">')+
          '</div>'+
          // Tags
          _cfgField('Tags / Etiquetas','<input id="cfg-tags" type="text" placeholder="ex: urgente, cliente, revisão" value="'+esc(m.tags||'')+'" style="'+_inp+'">')+
          // Proativo + TTL
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">'+
          '<div style="display:flex;align-items:center;gap:10px;padding:10px;background:#0f0f1a;border:1px solid #2d2d44;border-radius:8px">'+
          '<input id="cfg-proactive" type="checkbox"'+(m.proactive?' checked':'')+' style="width:16px;height:16px;accent-color:#6366f1;cursor:pointer">'+
          '<div><div style="font-size:13px;color:#e2e8f0;font-weight:500">Modo Proativo</div><div style="font-size:11px;color:#64748b">Orion age sem esperar</div></div></div>'+
          _cfgField('Arquivar após (dias)','<input id="cfg-ttl" type="number" min="0" step="1" placeholder="Nunca" value="'+(m.archive_ttl_days||'')+'" style="'+_inp+'">')+
          '</div>'+
          // Webhook
          _cfgField('Webhook ao Encerrar','<input id="cfg-webhook" type="url" placeholder="https://..." value="'+esc(m.webhook_url||'')+'" style="'+_inp+'">')+
          // Notas
          _cfgField('Notas Internas','<textarea id="cfg-notes" rows="2" placeholder="Contexto, objetivo, observações..." style="'+_inp+';resize:vertical;font-family:inherit">'+esc(m.notes||'')+'</textarea>')+
          // Consumo (readonly)
          '<div style="padding:10px 12px;background:#0f0f1a;border:1px solid #2d2d44;border-radius:8px;display:flex;justify-content:space-between;align-items:center">'+
          '<span style="font-size:12px;color:#64748b">Consumo acumulado</span>'+
          '<span style="font-size:13px;font-weight:600;color:#a78bfa">'+consumo+'</span></div>'+
          '</div>'+
          '<div style="padding:14px 20px;border-top:1px solid #2d2d44;display:flex;justify-content:flex-end;gap:8px">'+
          '<button onclick="document.getElementById(\'sb-sess-cfg-modal\').remove()" style="padding:8px 16px;background:transparent;border:1px solid #2d2d44;border-radius:8px;color:#94a3b8;font-size:13px;cursor:pointer">Cancelar</button>'+
          '<button id="cfg-save-btn" onclick="sbSaveSessConfig(\''+id+'\')" style="padding:8px 20px;background:#6366f1;border:none;border-radius:8px;color:#fff;font-size:13px;font-weight:600;cursor:pointer">Salvar</button>'+
          '</div></div>'
        // Guardar título original para comparação no save (evita rename desnecessário)
        modal.dataset.origTitle=currentTitle
        document.body.appendChild(modal)
        modal.addEventListener('click',function(e){ if(e.target===modal) modal.remove() })
        modal.querySelector('#cfg-title').focus()
      }

      window.sbSaveSessConfig=async function(id){
        const btn=document.getElementById('cfg-save-btn')
        if(btn){ btn.disabled=true; btn.textContent='Salvando...' }
        const modal=document.getElementById('sb-sess-cfg-modal')
        // Título original guardado no open (comparação confiável)
        const origTitle=modal?.dataset?.origTitle||''
        const vis=document.getElementById('cfg-vis').value
        const newTitle=document.getElementById('cfg-title').value.trim()
        const ownerEl=document.getElementById('cfg-owner-id')
        const ownerOpt=ownerEl.options[ownerEl.selectedIndex]
        const proactive=document.getElementById('cfg-proactive').checked
        const newMeta={
          project: document.getElementById('cfg-project').value||undefined,
          owner_id: ownerEl.value?Number(ownerEl.value):undefined,
          owner: ownerEl.value?(ownerOpt.textContent.trim()||undefined):undefined,
          preferred_model: document.getElementById('cfg-model').value||undefined,
          token_limit: parseInt(document.getElementById('cfg-tok-limit').value)||undefined,
          hours_limit: parseFloat(document.getElementById('cfg-hours-limit').value)||undefined,
          tags: document.getElementById('cfg-tags').value.trim()||undefined,
          // proactive: sempre salva (true OU false — false tem significado)
          proactive: proactive,
          archive_ttl_days: parseInt(document.getElementById('cfg-ttl').value)||undefined,
          webhook_url: document.getElementById('cfg-webhook').value.trim()||undefined,
          notes: document.getElementById('cfg-notes').value.trim()||undefined,
        }
        // Remove apenas undefined (não false/0)
        Object.keys(newMeta).forEach(k=>{ if(newMeta[k]===undefined) delete newMeta[k] })
        try{
          // Salvar config + visibilidade
          const r=await fetch('/api/claude-sessions/'+id+'/config',{
            method:'PATCH',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({ visibility:vis, config_meta:JSON.stringify(newMeta) })
          })
          if(!r.ok) throw new Error(await r.text())
          // Renomear SOMENTE se o título realmente mudou (vs o que estava no modal)
          if(newTitle&&newTitle!==origTitle){
            await fetch('/api/claude-sessions/'+id+'/title',{
              method:'PATCH',
              headers:{'Content-Type':'application/json'},
              body:JSON.stringify({ title:newTitle })
            })
          }
          // Atualizar cache local e redesenhar
          const idx=_allSess.findIndex(s=>s.id===id)
          if(idx>=0){
            _allSess[idx].visibility=vis
            _allSess[idx].config_meta=JSON.stringify(newMeta)
            // Sempre reflete o título exibido no modal (seja novo ou o original limpo)
            _allSess[idx].custom_title=newTitle||origTitle
          }
          modal?.remove()
          renderSessList()
        }catch(e){
          if(btn){ btn.disabled=false; btn.textContent='Salvar' }
          alert('Erro ao salvar: '+e.message)
        }
      }

      window.sbShowTrashMenu=function(btn,id){
        sbCloseMenu()
        const rect=btn.getBoundingClientRect()
        const menu=document.createElement('div')
        menu.className='sb-dots-menu'
        menu.style.cssText='position:fixed;top:'+(rect.bottom+4)+'px;left:'+Math.max(4,rect.left-120+rect.width)+'px;z-index:9999'
        menu.innerHTML=
          '<button onclick="event.stopPropagation();sbRestoreSession(\''+id+'\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>Restaurar</button>'+
          '<button class="danger" onclick="event.stopPropagation();sbHardDeleteFromMenu(\''+id+'\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M9 6V4h6v2"/></svg>Excluir permanentemente</button>'
        document.body.appendChild(menu)
        setTimeout(function(){
          document.addEventListener('click',function close(e){
            if(!menu.contains(e.target)){ sbCloseMenu(); document.removeEventListener('click',close) }
          })
        },0)
      }
      window.sbRestoreSession=function(id){
        sbCloseMenu()
        fetch('/api/claude-sessions/'+id+'/show',{method:'PATCH'}).catch(()=>{})
        _trashSess=_trashSess.filter(s=>s.id!==id)
        renderSessList()
      }
      window.sbHardDeleteFromMenu=function(id){
        sbCloseMenu()
        fetch('/api/claude-sessions/'+id,{method:'DELETE'}).catch(()=>{})
        setTimeout(function(){
          _trashSess=_trashSess.filter(s=>s.id!==id)
          renderSessList()
        },300)
      }
      window.sbToggleVis=function(id,newVis){
        fetch('/api/claude-sessions/'+id+'/visibility',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({visibility:newVis})})
          .then(function(r){return r.ok?r.json():null})
          .then(function(){
            _allSess=_allSess.map(function(s){return s.id===id?Object.assign({},s,{visibility:newVis}):s})
            renderSessList()
          }).catch(function(){})
      }
      const _SESS_KEY='_sbSessCache'
      const _TL_PREFIX='tlcache:'
      async function prefetchOpen(sessions){
        const open=sessions.filter(s=>s.opened_at&&!s.hidden)
        for(const s of open){
          const key=_TL_PREFIX+s.id
          try{
            const existing=sessionStorage.getItem(key)
            if(existing) continue // já tem cache, não buscar de novo
            // busca em background sem bloquear nada
            fetch('/api/claude-sessions/'+s.id).then(r=>r.json()).then(d=>{
              try{ sessionStorage.setItem(key, JSON.stringify({session:d.session,timeline:d.timeline,total:d.total,active:d.active})) }catch(e){}
            }).catch(()=>{})
          }catch(e){}
        }
      }
      async function loadSessions(){
        const box=document.getElementById('sb-sess-list')
        try{
          const resp=await fetch('/api/claude-sessions?limit=200')
          if(!resp.ok){
            if(box) box.innerHTML='<div class="sb-sess-empty" style="color:#ef4444">HTTP '+resp.status+' — '+resp.statusText+'</div>'
            return
          }
          const d=await resp.json()
          _allSess=(d.sessions||[]).filter(s=>!s.hidden)
          try{ localStorage.setItem(_SESS_KEY, JSON.stringify(_allSess)) }catch(e){}
          renderSessList()
          updateSpecRules()
          prefetchOpen(_allSess)
        }catch(e){
          if(box) box.innerHTML='<div class="sb-sess-empty" style="color:#ef4444">'+String(e&&e.message||e)+'</div>'
        }
      }
      // Renderiza do cache imediatamente (sem flash de "Carregando…")
      try{
        const cached=JSON.parse(localStorage.getItem(_SESS_KEY)||'null')
        if(cached&&cached.length){ _allSess=cached; renderSessList(); updateSpecRules(); prefetchOpen(cached) }
      }catch(e){}
      loadSessions()
      setInterval(loadSessions, 10000)
      // SSE: reage em tempo real quando backend detecta mudança de status
      ;(function(){
        let _es=null
        function connectSse(){
          if(_es) _es.close()
          _es=new EventSource('/api/claude-sessions/stream')
          _es.onmessage=function(e){
            try{
              const d=JSON.parse(e.data)
              if(d.type==='status_changed'){
                const active=new Set(d.active||[])
                const justFinished=new Set(d.finished||[])
                // sessão na lixeira que ficou ativa → auto-restaurar
                const toRestore=_trashSess.filter(s=>active.has(s.id))
                if(toRestore.length){
                  toRestore.forEach(s=>{
                    fetch('/api/claude-sessions/'+s.id+'/show',{method:'PATCH'}).catch(()=>{})
                    s.status='active'
                    _allSess.unshift(s)
                  })
                  _trashSess=_trashSess.filter(s=>!active.has(s.id))
                }
                const known=new Set(_allSess.map(s=>s.id))
                const hasUnknown=[...active].some(id=>!known.has(id))
                if(hasUnknown){
                  loadSessions()
                } else {
                  // atualiza dots in-place: active=verde, finished=laranja, resto=paused
                  _allSess.forEach(s=>{
                    if(active.has(s.id)) s.status='active'
                    else if(justFinished.has(s.id)) s.status='finished'
                    else if(s.status==='active') s.status='paused'
                  })
                  renderSessList()
                }
              } else if(d.type==='new_session'||d.type==='session_deleted'){
                loadSessions()
              }
            }catch{}
          }
          _es.onerror=function(){ setTimeout(connectSse,3000) }
        }
        connectSse()
      })()

      // ── File Explorer ────────────────────────────────────────────────────────
      const _ftCache={}
      let _ftFilter=''
      async function ftLoad(path){
        const tree=document.getElementById('ft-tree'); if(!tree) return
        if(!path){ tree.innerHTML='<div style="padding:8px;color:#4b5563;font-size:12px">…</div>' }
        const data=_ftCache[path]||(await fetch('/api/fs/list?path='+encodeURIComponent(path)).then(r=>r.json()).catch(()=>({entries:[]})))
        _ftCache[path]=data
        if(!path) ftRender(tree, data.entries, '')
      }
      function ftExt(name){ return name.split('.').pop().toLowerCase() }
      function ftFileIcon(name){
        const e=ftExt(name)
        if(['js','ts','jsx','tsx','mjs'].includes(e)) return '📄'
        if(['json','yaml','yml','toml'].includes(e)) return '📋'
        if(['md','mdx'].includes(e)) return '📝'
        if(['html','css','scss','svg'].includes(e)) return '🎨'
        if(['sh','bash'].includes(e)) return '⚙️'
        if(['png','jpg','jpeg','gif','webp','ico'].includes(e)) return '🖼'
        if(['sql','db','sqlite'].includes(e)) return '🗄'
        return '📄'
      }
      function ftRender(container, entries, basePath){
        container.innerHTML=''
        entries.forEach(entry=>{
          const row=document.createElement('div')
          row.className='ft-row '+(entry.type==='dir'?'ft-dir':'ft-file')
          row.dataset.path=entry.path
          row.dataset.type=entry.type
          const chevron=entry.type==='dir'?'<span class="ft-chevron"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg></span>':'<span style="width:12px;flex-shrink:0"></span>'
          const icon=entry.type==='dir'?'📁':ftFileIcon(entry.name)
          row.innerHTML=chevron+'<span class="ft-icon">'+icon+'</span><span class="ft-name">'+entry.name+'</span>'
          container.appendChild(row)
          if(entry.type==='dir'){
            const children=document.createElement('div')
            children.className='ft-children hidden'
            children.dataset.path=entry.path
            container.appendChild(children)
            row.onclick=async()=>{
              document.querySelectorAll('#ft-tree .ft-row.active').forEach(r=>r.classList.remove('active'))
              row.classList.add('active')
              const open=row.classList.toggle('open')
              children.classList.toggle('hidden',!open)
              window._ftSelDir=open?entry.path:entry.path.split('/').slice(0,-1).join('/')
              if(open&&!children.dataset.loaded){
                children.dataset.loaded='1'
                children.innerHTML='<div style="padding:4px 6px;color:#4b5563;font-size:11px">…</div>'
                const d=_ftCache[entry.path]||(await fetch('/api/fs/list?path='+encodeURIComponent(entry.path)).then(r=>r.json()).catch(()=>({entries:[]})))
                _ftCache[entry.path]=d
                ftRender(children,d.entries,entry.path)
              }
            }
          } else {
            row.onclick=()=>ftOpenFile(entry.path, entry.name)
          }
        })
      }
      window.ftFilter=function(q){
        _ftFilter=q.toLowerCase()
        document.querySelectorAll('#ft-tree .ft-row').forEach(r=>{
          const name=r.querySelector('.ft-name')?.textContent.toLowerCase()||''
          r.style.display=(!_ftFilter||name.includes(_ftFilter))?'':'none'
        })
      }
      async function ftOpenFile(path, name){
        window._ftSelDir=path.split('/').slice(0,-1).join('/')
        document.querySelectorAll('#ft-tree .ft-row').forEach(r=>r.classList.remove('active'))
        document.querySelector('#ft-tree .ft-row[data-path="'+path+'"]')?.classList.add('active')
        // Se existe tabbar, abrir como aba; caso contrário, abrir overlay diretamente
        if(window.orionOpenFiletab){ window.orionOpenFiletab(path, name); return }
        const res=await fetch('/api/fs/read?path='+encodeURIComponent(path)).then(r=>r.json()).catch(e=>({error:e.message}))
        if(res.error){ alert(res.error); return }
        ftShowEditor(path, name, res.content)
      }
      window.ftOpenFile=ftOpenFile
      window.ftShowEditor=ftShowEditor
      function ftShowEditor(path, name, content){
        let overlay=document.getElementById('ft-editor-overlay')
        if(!overlay){
          overlay=document.createElement('div')
          overlay.id='ft-editor-overlay'
          overlay.style.cssText='position:fixed;top:0;left:236px;right:0;bottom:0;z-index:1000;display:flex;flex-direction:column;background:#0d0d14;font-family:inherit'
          document.body.appendChild(overlay)
        }
        overlay.innerHTML=`<div style="display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid #1e1e2e;background:#0d0d14;flex-shrink:0">
          <span style="font-size:13px;color:#9ca3af;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${path}</span>
          <button id="ft-save-btn" style="background:rgba(99,102,241,.2);border:1px solid rgba(99,102,241,.4);color:#a5b4fc;padding:5px 14px;border-radius:7px;font-size:12px;cursor:pointer">Salvar</button>
          <button onclick="document.getElementById('ft-editor-overlay').remove()" style="background:none;border:none;color:#6b7280;font-size:18px;cursor:pointer;padding:0 4px">×</button>
        </div>
        <div id="ft-monaco" style="flex:1;overflow:hidden"></div>`
        overlay.style.display='flex'

        const saveBtn=document.getElementById('ft-save-btn')

        // Carrega Monaco via CDN se ainda não estiver carregado
        if(!window.monaco){
          const script=document.createElement('script')
          script.src='https://cdn.jsdelivr.net/npm/monaco-editor@0.44.0/min/vs/loader.js'
          script.onload=()=>{
            require.config({paths:{vs:'https://cdn.jsdelivr.net/npm/monaco-editor@0.44.0/min/vs'}})
            require(['vs/editor/editor.main'],()=>{
              ftInitMonaco(path, name, content, saveBtn)
            })
          }
          document.head.appendChild(script)
        } else {
          ftInitMonaco(path, name, content, saveBtn)
        }
      }
      function ftInitMonaco(path, name, content, saveBtn){
        const ext=name.split('.').pop()
        const langMap={js:'javascript',ts:'typescript',jsx:'javascript',tsx:'typescript',json:'json',html:'html',css:'css',scss:'scss',md:'markdown',py:'python',sh:'shell',yaml:'yaml',yml:'yaml',sql:'sql',toml:'ini',mjs:'javascript'}
        const lang=langMap[ext]||'plaintext'
        const container=document.getElementById('ft-monaco')
        if(!container) return
        if(window._ftEditor){ window._ftEditor.dispose(); window._ftEditor=null }
        const ed=monaco.editor.create(container,{
          value:content, language:lang,
          theme:'vs-dark', fontSize:13, minimap:{enabled:false},
          scrollBeyondLastLine:false, automaticLayout:true,
          fontFamily:"'JetBrains Mono','Fira Code',monospace"
        })
        window._ftEditor=ed
        saveBtn.onclick=async()=>{
          const newContent=ed.getValue()
          saveBtn.textContent='Salvando…'; saveBtn.disabled=true
          const r=await fetch('/api/fs/write',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path,content:newContent})}).then(r=>r.json()).catch(e=>({error:e.message}))
          saveBtn.textContent=r.ok?'Salvo ✓':'Erro!'
          saveBtn.disabled=false
          setTimeout(()=>{ saveBtn.textContent='Salvar' },2000)
        }
        ed.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.KeyS, ()=>saveBtn.click())
      }
      // ── Ações do explorador: novo arquivo / nova pasta / refresh / recolher ───
      window._ftSelDir=''
      async function ftReloadDir(dir){
        delete _ftCache[dir]
        const d=await fetch('/api/fs/list?path='+encodeURIComponent(dir)).then(r=>r.json()).catch(()=>({entries:[]}))
        _ftCache[dir]=d
        if(!dir){ const tree=document.getElementById('ft-tree'); if(tree) ftRender(tree,d.entries,''); return }
        const children=document.querySelector('#ft-tree .ft-children[data-path="'+CSS.escape(dir)+'"]')
        const row=document.querySelector('#ft-tree .ft-row[data-path="'+CSS.escape(dir)+'"]')
        if(children){
          children.dataset.loaded='1'; children.classList.remove('hidden')
          if(row) row.classList.add('open')
          ftRender(children,d.entries,dir)
        } else {
          const tree=document.getElementById('ft-tree'); if(tree){ const root=await fetch('/api/fs/list?path=').then(r=>r.json()).catch(()=>({entries:[]})); _ftCache['']=root; ftRender(tree,root.entries,'') }
        }
      }
      async function ftCreate(kind){
        const dir=window._ftSelDir||''
        const label=kind==='dir'?'pasta':'arquivo'
        const name=prompt('Nome '+(kind==='dir'?'da nova ':'do novo ')+label+(dir?(' em /'+dir):' (raiz)')+':')
        if(name==null) return
        const clean=name.trim(); if(!clean) return
        const r=await fetch('/api/fs/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dir,name:clean,kind})}).then(r=>r.json()).catch(e=>({error:e.message}))
        if(r.error){ alert(r.error); return }
        await ftReloadDir(dir)
        if(kind==='file') ftOpenFile(r.path, clean)
      }
      window.ftNewFile=()=>ftCreate('file')
      window.ftNewFolder=()=>ftCreate('dir')
      window.ftRefresh=function(){
        for(const k in _ftCache) delete _ftCache[k]
        window._ftLoaded=true
        ftLoad('')
      }
      window.ftCollapseAll=function(){
        document.querySelectorAll('#ft-tree .ft-row.ft-dir.open').forEach(r=>r.classList.remove('open'))
        document.querySelectorAll('#ft-tree .ft-children').forEach(c=>c.classList.add('hidden'))
        document.querySelectorAll('#ft-tree .ft-row.active').forEach(r=>r.classList.remove('active'))
        window._ftSelDir=''
      }
      window.sbNewSession=function(){
        if(window.openNewSession){ window.openNewSession(); return }
        window.location.href='/sessions?new=1'
      }
      // reabilita transições após o primeiro frame (sem flash no init)
      requestAnimationFrame(()=>requestAnimationFrame(()=>sb.style.transition=''))
    })()