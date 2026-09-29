import { useEffect, useRef, useState } from 'react';
import type { HookEntry, HookListing, SkillEntry } from './types';
import { HOOK_SOURCE_LABEL, SKILL_SOURCE_LABEL } from './types';
import { claudeApi } from './api';
import { groupHooksByEventAndMatcher } from './mapper';
import { X } from './icons';

/**
 * "Aba Claude" — painel de skills + lista de hooks (PARIDADE.md, seção 16; item 10/11 da seção 13).
 * Mesmo padrão visual de diálogo que `AgentMap.tsx` (overlay + painel centralizado, Esc fecha,
 * sem `createPortal` pelo mesmo motivo documentado lá: as variáveis `--cc-*` de tema só existem sob
 * `.cc`, um nó portado pra `document.body` não as herdaria).
 *
 * DUAS abas internas, um só gatilho — o pedido original descreveu "uma tela (painel/modal) que
 * lista (a) hooks ... (b) skills", não dois diálogos separados como a extensão real tem (`vH0` pros
 * hooks, outro componente pras skills, cada um com seu próprio gatilho).
 *
 * Hooks: SÓ LEITURA — decisão de segurança documentada a fundo em `server/claude/hooks.ts` (sem
 * canal de edição seguro equivalente ao da extensão real; um hook `command` é shell arbitrário que
 * passaria a rodar sozinho em toda sessão futura do projeto — risco real de escalação numa
 * ferramenta multi-usuário). Skills: habilitar/desabilitar é seguro (filtro de contexto do SDK,
 * `Options.skills`, nunca escreve `settings.json`/roda comando) — vai além de só leitura.
 */
export type SkillsHooksPanelProps = {
  open: boolean;
  onClose: () => void;
  projectId: number | null;
  projectLabel?: string;
};

type Tab = 'hooks' | 'skills';

function HookRow({ hook }: { hook: HookEntry }) {
  return (
    <div className="cc-hook-row">
      <span className="cc-hook-type">{hook.type}</span>
      <span className="cc-hook-desc cc-mono">{hook.description || '—'}</span>
      {hook.disabled && <span className="cc-hook-badge is-disabled">Desligado</span>}
      {typeof hook.timeout === 'number' && <span className="cc-hook-badge">{hook.timeout}s</span>}
      <span className="cc-hook-badge is-source">{HOOK_SOURCE_LABEL[hook.source]}</span>
    </div>
  );
}

