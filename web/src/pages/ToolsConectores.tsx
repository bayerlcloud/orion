import { Fragment, useEffect, useState } from 'react';
import { api, type User } from '../api';
import ToolsNotas, { copiar } from './ToolsNotas';
import ToolsContaModal from './ToolsContaModal';

type Github = { id: number; label: string; login: string; email: string; notes: string; mcp: string; token_hint: string };
type Cloudflare = { id: number; label: string; account_id: string; account_name: string; email: string; notes: string; nome: string; url: string; token_hint: string };
type Prov = 'github' | 'cloudflare';
/** Linha do card: rótulo, valor inteiro (copiar/popup) e, se houver, versão curta para o card. */
type Linha = [string, string, string?];
type Card = { prov: Prov; id: number; label: string; sub: string; linhas: Linha[]; notas: string };

const PROV: Record<Prov, { titulo: string; icone: string; badge: string; classe: string; api: string }> = {
  github: { titulo: 'GitHub', icone: '🐙', badge: 'MCP', classe: 'is-mcp', api: '/api/tools/github' },
  cloudflare: { titulo: 'Cloudflare', icone: '☁️', badge: 'Conector', classe: 'is-conector', api: '/api/tools/cloudflare' },
};
const vazio = () => ({ label: '', account_id: '', token: '', email: '', notes: '' });
type Form = { prov: Prov; id: number | null; v: ReturnType<typeof vazio> };

/** Aba Conectores: todas as contas (GitHub = MCP oficial, Cloudflare = conector simples via proxy) numa lista só.
 *  Cada card diz o provedor no título, abre popup ao clicar e só o admin cria/edita/remove. */
