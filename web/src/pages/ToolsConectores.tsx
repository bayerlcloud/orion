import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type User } from '../api';
import { IcoCloudflare, IcoGithub } from '../icons';
import ToolsNotas, { copiar } from './ToolsNotas';
import ToolsContaModal from './ToolsContaModal';

type Github = { id: number; label: string; login: string; email: string; notes: string; mcp: string; token_hint: string };
type Cloudflare = { id: number; label: string; account_id: string; account_name: string; email: string; notes: string; nome: string; url: string; token_hint: string };
type Kind = 'tool' | 'skill' | 'mcp';
type ToolItem = { id: number; kind: Kind; name: string; description: string; icon: string; status: 'ativo' | 'inativo'; link: string | null; details: string; created_by_name: string | null };
type Prov = 'github' | 'cloudflare';
type Tipo = Prov | Kind;
/** Linha do card: rótulo, valor inteiro (copiar/popup) e, se houver, versão curta para o card. */
type Linha = [string, string, string?];
type Card = { tipo: Tipo; id: number; label: string; sub: string; linhas: Linha[]; notas: string; detalhes?: string; icone: ReactNode; status?: 'ativo' | 'inativo'; autor?: string | null };

const TIPO: Record<Tipo, { titulo: string; badge: string; classe: string }> = {
  github: { titulo: 'GitHub', badge: 'MCP', classe: 'is-mcp' },
  cloudflare: { titulo: 'Cloudflare', badge: 'Conector', classe: 'is-conector' },
  mcp: { titulo: 'MCP', badge: 'MCP', classe: 'is-mcp' },
  tool: { titulo: 'Tool', badge: 'Tool', classe: 'is-tool' },
  skill: { titulo: 'Skill', badge: 'Skill', classe: 'is-skill' },
};
const API: Record<Prov, string> = { github: '/api/tools/github', cloudflare: '/api/tools/cloudflare' };
const KINDS: Kind[] = ['mcp', 'tool', 'skill'];
const FILTROS: (Tipo | 'todos')[] = ['todos', 'github', 'cloudflare', 'mcp', 'tool', 'skill'];
const ehConta = (t: Tipo): t is Prov => t === 'github' || t === 'cloudflare';

const contaVazia = () => ({ label: '', account_id: '', token: '', email: '', notes: '' });
const catVazio = () => ({ kind: 'mcp' as Kind, name: '', description: '', icon: '⚙️', link: '', details: '' });
type FormConta = { prov: Prov; id: number | null; v: ReturnType<typeof contaVazia> };
type FormCat = { id: number | null; v: ReturnType<typeof catVazio> };

/** Aba Conectores: tudo numa lista só — contas GitHub (MCP oficial), contas Cloudflare (conector simples via proxy)
 *  e o catálogo manual (MCPs, tools e skills anotados à mão). Cada card diz o tipo no título e abre popup ao clicar. */