function HooksTab({ listing, loading, error }: { listing: HookListing | null; loading: boolean; error: string | null }) {
  if (loading) return <div className="cc-skillshooks-empty">Carregando hooks…</div>;
  if (error) return <div className="cc-banner">{error}</div>;
  if (!listing) return null;
  const groups = groupHooksByEventAndMatcher(listing.hooks);
  const localOnly = listing.hooks.some(h => h.source === 'local');
  return (
    <>
      {listing.disableAllHooks && (
        <div className="cc-banner">Um dos arquivos de settings tem <span className="cc-mono">disableAllHooks: true</span> — todos os hooks abaixo estão desligados nesta sessão.</div>
      )}
      {listing.errors.length > 0 && (
        <div className="cc-banner">
          {listing.errors.length === 1 ? 'Um arquivo de settings' : `${listing.errors.length} arquivos de settings`} não pôde{listing.errors.length === 1 ? '' : 'ram'} ser lido{listing.errors.length === 1 ? '' : 's'} (JSON inválido) — hooks de lá não aparecem aqui:
          {' '}{listing.errors.map(e => e.file).join(', ')}
        </div>
      )}
      {localOnly && (
        <div className="cc-banner">Hooks de <span className="cc-mono">.claude/settings.local.json</span> (Local) existem, mas as sessões do Orion hoje não carregam essa fonte (<span className="cc-mono">settingSources: ['user','project']</span> em <span className="cc-mono">runner.ts</span>) — listados aqui só como informação.</div>
      )}
      {groups.length === 0 && (
        <div className="cc-skillshooks-empty">
          <p>Nenhum hook configurado.</p>
          <p className="cc-muted">Hooks rodam comandos, prompts ou chamadas HTTP em resposta a eventos do Claude Code (uso de ferramenta, envio de prompt, etc.). Configure em <span className="cc-mono">.claude/settings.json</span>.</p>
        </div>
      )}
      {groups.map(g => (
        <div key={g.event} className="cc-hook-event">
          <div className="cc-hook-event-head"><span className="cc-hook-event-name">{g.event}</span><span className="cc-hook-event-count">{g.count}</span></div>
          {g.matchers.map(m => (
            <div key={m.matcher || '(all)'}>
              {(g.matchers.length > 1 || m.matcher) && (
                <div className="cc-hook-matcher">Matcher: <span className="cc-mono">{m.matcher || '(todas)'}</span></div>
              )}
              {m.hooks.map((h, i) => <HookRow key={`${h.source}:${h.event}:${h.matcher}:${i}`} hook={h} />)}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

function SkillRow({ skill, saving, onToggle }: { skill: SkillEntry; saving: boolean; onToggle: () => void }) {
  return (
    <div className="cc-skill-row">
      <div className="cc-skill-main">
        <div className="cc-skill-name">{skill.name}</div>
        {skill.description && <div className="cc-skill-desc">{skill.description}</div>}
      </div>
      <span className="cc-hook-badge is-source">{SKILL_SOURCE_LABEL[skill.source]}</span>
      <button type="button" className={`cc-skill-toggle ${skill.enabled ? 'is-on' : 'is-off'}`} disabled={saving} onClick={onToggle} title={skill.enabled ? 'Clique para desabilitar' : 'Clique para habilitar'}>
        {saving ? 'Salvando…' : skill.enabled ? 'Habilitada' : 'Desabilitada'}
      </button>
    </div>
  );
}

function SkillsTab({ skills, loading, error, saving, onToggle }: { skills: SkillEntry[] | null; loading: boolean; error: string | null; saving: string | null; onToggle: (name: string, enabled: boolean) => void }) {
  if (loading) return <div className="cc-skillshooks-empty">Carregando skills…</div>;
  if (error) return <div className="cc-banner">{error}</div>;
  if (!skills) return null;
  if (skills.length === 0) {
    return (
      <div className="cc-skillshooks-empty">
        <p>Nenhuma skill disponível pra este projeto.</p>
        <p className="cc-muted">Skills vêm de <span className="cc-mono">.claude/skills/&lt;nome&gt;/SKILL.md</span> no projeto ou no usuário do servidor.</p>
      </div>
    );
  }
  return <>{skills.map(s => <SkillRow key={`${s.source}:${s.name}`} skill={s} saving={saving === s.name} onToggle={() => onToggle(s.name, !s.enabled)} />)}</>;
}

export default function SkillsHooksPanel({ open, onClose, projectId, projectLabel }: SkillsHooksPanelProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [tab, setTab] = useState<Tab>('hooks');
  const [hookListing, setHookListing] = useState<HookListing | null>(null);
  const [hooksLoading, setHooksLoading] = useState(false);
  const [hooksError, setHooksError] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillEntry[] | null>(null);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [savingSkill, setSavingSkill] = useState<string | null>(null);

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

  // Recarrega hooks/skills toda vez que o painel abre (nunca em cache: ambos podem mudar por fora,
  // ex. alguém editando settings.json direto ou uma skill nova sendo adicionada ao projeto).
  useEffect(() => {
    if (!open || projectId == null) return;
    let cancelled = false;
    setHooksLoading(true); setHooksError(null);
    claudeApi.hooks(projectId)
      .then(listing => { if (!cancelled) setHookListing(listing); })
      .catch((e: Error) => { if (!cancelled) setHooksError(e.message || 'falha ao carregar hooks'); })
      .finally(() => { if (!cancelled) setHooksLoading(false); });
    setSkillsLoading(true); setSkillsError(null);
    claudeApi.skills(projectId)
      .then(r => { if (!cancelled) setSkills(r.skills); })
      .catch((e: Error) => { if (!cancelled) setSkillsError(e.message || 'falha ao carregar skills'); })
      .finally(() => { if (!cancelled) setSkillsLoading(false); });
    return () => { cancelled = true; };
  }, [open, projectId]);

  async function toggleSkill(name: string, enabled: boolean) {
    if (projectId == null) return;
    setSavingSkill(name);
    try {
      await claudeApi.setSkillEnabled(projectId, name, enabled);
      setSkills(rows => rows && rows.map(s => s.name === name ? { ...s, enabled } : s));
    } catch (e) {
      setSkillsError(e instanceof Error ? e.message : 'falha ao salvar');
    } finally {
      setSavingSkill(null);
    }
  }

  if (!open) return null;

  return (
    <div className="cc-agentmap-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cc-agentmap cc-skillshooks" role="dialog" aria-label="Skills e hooks" tabIndex={-1}>
        <div className="cc-agentmap-head">
          <div className="cc-agentmap-headtext">
            <div className="cc-agentmap-title">Skills e hooks</div>
            <div className="cc-agentmap-subtitle">{projectLabel ? `Projeto: ${projectLabel}` : 'Sem projeto associado a esta sessão'}</div>
          </div>
          <button ref={closeRef} type="button" className="cc-icon" onClick={onClose} title="Fechar (Esc)"><X size={14} /></button>
        </div>
        <div className="cc-skillshooks-tabs">
          <button type="button" className={`cc-skillshooks-tab ${tab === 'hooks' ? 'is-active' : ''}`} onClick={() => setTab('hooks')}>
            Hooks{hookListing ? ` (${hookListing.hooks.length})` : ''}
          </button>
          <button type="button" className={`cc-skillshooks-tab ${tab === 'skills' ? 'is-active' : ''}`} onClick={() => setTab('skills')}>
            Skills{skills ? ` (${skills.length})` : ''}
          </button>
        </div>
        <div className="cc-agentmap-body cc-skillshooks-body">
          {projectId == null ? (
            <div className="cc-skillshooks-empty">Esta sessão não está associada a um projeto — sem `.claude/` pra ler hooks/skills.</div>
          ) : tab === 'hooks' ? (
            <HooksTab listing={hookListing} loading={hooksLoading} error={hooksError} />
          ) : (
            <SkillsTab skills={skills} loading={skillsLoading} error={skillsError} saving={savingSkill} onToggle={toggleSkill} />
          )}
        </div>
      </div>
    </div>
  );
}
