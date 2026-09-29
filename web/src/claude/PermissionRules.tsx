import { useEffect, useState } from 'react';
import type { Project, PermissionBehavior, PermissionScope, PermissionRuleSet } from './api';
import { claudeApi } from './api';
import { X, Plus, Pencil } from './icons';

/**
 * Editor de regras de permissão (allow/deny/ask) — "Aba Claude". Ver `server/claude/permissionRules.ts`
 * e `web/src/claude/PARIDADE.md` (item 9 da seção 13) pro achado completo lendo a extensão real
 * (`/srv/orion-reference-2.1.283/webview/index.js`, componente `jW0`/painel "Permission rules"):
 * classes `ruleItem/ruleActions/ruleDescription/ruleInput/ruleMain/ruleSource/ruleText/addRuleButton/
 * confirmRule` pertencem TODAS ao mesmo painel real (`var U4={...}_0Reg3g`) — confirmado lendo o
 * componente inteiro, não só os nomes de classe. `confirmRemoveRow/confirmRemoveText`, citados junto
 * na investigação inicial, na verdade pertencem a um componente DIFERENTE e genérico (`var
 * P1={...}_IHCQeQ`, usado pelo painel de servidores MCP pra confirmar remoção de um server) — achado
 * que corrige a suposição inicial; a confirmação de remover REGRA na extensão real usa um overlay
 * próprio (`overlayPanel/overlayTitle/confirmRule/overlayButtons`, texto "Remove {behavior} rule?"),
 * reimplementado aqui como `.cc-permrules-confirm`.
 *
 * Diferenças deliberadas em relação à extensão real (decisões de escopo, ver PARIDADE.md):
 * 1. A extensão fala com a Query AO VIVO de uma sessão (`session.listPermissionRules()`/
 *    `addPermissionRules()`/`removePermissionRule()`) e mostra a UNIÃO de ~10 fontes possíveis
 *    (userSettings/projectSettings/localSettings/policySettings/flagSettings/cliArg/session/command/
 *    toolsNarrowing/mcpServerPolicy/hostCredential), cada uma com sua própria editabilidade. O Orion
 *    lê/escreve os DOIS arquivos que `server/claude/runner.ts` realmente usa
 *    (`settingSources:['user','project']`) direto no disco — mais simples, funciona mesmo sem sessão
 *    ativa (Orion é multi-projeto; nem sempre há uma sessão rodando pro projeto que alguém quer
 *    editar), sem a dança de "pending/unconfirmed" que a extensão precisa pra confirmar que o
 *    processo da Query já releu o arquivo (aqui a escrita já É a verdade).
 * 2. Sem escopo "local" (`.claude/settings.local.json`) — o `Runner` não lê esse arquivo hoje, então
 *    uma regra salva lá nunca teria efeito nenhum; ofertar essa opção seria um cilada silenciosa.
 * 3. Sem as seções "read-only" (session/cliArg/policySettings/...) nem "Workspace directories" da
 *    extensão real — não existem no modelo do Orion (sem CLI flags por sessão, sem camada de política
 *    enterprise configurada, sem "additional directories" pela UI). As duas listas mostradas aqui
 *    (Projeto/Usuário) são sempre 100% editáveis quando `canEdit` é verdadeiro.
 * 4. "Editar" não existe como conceito separado na extensão real (só Add/Remove) — aqui existe como
 *    conveniência (`PUT`, `replaceRule` no servidor: remove a antiga + adiciona a nova numa escrita
 *    só), pedida explicitamente pela tarefa.
 * 5. Confirmação de remoção: pedida explicitamente pela tarefa E confirmada como comportamento real
 *    da extensão (overlay "Remove {behavior} rule?", ver acima) — implementada aqui como
 *    `.cc-permrules-confirm`, mesma mecânica visual do `AgentMap.tsx` (sem `createPortal`, Esc com
 *    capture+stopImmediatePropagation).
 */

const BEHAVIORS: PermissionBehavior[] = ['allow', 'ask', 'deny'];
const BEHAVIOR_LABEL: Record<PermissionBehavior, string> = { allow: 'Permitir', ask: 'Perguntar', deny: 'Negar' };

export type PermissionRulesProps = {
  open: boolean;
  onClose: () => void;
  projects: Project[];
  /** Projeto pré-selecionado ao abrir (da aba/sessão ativa, quando resolvível) — só um valor inicial; o usuário pode trocar dentro do painel. */
  defaultProjectId?: number;
  /** `true` quando `me.role === 'owner'` — só o admin edita o escopo "Usuário" (ver nota de raio de efeito global no servidor). Escopo "Projeto" é sempre editável por qualquer usuário autenticado. */
  canEditUser: boolean;
};

