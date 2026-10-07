import { useEffect, useState } from 'react';
import type { SessionGroupInfo, SessionSummary } from './types';
import type { ModelAttribution, UsageBar } from './mapper';
import { relativeTime, filterSessions, groupSessions, validateGroupName, type GroupBy } from './mapper';
import { Chevron, Plus, Search, Bolt, X, Archive, Pencil, Folder, Filter, Restore, Trash } from './icons';

/**
 * Sentinela usado pelo `<select>` "Mover para pasta" de cada sessão pra representar "solta, sem
 * pasta nenhuma" — `<option value="">` colidiria com um `groupId` real vazio (nunca acontece, mas
 * evita ambiguidade) e não dá pra usar `null` como `value` de um elemento HTML. Convertido de volta
 * pra `null` em `onMoveToGroup` (ver `SessionRow` abaixo).
 */
const UNGROUPED = '__sem_pasta__';

/** Fotinho de quem criou a sessão; sem foto, a inicial do nome. Usado na lista e nas abas. */
export function Avatar({ id, name }: { id: number; name: string }) {
  const [falhou, setFalhou] = useState(false);
  return (
    <span className="cc-item-avatar" title={`Criada por ${name}`}>
      {falhou ? (name.trim()[0] ?? '?').toUpperCase() : <img src={`/api/profile/avatar/${id}`} alt="" onError={() => setFalhou(true)} />}
    </span>
  );
}

