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
      function projOf(s){
        try{
          const m=titleOf(s).match(/^\[([^\]]+)\]/)
          if(!m) return null
          const word=(m[1].replace(/-WT\d+$/i,'').trim().split(/[\s-]/)||[''])[0]||''
          return word.toUpperCase().slice(0,10)||null
        }catch(e){ return null }
      }
      function shortT(s){ return titleOf(s).replace(/^\[[^\]]+\]\s*/,'').trim()||titleOf(s) }
      function _actorAvatar(s){
        const name=s.actor_name||s.actor_username||''
        if(!name) return ''
        const color=s.actor_color||'#6366f1'
        const initial=(name.charAt(0)||'?').toUpperCase()
        const title=esc('Última atividade: '+name)
        return '<span class="sb-actor-av" style="background:'+color+'" title="'+title+'">'+initial+'</span>'
      }
      function sbSessRow(s,inTrash){
        const t=shortT(s); const full=titleOf(s); const isCur=s.id===curSess
        const dot=s.status==='active'?' live':s.status==='finished'?' done':s.status==='waiting'?' idle':''
        const p=projOf(s)
        const badgeHtml=p?'<span class="sb-badge">'+esc(p)+'</span>':''
        const ctx=inTrash?'trash':'normal'
        const dotsBtn='<button class="sb-trash sb-hdots" title="Opções" data-sid="'+s.id+'" onclick="event.preventDefault();event.stopPropagation();sbShowSessMenu(this,\''+s.id+'\',\''+ctx+'\')">' +_dotsIcon+'</button>'
        const actorHtml=_actorAvatar(s)
        return '<a href="/sessions/'+s.id+'" class="sb-sess'+(isCur?' active':'')+(s.visibility==='team'?' sess-team':'')+'" title="'+esc(full)+'">'+'<span class="sb-dot'+dot+'"></span>'+badgeHtml+'<span class="sb-sess-t">'+esc(t)+'</span>'+actorHtml+dotsBtn+'</a>'
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
            '<button onclick="event.stopPropagation();sbRestoreSession(\''+id+'\')">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>Restaurar</button>'+
            '<button class="danger" onclick="event.stopPropagation();sbHardDeleteFromMenu(\''+id+'\')">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M9 6V4h6v2"/></svg>Excluir permanentemente</button>'
        } else {
          const isTeam=sess&&sess.visibility==='team'
          const visNewVal=isTeam?'personal':'team'
          const lockIc='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'
          const globeIc='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><circle cx="12" cy="12" r="10"/><ellipse cx="12" cy="12" rx="4" ry="10"/><line x1="2" y1="12" x2="22" y2="12"/></svg>'
          menu.innerHTML=
            '<button onclick="event.stopPropagation();sbToggleVis(\''+id+'\',\''+visNewVal+'\');sbCloseMenu()">'+(isTeam?lockIc:globeIc)+(isTeam?' Tornar pessoal':' Compartilhar')+'</button>'+
            '<button class="danger" onclick="event.stopPropagation();sbTrash(\''+id+'\',this);sbCloseMenu()">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M9 6V4h6v2"/></svg>Mover para lixeira</button>'
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
          const items=q?_allSess.filter(s=>titleOf(s).toLowerCase().includes(q)):_allSess
          const active=items.filter(s=>s.status==='active')
          const finished=items.filter(s=>s.status==='finished')
          const waiting=items.filter(s=>s.status==='waiting')
          const paused=items.filter(s=>s.status!=='active'&&s.status!=='finished'&&s.status!=='waiting'&&s.status!=='deleted')
          let html=''
          html+=active.map(s=>sbSessRow(s,false)).join('')
          if(active.length&&finished.length) html+='<div class="sb-div"></div>'
          html+=finished.map(s=>sbSessRow(s,false)).join('')
          if((active.length||finished.length)&&waiting.length) html+='<div class="sb-div"></div>'
          html+=waiting.map(s=>sbSessRow(s,false)).join('')
          if((active.length||finished.length||waiting.length)&&paused.length) html+='<div class="sb-div"></div>'
          html+=paused.map(s=>sbSessRow(s,false)).join('')
          if(!active.length&&!finished.length&&!waiting.length&&!paused.length) html='<div class="sb-sess-empty">Nenhuma sessão</div>'
          const tc=_trashSess.length
          html+='<div class="sb-trash-hdr'+(_trashOpen?' open':''+'" onclick="sbToggleTrash()">'+_trashIcon+'<span>Lixeira'+(tc?' · '+tc:'')+'</span>'+'<span class="sb-chev">'+_chevDn+'</span></div>'
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
      window.sbShowTrashMenu=function(btn,id){
        sbCloseMenu()
        const rect=btn.getBoundingClientRect()
        const menu=document.createElement('div')
        menu.className='sb-dots-menu'
        menu.style.cssText='position:fixed;top:'+(rect.bottom+4)+'px;left:'+Math.max(4,rect.left-120+rect.width)+'px;z-index:9999'
        menu.innerHTML=
          '<button onclick="event.stopPropagation();sbRestoreSession(\''+id+'\')">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>Restaurar</button>'+
          '<button class="danger" onclick="event.stopPropagation();sbHardDeleteFromMenu(\''+id+'\')">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M9 6V4h6v2"/></svg>Excluir permanentemente</button>'
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