export default function ToolsConectores({ user }: { user: User }) {
  const [gh, setGh] = useState<Github[]>([]);
  const [cf, setCf] = useState<Cloudflare[]>([]);
  const [erro, setErro] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const [open, setOpen] = useState<Card | null>(null);
  const admin = user.role === 'owner';

  async function load() {
    try {
      const [g, c] = await Promise.all([api<{ contas: Github[] }>(PROV.github.api), api<{ contas: Cloudflare[] }>(PROV.cloudflare.api)]);
      setGh(g.contas); setCf(c.contas); setErro('');
    } catch (e: any) { setErro(e.message); }
  }
  useEffect(() => { void load(); }, []);

  const cards: Card[] = [
    ...gh.map((c): Card => ({ prov: 'github', id: c.id, label: c.label, sub: `${c.login}${c.email ? ` · ${c.email}` : ''}`, notas: c.notes,
      linhas: [['tools', `mcp__${c.mcp}__*`], ['token', c.token_hint]] })),
    ...cf.map((c): Card => ({ prov: 'cloudflare', id: c.id, label: c.label, sub: c.email || c.account_name, notas: c.notes,
      linhas: [['account', c.account_id], ['proxy', c.url, c.url.replace(/^https?:\/\/[^/]+/, '')], ['token', c.token_hint]] })),
  ];

  function novo(prov: Prov) { setForm({ prov, id: null, v: vazio() }); }
  function editar(c: Card) {
    const orig = c.prov === 'github' ? gh.find(x => x.id === c.id) : cf.find(x => x.id === c.id);
    if (!orig) return;
    setOpen(null);
    setForm({ prov: c.prov, id: c.id, v: { label: orig.label, account_id: (orig as Cloudflare).account_id ?? '', token: '', email: orig.email, notes: orig.notes } });
  }
  async function salvar() {
    if (!form) return;
    const P = PROV[form.prov]; const v = form.v;
    setBusy(true); setErro('');
    try {
      if (form.id) await api(`${P.api}/${form.id}`, { method: 'PUT', body: JSON.stringify({ label: v.label, email: v.email, notes: v.notes }) });
      else await api(P.api, { method: 'POST', body: JSON.stringify(form.prov === 'github' ? { label: v.label, token: v.token, email: v.email, notes: v.notes } : v) });
      setForm(null); await load();
    } catch (e: any) { setErro(e.message); } finally { setBusy(false); }
  }
  async function remover(c: Card) {
    if (!window.confirm(`Remover a conta ${PROV[c.prov].titulo} "${c.label}"? As sessões novas deixam de enxergar essa conta.`)) return;
    try { await api(`${PROV[c.prov].api}/${c.id}`, { method: 'DELETE' }); setOpen(null); await load(); } catch (e: any) { setErro(e.message); }
  }
  const set = (k: keyof ReturnType<typeof vazio>, val: string) => setForm(f => f && ({ ...f, v: { ...f.v, [k]: val } }));
  const podeSalvar = form && form.v.label.trim() && (form.id || (form.v.token.trim() && (form.prov === 'github' || form.v.account_id.trim())));

  return (
    <>
      <div className="tls-sec-head" style={{ marginTop: 20 }}>
        <h2>Conectores</h2>
        <span className="muted small">{cards.length} conta{cards.length === 1 ? '' : 's'}</span>
        {admin && (<>
          <span className="tls-spacer" />
          <button className="btn-primary" onClick={() => novo('github')}>+ GitHub</button>
          <button className="btn-primary" onClick={() => novo('cloudflare')}>+ Cloudflare</button>
        </>)}
      </div>
      <p className="muted small">
        <b>GitHub</b>: cada conta vira um MCP oficial em toda sessão (repos, issues, PRs, código).
        <b> Cloudflare</b>: conector simples, o Claude chama a API (Pages, DNS, Workers, R2, D1…) por um proxy local do Orion que injeta o token; o token nunca entra na sessão.
        A explicação de cada conta entra no prompt.
      </p>
      {erro && <div className="erro">{erro}</div>}

      {form && (
        <div className="tls-form">
          <div className="tls-sec-head"><h2 style={{ fontSize: 14 }}>{form.id ? 'Editar' : 'Nova'} conta {PROV[form.prov].titulo}</h2></div>
          <div className="tls-form-grid">
            <label className="tls-form-name">nome ({form.prov === 'github' ? 'as tools ficam mcp__github-<nome>__*' : 'o proxy fica em /conector/cloudflare-<nome>/'})
              <input value={form.v.label} onChange={e => set('label', e.target.value)} placeholder={form.prov === 'github' ? 'ex.: bayerlcloud' : 'ex.: fisioexpert'} autoFocus />
            </label>
            <label>e-mail de login
              <input type="email" value={form.v.email} onChange={e => set('email', e.target.value)} placeholder="quem@exemplo.com" />
            </label>
          </div>
          {!form.id && form.prov === 'cloudflare' && (
            <label>account ID (32 hex, no painel da Cloudflare)
              <input value={form.v.account_id} onChange={e => set('account_id', e.target.value)} placeholder="8df20ec9…" autoComplete="off" />
            </label>
          )}
          {!form.id && (
            <label>{form.prov === 'github' ? 'token pessoal (PAT)' : 'token de API'}
              <input type="password" value={form.v.token} onChange={e => set('token', e.target.value)} placeholder={form.prov === 'github' ? 'ghp_… ou github_pat_…' : 'cfat_… ou cfut_…'} autoComplete="off" />
            </label>
          )}
          <label>o que tem nessa conta (entra no prompt de toda sessão)
            <textarea value={form.v.notes} onChange={e => set('notes', e.target.value)} rows={4}
              placeholder={form.prov === 'github' ? 'ex.: dona dos repos bayerlcloud/branspace, fisioexpert…' : 'ex.: Pages fisio.bayerl.cloud, bucket R2 dos uploads…'} />
          </label>
          <div className="tls-form-actions">
            <button className="btn-primary" onClick={salvar} disabled={busy || !podeSalvar}>{busy ? 'Validando…' : form.id ? 'Salvar' : 'Conectar'}</button>
            <button onClick={() => setForm(null)} disabled={busy}>Cancelar</button>
          </div>
        </div>
      )}

      {cards.length === 0 ? (
        <div className="tls-empty">Nenhuma conta ainda.{admin && <> Clique em <b>+ GitHub</b> ou <b>+ Cloudflare</b>.</>}</div>
      ) : (
        <div className="tls-grid">
          {cards.map(c => { const P = PROV[c.prov]; return (
            <div key={`${c.prov}-${c.id}`} className={`tls-card ${P.classe} is-conta`} onClick={() => setOpen(c)}>
              <div className="tls-card-top"><span className="tls-icon">{P.icone}</span><span className={`tls-badge ${P.classe}`}>{P.badge}</span></div>
              <div>
                <div className="tls-eyebrow">{P.titulo}</div>
                <div className="tls-name">{c.label}</div>
                <div className="tls-sub" title={c.sub}>{c.sub}</div>
              </div>
              <dl className="tls-rows">
                {c.linhas.map(l => <Fragment key={l[0]}><dt>{l[0]}</dt><dd className="cp" title={`${l[1]}  (clique para copiar)`} onClick={e => { e.stopPropagation(); copiar(l[1]); }}>{l[2] ?? l[1]}</dd></Fragment>)}
              </dl>
              <ToolsNotas texto={c.notas} />
              {admin && (
                <div className="tls-card-foot" onClick={e => e.stopPropagation()}>
                  <span className="tls-spacer" />
                  <button className="tls-icon-btn" onClick={() => editar(c)} title="Editar nome e explicação">✎</button>
                  <button className="tls-icon-btn" onClick={() => remover(c)} title="Remover">🗑</button>
                </div>
              )}
            </div>
          ); })}
        </div>
      )}

      {open && (
        <ToolsContaModal icone={PROV[open.prov].icone} badge={PROV[open.prov].badge} badgeClass={PROV[open.prov].classe}
          titulo={open.label} sub={`${PROV[open.prov].titulo} · ${open.sub}`} linhas={open.linhas.map(l => [l[0], l[1]])} notas={open.notas}
          onEdit={admin ? () => editar(open) : undefined} onClose={() => setOpen(null)} />
      )}
    </>
  );
}