export default function ToolsConectores({ user }: { user: User }) {
  const [gh, setGh] = useState<Github[]>([]);
  const [cf, setCf] = useState<Cloudflare[]>([]);
  const [cat, setCat] = useState<ToolItem[]>([]);
  const [erro, setErro] = useState('');
  const [busy, setBusy] = useState(false);
  const [filtro, setFiltro] = useState<Tipo | 'todos'>('todos');
  const [formConta, setFormConta] = useState<FormConta | null>(null);
  const [formCat, setFormCat] = useState<FormCat | null>(null);
  const [open, setOpen] = useState<Card | null>(null);
  const admin = user.role === 'owner';

  async function load() {
    try {
      const [g, c, t] = await Promise.all([api<{ contas: Github[] }>(API.github), api<{ contas: Cloudflare[] }>(API.cloudflare), api<{ tools: ToolItem[] }>('/api/tools')]);
      setGh(g.contas); setCf(c.contas); setCat(t.tools); setErro('');
    } catch (e: any) { setErro(e.message); }
  }
  useEffect(() => { void load(); }, []);

  const cards: Card[] = useMemo(() => [
    ...gh.map((c): Card => ({ tipo: 'github', id: c.id, label: c.label, sub: `${c.login}${c.email ? ` · ${c.email}` : ''}`, notas: c.notes, icone: <IcoGithub />,
      linhas: [['tools', `mcp__${c.mcp}__*`], ['token', c.token_hint]] })),
    ...cf.map((c): Card => ({ tipo: 'cloudflare', id: c.id, label: c.label, sub: c.email || c.account_name, notas: c.notes, icone: <IcoCloudflare />,
      linhas: [['account', c.account_id], ['proxy', c.url, c.url.replace(/^https?:\/\/[^/]+/, '')], ['token', c.token_hint]] })),
    ...cat.map((t): Card => ({ tipo: t.kind, id: t.id, label: t.name, sub: '', notas: t.description, detalhes: t.details, icone: t.icon, status: t.status, autor: t.created_by_name,
      linhas: t.link ? [['link', t.link, t.link.replace(/^https?:\/\//, '')]] : [] })),
  ], [gh, cf, cat]);
  const contagem = useMemo(() => {
    const c: Record<string, number> = { todos: cards.length };
    for (const k of cards) c[k.tipo] = (c[k.tipo] ?? 0) + 1;
    return c;
  }, [cards]);
  const visiveis = filtro === 'todos' ? cards : cards.filter(c => c.tipo === filtro);

  // ---- contas (GitHub / Cloudflare) ----
  function novaConta(prov: Prov) { setFormCat(null); setFormConta({ prov, id: null, v: contaVazia() }); }
  function editarConta(c: Card) {
    if (!ehConta(c.tipo)) return;
    const orig = c.tipo === 'github' ? gh.find(x => x.id === c.id) : cf.find(x => x.id === c.id);
    if (!orig) return;
    setOpen(null); setFormCat(null);
    setFormConta({ prov: c.tipo, id: c.id, v: { label: orig.label, account_id: (orig as Cloudflare).account_id ?? '', token: '', email: orig.email, notes: orig.notes } });
  }
  async function salvarConta() {
    if (!formConta) return;
    const { prov, id, v } = formConta;
    setBusy(true); setErro('');
    try {
      if (id) await api(`${API[prov]}/${id}`, { method: 'PUT', body: JSON.stringify({ label: v.label, email: v.email, notes: v.notes }) });
      else await api(API[prov], { method: 'POST', body: JSON.stringify(prov === 'github' ? { label: v.label, token: v.token, email: v.email, notes: v.notes } : v) });
      setFormConta(null); await load();
    } catch (e: any) { setErro(e.message); } finally { setBusy(false); }
  }
  const setC = (k: keyof ReturnType<typeof contaVazia>, val: string) => setFormConta(f => f && ({ ...f, v: { ...f.v, [k]: val } }));
  const podeSalvarConta = formConta && formConta.v.label.trim() && (formConta.id || (formConta.v.token.trim() && (formConta.prov === 'github' || formConta.v.account_id.trim())));

  // ---- catálogo manual ----
  function novoCat() { setFormConta(null); setFormCat({ id: null, v: catVazio() }); }
  function editarCat(c: Card) {
    const t = cat.find(x => x.id === c.id);
    if (!t) return;
    setOpen(null); setFormConta(null);
    setFormCat({ id: t.id, v: { kind: t.kind, name: t.name, description: t.description, icon: t.icon, link: t.link ?? '', details: t.details } });
  }
  async function salvarCat() {
    if (!formCat) return;
    if (!formCat.v.name.trim()) { setErro('nome é obrigatório'); return; }
    setBusy(true); setErro('');
    try {
      if (formCat.id) await api(`/api/tools/${formCat.id}`, { method: 'PUT', body: JSON.stringify(formCat.v) });
      else await api('/api/tools', { method: 'POST', body: JSON.stringify(formCat.v) });
      setFormCat(null); await load();
    } catch (e: any) { setErro(e.message); } finally { setBusy(false); }
  }
  const setK = (k: keyof ReturnType<typeof catVazio>, val: string) => setFormCat(f => f && ({ ...f, v: { ...f.v, [k]: val } }));
  async function alternarStatus(c: Card) {
    try { await api(`/api/tools/${c.id}`, { method: 'PUT', body: JSON.stringify({ status: c.status === 'ativo' ? 'inativo' : 'ativo' }) }); await load(); }
    catch (e: any) { setErro(e.message); }
  }

  function editar(c: Card) { ehConta(c.tipo) ? editarConta(c) : editarCat(c); }
  async function remover(c: Card) {
    const msg = ehConta(c.tipo) ? `Remover a conta ${TIPO[c.tipo].titulo} "${c.label}"? As sessões novas deixam de enxergar essa conta.` : `Apagar "${c.label}"?`;
    if (!window.confirm(msg)) return;
    try { await api(ehConta(c.tipo) ? `${API[c.tipo]}/${c.id}` : `/api/tools/${c.id}`, { method: 'DELETE' }); setOpen(null); await load(); }
    catch (e: any) { setErro(e.message); }
  }
  const podeMexer = (c: Card) => admin || !ehConta(c.tipo);

  return (
    <>
      <div className="tls-sec-head" style={{ marginTop: 20 }}>
        <h2>Conectores</h2>
        <span className="muted small">{cards.length} ite{cards.length === 1 ? 'm' : 'ns'}</span>
        <span className="tls-spacer" />
        {admin && <button className="btn-primary" onClick={() => novaConta('github')}>+ GitHub</button>}
        {admin && <button className="btn-primary" onClick={() => novaConta('cloudflare')}>+ Cloudflare</button>}
        <button className="btn-primary" onClick={novoCat}>+ Outro</button>
      </div>
      <p className="muted small">
        <b>GitHub</b>: cada conta vira um MCP oficial em toda sessão (repos, issues, PRs, código).
        <b> Cloudflare</b>: conector simples, o Claude chama a API (Pages, DNS, Workers, R2, D1…) por um proxy local do Orion que injeta o token; o token nunca entra na sessão.
        <b> Outros</b>: MCPs, tools e skills anotados à mão (o que é, permissões, link); o Claude também pode cadastrar via API.
      </p>
      {erro && <div className="erro">{erro}</div>}

      <div className="tls-filters">
        {FILTROS.map(f => (
          <button key={f} className={`tls-chip ${filtro === f ? 'is-on' : ''}`} onClick={() => setFiltro(f)}>{f === 'todos' ? 'Todos' : TIPO[f].titulo} <span className="tls-count">{contagem[f] ?? 0}</span></button>
        ))}
      </div>

      {formConta && (
        <div className="tls-form">
          <div className="tls-sec-head"><h2 style={{ fontSize: 14 }}>{formConta.id ? 'Editar' : 'Nova'} conta {TIPO[formConta.prov].titulo}</h2></div>
          <div className="tls-form-grid">
            <label className="tls-form-name">nome ({formConta.prov === 'github' ? 'as tools ficam mcp__github-<nome>__*' : 'o proxy fica em /conector/cloudflare-<nome>/'})
              <input value={formConta.v.label} onChange={e => setC('label', e.target.value)} placeholder={formConta.prov === 'github' ? 'ex.: bayerlcloud' : 'ex.: fisioexpert'} autoFocus />
            </label>
            <label>e-mail de login
              <input type="email" value={formConta.v.email} onChange={e => setC('email', e.target.value)} placeholder="quem@exemplo.com" />
            </label>
          </div>
          {!formConta.id && formConta.prov === 'cloudflare' && (
            <label>account ID (32 hex, no painel da Cloudflare)
              <input value={formConta.v.account_id} onChange={e => setC('account_id', e.target.value)} placeholder="8df20ec9…" autoComplete="off" />
            </label>
          )}
          {!formConta.id && (
            <label>{formConta.prov === 'github' ? 'token pessoal (PAT)' : 'token de API'}
              <input type="password" value={formConta.v.token} onChange={e => setC('token', e.target.value)} placeholder={formConta.prov === 'github' ? 'ghp_… ou github_pat_…' : 'cfat_… ou cfut_…'} autoComplete="off" />
            </label>
          )}
          <label>o que tem nessa conta (entra no prompt de toda sessão)
            <textarea value={formConta.v.notes} onChange={e => setC('notes', e.target.value)} rows={4}
              placeholder={formConta.prov === 'github' ? 'ex.: dona dos repos bayerlcloud/branspace, fisioexpert…' : 'ex.: Pages fisio.bayerl.cloud, bucket R2 dos uploads…'} />
          </label>
          <div className="tls-form-actions">
            <button className="btn-primary" onClick={salvarConta} disabled={busy || !podeSalvarConta}>{busy ? 'Validando…' : formConta.id ? 'Salvar' : 'Conectar'}</button>
            <button onClick={() => setFormConta(null)} disabled={busy}>Cancelar</button>
          </div>
        </div>
      )}

      {formCat && (
        <div className="tls-form">
          <div className="tls-sec-head"><h2 style={{ fontSize: 14 }}>{formCat.id ? 'Editar' : 'Novo'} item do catálogo</h2></div>
          <div className="tls-form-grid">
            <label>tipo
              <select value={formCat.v.kind} onChange={e => setK('kind', e.target.value)}>
                {KINDS.map(k => <option key={k} value={k}>{TIPO[k].titulo}</option>)}
              </select>
            </label>
            <label>ícone (emoji)
              <input value={formCat.v.icon} onChange={e => setK('icon', e.target.value)} maxLength={4} />
            </label>
            <label className="tls-form-name">nome
              <input value={formCat.v.name} onChange={e => setK('name', e.target.value)} autoFocus />
            </label>
          </div>
          <label>descrição
            <textarea value={formCat.v.description} onChange={e => setK('description', e.target.value)} rows={2} />
          </label>
          <label>link (opcional)
            <input value={formCat.v.link} onChange={e => setK('link', e.target.value)} placeholder="repo, docs, config…" />
          </label>
          <label>permissões e detalhes (aparece no popup do card)
            <textarea value={formCat.v.details} onChange={e => setK('details', e.target.value)} rows={6} />
          </label>
          <div className="tls-form-actions">
            <button className="btn-primary" onClick={salvarCat} disabled={busy}>{formCat.id ? 'Salvar' : 'Criar'}</button>
            <button onClick={() => setFormCat(null)} disabled={busy}>Cancelar</button>
          </div>
        </div>
      )}

      {visiveis.length === 0 ? (
        <div className="tls-empty">Nada aqui ainda.{admin && <> Clique em <b>+ GitHub</b>, <b>+ Cloudflare</b> ou <b>+ Outro</b>.</>}</div>
      ) : (
        <div className="tls-grid">
          {visiveis.map(c => { const T = TIPO[c.tipo]; return (
            <div key={`${c.tipo}-${c.id}`} className={`tls-card ${T.classe} is-conta ${c.status === 'inativo' ? 'is-off' : ''}`} onClick={() => setOpen(c)}>
              <div className="tls-card-top"><span className="tls-icon">{c.icone}</span><span className={`tls-badge ${T.classe}`}>{T.badge}</span></div>
              <div>
                <div className="tls-eyebrow">{T.titulo}</div>
                <div className="tls-name">{c.label}</div>
                {c.sub && <div className="tls-sub" title={c.sub}>{c.sub}</div>}
              </div>
              {c.linhas.length > 0 && (
                <dl className="tls-rows">
                  {c.linhas.map(l => <Fragment key={l[0]}><dt>{l[0]}</dt><dd className="cp" title={`${l[1]}  (clique para copiar)`} onClick={e => { e.stopPropagation(); copiar(l[1]); }}>{l[2] ?? l[1]}</dd></Fragment>)}
                </dl>
              )}
              <ToolsNotas texto={c.notas} />
              <div className="tls-card-foot" onClick={e => e.stopPropagation()}>
                {c.status && <><span className={`tls-dot is-${c.status}`} title={c.status} /><span className="tls-meta">{c.autor ?? '—'}</span></>}
                <span className="tls-spacer" />
                {podeMexer(c) && c.status && <button className="tls-icon-btn" onClick={() => alternarStatus(c)} title={c.status === 'ativo' ? 'Marcar inativo' : 'Marcar ativo'}>{c.status === 'ativo' ? '⏸' : '▶'}</button>}
                {podeMexer(c) && <button className="tls-icon-btn" onClick={() => editar(c)} title="Editar">✎</button>}
                {podeMexer(c) && <button className="tls-icon-btn" onClick={() => remover(c)} title={ehConta(c.tipo) ? 'Remover' : 'Apagar'}>🗑</button>}
              </div>
            </div>
          ); })}
        </div>
      )}

      {open && (
        <ToolsContaModal icone={open.icone} badge={TIPO[open.tipo].badge} badgeClass={TIPO[open.tipo].classe}
          titulo={open.label} sub={ehConta(open.tipo) ? `${TIPO[open.tipo].titulo} · ${open.sub}` : open.notas}
          linhas={open.linhas.map(l => [l[0], l[1]])}
          notas={ehConta(open.tipo) ? open.notas : (open.detalhes ?? '')}
          secao={ehConta(open.tipo) ? undefined : 'Permissões e detalhes'}
          onEdit={podeMexer(open) ? () => editar(open) : undefined} onClose={() => setOpen(null)} />
      )}
    </>
  );
}
