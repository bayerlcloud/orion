import { useEffect, useState } from 'react';
import { api, type User } from '../api';
import ToolsNotas, { copiar } from './ToolsNotas';

type Conta = { id: number; label: string; login: string; email: string; notes: string; mcp: string; token_hint: string };
const vazio = () => ({ label: '', token: '', email: '', notes: '' });

/** Contas GitHub: cada uma vira um MCP oficial em toda sessão; a explicação entra no prompt. Só o admin mexe. */
export default function ToolsGithub({ user }: { user: User }) {
  const [contas, setContas] = useState<Conta[]>([]);
  const [erro, setErro] = useState('');
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Conta | null>(null);
  const [form, setForm] = useState(vazio());
  const admin = user.role === 'owner';

  async function load() {
    try { setContas((await api<{ contas: Conta[] }>('/api/tools/github')).contas); } catch (e: any) { setErro(e.message); }
  }
  useEffect(() => { void load(); }, []);

  function startCreate() { setEditing(null); setForm(vazio()); setShowForm(true); }
  function startEdit(c: Conta) { setEditing(c); setForm({ label: c.label, token: '', email: c.email, notes: c.notes }); setShowForm(true); }
  async function save() {
    setBusy(true); setErro('');
    try {
      if (editing) await api(`/api/tools/github/${editing.id}`, { method: 'PUT', body: JSON.stringify({ label: form.label, email: form.email, notes: form.notes }) });
      else await api('/api/tools/github', { method: 'POST', body: JSON.stringify(form) });
      setShowForm(false); setEditing(null); setForm(vazio()); await load();
    } catch (e: any) { setErro(e.message); } finally { setBusy(false); }
  }
  async function remove(c: Conta) {
    if (!window.confirm(`Remover a conta "${c.label}"? As sessões perdem as tools ${c.mcp}.`)) return;
    try { await api(`/api/tools/github/${c.id}`, { method: 'DELETE' }); await load(); } catch (e: any) { setErro(e.message); }
  }

  return (
    <>
      <div className="tls-sec-head" style={{ marginTop: 28 }}>
        <h2>GitHub</h2>
        {admin && <button className="btn-primary" onClick={startCreate} style={{ marginLeft: 12 }}>+ Conta</button>}
      </div>
      <p className="muted small">Cada conta vira um MCP oficial do GitHub em toda sessão (repos, issues, PRs, código). A explicação diz ao Claude quais projetos vivem em cada conta.</p>
      {erro && <div className="erro">{erro}</div>}

      {showForm && (
        <div className="tls-form">
          <div className="tls-form-grid">
            <label className="tls-form-name">nome (as tools ficam mcp__github-&lt;nome&gt;__*)
              <input value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} placeholder="ex.: bayerlcloud" autoFocus />
            </label>
            <label>e-mail de login
              <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="quem@exemplo.com" />
            </label>
          </div>
          {!editing && (
            <label>token pessoal (PAT)
              <input type="password" value={form.token} onChange={e => setForm(f => ({ ...f, token: e.target.value }))} placeholder="ghp_… ou github_pat_…" autoComplete="off" />
            </label>
          )}
          <label>quais projetos tem nessa conta (entra no prompt de toda sessão)
            <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={4}
              placeholder="ex.: dona dos repos bayerlcloud/branspace, fisioexpert, trackingmachine, bayerlstudio…" />
          </label>
          <div className="tls-form-actions">
            <button className="btn-primary" onClick={save} disabled={busy || !form.label.trim() || (!editing && !form.token.trim())}>{busy ? 'Validando…' : editing ? 'Salvar' : 'Conectar'}</button>
            <button onClick={() => { setShowForm(false); setEditing(null); }} disabled={busy}>Cancelar</button>
          </div>
        </div>
      )}

      {contas.length === 0 ? (
        <div className="tls-empty">Nenhuma conta GitHub ainda.{admin && <> Clique em <b>+ Conta</b> e cole um token pessoal.</>}</div>
      ) : (
        <div className="tls-grid">
          {contas.map(c => (
            <div key={c.id} className="tls-card is-mcp is-conta">
              <div className="tls-card-top"><span className="tls-icon">🐙</span><span className="tls-badge is-mcp">MCP</span></div>
              <div>
                <div className="tls-name">{c.label}</div>
                <div className="tls-sub" title={c.email}>{c.login}{c.email && ` · ${c.email}`}</div>
              </div>
              <dl className="tls-rows">
                <dt>tools</dt><dd className="cp" title="clique para copiar" onClick={() => copiar(`mcp__${c.mcp}__`)}>mcp__{c.mcp}__*</dd>
                <dt>token</dt><dd>{c.token_hint}</dd>
              </dl>
              <ToolsNotas texto={c.notes} />
              {admin && (
                <div className="tls-card-foot">
                  <span className="tls-spacer" />
                  <button className="tls-icon-btn" onClick={() => startEdit(c)} title="Editar nome e explicação">✎</button>
                  <button className="tls-icon-btn" onClick={() => remove(c)} title="Remover">🗑</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
