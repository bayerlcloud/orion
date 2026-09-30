import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type User } from '../api';
import { IcoCloudflare, IcoGithub } from '../icons';
import ToolsNotas, { copiar } from './ToolsNotas';
import ToolsContaModal from './ToolsContaModal';

type Github = { id: number; label: string; login: string; email: string; notes: string; mcp: string; token_hint: string };
type Cloudflare = { id: number; label: string; account_id: string; account_name: string; email: string; notes: string; nome: string; url: string; token_hint: string };
type Kind = 'tool' | 'skill' | 'mcp';
type ToolItem = { id: number; kind: Kind; name: string; description: string; icon: string; status: 'ativo' | 'inativo'; link: string | null; details: string; tag: string | null; created_by_name: string | null };
type Prov = 'github' | 'cloudflare';
type Hostinger = { conectado: boolean; token_hint: string | null; mcps: string[] };
type Tipo = Prov | 'hostinger' | Kind;
/** Linha do card: rótulo, valor inteiro (copiar/popup) e, se houver, versão curta para o card. */
type Linha = [string, string, string?];
type Card = { tipo: Tipo; id: number; label: string; sub: string; linhas: Linha[]; notas: string; detalhes?: string; icone: ReactNode; tag?: string | null; status?: 'ativo' | 'inativo'; autor?: string | null };

const TIPO: Record<Tipo, { titulo: string; badge: string; classe: string }> = {
  github: { titulo: 'GitHub', badge: 'MCP', classe: 'is-mcp' },
  cloudflare: { titulo: 'Cloudflare', badge: 'Conector', classe: 'is-conector' },
  hostinger: { titulo: 'Hostinger', badge: 'MCP', classe: 'is-mcp' },
  mcp: { titulo: 'MCP', badge: 'MCP', classe: 'is-mcp' },
  tool: { titulo: 'Tool', badge: 'Tool', classe: 'is-tool' },
  skill: { titulo: 'Skill', badge: 'Skill', classe: 'is-skill' },
};
const API: Record<Prov, string> = { github: '/api/tools/github', cloudflare: '/api/tools/cloudflare' };
const KINDS: Kind[] = ['mcp', 'tool', 'skill'];
const FILTROS: (Tipo | 'todos')[] = ['todos', 'github', 'cloudflare', 'hostinger', 'mcp', 'tool', 'skill'];
const ehConta = (t: Tipo): t is Prov => t === 'github' || t === 'cloudflare';

const HOSTINGER_NOTAS = `Um token da API Hostinger vira 8 MCPs oficiais em toda sessão. Cada um tem search (acha a operação), execute e multi-execute: dentro da área, o Claude lê E altera tudo que a API permite.

• hostinger-dns: criar, alterar e apagar registros DNS (bayerl.cloud incluso). Sempre registro A explícito.
• hostinger-domains: domínios, disponibilidade, WHOIS, nameservers, compra.
• hostinger-hosting: sites, bancos MySQL, FTP, builds Node.js e variáveis de ambiente.
• hostinger-vps-studio: VPS (ligar, desligar, reiniciar, firewall, snapshots, backups, chaves SSH, reinstalar SO).
• hostinger-wordpress: instalar WordPress, plugins, temas, core.
• hostinger-billing: assinaturas, pagamentos, pedidos (pode gerar cobrança).
• hostinger-ecommerce: lojas Hostinger.
• hostinger-reach: e-mail marketing.

Atenção: billing, compra de domínio e ações de VPS mexem com dinheiro ou derrubam servidor. Confirmar antes.`;

const contaVazia = () => ({ label: '', account_id: '', token: '', email: '', notes: '' });
const catVazio = () => ({ kind: 'mcp' as Kind, name: '', description: '', icon: '⚙️', link: '', details: '', tag: '' });
type FormConta = { prov: Prov; id: number | null; v: ReturnType<typeof contaVazia> };
type FormCat = { id: number | null; v: ReturnType<typeof catVazio> };

/** Aba Conectores: tudo numa lista só — contas GitHub (MCP oficial), contas Cloudflare (conector simples via proxy)
 *  e o catálogo manual (MCPs, tools e skills anotados à mão). Cada card diz o tipo no título e abre popup ao clicar. */