function SessionRow({ s, active, onSelect, onRename, onArchive, onDelete, folders, onMoveToGroup }: {
  s: SessionSummary; active: boolean; onSelect: () => void;
  onRename: (id: string, title: string) => void; onArchive: (id: string, archived: boolean) => void;
  onDelete?: (id: string) => void;
  folders: SessionGroupInfo[]; onMoveToGroup?: (sessionId: string, groupId: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(s.title);
  function commit() { const t = draft.trim(); setEditing(false); if (t && t !== s.title) onRename(s.id, t); }
  return (
    <div className={`cc-item ${active ? 'is-active' : ''}`}>
      {/* Bolinha só em sessão aberta numa aba, rodando ou esperando você: igual ao plugin (`GF0` no
          webview 2.1.283: fechada e parada = sem indicador). */}
      {/* Ordem: bolinha > avatar > selo do projeto > nome. Sem bolinha fica um espaço do mesmo
          tamanho, pra avatares e selos alinharem em coluna. */}
      {(s.open || s.status === 'running' || s.status === 'waiting') ? <span className={`cc-dot is-${s.status}`} /> : <span className="cc-dot is-none" aria-hidden="true" />}
      {s.userId !== undefined && <Avatar id={s.userId} name={s.userName ?? ''} />}
      <span className="cc-item-project" title={`Projeto: ${s.projectName ?? 'Neutro'}`}>{s.projectName ?? 'Neutro'}</span>
      {editing ? (
        <input className="cc-item-edit" autoFocus value={draft} onChange={e => setDraft(e.target.value)}
          onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }} />
      ) : (
        <button
          className="cc-item-name"
          onClick={onSelect}
          title={s.title}
          onMouseEnter={e => {
            const btn = e.currentTarget;
            const txt = btn.querySelector<HTMLElement>('.cc-item-name-text');
            if (!txt) return;
            const overflow = txt.scrollWidth - btn.clientWidth;
            if (overflow > 0) {
              btn.style.textOverflow = 'clip';
              txt.style.transitionDuration = `${Math.max(0.4, overflow / 40)}s`;
              txt.style.transform = `translateX(-${overflow}px)`;
            }
          }}
          onMouseLeave={e => {
            const btn = e.currentTarget;
            const txt = btn.querySelector<HTMLElement>('.cc-item-name-text');
            btn.style.textOverflow = '';
            if (txt) txt.style.transform = '';
          }}
        >
          <span className="cc-item-name-text">{s.title}</span>
        </button>
      )}
      <span className="cc-item-time">{relativeTime(s.updatedAt)}</span>
      <span className="cc-item-actions">
        {/*
          "Mover para pasta" — alternativa a arrastar-e-soltar (ver PARIDADE.md item 12 da seção 13,
          decisão de escopo: a extensão real move sessão pra pasta por drag-and-drop OU por um menu de
          contexto "Add to group"/"Remove from group"; aqui só o caminho de menu, um `<select>` nativo
          — totalmente acessível por teclado, e sem nenhum estado de DOM/evento de drag pra acertar
          sem poder testar num navegador de verdade). Só aparece quando existe pelo menos uma pasta
          criada (senão não haveria pra onde mover) — mesmo padrão já usado pelo filtro de projeto
          logo acima em Sidebar (`projectOptions.length > 1`).
        */}
        {onMoveToGroup && folders.length > 0 && (
          <select className="cc-select cc-mini-select cc-item-move" title="Mover para pasta" value={s.groupId ?? UNGROUPED}
            onClick={e => e.stopPropagation()}
            onChange={e => onMoveToGroup(s.id, e.target.value === UNGROUPED ? null : e.target.value)}>
            <option value={UNGROUPED}>Sem pasta</option>
            {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        )}
        {!s.archived && <button className="cc-item-act" title="Renomear" onClick={() => { setDraft(s.title); setEditing(true); }}><Pencil size={12} /></button>}
        {s.archived ? (
          <>
            <button className="cc-item-act" title="Restaurar" onClick={() => onArchive(s.id, false)}><Restore size={12} /></button>
            {onDelete && <button className="cc-item-act" title="Excluir definitivamente" onClick={() => onDelete(s.id)}><Trash size={12} /></button>}
          </>
        ) : (
          <button className="cc-item-act" title="Arquivar" onClick={() => onArchive(s.id, true)}><Archive size={12} /></button>
        )}
      </span>
    </div>
  );
}

function SessionGroupSection({ groupKey, label, sessions, collapsible, collapsed, onToggle, activeId, onSelect, onRename, onArchive, folders, onMoveToGroup, isFolder, onRenameGroup, onDeleteGroup, drag }: {
  groupKey: string; label: string; sessions: SessionSummary[]; collapsible: boolean; collapsed: boolean; onToggle: () => void;
  activeId: string | null; onSelect: (id: string) => void; onRename: (id: string, title: string) => void; onArchive: (id: string, archived: boolean) => void;
  folders: SessionGroupInfo[]; onMoveToGroup?: (sessionId: string, groupId: string | null) => void;
  /** `isFolder`: esta seção é uma pasta nomeada de verdade (não "Sem pasta"/os baldes automáticos de projeto/recência) — só então mostra os ícones de renomear/excluir. */
  drag?: { isOpen: (id: string) => boolean; dragId: string | null; setDragId: (id: string | null) => void; onDrop: (toId: string) => void };
  isFolder?: boolean; onRenameGroup?: (name: string) => void; onDeleteGroup?: () => void;
}) {
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(label);
  function commitName() {
    const t = draftName.trim();
    setEditingName(false);
    if (t && t !== label) onRenameGroup?.(t);
  }
  return (
    <div key={groupKey}>
      {/* Sem agrupar: lista direta, sem o cabeçalho "Sem grupo". */}
      {groupKey !== 'all' && (
      <div className={`cc-group-head ${collapsible ? 'cc-clickable' : ''}`} onClick={collapsible && !editingName ? onToggle : undefined}>
        <Chevron size={11} className={`cc-chev ${collapsed ? '' : 'is-open'}`} />
        {editingName ? (
          <input className="cc-item-edit" autoFocus value={draftName} onChange={e => setDraftName(e.target.value)}
            onClick={e => e.stopPropagation()} onBlur={commitName}
            onKeyDown={e => { if (e.key === 'Enter') commitName(); if (e.key === 'Escape') setEditingName(false); }} />
        ) : (
          <>{label} </>
        )}
        <span className="cc-badge">{sessions.length}</span>
        {isFolder && !editingName && (
          <span className="cc-group-actions">
            <button className="cc-item-act" title="Renomear pasta" onClick={e => { e.stopPropagation(); setDraftName(label); setEditingName(true); }}><Pencil size={11} /></button>
            <button className="cc-item-act" title="Excluir pasta" onClick={e => { e.stopPropagation(); onDeleteGroup?.(); }}><X size={11} /></button>
          </span>
        )}
      </div>
      )}
      {!collapsed && (
        <div className="cc-list">
          {sessions.map(s => {
            const row = <SessionRow key={s.id} s={s} active={s.id === activeId} onSelect={() => onSelect(s.id)} onRename={onRename} onArchive={onArchive}
              folders={folders} onMoveToGroup={onMoveToGroup} />;
            // Modo "ordem das abas": as abertas podem ser arrastadas na lista para mudar a ordem das abas.
            if (!drag || !drag.isOpen(s.id)) return row;
            return (
              <div key={s.id} draggable className={`cc-item-drag ${drag.dragId === s.id ? 'is-dragging' : ''}`}
                onDragStart={e => { drag.setDragId(s.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-orion-session', s.id); }}
                onDragOver={e => { if (drag.dragId) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }}
                onDrop={e => { e.preventDefault(); drag.onDrop(s.id); }}
                onDragEnd={() => drag.setDragId(null)}>
                {row}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function Sidebar({ tabOrder, onMoveTab, sessions, meId, usage, modelAttribution, activeId, loading, folders, onSelect, onNew, onRename, onArchive, onDelete, onCreateGroup, onRenameGroup, onDeleteGroup, onMoveToGroup }:
  {
    tabOrder: string[]; onMoveTab: (fromId: string, toId: string) => void;
    sessions: SessionSummary[]; meId?: number; usage: UsageBar[];
    /** "% do uso" por modelo (7 dias) — breakdown de atribuição da extensão real (`attribution*_QET5Ow`, string "% of usage"); ver computeModelAttribution em mapper.ts e PARIDADE-seletor.md. Vazio = bloco escondido. */
    modelAttribution?: ModelAttribution[];
    activeId: string | null; loading?: boolean;
    /** Pastas nomeadas manuais (ver PARIDADE.md item 12 da seção 13) — `[]` quando nenhuma foi criada ainda; o modo "Por pasta" e o seletor "Mover para pasta" por sessão só aparecem de fato úteis quando há pelo menos uma. */
    folders: SessionGroupInfo[];
    onSelect: (id: string) => void; onNew: () => void; onRename: (id: string, title: string) => void; onArchive: (id: string, archived: boolean) => void;
    onDelete: (id: string) => void;
    onCreateGroup: (name: string) => void; onRenameGroup: (id: string, name: string) => void; onDeleteGroup: (id: string) => void;
    onMoveToGroup: (sessionId: string, groupId: string | null) => void;
  }) {
  // Gaveta do celular (≤800px, ver claude.css): fecha sozinha ao escolher ou criar sessão. No desktop o botão fica oculto.
  const [drawer, setDrawer] = useState(false);
  const pick = (id: string) => { setDrawer(false); onSelect(id); };
  const [open, setOpen] = useState(true);
  const [acctOpen, setAcctOpen] = useState(true);
  const [q, setQ] = useState('');
  const [activeOnly, setActiveOnly] = useState(false);
  const [soMinhas, setSoMinhas] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [projectFilter, setProjectFilter] = useState('');
  // Lista direta, sem agrupar (pedido do Danilo, 01/10/2026: o projeto já aparece no selo de cada linha).
  const groupBy = 'none' as GroupBy;
  const [viewOpen, setViewOpen] = useState(false);
  // Ordem das sessões abertas na lista: por última atividade ou igual às abas (lembrada no navegador).
  const [openOrder, setOpenOrder] = useState<'recent' | 'tabs'>(() => localStorage.getItem('orion.openOrder') === 'tabs' ? 'tabs' : 'recent');
  useEffect(() => { localStorage.setItem('orion.openOrder', openOrder); }, [openOrder]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  function toggleGroup(key: string) {
    setCollapsedGroups(s => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  }
  // "Nova pasta" (`newGroupButton`/`newGroupIcon` da extensão real) — inline, mesmo padrão já usado
  // pro campo "New worktree name" do compositor (ver Composer.tsx, PARIDADE.md seção 14): digita o
  // nome ANTES de criar (em vez de criar com um nome-padrão e entrar em modo de renomear depois —
  // mais simples de verificar sem navegador, um só passo). Só aparece no modo "Por pasta": é onde
  // faz sentido perguntar "criar uma pasta pra quê", já que é o único momento em que as pastas
  // aparecem como seções navegáveis na lateral.
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  function commitNewFolder() {
    const err = validateGroupName(newFolderName);
    if (err) return; // campo continua aberto; sem UI de erro dedicada (mesmo nível de simplicidade do rename de sessão/pasta, que também não tem)
    onCreateGroup(newFolderName.trim());
    setNewFolderName('');
    setCreatingFolder(false);
  }

  // Dentro de cada grupo: as abertas em aba primeiro, depois as fechadas (por última atividade).
  // As abertas seguem a ordem escolhida no botão: última atividade ou a mesma ordem das abas.
  const tabIndex = new Map(tabOrder.map((id, i) => [id, i] as const));
  // Botão ⚡ (pedido do Danilo, 02/10/2026): filtra toda sessão com bolinha (aberta para este usuário, rodando ou esperando).
  const temBolinha = (s: SessionSummary) => s.open || tabIndex.has(s.id) || s.status === 'running' || s.status === 'waiting';
  const openCount = sessions.filter(temBolinha).length;
  const filter = { term: q, project: projectFilter || undefined, userId: soMinhas ? meId : undefined };
  const soAbertas = (list: SessionSummary[]) => activeOnly ? list.filter(temBolinha) : list;
  const localList = soAbertas(filterSessions(sessions.filter(s => !s.archived), filter));
  const archivedList = soAbertas(filterSessions(sessions.filter(s => s.archived), filter));
  const openFirst = (list: SessionSummary[]) => {
    const abertas = list.filter(s => tabIndex.has(s.id));
    const fechadas = list.filter(s => !tabIndex.has(s.id));
    if (openOrder === 'tabs') abertas.sort((a, b) => tabIndex.get(a.id)! - tabIndex.get(b.id)!);
    return [...abertas, ...fechadas];
  };
  const groups = groupSessions(localList, groupBy, Date.now(), folders).map(g => ({ ...g, sessions: openFirst(g.sessions) }));

  // Projetos presentes entre as sessões, para o filtro (slug → rótulo). Só aparece quando há mais de um.
  const projectOptions: [string, string][] = [];
  const seenProjects = new Set<string>();
  for (const s of sessions) {
    if (s.project && !seenProjects.has(s.project)) { seenProjects.add(s.project); projectOptions.push([s.project, s.projectName ?? s.project]); }
  }
  projectOptions.sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'));

  return (
    <>
    <button className="cc-side-toggle" onClick={() => setDrawer(true)} title="Sessões" aria-label="Abrir lista de sessões">
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M2.5 4h11M2.5 8h11M2.5 12h11" /></svg>
    </button>
    <div className={`cc-side-backdrop ${drawer ? 'is-open' : ''}`} onClick={() => setDrawer(false)} />
    <aside className={`cc-side ${drawer ? 'is-open' : ''}`}>
      <div className="cc-side-title">CLAUDE CODE</div>

      <section className="cc-section">
        <div className="cc-section-head" onClick={() => setAcctOpen(o => !o)}>
          <Chevron size={12} className={`cc-chev ${acctOpen ? 'is-open' : ''}`} /> CONTA E USO
        </div>
        {acctOpen && (
          <>
            <div className="cc-usage-title">USO</div>
            {usage.map(u => (
              <div key={u.key} className="cc-usage">
                <div className="cc-usage-head"><span>{u.label}</span><span>{u.pct}%</span></div>
                {/* limiar de 80% é o mesmo da extensão real (função `ee` do webview: usageFillHigh a partir de 80%) */}
                <div className="cc-track"><div className={`cc-fill ${u.pct >= 80 ? 'is-high' : ''}`} style={{ width: `${u.pct}%` }} /></div>
                {u.sub && <div className="cc-usage-note">{u.sub}</div>}
                {u.resetText && <div className="cc-usage-note">Reinicia {u.resetText}</div>}
              </div>
            ))}
            {/*
              "% do uso" por modelo — cópia do bloco de atribuição da tela Account & Usage real
              (componente `J11`, header com o título do grupo + a coluna "% of usage", classes
              `attributionGroup/HeaderRow/Title/List/Row/Name/Pct/More_QET5Ow`; ver
              PARIDADE-seletor.md). Aqui o grupo é "Por modelo" (custo de 7 dias por
              `claude_sessions.model`, ver computeModelAttribution em mapper.ts), truncado em 4
              linhas + "+N mais". Sem dado (lista vazia), o bloco some inteiro.
            */}
            {(modelAttribution?.length ?? 0) > 0 && (
              <div className="cc-attr-group">
                <div className="cc-attr-head">
                  <span className="cc-attr-title">Por modelo (7 dias)</span>
                  <span className="cc-attr-pct">% do uso</span>
                </div>
                <div className="cc-attr-list">
                  {modelAttribution!.slice(0, 4).map(a => (
                    <div key={a.name} className="cc-attr-row">
                      <span className="cc-attr-name" title={a.name}>{a.name}</span>
                      <span className="cc-attr-pct">{a.pct}%</span>
                    </div>
                  ))}
                  {modelAttribution!.length > 4 && <span className="cc-attr-more">+{modelAttribution!.length - 4} mais</span>}
                </div>
              </div>
            )}
          </>
        )}
      </section>

      <section className="cc-section cc-sessions">
        <div className="cc-section-head" onClick={() => setOpen(o => !o)}><Chevron size={12} className={`cc-chev ${open ? 'is-open' : ''}`} /> SESSÕES</div>
        {open && (
          <>
            <button className="cc-new" onClick={() => { setDrawer(false); onNew(); }}><Plus size={13} /> Nova sessão</button>
            {/* Linha única de filtros (01/10/2026): busca, projeto, filtros em pílula (Minhas, Ativas) e,
                à direita, o menu ⇅ com o modo de ver (ordenar e agrupar). Sem pastas manuais: o projeto já é o grupo. */}
            {searchOpen ? (
              <div className="cc-search">
                <Search size={12} className="cc-search-icon" />
                <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar sessão…"
                  onKeyDown={e => { if (e.key === 'Escape') { setQ(''); setSearchOpen(false); } }}
                  onBlur={() => { if (!q) setSearchOpen(false); }} />
                <button className="cc-search-clear" onClick={() => { setQ(''); setSearchOpen(false); }} title="Fechar busca"><X size={11} /></button>
              </div>
            ) : (
              <div className="cc-fbar">
                <button className={`cc-fbtn ${q ? 'is-on' : ''}`} onClick={() => setSearchOpen(true)} title="Buscar sessão"><Search size={13} /></button>
                {projectOptions.length > 1 && (
                  <label className={`cc-fproj ${projectFilter ? 'is-on' : ''}`} title="Filtrar por projeto">
                    <span>{projectFilter ? (projectOptions.find(([slug]) => slug === projectFilter)?.[1] ?? projectFilter) : 'Todos'}</span>
                    <Chevron size={9} className="cc-chev-down" />
                    <select value={projectFilter} onChange={e => setProjectFilter(e.target.value)} aria-label="Filtrar por projeto">
                      <option value="">Todos os projetos</option>
                      {projectOptions.map(([slug, label]) => <option key={slug} value={slug}>{label}</option>)}
                    </select>
                  </label>
                )}
                <button className={`cc-fchip ${soMinhas ? 'is-on' : ''}`} onClick={() => setSoMinhas(m => !m)} title="Só as sessões que eu criei" disabled={meId === undefined}>Minhas</button>
                <button className={`cc-fchip ${activeOnly ? 'is-on' : ''}`} onClick={() => setActiveOnly(a => !a)} title="Só as sessões abertas (com bolinha)"><Bolt size={10} /> {openCount}</button>
                <span className="cc-fview">
                  <button className={`cc-fbtn ${viewOpen ? 'is-on' : ''}`} onClick={() => setViewOpen(o => !o)} title="Ordenar as abertas">⇅</button>
                  {viewOpen && (
                    <>
                      <div className="cc-menu-backdrop" onClick={() => setViewOpen(false)} />
                      <div className="cc-fview-pop" role="menu">
                        <div className="cc-smenu-title">Ordenar abertas</div>
                        <button className={openOrder === 'recent' ? 'is-on' : ''} onClick={() => { setOpenOrder('recent'); setViewOpen(false); }}>Recentes</button>
                        <button className={openOrder === 'tabs' ? 'is-on' : ''} onClick={() => { setOpenOrder('tabs'); setViewOpen(false); }}>Ordem das abas</button>
                      </div>
                    </>
                  )}
                </span>
              </div>
            )}
            {loading ? (
              // Estado de carregamento inicial (localSessionsLoaded=false na extensão real) — antes
              // pulava direto pra "Nenhuma sessão" enquanto o primeiro fetch ainda estava em voo.
              <div className="cc-loading"><span className="cc-spinner" /> Carregando sessões…</div>
            ) : (
              <>
                {groups.map(g => (
                  <SessionGroupSection key={g.key} groupKey={g.key} label={g.label} sessions={g.sessions}
                    collapsible={groupBy !== 'none'} collapsed={collapsedGroups.has(g.key)} onToggle={() => toggleGroup(g.key)}
                    activeId={activeId} onSelect={pick} onRename={onRename} onArchive={onArchive}
                    folders={folders} onMoveToGroup={onMoveToGroup}
                    drag={openOrder === 'tabs' ? { isOpen: id => tabIndex.has(id), dragId, setDragId, onDrop: (to) => { if (dragId && tabIndex.has(to)) onMoveTab(dragId, to); setDragId(null); } } : undefined}
                    isFolder={groupBy === 'folder' && g.key !== 'ungrouped'}
                    onRenameGroup={g.key.startsWith('folder:') ? (name) => onRenameGroup(g.key.slice('folder:'.length), name) : undefined}
                    onDeleteGroup={g.key.startsWith('folder:') ? () => onDeleteGroup(g.key.slice('folder:'.length)) : undefined} />
                ))}
                {localList.length === 0 && <div className="cc-empty">Nenhuma sessão</div>}
                {archivedList.length > 0 && (
                  <>
                    <div className="cc-group-head cc-clickable" onClick={() => setShowArchived(v => !v)}>
                      <Chevron size={11} className={`cc-chev ${showArchived ? 'is-open' : ''}`} /> Arquivadas <span className="cc-badge cc-badge-muted">{archivedList.length}</span>
                    </div>
                    {showArchived && (
                      <div className="cc-list">
                        {archivedList.map(s => (
                          <SessionRow key={s.id} s={s} active={s.id === activeId} onSelect={() => { onArchive(s.id, false); pick(s.id); }} onRename={onRename} onArchive={onArchive} onDelete={onDelete}
                            folders={folders} onMoveToGroup={onMoveToGroup} />
                        ))}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </>
        )}
      </section>
    </aside>
    </>
  );
}
