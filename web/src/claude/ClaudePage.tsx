import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionGroupInfo, SessionSummary, UserAttachment } from './types';
import { applyLive, emptyLive, fromRows, toConvEvents, type LiveState } from './live';
import { claudeApi, matchModelAlias, matchEffort, MODEL_LABEL, NOVA_SESSAO, type ApiSession, type Mode, type EffortChoice, type ModelAlias, type OutputStyleInfo, type Project, type Attachment } from './api';
import { api } from '../api';
import { computeUsageBars, computeModelAttribution, messageHistory, currentPermission, sumSessionTokens, agentTaskList, applyPendingToAgentTasks, agentsPillDot, agentsPillCount, sessionWorktreeName, type UsageBar, type ModelAttribution } from './mapper';
import Sidebar, { Avatar } from './Sidebar';
import Timeline, { PermissionDock } from './Timeline';
import Composer from './Composer';
import AgentMap from './AgentMap';
import SkillsHooksPanel from './SkillsHooksPanel';
import PermissionRules from './PermissionRules';
import Marketplace from './Marketplace';
import BuildStyleDialog from './OutputStyles';
import { X, Dots, Power, Sync, ArrowLeft, ArrowRight, AgentMap as AgentMapIcon, GitBranch, Wrench, Shield, Puzzle, Eye, EyeOff, Filter, SendArrow } from './icons';
import PreviewPublico, { prefetchPreviewPublico } from '../PreviewPublico';
import SessionMenu from './SessionMenu';
import { Pencil } from './icons';
import './claude.css';
import { confirmar, perguntar } from '../dialogo';
import { IcoPainelDireito, useOrionPanel } from '../OrionPanel';

/** `worktreeName`: rascunho do nome digitado no seletor "Worktree" do compositor (ver Composer.tsx,
 * PARIDADE.md seção 14) — por aba, igual `projectId`, porque é específico de CADA sessão nova, não
 * um valor "de sempre" como o projeto costuma ser. `undefined`/vazio = sessão normal, sem worktree. */
/** projectId: undefined = ainda não escolhido (mostra a tela de escolha), null = sessão neutra. */
type Tab = { id: string; draft?: boolean; projectId?: number | null; worktreeName?: string };
const isDraft = (id: string) => id.startsWith('draft-');
/** Identifica esta guia no stream de abas, pra ignorar o eco das próprias mudanças. */
const CLIENT_ID = crypto.randomUUID();

/** `projects` só pra resolver o `path` do projeto da sessão e derivar `worktreeName` (ver
 * `sessionWorktreeName` em mapper.ts — sem coluna nova no Postgres, ver PARIDADE.md seção 14). */
function toSummary(s: ApiSession, projects: Project[]): SessionSummary {
  const status = s.status === 'error' ? 'failed' : s.status;
  const projectPath = projects.find(p => p.slug === s.project_slug)?.path;
  return {
    id: s.id, title: s.title, status, updatedAt: new Date(s.updated_at).getTime(), project: s.project_slug ?? 'neutro', projectName: s.project_name ?? 'Neutro', archived: !!s.archived, private: !!s.private, userId: s.user_id, userName: s.user_name,
    worktreeName: sessionWorktreeName(s.cwd, projectPath) ?? undefined,
    groupId: s.group_id,
  };
}

