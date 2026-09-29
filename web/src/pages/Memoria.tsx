import { useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import { api, type User } from '../api';
import {
  MAX_KEYWORDS,
  NIVEL_OPTIONS,
  NOTA_MAX,
  NOTA_MIN,
  NOTA_INICIAL,
  SUMMARY_MAX,
  colorVar,
  fmtDate,
  fmtDateTime,
  nivelBanner,
  nivelEditavel,
  nivelLabel,
  truncate,
} from './memoriaUtils';
import './memoria.css';

type ListItem = {
  id: number;
  code: string;
  title: string;
  summary: string;
  level: number;
  nota: number | null;
  keywords: string[];
  scope_project_id: number | null;
  scope_user_id: number | null;
  project_name: string | null;
  user_name: string | null;
  created_at: string;
  last_accessed_at: string | null;
};

type Memory = ListItem & {
  body_md: string;
  rewritable: boolean;
  updated_at: string;
  last_accessed_session: string | null;
  last_accessed_reason: string | null;
  last_analyzed_at: string | null;
  last_rewritten_at: string | null;
  last_decay_at: string | null;
};

type Meta = { projects: { id: number; name: string }[]; users: { id: number; name: string }[] };
type Toast = { kind: 'ok' | 'bad'; text: string } | null;
type NivelFilter = '' | '0' | '1' | '2' | '3' | '4';
type ScopeFilter = '' | 'universais' | 'projeto' | 'usuario';

const NIVEL_CHIPS: { key: NivelFilter; label: string }[] = [
  { key: '', label: 'Todas' },
  { key: '0', label: '0 Constituição' },
  { key: '1', label: '1 Automática' },
  { key: '2', label: '2 Regra' },
  { key: '3', label: '3 Decisão' },
  { key: '4', label: '4 Micro-fato' },
];
const SCOPE_CHIPS: { key: ScopeFilter; label: string }[] = [
  { key: '', label: 'Qualquer escopo' },
  { key: 'universais', label: 'Universais' },
  { key: 'projeto', label: 'Projeto' },
  { key: 'usuario', label: 'Usuário' },
];

function Selo({ level, nota }: { level: number; nota: number | null }) {
  return (
    <span className="mem-selo-linha">
      <span className="mem-badge" style={{ background: colorVar(level) }}>
        {nivelLabel(level)}
      </span>
      {level === 4 && nota != null && (
        <span className={`mem-nota ${nota === NOTA_MAX ? 'is-promo' : ''}`}>
          nota {nota}/{NOTA_MAX}
          {nota === NOTA_MAX ? ' · candidata a promoção' : ''}
        </span>
      )}
    </span>
  );
}

export default function Memoria({ user }: { user: User }) {
  const [list, setList] = useState<ListItem[]>([]);
  const [meta, setMeta] = useState<Meta>({ projects: [], users: [] });
  const [q, setQ] = useState('');
  const [nivelFilter, setNivelFilter] = useState<NivelFilter>('');
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Memory | null>(null);
  const [bodyMode, setBodyMode] = useState<'ler' | 'editar'>('ler');
  const [kw, setKw] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [erro, setErro] = useState('');
  const [syncProj, setSyncProj] = useState<number | null>(null);
  const readerRef = useRef<HTMLDivElement>(null);

  async function loadList() {
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (nivelFilter !== '') params.set('level', nivelFilter);
    if (scopeFilter) params.set('scope', scopeFilter);
    try {
      const r = await api<{ memories: ListItem[] }>(`/api/memories?${params.toString()}`);
      setList(r.memories);
    } catch (e: any) {
      setErro(e.message);
    }
  }

  useEffect(() => {
    api<Meta>('/api/memories/meta').then(m => { setMeta(m); setSyncProj(p => p ?? m.projects[0]?.id ?? null); }).catch(() => {});
  }, []);

  // Busca com pequeno atraso; filtros mudam na hora.
  useEffect(() => {
    const t = setTimeout(loadList, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, nivelFilter, scopeFilter]);

  async function abrir(id: number, scroll = false) {
    setErro('');
    try {
      const r = await api<{ memory: Memory }>(`/api/memories/${id}`);
      setSelectedId(id);
      setDraft(r.memory);
      setBodyMode('ler');
      setKw('');
      if (scroll && window.innerWidth < 760) {
        setTimeout(() => readerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 40);
      }
    } catch (e: any) {
      setErro(e.message);
    }
  }

  async function nova() {
    setBusy(true);
    setErro('');
    try {
      const r = await api<{ memory: Memory }>('/api/memories', {
        method: 'POST',
        body: JSON.stringify({ title: 'Nova memória', level: 4 }),
      });
      await loadList();
      setSelectedId(r.memory.id);
      setDraft(r.memory);
      setBodyMode('editar');
      if (window.innerWidth < 760) setTimeout(() => readerRef.current?.scrollIntoView({ behavior: 'smooth' }), 40);
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setBusy(false);
    }
  }

  function patch(p: Partial<Memory>) {
    setDraft((d) => (d ? { ...d, ...p } : d));
  }

  function onNivel(v: string) {
    const level = Number(v);
    // A escada de escrita trava 0 e 1: o seletor nem oferece esses níveis quando a memória é editável.
    if (!nivelEditavel(level)) return;
    patch({ level, nota: level === 4 ? (draft?.nota ?? NOTA_INICIAL) : null });
  }

  function addKeyword() {
    const v = kw.trim();
    if (!v || !draft) return;
    if (draft.keywords.length >= MAX_KEYWORDS) return;
    if (draft.keywords.includes(v)) {
      setKw('');
      return;
    }
    patch({ keywords: [...draft.keywords, v] });
    setKw('');
  }

  function removeKeyword(k: string) {
    if (!draft) return;
    patch({ keywords: draft.keywords.filter((x) => x !== k) });
  }

  async function salvar() {
    if (!draft) return;
    setBusy(true);
    setToast(null);
    try {
      const r = await api<{ memory: Memory }>(`/api/memories/${draft.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          title: draft.title,
          summary: draft.summary,
          body_md: draft.body_md,
          level: draft.level,
          nota: draft.nota,
          rewritable: draft.rewritable,
          keywords: draft.keywords,
          scope_project_id: draft.scope_project_id,
          scope_user_id: draft.scope_user_id,
        }),
      });
      setDraft(r.memory);
      await loadList();
      setToast({ kind: 'ok', text: 'Memória salva.' });
    } catch (e: any) {
      setToast({ kind: 'bad', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  async function excluir() {
    if (!draft) return;
    if (!window.confirm(`Excluir a memória "${draft.title}"? Isso não tem volta.`)) return;
    setBusy(true);
    setToast(null);
    try {
      await api(`/api/memories/${draft.id}`, { method: 'DELETE' });
      setSelectedId(null);
      setDraft(null);
      await loadList();
      setToast({ kind: 'ok', text: 'Memória excluída.' });
    } catch (e: any) {
      setToast({ kind: 'bad', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  const bodyHtml = useMemo(() => (draft ? (marked.parse(draft.body_md || '') as string) : ''), [draft?.body_md]);
  const somaCount = draft?.summary.length ?? 0;
  const editavel = draft ? nivelEditavel(draft.level) : false;
  const banner = draft ? nivelBanner(draft.level) : null;

  async function importar() {
    if (!syncProj) return;
    setBusy(true); setErro('');
    try { const r = await api<{ importadas: number; aviso?: string }>('/api/memories/import', { method: 'POST', body: JSON.stringify({ project_id: syncProj }) }); setToast({ kind: 'ok', text: r.aviso ?? `${r.importadas} memória(s) importada(s) do Claude` }); await loadList(); }
    catch (e: any) { setErro(e.message); } finally { setBusy(false); }
  }
  async function exportar() {
    if (!syncProj) return;
    setBusy(true); setErro('');
    try { const r = await api<{ exportadas: number }>('/api/memories/export', { method: 'POST', body: JSON.stringify({ project_id: syncProj }) }); setToast({ kind: 'ok', text: `${r.exportadas} memória(s) enviada(s) para o Claude ler` }); }
    catch (e: any) { setErro(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="mem">
      <div className="mem-list">
        <div className="mem-list-head">
          <button className="mem-nova" onClick={nova} disabled={busy}>+ Nova memória</button>
          <div className="mem-sync">
            <select value={syncProj ?? ''} onChange={e => setSyncProj(Number(e.target.value))} title="projeto para sincronizar com o Claude">
              {meta.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button className="link" onClick={importar} disabled={busy || !syncProj} title="trazer o que o Claude escreveu">importar do Claude</button>
            <button className="link" onClick={exportar} disabled={busy || !syncProj} title="enviar estas memórias para o Claude ler">exportar</button>
          </div>
          <input
            className="mem-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por título, resumo ou palavra-chave…"
          />
          <div className="mem-chips">
            {NIVEL_CHIPS.map((c) => (
              <button
                key={c.key || 'todas'}
                className={`mem-chip ${nivelFilter === c.key ? 'is-on' : ''}`}
                onClick={() => setNivelFilter(c.key)}
              >
                {c.label}
              </button>
            ))}
          </div>
          <div className="mem-chips">
            {SCOPE_CHIPS.map((c) => (
              <button
                key={c.key || 'qualquer'}
                className={`mem-chip ${scopeFilter === c.key ? 'is-on' : ''}`}
                onClick={() => setScopeFilter(c.key)}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        {erro && <div className="erro">{erro}</div>}

        <div className="mem-rows">
          {list.length === 0 ? (
            <div className="mem-empty small">Nenhuma memória encontrada.</div>
          ) : (
            list.map((m) => (
              <button
                key={m.id}
                className={`mem-row ${m.id === selectedId ? 'is-active' : ''}`}
                onClick={() => abrir(m.id, true)}
              >
                <div className="mem-row-top">
                  <span className="mem-dot" style={{ background: colorVar(m.level) }} />
                  <span className="mem-row-title">{m.title}</span>
                </div>
                {m.summary && <div className="mem-row-sum small">{truncate(m.summary, SUMMARY_MAX)}</div>}
                {m.keywords.length > 0 && (
                  <div className="mem-kw-line">
                    {m.keywords.map((k) => (
                      <span key={k} className="mem-kw">{k}</span>
                    ))}
                  </div>
                )}
                <div className="mem-scope-line">
                  <span className="mem-scope">{nivelLabel(m.level)}{m.level === 4 && m.nota != null ? ` ${m.nota}/${NOTA_MAX}` : ''}</span>
                  <span className="mem-scope">{m.project_name ? `projeto ${m.project_name}` : 'universal'}</span>
                  <span className="mem-scope">{m.user_name ? `usuário ${m.user_name}` : 'universal'}</span>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="mem-reader" ref={readerRef}>
        {!draft ? (
          <div className="mem-reader-empty muted">Selecione uma memória à esquerda ou crie uma nova.</div>
        ) : (
          <>
            {banner && <div className="mem-banner">{banner}</div>}
            <div className="mem-card">
              <label className="mem-field">
                <span>título</span>
                <input value={draft.title} onChange={(e) => patch({ title: e.target.value })} disabled={!editavel} />
              </label>

              <div className="mem-field-grid">
                <label className="mem-field">
                  <span>código</span>
                  <input className="mono" value={draft.code} readOnly title="o código não muda depois de criado" />
                </label>
                <label className="mem-field">
                  <span>nível</span>
                  <select value={draft.level} onChange={(e) => onNivel(e.target.value)} disabled={!editavel}>
                    {NIVEL_OPTIONS.map((o) => (
                      // 0 e 1 aparecem só quando a memória JÁ está nesse nível (somente leitura);
                      // uma memória editável nunca pode ser movida para eles pelo painel.
                      (nivelEditavel(o.level) || o.level === draft.level) && (
                        <option key={o.level} value={o.level} disabled={!nivelEditavel(o.level)}>{o.label}</option>
                      )
                    ))}
                  </select>
                </label>
              </div>

              {draft.level === 4 && (
                <label className="mem-field mem-field-nota">
                  <span>nota (vida do micro-fato)</span>
                  <select
                    value={draft.nota ?? NOTA_INICIAL}
                    onChange={(e) => patch({ nota: Number(e.target.value) })}
                    disabled={!editavel}
                  >
                    {Array.from({ length: NOTA_MAX - NOTA_MIN + 1 }, (_, i) => NOTA_MIN + i).map((n) => (
                      <option key={n} value={n}>{n}{n === NOTA_MAX ? ' (candidata a promoção)' : ''}</option>
                    ))}
                  </select>
                </label>
              )}

              <div className="mem-importance">
                <Selo level={draft.level} nota={draft.nota} />
              </div>

              <label className="mem-field">
                <span>
                  resumo
                  <span className={`mem-counter ${somaCount > SUMMARY_MAX ? 'is-over' : ''}`}>{somaCount}/{SUMMARY_MAX}</span>
                </span>
                <textarea
                  className="mem-summary"
                  rows={2}
                  value={draft.summary}
                  onChange={(e) => patch({ summary: e.target.value })}
                  placeholder="Um resumo curto (até 144 caracteres)."
                  disabled={!editavel}
                />
              </label>

              <div className="mem-meta-grid">
                <div><span className="muted small">nasceu em</span><div>{fmtDate(draft.created_at)}</div></div>
                <div>
                  <span className="muted small">último acesso</span>
                  <div className="small">
                    {draft.last_accessed_at
                      ? `${fmtDateTime(draft.last_accessed_at)} · sessão ${draft.last_accessed_session ?? '?'} · ${draft.last_accessed_reason ?? '?'}`
                      : 'nunca'}
                  </div>
                </div>
                <div><span className="muted small">última análise pela IA</span><div>{fmtDateTime(draft.last_analyzed_at)}</div></div>
                <div><span className="muted small">última reescrita</span><div>{fmtDateTime(draft.last_rewritten_at)}</div></div>
                {draft.level === 4 && (
                  <div><span className="muted small">último decaimento</span><div>{fmtDateTime(draft.last_decay_at)}</div></div>
                )}
              </div>

              <label className="mem-toggle-line">
                <input type="checkbox" checked={draft.rewritable} onChange={(e) => patch({ rewritable: e.target.checked })} disabled={!editavel} />
                <span>pode ser reescrita pela IA</span>
              </label>

              <div className="mem-field">
                <span>palavras-chave <span className="muted small">({draft.keywords.length}/{MAX_KEYWORDS})</span></span>
                <div className="mem-kw-edit">
                  {draft.keywords.map((k) => (
                    <span key={k} className="mem-kw is-edit">
                      {k}
                      {editavel && <button className="mem-kw-x" onClick={() => removeKeyword(k)} aria-label={`remover ${k}`}>×</button>}
                    </span>
                  ))}
                  {editavel && draft.keywords.length < MAX_KEYWORDS && (
                    <input
                      className="mem-kw-input"
                      value={kw}
                      onChange={(e) => setKw(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addKeyword(); } }}
                      onBlur={addKeyword}
                      placeholder="+ palavra"
                    />
                  )}
                </div>
              </div>

              <div className="mem-field-grid">
                <label className="mem-field">
                  <span>projeto</span>
                  <select
                    value={draft.scope_project_id ?? ''}
                    onChange={(e) => patch({ scope_project_id: e.target.value ? Number(e.target.value) : null })}
                    disabled={!editavel}
                  >
                    <option value="">Universal (todos os projetos)</option>
                    {meta.projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </label>
                <label className="mem-field">
                  <span>usuário</span>
                  <select
                    value={draft.scope_user_id ?? ''}
                    onChange={(e) => patch({ scope_user_id: e.target.value ? Number(e.target.value) : null })}
                    disabled={!editavel}
                  >
                    <option value="">Universal (qualquer usuário)</option>
                    {meta.users.map((u) => (
                      <option key={u.id} value={u.id}>{u.name}</option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="muted small mem-hint">Quando marcada, só vale para esse usuário ou quando perguntam sobre ele.</p>
            </div>

            <div className="mem-body">
              <div className="mem-body-tabs">
                <button className={bodyMode === 'ler' ? 'is-on' : ''} onClick={() => setBodyMode('ler')}>ler</button>
                {editavel && <button className={bodyMode === 'editar' ? 'is-on' : ''} onClick={() => setBodyMode('editar')}>editar</button>}
              </div>
              {bodyMode === 'ler' || !editavel ? (
                draft.body_md.trim() ? (
                  <article className="md mem-md" dangerouslySetInnerHTML={{ __html: bodyHtml }} />
                ) : (
                  <p className="muted">Sem conteúdo ainda. Vá em "editar" para escrever.</p>
                )
              ) : (
                <textarea
                  className="mem-editor mono"
                  value={draft.body_md}
                  onChange={(e) => patch({ body_md: e.target.value })}
                  placeholder="Escreva a memória em markdown…"
                />
              )}
            </div>

            <div className="mem-actions">
              {editavel && <button className="btn-primary" onClick={salvar} disabled={busy}>Salvar</button>}
              {editavel && user.role === 'owner' && <button onClick={excluir} disabled={busy}>Excluir</button>}
              {toast && <span className={`mem-toast ${toast.kind === 'bad' ? 'is-bad' : 'is-ok'}`}>{toast.text}</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
