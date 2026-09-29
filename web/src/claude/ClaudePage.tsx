import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionGroupInfo, SessionSummary } from './types';
import { applyLive, emptyLive, fromRows, toConvEvents, type LiveState } from './live';
import { claudeApi, matchModelAlias, matchEffort, MODEL_LABEL, type ApiSession, type Mode, type Effort, type ModelAlias, type OutputStyleInfo, type Project } from './api';
import { formatCost, computeUsageBars, messageHistory, currentPermission, sumSessionTokens, agentTaskList, sessionWorktreeName, type UsageBar } from './mapper';
import Sidebar from './Sidebar';
import Timeline, { PermissionDock } from './Timeline';
import Composer from './Composer';
import AgentMap from './AgentMap';
import SkillsHooksPanel from './SkillsHooksPanel';
import PermissionRules from './PermissionRules';
import Marketplace from './Marketplace';
import BuildStyleDialog from './OutputStyles';
import { X, Dots, Power, Sync, ArrowLeft, ArrowRight, AgentMap as AgentMapIcon, GitBranch, Wrench, Shield, Puzzle } from './icons';
import './claude.css';

/** `worktreeName`: rascunho do nome digitado no seletor "Worktree" do compositor (ver Composer.tsx,
 * PARIDADE.md seção 14) — por aba, igual `projectId`, porque é específico de CADA sessão nova, não
 * um valor "de sempre" como o projeto costuma ser. `undefined`/vazio = sessão normal, sem worktree. */
type Tab = { id: string; draft?: boolean; projectId?: number; worktreeName?: string };
const isDraft = (id: string) => id.startsWith('draft-');
/** Identifica esta guia no stream de abas, pra ignorar o eco das próprias mudanças. */
const CLIENT_ID = crypto.randomUUID();

/** `projects` só pra resolver o `path` do projeto da sessão e derivar `worktreeName` (ver
 * `sessionWorktreeName` em mapper.ts — sem coluna nova no Postgres, ver PARIDADE.md seção 14). */
function toSummary(s: ApiSession, projects: Project[]): SessionSummary {
  const status = s.status === 'error' ? 'failed' : s.status;
  const projectPath = projects.find(p => p.slug === s.project_slug)?.path;
  return {
    id: s.id, title: s.title, status, updatedAt: new Date(s.updated_at).getTime(), project: s.project_slug ?? undefined, projectName: s.project_name ?? undefined, archived: !!s.archived,
    worktreeName: sessionWorktreeName(s.cwd, projectPath) ?? undefined,
    groupId: s.group_id,
  };
}

