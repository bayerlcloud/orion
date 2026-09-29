import { useEffect, useRef, useState } from 'react';
import type { AgentTask } from './types';
import { agentTaskDuration, formatAgentDuration, formatTokens, taskStatusLabel } from './mapper';
import { X } from './icons';

type SessionStatus = 'running' | 'waiting' | 'idle' | 'error';

/**
 * "Mapa de agentes" — pedido ao vivo do Bayerl 28/09/2026, mostrando um print do painel "Agent map"
 * desta MESMA extensão (Claude Code / "claude do antigravity") e pedindo o equivalente no Orion:
 * "essa parte de multi agentes igual aqui o claude code do antigravity coloca no claude do orion v2".
 * Retoma explicitamente o que a rodada de Task/Agent (ver `taskStatusLabel` em mapper.ts) tinha
 * deixado de fora de propósito: "a extensão tem telemetria ao vivo (tempo decorrido, tokens, contagem
 * de tool calls do subagente — `subagentRow` real, exigiria stream de progresso por tarefa que o
 * Orion não tem hoje)".
 *
 * Achado (28/09/2026, investigação completa em PARIDADE.md — não um "não existe", como a rodada
 * anterior presumia com cautela): o painel "Agent map" É REAL, confirmado lendo o webview decompilado
 * da extensão (v2.1.282 e v2.1.283, `/srv/orion-reference/webview/index.js` e
 * `/srv/orion-reference-2.1.283/webview/index.js`) função por função —
 * `title:"Agent map"`, subtítulo "{N} agent(s) · click an agent for details", gatilho um "pill" com
 * ícone+dot+contagem no rodapé do compositor (`agentsPill`), árvore raiz→agentes com linhas de
 * conexão em CSS puro (`.tree`/`.node`/`.children`/`.child`, via `::before`/`::after` absolutamente
 * posicionados — a MESMA técnica usada aqui, sem nenhuma lib de grafo nova). Duração/tokens de cada
 * agente vêm de um campo REAL do SDK (`tool_use_result`, ver `parseAgentTaskUsage` em mapper.ts) — não
 * fabricados; ausentes na maioria dos casos hoje (ver PARIDADE.md pra o porquê e a lacuna de
 * verificação em produção, já que este ambiente não tem acesso a credenciais de banco).
 *
 * Layout/interação: raiz (esta sessão: título, dot de atividade, modelo + tokens já gastos nesta
 * sessão) à esquerda, um card por subagente `Task` à direita, ligados por conectores CSS (mesma
 * técnica real: `::before`/`::after` em vez de SVG/lib). Sem view de detalhe por agente ao clicar —
 * diferente da extensão real, que abre um painel próprio por agente (histórico completo do
 * subagente) — decisão de escopo: o prompt/resultado de cada `Task` já é visível na timeline
 * principal (`TaskAgent` em Timeline.tsx, existente); duplicar aqui seria "over-engineering" pro que
 * foi pedido (um mapa/visão geral, não um visualizador de transcript por agente).
 *
 * Esc + fechar no backdrop: mesmo padrão já usado por `Lightbox.tsx` (Esc capturado com
 * `capture:true`/`stopImmediatePropagation` pra não vazar pro handler de Esc do compositor). SEM
 * `createPortal` (diferente do Lightbox) — de propósito: as cores daqui usam `var(--cc-*)` pra
 * respeitar o tema claro/escuro (`claude.css`, bloco `:root[data-theme="light"] .cc`), e essas
 * variáveis são declaradas SÓ no seletor `.cc` (não em `:root`) — um nó portado pra `document.body`
 * (irmão de `#root`, nunca descendente de `.cc`) não as herdaria, caindo pro valor inicial de cada
 * propriedade (fundo/borda transparentes, cor herdada do body) em vez do tema de verdade. Confirmado
 * lendo `web/index.html`/`main.tsx` (a árvore React inteira mora dentro de `#root`) e `claude.css`
 * (`--cc-bg` etc. só em `.cc {...}`, nunca em `:root`). `position:fixed` não precisa de portal pra
 * cobrir a viewport inteira — continua funcionando igual, mesmo renderizado como filho comum dentro
 * de `.cc` (nenhum ancestral daqui tem `transform`/`filter`/`perspective`, que criaria um novo
 * containing block e prenderia o `fixed` — conferido no `claude.css` inteiro). Renderizado por
 * `ClaudePage.tsx` como irmão de `<Sidebar>`/`<main>`, dentro do MESMO `.cc`.
 */