export default function ToolsConectores({ user }: { user: User }) {
  const [gh, setGh] = useState<Github[]>([]);
  const [cf, setCf] = useState<Cloudflare[]>([]);
  const [cat, setCat] = useState<ToolItem[]>([]);
  const [host, setHost] = useState<Hostinger | null>(null);
  const [formHost, setFormHost] = useState<string | null>(null);
  const [erro, setErro] = useState('');
  const [busy, setBusy] = useState(false);
  const [filtro, setFiltro] = useState<Tipo | 'todos'>('todos');
  const [formConta, setFormConta] = useState<FormConta | null>(null);
  const [formCat, setFormCat] = useState<FormCat | null>(null);
  const [open, setOpen] = useState<Card | null>(null);
  const admin = user.role === 'owner';

  async function load() {
    try {
      const [g, c, t, h] = await Promise.all([api<{ contas: Github[] }>(API.github), api<{ contas: Cloudflare[] }>(API.cloudflare), api<{ tools: ToolItem[] }>('/api/tools'), api<Hostinger>('/api/tools/hostinger')]);
      setGh(g.contas); setCf(c.contas); setCat(t.tools); setHost(h); setErro('');
    } catch (e: any) { setErro(e.message); }
  }
  useEffect(() => { void load(); }, []);

  const cards: Card[] = useMemo(() => [
    ...gh.map((c): Card => ({ tipo: 'github', id: c.id, label: c.label, sub: `${c.login}${c.email ? ` · ${c.email}` : ''}`, notas: c.notes, icone: <IcoGithub />,
      linhas: [['tools', `mcp__${c.mcp}__*`], ['token', c.token_hint]] })),
    ...cf.map((c): Card => ({ tipo: 'cloudflare', id: c.id, label: c.label, sub: c.email || c.account_name, notas: c.notes, icone: <IcoCloudflare />,
      linhas: [['account', c.account_id], ['proxy', c.url, c.url.replace(/^https?:\/\/[^/]+/, '')], ['token', c.token_hint]] })),
    ...(host ? [{ tipo: 'hostinger' as const, id: 0, label: 'hostinger', sub: host.conectado ? `${host.mcps.length} MCPs em toda sessão` : 'sem token: nenhum MCP ativo', notas: 'DNS, domínios, VPS, hosting, WordPress, billing, e-commerce e e-mail marketing.', detalhes: HOSTINGER_NOTAS, icone: '🌐',
      linhas: [['tools', host.mcps.map(m => `mcp__${m}__*`).join('\n'), 'mcp__hostinger-*__*'], ['token', host.token_hint ?? 'nenhum']] as Linha[] }] : []),
    ...cat.map((t): Card => ({ tipo: t.kind, id: t.id, label: t.name, sub: '', notas: t.description, detalhes: t.details, tag: t.tag, icone: t.icon, status: t.status, autor: t.created_by_name,
      linhas: t.link ? [['link', t.link, t.link.replace(/^https?:\/\//, '')]] : [] })),
  ], [gh, cf, cat, host]);
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
    setFormCat({ id: t.id, v: { kind: t.kind, name: t.name, description: t.description, icon: t.icon, link: t.link ?? '', details: t.details, tag: t.tag ?? '' } });
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

  async function salvarHost() {
    if (formHost === null) return;
    setBusy(true); setErro('');
    try { await api('/api/tools/hostinger', { method: 'PUT', body: JSON.stringify({ token: formHost }) }); setFormHost(null); await load(); }
    catch (e: any) { setErro(e.message); } finally { setBusy(false); }
  }

  function editar(c: Card) {
    if (c.tipo === 'hostinger') { setOpen(null); setFormConta(null); setFormCat(null); setFormHost(''); return; }
    ehConta(c.tipo) ? editarConta(c) : editarCat(c);
  }
  async function remover(c: Card) {
    const msg = ehConta(c.tipo) ? `Remover a conta ${TIPO[c.tipo].titulo} "${c.label}"? As sessões novas deixam de enxergar essa conta.` : `Apagar "${c.label}"?`;
    if (!window.confirm(msg)) return;
    try { await api(ehConta(c.tipo) ? `${API[c.tipo]}/${c.id}` : `/api/tools/${c.id}`, { method: 'DELETE' }); setOpen(null); await load(); }
    catch (e: any) { setErro(e.message); }
  }
  const podeMexer = (c: Card) => admin || (!ehConta(c.tipo) && c.tipo !== 'hostinger');
  const podeApagar = (c: Card) => podeMexer(c) && c.tipo !== 'hostinger';

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
        <b> Hostinger</b>: um token vira os MCPs oficiais (DNS, domínios, VPS, hosting, WordPress, billing).
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

      {formHost !== null && (
        <div className="tls-form">
          <div className="tls-sec-head"><h2 style={{ fontSize: 14 }}>Trocar token da Hostinger</h2></div>
          <label>token de API (hPanel → Perfil → API). Vale para os 8 MCPs hostinger-* nas sessões novas.
            <input type="password" value={formHost} onChange={e => setFormHost(e.target.value)} autoComplete="off" autoFocus />
          </label>
          <div className="tls-form-actions">
            <button className="btn-primary" onClick={salvarHost} disabled={busy || formHost.trim().length < 20}>{busy ? 'Validando…' : 'Salvar'}</button>
            <button onClick={() => setFormHost(null)} disabled={busy}>Cancelar</button>
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
          <label>selo vermelho (opcional, ex.: c1 = lembrete de pendência)
            <input value={formCat.v.tag} onChange={e => setK('tag', e.target.value)} maxLength={12} />
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
              <div className="tls-card-top"><span className="tls-icon">{c.icone}</span><span className="tls-spacer" />{c.tag && <span className="tls-badge is-tag" title="pendência">{c.tag}</span>}<span className={`tls-badge ${T.classe}`}>{T.badge}</span></div>
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
                {podeApagar(c) && <button className="tls-icon-btn" onClick={() => remover(c)} title={ehConta(c.tipo) ? 'Remover' : 'Apagar'}>🗑</button>}
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