export default function ClaudePage() {
  const [sessions, setSessions] = useState<ApiSession[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  // Pastas nomeadas manuais (ver PARIDADE.md item 12 da seção 13) — compartilhadas entre usuários,
  // mesmo modelo de `sessions` (sem filtro por dono).
  const [groups, setGroups] = useState<SessionGroupInfo[]>([]);
  const [login, setLogin] = useState<{ logged_in: boolean; linux_user: string | null; version: string } | null>(null);
  const [usage, setUsage] = useState<UsageBar[]>([]);
  const [email, setEmail] = useState<string | null>(null);
  // `role` só alimenta `canEditUser` do editor de "Regras de permissão" (ver PermissionRules.tsx) —
  // escrever no escopo "Usuário" é restrito a `role === 'owner'` porque afeta TODOS os projetos e
  // usuários do Orion (um único settings.json de usuário, do login que roda o servidor na c3).
  const [role, setRole] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [live, setLive] = useState<Record<string, LiveState>>({});
  const [mode, setMode] = useState<Mode>('acceptEdits');
  const [effort, setEffort] = useState<Effort>('medium');
  const [model, setModel] = useState<ModelAlias>('default');
  const [draftProject, setDraftProject] = useState<number | undefined>(undefined);
  // "Mapa de agentes" (ver AgentMap.tsx) — pedido ao vivo do Bayerl 28/09/2026, gatilho na faixa de
  // ações da aba (`.cc-tab-actions`, mesmo grupo de Sync/Power/Dots), painel em portal próprio.
  const [agentMapOpen, setAgentMapOpen] = useState(false);
  // Painel de skills + lista de hooks (SkillsHooksPanel.tsx) — mesmo padrão de gatilho/estado do Mapa de agentes acima.
  const [skillsHooksOpen, setSkillsHooksOpen] = useState(false);
  // "Regras de permissão" (ver PermissionRules.tsx, PARIDADE.md item 9 da seção 13) — mesmo padrão de
  // gatilho na `.cc-tab-actions`, mas SEM depender de `activeId` (diferente do Mapa de agentes): as
  // regras são por projeto/usuário, não por sessão — faz sentido abrir o painel mesmo sem nenhuma aba
  // aberta ainda (ex.: primeira visita à página).
  const [permRulesOpen, setPermRulesOpen] = useState(false);
  // "Gerenciar plugins" (Marketplace.tsx) — mesmo padrão de gatilho do editor de regras acima: por
  // catálogo/pessoa, não por sessão, então abre mesmo sem aba nenhuma. Ver PARIDADE-marketplace.md.
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);
  // Output styles (OutputStyles.tsx/Composer): lista carregada 1x + recarregada após criar estilo;
  // o estilo ATUAL é por sessão (claude_sessions.output_style), restaurado no efeito de carga como
  // modo/modelo/esforço. 'default' = sem estilo.
  const [buildStyleOpen, setBuildStyleOpen] = useState(false);
  const [styles, setStyles] = useState<OutputStyleInfo[]>([]);
  const [outputStyle, setOutputStyle] = useState<string>('default');
  const refreshStyles = useCallback(async () => {
    try { setStyles((await claudeApi.outputStyles()).styles); } catch { /* silencioso: o seletor cai no vazio */ }
  }, []);
  const [erro, setErro] = useState('');
  // true até o primeiro fetch de sessões terminar (sucesso ou falha) — enquanto isso, a lateral
  // mostra "Carregando sessões…" em vez de pular direto pra "Nenhuma sessão" (ver Sidebar.tsx;
  // espelha localSessionsLoaded/disconnectedState da extensão real).
  const [sessionsLoading, setSessionsLoading] = useState(true);
  // Estado da conexão SSE da sessão aberta — só pra avisar visualmente quando cai (o EventSource
  // nativo já reconecta sozinho; antes o onerror era um no-op puro, silêncio total pro usuário).
  const [streamStatus, setStreamStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const scrollRef = useRef<HTMLDivElement>(null);
  // Overlay flutuante do composer + card de permissão (ver claude.css `.cc-float`/`.cc-fade` e
  // PARIDADE.md "Layout flutuante do composer", rodada 7): mede a altura real do bloco flutuante via
  // ResizeObserver, igual ao `inputContainer_07S1Yg` da extensão real (webview/index.js v2.1.282:
  // `new ResizeObserver(es=>{for(let e of es)V(e.contentRect.height)})` observando o próprio nó do
  // inputContainer) — o valor vira a altura de um spacer no fim de `.cc-scroll` logo abaixo, senão a
  // última mensagem ficaria escondida atrás do card/composer flutuante (que agora sobrepõe a área que
  // rola em vez de empurrá-la, diferente da rodada 6/`.cc-dock`).
  const floatRef = useRef<HTMLDivElement>(null);
  const [floatHeight, setFloatHeight] = useState(0);
  const draftCounter = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const restoredRef = useRef(false);
  const savedKeyRef = useRef('');
  // Pilha de sessões fechadas recentemente (só ids reais, nunca rascunho) — estilo aba de navegador
  // pro Ctrl/Cmd+Shift+T: cada fechamento empilha, reabrir desempilha o mais recente. Cap de 10, igual
  // ao `recentlyClosedSessions`/rk0 da extensão real (extension.js) — é de fato uma pilha pequena, não
  // só "o último", confirmado lendo o código: o context key `lastClosedWasSession` que gate a tecla é
  // só `recentlyClosedSessions.length>0`, mas o array em si guarda até 10.
  const closedStack = useRef<string[]>([]);

  const refreshSessions = useCallback(async () => {
    try { const r = await claudeApi.sessions(); setSessions(r.sessions); } catch (e: any) { setErro(e.message); }
  }, []);
  const refreshUsage = useCallback(async () => {
    try {
      const r = await claudeApi.usage();
      setUsage(computeUsageBars(r.usage, r.real));
    } catch { /* silencioso */ }
  }, []);
  const refreshGroups = useCallback(async () => {
    try { const r = await claudeApi.sessionGroups(); setGroups(r.groups.map(g => ({ id: g.id, name: g.name, createdAt: new Date(g.created_at).getTime() }))); } catch { /* silencioso — pastas são um extra, nunca bloqueia a lista de sessões */ }
  }, []);

  useEffect(() => {
    let alive = true;
    // Primeira carga: junto com as sessões, restaura as abas que o usuário tinha abertas.
    Promise.allSettled([claudeApi.sessions(), claudeApi.uiState()]).then(([sessRes, uiRes]) => {
      if (!alive) return;
      if (sessRes.status === 'fulfilled') {
        setSessions(sessRes.value.sessions);
        if (uiRes.status === 'fulfilled') {
          const validIds = new Set(sessRes.value.sessions.map(s => s.id));
          setTabs(uiRes.value.tabs.filter(id => validIds.has(id)).map(id => ({ id })));
          setActiveId(uiRes.value.active_id && validIds.has(uiRes.value.active_id) ? uiRes.value.active_id : null);
        }
      } else {
        setErro((sessRes.reason as Error).message);
      }
      restoredRef.current = true;
      setSessionsLoading(false);
    });
    void refreshUsage();
    void refreshGroups();
    void refreshStyles();
    claudeApi.projects().then(r => { setProjects(r.projects); setDraftProject(p => p ?? r.projects[0]?.id); }).catch(e => setErro(e.message));
    claudeApi.status().then(setLogin).catch(() => setLogin(null));
    claudeApi.me().then(r => { setEmail(r.user.email); setRole(r.user.role); }).catch(() => { setEmail(null); setRole(null); });
    const t = setInterval(() => { void refreshSessions(); void refreshUsage(); }, 8000);
    return () => { alive = false; clearInterval(t); };
  }, [refreshSessions, refreshUsage, refreshGroups, refreshStyles]);

  // Sempre que as abas abertas mudam, lembra por usuário (sobrevive a reload/troca de dispositivo).
  // Pula o PUT quando nada mudou de fato (ex.: a lista acabou de chegar de outra guia).
  useEffect(() => {
    if (!restoredRef.current) return;
    const ids = tabs.filter(t => !t.draft).map(t => t.id);
    const active = activeId && !isDraft(activeId) ? activeId : null;
    const key = JSON.stringify([ids, active]);
    if (key === savedKeyRef.current) return;
    savedKeyRef.current = key;
    void claudeApi.saveUiState({ tabs: ids, active_id: active, client: CLIENT_ID }).catch(() => { /* melhor esforço */ });
  }, [tabs, activeId]);

  // Abas em tempo real entre guias/dispositivos: outra guia abriu/fechou sessão → aplica aqui.
  // Só a lista de abas é sincronizada; cada guia continua com a sua aba ativa (senão brigam).
  useEffect(() => {
    const es = new EventSource('/api/claude/ui-state/stream');
    es.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data) as { tabs: string[]; client?: string };
        if (ev.client === CLIENT_ID) return;
        void refreshSessions(); // sessão criada na outra guia ainda não está na lista local
        setTabs(t => [...ev.tabs.map(id => ({ id })), ...t.filter(x => x.draft)]);
        setActiveId(a => a && !isDraft(a) && !ev.tabs.includes(a) ? (ev.tabs.at(-1) ?? null) : a);
      } catch { /* ignora */ }
    };
    return () => es.close();
  }, [refreshSessions]);

  // Abre a sessão ativa: liga o stream PRIMEIRO e só então carrega o histórico, a cada (re)conexão.
  // Antes era o contrário (histórico, depois stream): o que o Claude emitia nesse intervalo, ou
  // enquanto a conexão estava caída, se perdia, e a tela ficava parada até alguém "cutucar" a
  // sessão. Agora os eventos que chegam durante a carga ficam num buffer e são aplicados por cima
  // do histórico (duplicados são ignorados em pushMessage/permission_request).
  useEffect(() => {
    esRef.current?.close(); esRef.current = null;
    if (!activeId || isDraft(activeId)) return;
    let alive = true;
    let buffer: any[] | null = [];
    let first = true; // modo/modelo só vêm do servidor na primeira carga (reconexão não desfaz o seletor)
    setStreamStatus('connecting');
    const apply = (ev: any) => {
      setLive(l => ({ ...l, [activeId]: applyLive(l[activeId] ?? emptyLive(), ev) }));
      if (ev.type === 'turn_end' || ev.type === 'status') void refreshSessions();
      if (ev.type === 'turn_end') void refreshUsage();
    };
    const es = new EventSource(`/api/claude/sessions/${activeId}/stream`);
    es.onmessage = (m) => { try { const ev = JSON.parse(m.data); if (buffer) buffer.push(ev); else apply(ev); } catch { /* ignora */ } };
    // onopen dispara na primeira conexão e em cada reconexão automática do navegador: nas duas,
    // recarrega o histórico pra recuperar o que aconteceu enquanto não estava ouvindo.
    es.onopen = () => {
      setStreamStatus('connected');
      buffer = buffer ?? [];
      claudeApi.get(activeId).then(r => {
        if (!alive) return;
        const pending = buffer ?? []; buffer = null;
        setLive(l => ({ ...l, [activeId]: pending.reduce((st, ev) => applyLive(st, ev), fromRows(r.events, r.session.status, r.pending)) }));
        if (!first) return;
        first = false;
        const s = r.session; if (s.permission_mode && ['acceptEdits', 'default', 'plan', 'auto'].includes(s.permission_mode)) setMode(s.permission_mode as Mode);
        setModel(matchModelAlias(s.model));
        // Esforço: sempre resolve pra um valor concreto (ver matchEffort), senão o da sessão anterior vaza.
        setEffort(matchEffort(s.effort));
        // Output style: mesmo padrão do esforço acima (sempre resolve, senão o da sessão anterior vaza).
        setOutputStyle(s.output_style || 'default');
      }).catch(e => { buffer = null; setErro(e.message); });
    };
    es.onerror = () => { setStreamStatus('disconnected'); };
    esRef.current = es;
    return () => { alive = false; es.close(); esRef.current = null; };
  }, [activeId, refreshSessions, refreshUsage]);

  const state = activeId ? (live[activeId] ?? emptyLive()) : emptyLive();
  const events = useMemo(() => toConvEvents(state), [state]);
  // Recall ArrowUp/ArrowDown do compositor: mensagens já enviadas nesta sessão, mais recente primeiro.
  const history = useMemo(() => messageHistory(events), [events]);
  // Card de permissão docado (Bash/Edit e AskUserQuestion passam pelo mesmo mecanismo de
  // permission_request — ver mapper.ts): sempre o pedido pendente mais antigo, nunca mais de um ao
  // mesmo tempo — ver PermissionDock/currentPermission e PARIDADE.md "Card de permissão docado".
  const dockedPermission = useMemo(() => currentPermission(events), [events]);
  // Mapa de agentes: subagentes (Task) desta sessão, ordenados por ordem de disparo (ver
  // agentTaskList/AgentTask em mapper.ts/types.ts), e o total de tokens já gastos na sessão (soma dos
  // "result" de cada turno concluído — undefined antes do 1º turno terminar, nunca "0" fabricado).
  const agentTasks = useMemo(() => agentTaskList(state.agentTasks), [state.agentTasks]);
  const sessionTokens = useMemo(() => sumSessionTokens(events), [events]);
  // Reobserva sempre que a sessão ativa muda: `.cc-float` (ver JSX abaixo) só existe com `activeId`
  // truthy — é condicional, igual `.cc-dock` já era antes dele — então o nó do DOM observado troca a
  // cada montagem/desmontagem (sem sessão aberta, sem composer, sem altura pra medir).
  useEffect(() => {
    const el = floatRef.current;
    if (!el) { setFloatHeight(0); return; }
    const ro = new ResizeObserver(entries => { for (const e of entries) setFloatHeight(e.contentRect.height); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeId]);
  // `floatHeight` entra nas dependências porque o card de permissão pode crescer o composer flutuante
  // (ver `.cc-float` em claude.css) no MESMO instante em que o evento de permissão é adicionado a
  // `events` — sem isso, o `scrollTo` deste efeito rodaria com o `scrollHeight` de ANTES do spacer
  // crescer (o ResizeObserver acima dispara um frame depois), deixando a última mensagem visível por
  // baixo do card recém-aparecido por um instante.
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [events.length, state.partialText.length, state.partialThinking.length, activeId, floatHeight]);

  const active = sessions.find(s => s.id === activeId);
  const activeTab = tabs.find(t => t.id === activeId);
  const running = state.status === 'running' || state.status === 'waiting';

  function open(id: string) {
    // Sessão voltou a estar aberta: não é mais "fechada recentemente" (senão Ctrl+Shift+T podia
    // oferecer reabrir uma aba que o usuário já reabriu manualmente pelo clique na lateral).
    closedStack.current = closedStack.current.filter(x => x !== id);
    setActiveId(id);
    setTabs(t => t.some(x => x.id === id) ? t : [...t, { id }]);
  }
  function closeTab(id: string) {
    setTabs(t => { const next = t.filter(x => x.id !== id); if (id === activeId) setActiveId(next.length ? next[next.length - 1].id : null); return next; });
    // Só sessões de verdade entram na pilha de "fechadas recentemente" (rascunho fechado não é uma
    // sessão pra reabrir — a extensão real também só rastreia `sessionId`, nunca uma aba vazia).
    if (!isDraft(id)) {
      closedStack.current = [...closedStack.current.filter(x => x !== id), id];
      if (closedStack.current.length > 10) closedStack.current.shift();
    }
  }
  /** Ctrl/Cmd+Shift+T: reabre a sessão fechada mais recentemente (estilo aba de navegador — desempilha; ver closedStack acima). Pula ids que não existem mais (arquivada/removida) até achar uma válida ou esvaziar. */
  function reopenLastClosed() {
    while (closedStack.current.length) {
      const id = closedStack.current.pop()!;
      if (sessions.some(s => s.id === id)) { open(id); return; }
    }
  }
  function newSession() {
    const id = `draft-${++draftCounter.current}`;
    setTabs(t => [...t, { id, draft: true, projectId: draftProject }]);
    setActiveId(id);
  }
  /** Setinhas do topo (pedido do Bayerl 29/09/2026, estilo navegador): andam pela ordem das abas
   * abertas, não por histórico de navegação de verdade — dá a volta nas pontas. */
  function stepTab(dir: -1 | 1) {
    if (tabs.length < 2) return;
    const i = tabs.findIndex(t => t.id === activeId);
    const next = i === -1 ? 0 : (i + dir + tabs.length) % tabs.length;
    setActiveId(tabs[next].id);
  }
  // Rola a faixa de abas até a aba ativa aparecer, um pedaço de cada vez (scrollIntoView cuida
  // disso sozinho: se já está visível não faz nada; senão desliza o mínimo — revela uma ponta,
  // esconde a outra, igual pedido pelo Bayerl 29/09/2026). Roda tanto clicando direto numa aba
  // quanto usando as setinhas.
  useEffect(() => {
    if (!activeId) return;
    const el = document.querySelector(`.cc-tabs-scroll [data-tab-id="${activeId}"]`);
    el?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
  }, [activeId]);

  // Atalhos globais da aba Claude (package.json da extensão real, contributes.keybindings):
  // Ctrl/Cmd+N → newConversation (nova sessão, quando o painel do Claude está em foco — aqui, a
  // página inteira, já que não existe outro painel concorrendo); Ctrl/Cmd+Shift+T →
  // reopenClosedSession (reabre a última sessão fechada, estilo aba de navegador — ver closedStack/
  // reopenLastClosed acima). Alguns navegadores reservam essas combinações pra si (nova
  // janela/reabrir aba) e não deixam preventDefault interceptar — mesma limitação que a extensão real
  // não tem dentro do VS Code/Electron; aqui é o melhor esforço possível numa página web comum.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (!e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newSession(); return; }
      if (e.shiftKey && e.key.toLowerCase() === 't') { e.preventDefault(); reopenLastClosed(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draftProject, sessions]);

  async function send(text: string, files: File[] = []) {
    setErro('');
    try {
      const prompt = text || (files.length ? '(arquivos em anexo)' : '');
      const attachments = files.length ? (await claudeApi.uploads(files)).attachments : undefined;
      // 'default' = sem override (deixa a sessão/conta decidir); só manda um valor real quando o
      // usuário escolheu algo no seletor de modelo.
      const modelOverride = model !== 'default' ? model : undefined;
      if (!activeId || isDraft(activeId)) {
        const pid = activeTab?.projectId ?? draftProject ?? projects[0]?.id;
        if (!pid) { setErro('Nenhum projeto cadastrado'); return; }
        // "Aba Claude" — criar worktree direto pela UI do chat (ver PARIDADE.md seção 14): nome
        // digitado no seletor "Worktree" do compositor, se houver. O servidor cria o git worktree e
        // já faz a sessão nascer com `cwd` apontando pra ele; nome vazio = sessão normal, como sempre.
        const worktreeName = activeTab?.worktreeName?.trim() || undefined;
        const r = await claudeApi.create({ project_id: pid, prompt, permission_mode: mode, model: modelOverride, effort, attachments, worktree_name: worktreeName });
        const draftId = activeId;
        setTabs(t => draftId ? t.map(x => x.id === draftId ? { id: r.id } : x) : [...t, { id: r.id }]);
        setActiveId(r.id);
        void refreshSessions();
      } else {
        await claudeApi.send(activeId, { prompt, permission_mode: mode, model: modelOverride, effort, attachments });
      }
    } catch (e: any) { setErro(e.message); throw e; }
  }
  async function decide(approvalId: string, d: 'allow' | 'allow_always' | 'deny' | 'answer', msg?: string) {
    if (!activeId) return;
    try { await claudeApi.permission(activeId, { approval_id: approvalId, decision: d, message: msg }); } catch (e: any) { setErro(e.message); }
  }
  async function stop() { if (activeId && !isDraft(activeId)) { try { await claudeApi.stop(activeId); } catch (e: any) { setErro(e.message); } } }
  /**
   * Troca de modo/modelo/esforço no compositor: sempre atualiza o estado local na hora (pro próprio
   * seletor mostrar a escolha e pra já valer no próximo create/send, como antes) e, quando o valor
   * realmente mudou E há uma sessão de verdade aberta (não rascunho — ainda não existe Query nem
   * linha no Postgres pra atualizar), também dispara a troca AO VIVO (`claudeApi.setMode`/`setModel`/
   * `setEffort`) — bug corrigido em 28/09/2026 (ver PARIDADE.md): antes, mudar o modo com um turno já
   * em andamento não tinha efeito nenhum até a próxima mensagem, sem nenhum aviso ao usuário. Falha
   * na chamada ao vivo (rede/servidor) só um aviso no console — nunca reverte o estado local (a
   * intenção do usuário continua valendo pro próximo turno de qualquer forma) nem quebra a tela.
   */
  function handleMode(m: Mode) {
    setMode(m);
    if (m === mode || !activeId || isDraft(activeId)) return;
    claudeApi.setMode(activeId, m).catch(e => console.warn('troca de modo ao vivo falhou:', e?.message ?? e));
  }
  function handleModel(m: ModelAlias) {
    setModel(m);
    if (m === model || !activeId || isDraft(activeId)) return;
    claudeApi.setModel(activeId, m !== 'default' ? m : undefined).catch(e => console.warn('troca de modelo ao vivo falhou:', e?.message ?? e));
  }
  function handleEffort(e: Effort) {
    setEffort(e);
    if (e === effort || !activeId || isDraft(activeId)) return;
    claudeApi.setEffort(activeId, e).catch(err => console.warn('troca de esforço ao vivo falhou:', err?.message ?? err));
  }
  /** Troca de output style — mesmo contrato dos três acima: estado local na hora + persistência/
   * aplicação ao vivo na sessão real (POST /:id/output-style; ver PARIDADE-marketplace.md). */
  function handleOutputStyle(nome: string) {
    setOutputStyle(nome);
    if (nome === outputStyle || !activeId || isDraft(activeId)) return;
    claudeApi.setOutputStyle(activeId, nome).catch(err => console.warn('troca de estilo ao vivo falhou:', err?.message ?? err));
  }
  async function rename() {
    if (!active) return;
    const t = window.prompt('Novo título da sessão', active.title);
    if (t && t.trim()) { await claudeApi.rename(active.id, t.trim()); void refreshSessions(); }
  }
  async function renameSession(id: string, title: string) {
    setSessions(ss => ss.map(s => s.id === id ? { ...s, title } : s));
    try { await claudeApi.rename(id, title); } catch (e: any) { setErro(e.message); } finally { void refreshSessions(); }
  }
  async function archiveSession(id: string, archived: boolean) {
    setSessions(ss => ss.map(s => s.id === id ? { ...s, archived } : s));
    try { await claudeApi.archive(id, archived); } catch (e: any) { setErro(e.message); } finally { void refreshSessions(); }
  }
  /**
   * Pastas nomeadas manuais (ver PARIDADE.md item 12 da seção 13) — CRUD + mover sessão pra
   * dentro/fora. Mesmo padrão otimista já usado por `renameSession`/`archiveSession` acima quando faz
   * sentido (move/rename refletem na hora, sem esperar a resposta); criar/apagar pasta só recarrega a
   * lista depois da resposta (não há "otimista" óbvio pra um id que ainda não existe).
   */
  async function createGroup(name: string) {
    try { await claudeApi.createGroup(name); } catch (e: any) { setErro(e.message); } finally { void refreshGroups(); }
  }
  async function renameGroup(id: string, name: string) {
    setGroups(gs => gs.map(g => g.id === id ? { ...g, name } : g));
    try { await claudeApi.renameGroup(id, name); } catch (e: any) { setErro(e.message); } finally { void refreshGroups(); }
  }
  async function deleteGroup(id: string) {
    setGroups(gs => gs.filter(g => g.id !== id));
    try { await claudeApi.deleteGroup(id); } catch (e: any) { setErro(e.message); } finally { void refreshGroups(); void refreshSessions(); }
  }
  async function moveToGroup(sessionId: string, groupId: string | null) {
    setSessions(ss => ss.map(s => s.id === sessionId ? { ...s, group_id: groupId } : s));
    try { await claudeApi.moveToGroup(sessionId, groupId); } catch (e: any) { setErro(e.message); } finally { void refreshSessions(); }
  }
  /** Nome de worktree digitado pro rascunho da aba ativa (ver Composer.tsx, PARIDADE.md seção 14) — só mexe no `Tab`, nada remoto ainda (a criação acontece em `send()`, junto com a 1ª mensagem). */
  function setDraftWorktreeName(name: string) {
    setTabs(t => t.map(x => x.id === activeId ? { ...x, worktreeName: name } : x));
  }

  const summaries = useMemo(() => sessions.map(s => toSummary(s, projects)), [sessions, projects]);
  const title = activeTab?.draft ? 'Nova sessão' : (active?.title ?? (activeId ? 'Sessão' : 'Claude'));
  // Mostra o que vale pra PRÓXIMA mensagem: o override escolhido no seletor, se houver; senão o
  // modelo resolvido da sessão (gravado no system/init do SDK), como antes.
  const modelLabel = model !== 'default' ? MODEL_LABEL[model] : (active?.model ?? 'modelo padrão');
  // Worktree da sessão ATIVA (não rascunho) — alimenta o banner "Esta sessão está no worktree X"
  // abaixo, espelhando `worktree.value.path !== defaultCwd.value` da extensão real (ver PARIDADE.md
  // seção 14). `active` já é `ApiSession` (tem `cwd`); o `path` do projeto vem de `projects` (mesma
  // fonte que `toSummary` usa pras sessões da lateral).
  const activeProjectPath = active ? projects.find(p => p.slug === active.project_slug)?.path : undefined;
  const activeWorktreeName = active ? sessionWorktreeName(active.cwd, activeProjectPath) : null;
  // Painel de skills + lista de hooks (SkillsHooksPanel.tsx, PARIDADE.md seção 16) — projeto da
  // sessão ativa resolvido por slug, mesmo caminho que `activeProjectPath` já usa acima (sem coluna
  // `project_id` na resposta de `GET /api/claude/sessions`, que só devolve `project_slug`/`project_name`).
  const activeProject = active ? projects.find(p => p.slug === active.project_slug) : undefined;
  // Projeto pra pré-selecionar no editor de "Regras de permissão" ao abrir — sessão de verdade: o
  // projeto dela (via `project_slug`); aba rascunho: o projeto escolhido no seletor do compositor.
  // `undefined` quando nada resolve (ex.: nenhuma aba aberta) — o painel cai no 1º projeto da lista.
  const permRulesProjectId = activeTab?.draft ? (activeTab.projectId ?? draftProject) : (active ? projects.find(p => p.slug === active.project_slug)?.id : undefined);

  return (
    <div className="cc">
      <Sidebar sessions={summaries} usage={usage} activeId={activeId} loading={sessionsLoading} folders={groups} onSelect={open} onNew={newSession} onRename={renameSession} onArchive={archiveSession}
        onCreateGroup={createGroup} onRenameGroup={renameGroup} onDeleteGroup={deleteGroup} onMoveToGroup={moveToGroup} />
      <main className="cc-main">
        <div className="cc-tabs">
          <div className="cc-tabs-scroll">
          {tabs.map(t => {
            const s = sessions.find(x => x.id === t.id);
            const label = t.draft ? 'Nova sessão' : (s?.title ?? '…');
            return (
              <div key={t.id} data-tab-id={t.id} className={`cc-tab ${t.id === activeId ? 'is-active' : ''}`} onClick={() => setActiveId(t.id)}>
                <span className="cc-tab-spark">✳</span><span className="cc-tab-title">{label}</span>
                <button className="cc-tab-x" onClick={e => { e.stopPropagation(); closeTab(t.id); }} title="Fechar aba"><X size={11} /></button>
              </div>
            );
          })}
          </div>
          <span className="cc-tab-actions">
            <button className="cc-icon" title="Aba anterior" disabled={tabs.length < 2} onClick={() => stepTab(-1)}><ArrowLeft size={13} /></button>
            <button className="cc-icon" title="Próxima aba" disabled={tabs.length < 2} onClick={() => stepTab(1)}><ArrowRight size={13} /></button>
            <button className="cc-icon" title="Mapa de agentes" disabled={!activeId} onClick={() => setAgentMapOpen(true)}><AgentMapIcon size={13} /></button>
            <button className="cc-icon" title="Skills e hooks" disabled={!activeId} onClick={() => setSkillsHooksOpen(true)}><Wrench size={13} /></button>
            <button className="cc-icon" title="Regras de permissão" onClick={() => setPermRulesOpen(true)}><Shield size={13} /></button>
            <button className="cc-icon" title="Gerenciar plugins" onClick={() => setMarketplaceOpen(true)}><Puzzle size={13} /></button>
            <button className="cc-icon" title="Parar sessão" onClick={stop}><Power size={13} /></button>
            <button className="cc-icon" title="Recarregar lista" onClick={() => { void refreshSessions(); void refreshUsage(); }}><Sync size={13} /></button>
            <button className="cc-icon" title="Renomear sessão" onClick={rename}><Dots size={13} /></button>
          </span>
        </div>
        {login && !login.logged_in && (
          <div className="cc-banner">
            O Claude não está logado na c3 como <span className="cc-mono">{login.linux_user ?? 'danilo'}</span>. Cole o token do Max em <b>Configurações</b>, ou no seu Mac: <span className="cc-mono">ssh c3</span> e depois <span className="cc-mono">sudo -iu danilo claude</span>.
          </div>
        )}
        <div className="cc-head">
          <span>{title}</span>
          {active && <span className="cc-head-meta">{active.project_name ?? ''} · {active.user_name} · {formatCost(Number(active.cost_usd))} · {active.turns} turnos · <span className={`cc-dot is-${toSummary(active, projects).status}`} /> {active.status}</span>}
        </div>
        {erro && <div className="cc-error-bar">{erro}</div>}
        {activeId && streamStatus === 'disconnected' && (
          <div className="cc-banner cc-reconnect"><span className="cc-spinner" /> Conexão em tempo real perdida — reconectando…</div>
        )}
        {/*
          "Aba Claude" — criar/gerenciar worktree direto pela UI do chat (ver PARIDADE.md seção 14).
          Espelha o banner real (`worktreeBanner_aqhumA`: "This session is in worktree" + pill com o
          nome), condicionado a `worktree.value.path !== defaultCwd.value` — aqui, `cwd` da sessão
          diferente do `path` do projeto. Sem o botão "Open worktree" da extensão real (abre em nova
          janela do editor — não existe equivalente numa página web só de chat): o caminho completo já
          aparece na barra de status embaixo (`.cc-status`), então o banner aqui é só informativo.
        */}
        {active && activeWorktreeName && (
          <div className="cc-worktree-banner">
            <span className="cc-worktree-banner-left">
              <GitBranch size={14} /> Esta sessão está no worktree <span className="cc-worktree-banner-name">{activeWorktreeName}</span>
            </span>
          </div>
        )}
        {/* `.cc-chat` = `.chatContainer_07S1Yg` real: âncora `position:relative` pras duas camadas
            absolutas por cima da área que rola (`.cc-fade`/`.cc-float` abaixo) — ver claude.css e
            PARIDADE.md "Layout flutuante do composer". */}
        <div className="cc-chat">
          <div className="cc-scroll" ref={scrollRef}>
            {!activeId && (
              <div className="cc-empty-state">
                <div className="cc-brand-big">✳ Claude Code</div>
                <p>Escolha uma sessão à esquerda ou clique em <b>Nova sessão</b>.</p>
                <p className="cc-muted">Cada sessão roda na c3, na pasta do projeto, com o login único do Max. Fechar o navegador não interrompe nada.</p>
              </div>
            )}
            {activeId && <Timeline events={events} onDecide={decide} />}
            {/* Spacer com a altura real do composer flutuante (floatHeight acima) — mesma função do
                `<div ref={Y} style={{height:U+'px',minHeight:U+'px'}}/>` real, último filho de
                `messagesContainer_07S1Yg`: garante que a última mensagem role pra cima do card/composer
                flutuante, nunca fique escondida atrás dele. */}
            {activeId && <div style={{ height: floatHeight, minHeight: floatHeight }} aria-hidden="true" />}
          </div>
          {/* Camada de esmaecimento entre o texto que rola e o composer flutuante — `.messageGradient_07S1Yg`
              real: gradiente sólido até a cor de fundo, NÃO blur/backdrop-filter (nenhum dos dois existe
              nesta área do bundle real — ver claude.css/PARIDADE.md). */}
          {activeId && <div className="cc-fade" aria-hidden="true" />}
          {activeId && (
            <div className="cc-float" ref={floatRef}>
              <PermissionDock event={dockedPermission} onDecide={decide} />
              <Composer onSend={send} onStop={stop} running={running} mode={mode} onMode={handleMode} effort={effort} onEffort={handleEffort}
                model={model} onModel={handleModel} modelLabel={modelLabel} history={history} commands={state.commands} sessionId={activeId}
                projects={activeTab?.draft ? projects : undefined} projectId={activeTab?.projectId ?? draftProject}
                onProject={(id) => { setDraftProject(id); setTabs(t => t.map(x => x.id === activeId ? { ...x, projectId: id } : x)); }}
                worktreeName={activeTab?.worktreeName} onWorktreeName={activeTab?.draft ? setDraftWorktreeName : undefined}
                outputStyles={styles} outputStyle={outputStyle}
                onOutputStyle={!activeTab?.draft ? handleOutputStyle : undefined}
                onBuildStyle={() => setBuildStyleOpen(true)} />
            </div>
          )}
        </div>
        <div className="cc-status">
          <span>{active?.project_slug ?? '—'}</span><span className="cc-mono">{active?.cwd ?? ''}</span><span className="cc-spacer" />
          <span>{login ? `Claude Code ${login.version}` : ''}</span><span>{sessions.filter(s => s.status === 'running' || s.status === 'waiting').length} ativa(s)</span>
        </div>
      </main>
      {activeId && (
        <AgentMap
          open={agentMapOpen}
          onClose={() => setAgentMapOpen(false)}
          sessionTitle={title}
          sessionStatus={state.status}
          modelLabel={modelLabel}
          sessionTokens={sessionTokens}
          tasks={agentTasks}
        />
      )}
      {activeId && (
        <SkillsHooksPanel
          open={skillsHooksOpen}
          onClose={() => setSkillsHooksOpen(false)}
          projectId={activeProject?.id ?? null}
          projectLabel={activeProject?.name}
        />
      )}
      <PermissionRules
        open={permRulesOpen}
        onClose={() => setPermRulesOpen(false)}
        projects={projects}
        defaultProjectId={permRulesProjectId}
        canEditUser={role === 'owner'}
      />
      <Marketplace open={marketplaceOpen} onClose={() => setMarketplaceOpen(false)} isOwner={role === 'owner'} />
      <BuildStyleDialog open={buildStyleOpen} onClose={() => setBuildStyleOpen(false)} existing={styles}
        canSwitchNow={!!activeId && !isDraft(activeId)}
        onSaved={(slug, switchNow) => { void refreshStyles(); if (switchNow) handleOutputStyle(slug); }} />
    </div>
  );
}