export default function ClaudePage() {
  const [sessions, setSessions] = useState<ApiSession[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [meId, setMeId] = useState<number | undefined>(undefined);
  const [meName, setMeName] = useState('');
  // Pastas nomeadas manuais (ver PARIDADE.md item 12 da seção 13) — compartilhadas entre usuários,
  // mesmo modelo de `sessions` (sem filtro por dono).
  const [groups, setGroups] = useState<SessionGroupInfo[]>([]);
  const [login, setLogin] = useState<{ logged_in: boolean; linux_user: string | null; version: string } | null>(null);
  const [usage, setUsage] = useState<UsageBar[]>([]);
  // "% do uso" por modelo na seção Conta e Uso (ver Sidebar.tsx e PARIDADE-seletor.md) — custo por
  // modelo (7 dias) agregado pelo servidor em /api/claude/usage, percentual calculado no cliente.
  const [modelAttribution, setModelAttribution] = useState<ModelAttribution[]>([]);
  const [email, setEmail] = useState<string | null>(null);
  // `role` só alimenta `canEditUser` do editor de "Regras de permissão" (ver PermissionRules.tsx) —
  // escrever no escopo "Usuário" é restrito a `role === 'owner'` porque afeta TODOS os projetos e
  // usuários do Orion (um único settings.json de usuário, do login que roda o servidor na c3).
  const [role, setRole] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  // Lista de sessões recolhida (clique no ícone do Claude no menu da esquerda). Lembra no navegador.
  const [sideHidden, setSideHidden] = useState(() => localStorage.getItem('orion.claudeSideHidden') === '1');
  useEffect(() => {
    const t = () => setSideHidden(h => { localStorage.setItem('orion.claudeSideHidden', h ? '0' : '1'); return !h; });
    window.addEventListener('orion:toggle-claude-side', t);
    return () => window.removeEventListener('orion:toggle-claude-side', t);
  }, []);
  useEffect(() => { document.body.dataset.claudeSide = sideHidden ? 'hidden' : 'shown'; return () => { delete document.body.dataset.claudeSide; }; }, [sideHidden]);
  // Modo compacto (menu ⋮): esconde ferramentas e pensamento, só pergunta e resposta final. Lembra no navegador.
  const [compacto, setCompacto] = useState(() => localStorage.getItem('orion.claudeCompacto') === '1');
  const [painelOpen, togglePainel] = useOrionPanel();
  const toggleCompacto = () => setCompacto(c => { localStorage.setItem('orion.claudeCompacto', c ? '0' : '1'); return !c; });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [live, setLive] = useState<Record<string, LiveState>>({});
  const [mode, setMode] = useState<Mode>('acceptEdits');
  const [effort, setEffort] = useState<EffortChoice>(NOVA_SESSAO.effort);
  const [model, setModel] = useState<ModelAlias>(NOVA_SESSAO.model);
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
  const [outputStyle, setOutputStyle] = useState<string>(NOVA_SESSAO.outputStyle);
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

  // 502/503/504 e queda de rede sao passageiros (o orion-central reinicia a cada deploy; o Caddy segura a
  // requisicao por ate 15 s): nao viram banner, e o banner antigo some na proxima chamada que der certo.
  const transitorio = (m: string) => /^erro 50[234]$/.test(m) || /failed to fetch|networkerror|load failed/i.test(m);
  const falha = useCallback((e: any) => { const m = e?.message ?? String(e); if (!transitorio(m)) setErro(m); }, []);
  const refreshSessions = useCallback(async () => {
    try { const r = await claudeApi.sessions(); setSessions(r.sessions); setErro(prev => (transitorio(prev) ? '' : prev)); } catch (e: any) { falha(e); }
  }, [falha]);
  const refreshUsage = useCallback(async () => {
    try {
      const r = await claudeApi.usage();
      setUsage(computeUsageBars(r.usage, r.real));
      setModelAttribution(computeModelAttribution(r.by_model));
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
          const restored = uiRes.value.tabs.filter(id => validIds.has(id));
          setTabs(restored.map(id => ({ id })));
          // Sem aba ativa salva (ou ela sumiu): abre a última aba, nunca o chat vazio com abas abertas.
          setActiveId(uiRes.value.active_id && validIds.has(uiRes.value.active_id) ? uiRes.value.active_id : (restored.at(-1) ?? null));
        }
      } else {
        falha(sessRes.reason);
      }
      restoredRef.current = true;
      setSessionsLoading(false);
    });
    void refreshUsage();
    void refreshGroups();
    void refreshStyles();
    claudeApi.projects().then(r => setProjects(r.projects)).catch(falha);
    claudeApi.status().then(setLogin).catch(() => setLogin(null));
    claudeApi.me().then(r => { setEmail(r.user.email); setRole(r.user.role); setMeId(r.user.id); setMeName(r.user.name); }).catch(() => { setEmail(null); setRole(null); });
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

  // Todas as abas abertas ficam AO VIVO, não só a ativa: cada aba de fundo tem o seu próprio stream
  // (SSE) e aplica os eventos no `live` dela. Ao trocar de aba, a conversa já está na última versão
  // (inclusive o "pensando" ou a resposta que chegou enquanto você estava em outra aba). Na carga da
  // página todas abrem juntas. A aba ativa usa o stream do efeito abaixo (que também cuida de modo,
  // modelo e aviso de conexão); quando uma aba vira ativa, o stream de fundo dela fecha e o da ativa
  // assume, recarregando o histórico por cima do que já está na tela.
  const bgStreamsRef = useRef(new Map<string, () => void>());
  useEffect(() => {
    const want = new Set(tabs.filter(t => !t.draft && t.id !== activeId).map(t => t.id));
    const streams = bgStreamsRef.current;
    for (const [id, close] of streams) if (!want.has(id)) { close(); streams.delete(id); }
    for (const id of want) {
      if (streams.has(id)) continue;
      let alive = true;
      let buffer: any[] | null = [];
      const es = new EventSource(`/api/claude/sessions/${id}/stream`);
      es.onmessage = (m) => {
        try {
          const ev = JSON.parse(m.data);
          if (buffer) { buffer.push(ev); return; }
          setLive(l => ({ ...l, [id]: applyLive(l[id] ?? emptyLive(), ev) }));
          if (ev.type === 'turn_end' || ev.type === 'status') void refreshSessions();
        } catch { /* ignora */ }
      };
      es.onopen = () => {
        buffer = buffer ?? [];
        claudeApi.get(id).then(r => {
          if (!alive) return;
          const pending = buffer ?? []; buffer = null;
          setLive(l => ({ ...l, [id]: pending.reduce((st, ev) => applyLive(st, ev), fromRows(r.events, r.session.status, r.pending)) }));
        }).catch(() => { buffer = null; });
      };
      streams.set(id, () => { alive = false; es.close(); });
    }
  }, [tabs, activeId, refreshSessions]);
  useEffect(() => () => { for (const close of bgStreamsRef.current.values()) close(); bgStreamsRef.current.clear(); }, []);

  // Reordenar abas arrastando (igual às abas do editor no Antigravity). A ordem nova vai pro
  // ui-state pelo efeito de salvar acima, então sincroniza entre guias e dispositivos.
  const dragTabRef = useRef<string | null>(null);
  const [dragOverTab, setDragOverTab] = useState<string | null>(null);
  // Arrastando pra frente (índice maior), a aba entra DEPOIS da alvo — o tracinho precisa aparecer do
  // lado direito dela pra combinar (senão parecia que ia entrar antes da última, mesmo indo pro fim).
  const [dragAfter, setDragAfter] = useState(false);
  function dragOverTabAt(targetId: string) {
    if (dragOverTab !== targetId) setDragOverTab(targetId);
    const from = dragTabRef.current;
    const after = !!from && tabs.findIndex(t => t.id === from) < tabs.findIndex(t => t.id === targetId);
    setDragAfter(after);
  }
  function dropTab(targetId: string) {
    const from = dragTabRef.current;
    dragTabRef.current = null; setDragOverTab(null);
    if (from) moveTab(from, targetId);
  }
  // Move a aba `from` para a posição de `targetId` (usado pelo arraste nas abas e na lista lateral).
  function moveTab(from: string, targetId: string) {
    if (from === targetId) return;
    setTabs(t => {
      const moving = t.find(x => x.id === from);
      if (!moving) return t;
      const rest = t.filter(x => x.id !== from);
      const at = rest.findIndex(x => x.id === targetId);
      const fromIdx = t.findIndex(x => x.id === from), toIdx = t.findIndex(x => x.id === targetId);
      rest.splice(fromIdx < toIdx ? at + 1 : at, 0, moving);
      return rest;
    });
  }

  // Abre a sessão ativa: liga o stream PRIMEIRO e só então carrega o histórico, a cada (re)conexão.
  // Antes era o contrário (histórico, depois stream): o que o Claude emitia nesse intervalo, ou
  // enquanto a conexão estava caída, se perdia, e a tela ficava parada até alguém "cutucar" a
  // sessão. Agora os eventos que chegam durante a carga ficam num buffer e são aplicados por cima
  // do histórico (duplicados são ignorados em pushMessage/permission_request).
  useEffect(() => {
    esRef.current?.close(); esRef.current = null;
    if (!activeId) return;
    if (isDraft(activeId)) {
      // Rascunho (sessão nova, ou volta pra uma aba rascunho): seletor no padrão do sistema, nunca o
      // modelo/esforço da última sessão aberta nesta página (ver NOVA_SESSAO em api.ts).
      setModel(NOVA_SESSAO.model); setEffort(NOVA_SESSAO.effort); setOutputStyle(NOVA_SESSAO.outputStyle);
      return;
    }
    let alive = true;
    let buffer: any[] | null = [];
    let first = true; // modo/modelo só vêm do servidor na primeira carga (reconexão não desfaz o seletor)
    // Troca de aba: o seletor já assume o modo da sessão da lista, sem esperar o fetch; senão uma
    // mensagem enviada nesse intervalo gravava o modo da aba anterior nesta sessão.
    const known = sessions.find(x => x.id === activeId)?.permission_mode;
    if (known && ['acceptEdits', 'default', 'plan', 'auto'].includes(known)) setMode(known as Mode);
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
      if (dropTimer) { clearTimeout(dropTimer); dropTimer = null; }
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
      }).catch(e => { buffer = null; falha(e); });
    };
    // Só avisa se a queda passar de 4s: deploy (restart do serviço) e piscadas de rede reconectam
    // sozinhas em 1 a 3s, e o banner aparecendo e sumindo a cada uma parecia instabilidade.
    let dropTimer: ReturnType<typeof setTimeout> | null = null;
    es.onerror = () => { if (!dropTimer) dropTimer = setTimeout(() => { dropTimer = null; setStreamStatus('disconnected'); }, 4000); };
    esRef.current = es;
    return () => { alive = false; if (dropTimer) clearTimeout(dropTimer); es.close(); esRef.current = null; };
  }, [activeId, refreshSessions, refreshUsage]);

  const state = activeId ? (live[activeId] ?? emptyLive()) : emptyLive();
  // Sessão real ainda sem histórico carregado (o live só nasce depois do GET): mostra o loading em vez da tela vazia.
  const carregandoSessao = !!activeId && !isDraft(activeId) && !live[activeId];
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
  // `applyPendingToAgentTasks` (29/09/2026, ver PARIDADE-agentmap.md): pinta de 'waiting' o
  // subagente/tool call aninhada com permissão pendente AGORA — mesma correção de view que
  // `applyPendingToolWaitStatus` já faz pra timeline, ligada pelo toolUseId real do SDK.
  const agentTasks = useMemo(() => {
    const pendingIds = state.pending.map(p => p.toolUseId).filter((x): x is string => !!x);
    return applyPendingToAgentTasks(agentTaskList(state.agentTasks), pendingIds);
  }, [state.agentTasks, state.pending]);
  // Agents pill do compositor (gatilho do Mapa de agentes perto do model pill — portas de
  // `pS`/`oE1` reais, ver mapper.ts): contagem de ativos + estado agregado do dot.
  const agentsPill = useMemo(() => ({ total: agentTasks.length, count: agentsPillCount(agentTasks), dot: agentsPillDot(agentTasks) }), [agentTasks]);
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
  // Colado no fim (igual ao plugin): se a tela está rolada até o final, ela continua no final a cada
  // mudança de altura do conteúdo, inclusive as que não mudam a contagem de eventos (resultado de
  // ferramenta chegando, indicador "pensando" entrando/saindo, imagem carregando). Antes só rolava
  // quando events.length mudava, e o indicador descia pra trás do composer até o próximo evento.
  // Se a pessoa rolou pra cima, não mexe: o conteúdo novo passa por trás do composer.
  const atBottomRef = useRef(true);
  // Botão "ir para o fim": aparece quando a pessoa rolou pra cima.
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const toBottom = useCallback(() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      atBottomRef.current = dist < 40;
      // O botão só aparece depois de rolar mais de uma tela pra cima (perto do fim ele atrapalha).
      setAwayFromBottom(dist > el.clientHeight);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => { if (atBottomRef.current) toBottom(); });
    for (const c of Array.from(el.children)) ro.observe(c);
    const mo = new MutationObserver(() => { ro.disconnect(); for (const c of Array.from(el.children)) ro.observe(c); if (atBottomRef.current) toBottom(); });
    mo.observe(el, { childList: true });
    return () => { el.removeEventListener('scroll', onScroll); ro.disconnect(); mo.disconnect(); };
  }, [activeId, toBottom]);
  // Trocou de aba: sempre começa no fim.
  useEffect(() => { atBottomRef.current = true; toBottom(); }, [activeId, toBottom]);
  // Mensagem nova do usuário (a pessoa acabou de enviar) sempre leva pro fim, mesmo rolado pra cima.
  const lastIsUser = events[events.length - 1]?.kind === 'user';
  useEffect(() => { if (lastIsUser) atBottomRef.current = true; if (atBottomRef.current) toBottom(); }, [events.length, lastIsUser, state.partialText.length, state.partialThinking.length, floatHeight, toBottom]);

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
  function escolherProjeto(id: number | null) {
    setTabs(t => t.map(x => x.id === activeId ? { ...x, projectId: id } : x));
  }
  function newSession() {
    const id = `draft-${++draftCounter.current}`;
    // Sem projeto pré-escolhido: a aba abre na tela de escolha (projetos + Neutro).
    setTabs(t => [...t, { id, draft: true }]);
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
      if (document.body.dataset.page && document.body.dataset.page !== '/claude') return; // página escondida (menu trocado)
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (!e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newSession(); return; }
      if (e.shiftKey && e.key.toLowerCase() === 't') { e.preventDefault(); reopenLastClosed(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sessions]);

  async function send(text: string, files: File[] = [], uploaded: Attachment[] = []) {
    setErro('');
    try {
      const prompt = text || (files.length || uploaded.length ? '(arquivos em anexo)' : '');
      const fresh = files.length ? (await claudeApi.uploads(files)).attachments : [];
      const all = [...uploaded, ...fresh];
      const attachments = all.length ? all : undefined;
      // 'default' = sem override (deixa a sessão/conta decidir); só manda um valor real quando o
      // usuário escolheu algo no seletor de modelo.
      const modelOverride = model !== 'default' ? model : undefined;
      if (!activeId || isDraft(activeId)) {
        const pid = activeTab?.projectId;
        if (pid === undefined) { setErro('Escolha o projeto da sessão (ou Neutro) antes de enviar.'); return; }
        // "Aba Claude" — criar worktree direto pela UI do chat (ver PARIDADE.md seção 14): nome
        // digitado no seletor "Worktree" do compositor, se houver. O servidor cria o git worktree e
        // já faz a sessão nascer com `cwd` apontando pra ele; nome vazio = sessão normal, como sempre.
        const r = await claudeApi.create({ project_id: pid, prompt, permission_mode: mode, model: modelOverride, effort, attachments });
        const draftId = activeId;
        setTabs(t => draftId ? t.map(x => x.id === draftId ? { id: r.id } : x) : [...t, { id: r.id }]);
        setActiveId(r.id);
        void refreshSessions();
      } else {
        await claudeApi.send(activeId, { prompt, permission_mode: mode, model: modelOverride, effort, attachments });
      }
    } catch (e: any) { setErro(e.message); throw e; }
  }
  /** Reenvio de um prompt que um hook rejeitou (card "Mensagem não entregue", Timeline.tsx): os anexos já estão no servidor, não sobe nada de novo. */
  async function resend(text: string, attachments?: UserAttachment[]) {
    if (!activeId || isDraft(activeId)) return;
    setErro('');
    const atts = attachments?.filter((a): a is Attachment => !!a.path && !!a.media_type);
    try { await claudeApi.send(activeId, { prompt: text, permission_mode: mode, model: model !== 'default' ? model : undefined, effort, attachments: atts?.length ? atts : undefined }); }
    catch (e: any) { setErro(e.message); }
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
  function handleEffort(e: EffortChoice) {
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
    const t = await perguntar('Novo título da sessão', active.title);
    if (t && t.trim()) { await claudeApi.rename(active.id, t.trim()); void refreshSessions(); }
  }
  async function renameSession(id: string, title: string) {
    setSessions(ss => ss.map(s => s.id === id ? { ...s, title } : s));
    try { await claudeApi.rename(id, title); } catch (e: any) { setErro(e.message); } finally { void refreshSessions(); }
  }
  async function archiveSession(id: string, archived: boolean) {
    // Arquivou: some das abas (pedido do Danilo 01/10/2026). Desarquivar não abre sozinho; quem abre é o clique.
    if (archived) closeTab(id);
    setSessions(ss => ss.map(s => s.id === id ? { ...s, archived } : s));
    try { await claudeApi.archive(id, archived); } catch (e: any) { setErro(e.message); } finally { void refreshSessions(); }
  }
  async function togglePrivate(id: string, priv: boolean) {
    setSessions(ss => ss.map(s => s.id === id ? { ...s, private: priv } : s));
    try { await claudeApi.private(id, priv); } catch (e: any) { setErro(e.message); } finally { void refreshSessions(); }
  }
  async function deleteSession(id: string) {
    const s = sessions.find(x => x.id === id);
    if (!(await confirmar(`Excluir "${s?.title ?? 'sessão'}" definitivamente? A conversa some e não dá para desfazer.`, { perigo: true }))) return;
    closeTab(id);
    setSessions(ss => ss.filter(x => x.id !== id));
    try { await claudeApi.remove(id); } catch (e: any) { setErro(e.message); } finally { void refreshSessions(); }
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

  const openIds = useMemo(() => new Set(tabs.map(t => t.id)), [tabs]);
  const summaries = useMemo(() => sessions.map(s => ({ ...toSummary(s, projects), open: openIds.has(s.id) })), [sessions, projects, openIds]);
  const title = activeTab?.draft ? 'Nova sessão' : (active?.title ?? (activeId ? 'Sessão' : 'Claude'));
  // Mostra o que vale pra PRÓXIMA mensagem: o override escolhido no seletor, se houver; senão o
  // modelo resolvido da sessão (gravado no system/init do SDK), como antes.
  const modelLabel = MODEL_LABEL[model === 'default' ? 'opus' : model];
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
  // Deixa o estado do preview público pronto antes de abrir o menu ⋮.
  useEffect(() => { if (activeProject) void prefetchPreviewPublico(activeProject.id); }, [activeProject?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Projeto pra pré-selecionar no editor de "Regras de permissão" ao abrir — sessão de verdade: o
  // projeto dela (via `project_slug`); aba rascunho: o projeto escolhido no seletor do compositor.
  // `undefined` quando nada resolve (ex.: nenhuma aba aberta) — o painel cai no 1º projeto da lista.
  const permRulesProjectId = activeTab?.draft ? (activeTab.projectId ?? undefined) : (active ? projects.find(p => p.slug === active.project_slug)?.id : undefined);

  return (
    <div className={`cc ${sideHidden ? 'is-side-hidden' : ''}`}>
      <Sidebar tabOrder={tabs.map(t => t.id)} onMoveTab={moveTab} sessions={summaries} meId={meId} usage={usage} modelAttribution={modelAttribution} activeId={activeId} loading={sessionsLoading} folders={groups} onSelect={open} onNew={newSession} onRename={renameSession} onArchive={archiveSession} onDelete={deleteSession}
        onCreateGroup={createGroup} onRenameGroup={renameGroup} onDeleteGroup={deleteGroup} onMoveToGroup={moveToGroup} />
      <main className="cc-main">
        <div className="cc-tabs">
          <div className="cc-tabs-scroll">
          {tabs.map(t => {
            const s = sessions.find(x => x.id === t.id);
            // Projeto só na exibição da aba ("[Orion] Título"): não faz parte do título salvo, então renomear não mexe nele.
            const label = t.draft ? 'Nova sessão' : (s ? `[${s.project_name ?? 'Neutro'}] ${s.title}` : '…');
            // Tooltip da aba: título · projeto · criador — destino do que a barra de título removida
            // mostrava (ver PARIDADE-seletor.md; a extensão real não tem barra entre as abas e o chat).
            const tip = s ? [s.title, s.project_name, s.user_name].filter(Boolean).join(' · ') : label;
            return (
              <div key={t.id} data-tab-id={t.id} className={`cc-tab ${t.id === activeId ? 'is-active' : ''} ${dragOverTab === t.id ? (dragAfter ? 'is-drop-after' : 'is-drop-before') : ''}`} onClick={() => setActiveId(t.id)} title={tip}
                draggable
                onDragStart={e => { dragTabRef.current = t.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-orion-tab', t.id); }}
                onDragOver={e => { if (!dragTabRef.current) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; dragOverTabAt(t.id); }}
                onDragLeave={() => setDragOverTab(d => d === t.id ? null : d)}
                onDrop={e => { e.preventDefault(); dropTab(t.id); }}
                onDragEnd={() => { dragTabRef.current = null; setDragOverTab(null); }}>
                {/* Foto de quem criou a sessão no lugar do asterisco do Claude; aba rascunho é minha. */}
                {s ? <Avatar id={s.user_id} name={s.user_name} />
                  : t.draft && meId !== undefined ? <Avatar id={meId} name={meName} />
                  : <span className="cc-tab-spark">✳</span>}
                {/* Dot de status na própria aba — outro destino da barra removida (o texto de status ficava lá). */}
                {s && <span className={`cc-dot cc-tab-dot is-${toSummary(s, projects).status}`} />}
                <span className="cc-tab-title">{label}</span>
                <button className="cc-tab-x" onClick={e => { e.stopPropagation(); closeTab(t.id); }} title="Fechar aba"><X size={11} /></button>
              </div>
            );
          })}
          </div>
          <span className="cc-tab-actions">
            <button className="cc-icon" title="Aba anterior" disabled={tabs.length < 2} onClick={() => stepTab(-1)}><ArrowLeft size={14} /></button>
            <button className="cc-icon" title="Próxima aba" disabled={tabs.length < 2} onClick={() => stepTab(1)}><ArrowRight size={14} /></button>
            {/* Trocado de lugar com o ⋮ (pedido do Danilo, 04/10/2026): este botão entra na barra,
                o ⋮ vai pro canto fixo onde ele estava (ver cc-smenu-corner em claude.css/App.tsx). */}
            <button className={`cc-icon ${painelOpen ? 'is-on' : ''}`} title={painelOpen ? 'Fechar o Orion' : 'Abrir o Orion'} onClick={togglePainel}><IcoPainelDireito open={painelOpen} size={14} /></button>
            {/* Olhinho (pedido do Danilo, 09/10/2026): sessão privada, só quem criou e o admin veem.
                Canto superior direito, fixo, ao lado do menu ⋮ (mesma faixa cc-smenu-corner). */}
            {active && !isDraft(activeId!) && (active.user_id === meId || role === 'owner') && (
              <button type="button" className="cc-icon cc-eye-corner" onClick={() => togglePrivate(active.id, !active.private)}
                title={active.private ? 'Sessão privada: só você (e o admin) veem. Clique para tornar pública.' : 'Tornar esta sessão privada: só você (e o admin) vão vê-la na lista'}>
                {active.private ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            )}
            {/* Tudo o mais fica no menu ⋮ (preview do usuário, agentes, renomear, parar, skills, permissões, plugins). */}
            <SessionMenu
              corner
              topo={activeProject ? <PreviewPublico projectId={activeProject.id} /> : undefined}
              sessao={[
                activeProject && !activeProject.temPreview
                  ? { icon: <Eye size={15} />, label: 'Ver produção', desc: 'Projeto estático, sem preview ao vivo', hidden: !activeProject.productionUrl, onClick: () => window.open(activeProject.productionUrl!, '_blank') }
                  : { icon: <Eye size={15} />, label: 'Preview do usuário', desc: 'Seu endereço pessoal, mostrando a sua worktree neste projeto', disabled: !activeId || isDraft(activeId), onClick: () => window.open(`/api/preview/open?session=${encodeURIComponent(activeId!)}`, '_blank') },
                { icon: <Filter size={15} />, label: compacto ? 'Mostrar os passos' : 'Só pergunta e resposta', desc: compacto ? 'Volta a mostrar ferramentas (Bash, Edit…) e pensamento' : 'Esconde ferramentas e pensamento; fica só sua mensagem e a resposta final', onClick: toggleCompacto },
                { icon: <AgentMapIcon size={15} />, label: 'Mapa de agentes', desc: 'Subagentes desta sessão, tempo e tokens', disabled: !activeId, onClick: () => setAgentMapOpen(true) },
                { icon: <Pencil size={15} />, label: 'Renomear sessão', desc: 'Troca o nome que aparece na aba e na lista', disabled: !activeId || isDraft(activeId), onClick: rename },
                { icon: <Power size={15} />, label: 'Parar o Claude', desc: 'Interrompe o que ele está fazendo agora', hidden: !running, danger: true, onClick: stop },
              ]}
/>
          </span>
        </div>
        {login && !login.logged_in && (
          <div className="cc-banner">
            O Claude não está logado na c3 como <span className="cc-mono">{login.linux_user ?? 'danilo'}</span>. Cole o token do Max em <b>Configurações</b>, ou no seu Mac: <span className="cc-mono">ssh c3</span> e depois <span className="cc-mono">sudo -iu danilo claude</span>.
          </div>
        )}
        {/*
          Barra de título REMOVIDA (pedido do Bayerl 29/09/2026): a extensão real não tem nenhuma
          faixa entre as abas e o chat. Nada do que ela mostrava se perdeu (ver PARIDADE-seletor.md):
          título/projeto/criador viraram tooltip da aba; status virou dot na aba (e já existia na
          lateral); turnos e tokens já aparecem na linha "Concluído · … · N turnos · tokens" de cada result
          na timeline e agregados na seção Conta e Uso; projeto/cwd seguem na barra de status embaixo.
        */}
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
        {/* `.cc-chat` = `.chatContainer_07S1Yg` real: âncora `position:relative` pras duas camadas
            absolutas por cima da área que rola (`.cc-fade`/`.cc-float` abaixo) — ver claude.css e
            PARIDADE.md "Layout flutuante do composer". */}
        <div className="cc-chat">
          <div className="cc-scroll" ref={scrollRef}>
            {/* Dentro do .cc-scroll (pedido do Danilo 02/10/2026): rola junto e some com a conversa, não fica fixo. */}
            {active && activeWorktreeName && (
              <div className="cc-worktree-banner">
                <span className="cc-worktree-banner-left">
                  <GitBranch size={14} /> Esta sessão está no worktree <span className="cc-worktree-banner-name">{activeWorktreeName}</span>
                </span>
              </div>
            )}
            {/* F5: antes das sessões/abas voltarem do servidor, `activeId` começa null — sem este
                `sessionsLoading`, a tela "nenhuma sessão" pisca ali por um instante antes da aba de
                verdade abrir, parecendo bug (achado pelo Danilo, 04/10/2026). Mesmo "pontinho"
                pulsando de `carregandoSessao`, só que cobrindo a tela toda enquanto não se sabe
                ainda se tem aba pra restaurar. */}
            {!activeId && sessionsLoading && <div className="cc-loading" role="status" aria-label="Carregando"><span /><span /><span /></div>}
            {!activeId && !sessionsLoading && (
              <div className="cc-empty-state">
                <div className="cc-brand-big">✳ Claude Code</div>
                <p>Escolha uma sessão à esquerda ou clique em <b>Nova sessão</b>.</p>
                <p className="cc-muted">Cada sessão roda na c3, na pasta do projeto, com o login único do Max. Fechar o navegador não interrompe nada.</p>
              </div>
            )}
            {activeTab?.draft && activeTab.projectId === undefined && (
              <div className="cc-pick-project">
                <p className="cc-muted">Em qual projeto é esta sessão?</p>
                <div className="cc-pick-list">
                  {[...projects].sort((a, b) => a.slug === 'orion' ? -1 : b.slug === 'orion' ? 1 : a.name.localeCompare(b.name, 'pt-BR')).map(p => <button key={p.id} type="button" onClick={() => escolherProjeto(p.id)}>{p.name}</button>)}
                  <button type="button" className="is-neutro" onClick={() => escolherProjeto(null)}>Neutro<span>sem projeto, perguntas gerais</span></button>
                </div>
              </div>
            )}
            {carregandoSessao && <div className="cc-loading" role="status" aria-label="Carregando sessão"><span /><span /><span /></div>}
            {activeId && !carregandoSessao && <Timeline events={events} onDecide={decide} agentTasks={agentTasks} onResend={resend} compacto={compacto} />}
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
              {awayFromBottom && (
                <button type="button" className="cc-jump" title="Ir para o fim" aria-label="Ir para o fim"
                  onClick={() => {
                    atBottomRef.current = true; setAwayFromBottom(false); toBottom();
                    // Repete nos quadros seguintes: o composer encolhe quando o botão some e o conteúdo
                    // pode crescer depois do primeiro pulo, que antes parava em ~99%.
                    requestAnimationFrame(() => { toBottom(); requestAnimationFrame(toBottom); });
                    setTimeout(toBottom, 200);
                  }}>
                  <SendArrow className="cc-jump-icon" />
                </button>
              )}
              <PermissionDock event={dockedPermission} onDecide={decide} />
              <Composer onSend={send} onStop={stop} running={running} mode={mode} onMode={handleMode} effort={effort} onEffort={handleEffort}
                fastMode={state.fastMode}
                model={model} onModel={handleModel} modelLabel={modelLabel} history={history} commands={state.commands} sessionId={activeId}
                projects={activeTab?.draft && activeTab.projectId !== undefined ? projects : undefined} projectId={activeTab?.projectId}
                onProject={escolherProjeto}
                agents={agentsPill} onAgents={() => setAgentMapOpen(true)}
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
      <BuildStyleDialog open={buildStyleOpen} onClose={() => setBuildStyleOpen(false)} existing={styles}
        canSwitchNow={!!activeId && !isDraft(activeId)}
        onSaved={(slug, switchNow) => { void refreshStyles(); if (switchNow) handleOutputStyle(slug); }} />
    </div>
  );
}