type RuleKey = { behavior: PermissionBehavior; rule: string };
const emptySet = (): PermissionRuleSet => ({ allow: [], ask: [], deny: [] });

export default function PermissionRules({ open, onClose, projects, defaultProjectId, canEditUser }: PermissionRulesProps) {
  const [scope, setScope] = useState<PermissionScope>('project');
  const [projectId, setProjectId] = useState<number | undefined>(defaultProjectId ?? projects[0]?.id);
  const [set, setSet] = useState<PermissionRuleSet>(emptySet());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<PermissionBehavior | null>(null);
  const [newRuleText, setNewRuleText] = useState('');
  const [editing, setEditing] = useState<RuleKey | null>(null);
  const [editText, setEditText] = useState('');
  const [editBehavior, setEditBehavior] = useState<PermissionBehavior>('allow');
  const [removing, setRemoving] = useState<RuleKey | null>(null);
  const [busy, setBusy] = useState(false);

  // Projeto pré-selecionado muda quando a aba/sessão ativa muda por trás do painel fechado — só
  // adota o novo valor default enquanto o painel ainda não foi aberto com um projeto próprio.
  useEffect(() => { if (defaultProjectId !== undefined) setProjectId(defaultProjectId); }, [defaultProjectId]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    if (scope === 'project' && !projectId) { setSet(emptySet()); setError(null); return; }
    setLoading(true); setError(null);
    claudeApi.permissionRules(scope, scope === 'project' ? projectId : undefined)
      .then(r => { if (cancelled) return; setSet({ allow: r.allow, ask: r.ask, deny: r.deny }); if (r.error) setError(r.error); })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, scope, projectId]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      if (removing) { setRemoving(null); return; }
      if (editing) { setEditing(null); return; }
      if (adding) { setAdding(null); return; }
      onClose();
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose, removing, editing, adding]);

  if (!open) return null;

  const canEdit = scope === 'project' ? true : canEditUser;

  async function submitAdd() {
    if (!adding || busy) return;
    const text = newRuleText.trim();
    if (!text) return;
    setBusy(true); setError(null);
    try {
      const r = await claudeApi.addPermissionRule({ scope, projectId: scope === 'project' ? projectId : undefined, behavior: adding, rule: text });
      setSet(r); setAdding(null); setNewRuleText('');
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function submitEdit() {
    if (!editing || busy) return;
    const text = editText.trim();
    if (!text) return;
    setBusy(true); setError(null);
    try {
      const r = await claudeApi.editPermissionRule({
        scope, projectId: scope === 'project' ? projectId : undefined,
        oldBehavior: editing.behavior, oldRule: editing.rule, behavior: editBehavior, rule: text,
      });
      setSet(r); setEditing(null);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function confirmRemove() {
    if (!removing || busy) return;
    setBusy(true); setError(null);
    try {
      const r = await claudeApi.removePermissionRule({ scope, projectId: scope === 'project' ? projectId : undefined, behavior: removing.behavior, rule: removing.rule });
      setSet(r); setRemoving(null);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="cc-permrules-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cc-permrules" role="dialog" aria-label="Regras de permissão">
        <div className="cc-permrules-head">
          <div>
            <div className="cc-permrules-title">Regras de permissão</div>
            <div className="cc-permrules-subtitle">allow / ask / deny por padrão de ferramenta — ex.: <span className="cc-mono">Bash(npm run test:*)</span> ou <span className="cc-mono">WebFetch</span></div>
          </div>
          <button type="button" className="cc-icon" onClick={onClose} title="Fechar (Esc)"><X size={14} /></button>
        </div>

        <div className="cc-permrules-scope">
          <div className="cc-toggle cc-permrules-toggle">
            <button type="button" className={scope === 'project' ? 'is-on' : ''} onClick={() => setScope('project')}>Projeto</button>
            <button type="button" className={scope === 'user' ? 'is-on' : ''} onClick={() => setScope('user')}>Usuário (global)</button>
          </div>
          {scope === 'project' && (
            <select className="cc-pill cc-select" value={projectId ?? ''} onChange={e => setProjectId(Number(e.target.value) || undefined)} title="Projeto">
              {projects.length === 0 && <option value="">Nenhum projeto</option>}
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
        </div>

        {scope === 'user' && (
          <div className="cc-permrules-notice">
            Regras de usuário valem para <b>todos os projetos e usuários</b> do Orion (mesmo login único na c3).
            {!canEditUser && ' Só o admin edita esta lista; você pode ver.'}
          </div>
        )}

        {error && <div className="cc-permrules-error">{error}</div>}
        {loading && <div className="cc-loading"><span className="cc-spinner" /> Carregando regras…</div>}

        {!loading && scope === 'project' && !projectId && (
          <div className="cc-permrules-empty">Escolha um projeto.</div>
        )}

        {!loading && (scope === 'user' || projectId) && (
          <div className="cc-permrules-body">
            {BEHAVIORS.map(b => (
              <div className="cc-permrules-section" key={b}>
                <div className="cc-permrules-section-head">
                  <span>{BEHAVIOR_LABEL[b]} ({set[b].length})</span>
                  {canEdit && (
                    <button type="button" className="cc-permrules-add" onClick={() => { setAdding(b); setNewRuleText(''); setError(null); }}>
                      <Plus size={11} /> Nova regra
                    </button>
                  )}
                </div>
                {set[b].length === 0 && adding !== b && <div className="cc-permrules-empty">Nenhuma regra.</div>}
                {set[b].map(rule => (
                  <div className="cc-permrules-item" key={rule}>
                    <span className="cc-permrules-text cc-mono">{rule}</span>
                    {canEdit && (
                      <span className="cc-permrules-actions">
                        <button type="button" className="cc-icon" title="Editar" onClick={() => { setEditing({ behavior: b, rule }); setEditText(rule); setEditBehavior(b); setError(null); }}><Pencil size={12} /></button>
                        <button type="button" className="cc-icon" title="Remover" onClick={() => { setRemoving({ behavior: b, rule }); setError(null); }}><X size={12} /></button>
                      </span>
                    )}
                  </div>
                ))}
                {adding === b && (
                  <div className="cc-permrules-form">
                    <input
                      autoFocus className="cc-permrules-input" placeholder="Ex.: Bash(npm run test:*)" value={newRuleText}
                      onChange={e => setNewRuleText(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') void submitAdd();
                        if (e.key === 'Escape') { e.stopPropagation(); setAdding(null); }
                      }}
                    />
                    <button type="button" className="cc-btn cc-btn-primary" disabled={busy || !newRuleText.trim()} onClick={() => void submitAdd()}>{busy ? 'Salvando…' : 'Adicionar'}</button>
                    <button type="button" className="cc-btn" onClick={() => setAdding(null)}>Cancelar</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="cc-permrules-footer">
          Regras valem a partir da PRÓXIMA sessão/turno — o Claude só lê o settings.json quando uma sessão começa, nunca no meio de um turno já em andamento.
        </div>

        {editing && (
          <div className="cc-permrules-overlay-inner" onClick={e => { if (e.target === e.currentTarget) setEditing(null); }}>
            <div className="cc-permrules-confirm">
              <div className="cc-permrules-confirm-title">Editar regra</div>
              <input
                className="cc-permrules-input" value={editText} onChange={e => setEditText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void submitEdit(); }} autoFocus
              />
              <select className="cc-pill cc-select" value={editBehavior} onChange={e => setEditBehavior(e.target.value as PermissionBehavior)}>
                {BEHAVIORS.map(b => <option key={b} value={b}>{BEHAVIOR_LABEL[b]}</option>)}
              </select>
              {error && <div className="cc-permrules-error">{error}</div>}
              <div className="cc-permrules-confirm-actions">
                <button type="button" className="cc-btn cc-btn-primary" disabled={busy || !editText.trim()} onClick={() => void submitEdit()}>{busy ? 'Salvando…' : 'Salvar'}</button>
                <button type="button" className="cc-btn" onClick={() => setEditing(null)}>Cancelar</button>
              </div>
            </div>
          </div>
        )}

        {removing && (
          <div className="cc-permrules-overlay-inner" onClick={e => { if (e.target === e.currentTarget) setRemoving(null); }}>
            <div className="cc-permrules-confirm">
              <div className="cc-permrules-confirm-title">Remover regra de {BEHAVIOR_LABEL[removing.behavior].toLowerCase()}?</div>
              <div className="cc-permrules-confirm-rule cc-mono">{removing.rule}</div>
              {error && <div className="cc-permrules-error">{error}</div>}
              <div className="cc-permrules-confirm-actions">
                <button type="button" className="cc-btn cc-btn-primary" disabled={busy} onClick={() => void confirmRemove()}>{busy ? 'Removendo…' : 'Remover'}</button>
                <button type="button" className="cc-btn" onClick={() => setRemoving(null)}>Cancelar</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