export type AgentMapProps = {
  open: boolean;
  onClose: () => void;
  sessionTitle: string;
  sessionStatus: SessionStatus;
  modelLabel?: string;
  sessionTokens?: number;
  tasks: AgentTask[];
};

function agentDotClass(status: AgentTask['status']): string {
  switch (status) {
    case 'success': return 'is-success';
    case 'failure': return 'is-failure';
    case 'warning': return 'is-warning';
    case 'waiting': return 'is-waiting';
    default: return 'is-running';
  }
}

/** Meta de um card de agente: "duração · N tokens" quando há dado real pra mostrar; senão, o rótulo
 * de status (`taskStatusLabel`, mesmo texto já usado na timeline principal) — nunca um "—" vazio nem
 * um número inventado. */
function agentMeta(task: AgentTask, now: number): string {
  const duration = agentTaskDuration(task, now);
  const tokens = task.usage?.totalTokens;
  const parts = [
    duration !== undefined ? formatAgentDuration(duration) : undefined,
    tokens !== undefined && tokens > 0 ? `${formatTokens(tokens)} tokens` : undefined,
  ].filter((x): x is string => x !== undefined);
  return parts.length ? parts.join(' · ') : taskStatusLabel(task.status);
}

function AgentCard({ task, now }: { task: AgentTask; now: number }) {
  return (
    <div className="cc-agentmap-child">
      <div className="cc-agentmap-node">
        <div className="cc-agentmap-card" title={task.description} data-agent-status={task.status}>
          <div className="cc-agentmap-row-title">
            <span className={`cc-agentmap-dot ${agentDotClass(task.status)}`} aria-hidden="true" />
            <span className="cc-agentmap-name cc-clamp2">{task.description}</span>
          </div>
          <div className="cc-agentmap-meta">
            {task.subagentType && <span className="cc-task-type">{task.subagentType}</span>}
            <span>{agentMeta(task, now)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AgentMap({ open, onClose, sessionTitle, sessionStatus, modelLabel, sessionTokens, tasks }: AgentMapProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      onClose();
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  // Tique de 1s só enquanto o painel está aberto E algo ainda está rodando (sessão ou algum
  // subagente) — sem isso, a duração "ao vivo" (agentTaskDuration com status running/waiting) nunca
  // avançaria na tela. Parado (sem timer) assim que tudo termina ou o painel fecha.
  useEffect(() => {
    if (!open) return;
    const live = sessionStatus === 'running' || sessionStatus === 'waiting' || tasks.some(t => t.status === 'running' || t.status === 'waiting');
    if (!live) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open, sessionStatus, tasks]);

  if (!open) return null;

  const sessionBusy = sessionStatus === 'running' || sessionStatus === 'waiting';
  const sessionMeta = [
    modelLabel,
    sessionTokens !== undefined && sessionTokens > 0 ? `${formatTokens(sessionTokens)} tokens nesta sessão` : undefined,
  ].filter((x): x is string => x !== undefined).join(' · ');

  return (
    <div className="cc-agentmap-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cc-agentmap" role="dialog" aria-label="Mapa de agentes" tabIndex={-1}>
        <div className="cc-agentmap-head">
          <div className="cc-agentmap-headtext">
            <div className="cc-agentmap-title">Mapa de agentes</div>
            <div className="cc-agentmap-subtitle">{tasks.length} {tasks.length === 1 ? 'agente' : 'agentes'} nesta sessão</div>
          </div>
          <button ref={closeRef} type="button" className="cc-icon" onClick={onClose} title="Fechar (Esc)"><X size={14} /></button>
        </div>
        <div className="cc-agentmap-body">
          <div className="cc-agentmap-tree">
            <div className="cc-agentmap-node">
              <div className="cc-agentmap-card is-root" title={sessionTitle}>
                <div className="cc-agentmap-row-title">
                  <span className={`cc-agentmap-dot ${sessionBusy ? 'is-running' : sessionStatus === 'error' ? 'is-failure' : 'is-idle'}`} aria-hidden="true" />
                  <span className="cc-agentmap-name cc-clamp2">{sessionTitle}</span>
                </div>
                {sessionMeta && <div className="cc-agentmap-meta">{sessionMeta}</div>}
              </div>
              {tasks.length > 0 && (
                <div className="cc-agentmap-children">
                  {tasks.map(t => <AgentCard key={t.toolUseId} task={t} now={now} />)}
                </div>
              )}
            </div>
          </div>
          {tasks.length === 0 && (
            <div className="cc-agentmap-empty">Nenhum subagente (ferramenta <span className="cc-mono">Task</span>) disparado nesta sessão ainda.</div>
          )}
        </div>
      </div>
    </div>
  );
}
