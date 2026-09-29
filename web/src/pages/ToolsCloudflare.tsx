import { useEffect, useState } from 'react';
import { api, type User } from '../api';

type Conta = { id: number; label: string; account_id: string; account_name: string; email: string; notes: string; mcp: string; token_hint: string };
const vazio = () => ({ label: '', account_id: '', token: '', email: '', notes: '' });

/** Contas Cloudflare: cada uma vira o MCP oficial (bindings) em toda sessão; a explicação entra no prompt. Só o admin mexe. */
export default function ToolsCloudflare({ user }: { user: User }) {
  const [contas, setContas] = useState<Conta[]>([]);
  const [erro, setErro] = useState('');
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Conta | null>(null);
  const [form, setForm] = useState(vazio());
  const admin = user.role === 'owner';

  async function load() {
    try { setContas((await api<{ contas: Conta[] }>('/api/tools/cloudflare')).contas); } catch (e: any) { setErro(e.message); }
  }
  useEffect(() => { void load(); }, []);

  function startCreate() { setEditing(null); setForm(vazio()); setShowForm(true); }
  function startEdit(c: Conta) { setEditing(c); setForm({ label: c.label, account_id: c.account_id, token: '', email: c.email, notes: c.notes }); setShowForm(true); }
  async function save() {
    setBusy(true); setErro('');
    try {
      if (editing) await api(`/api/tools/cloudflare/${editing.id}`, { method: 'PUT', body: JSON.stringify({ label: form.label, email: form.email, notes: form.notes }) });
      else await api('/api/tools/cloudflare', { method: 'POST', body: JSON.stringify(form) });
      setShowForm(false); setEditing(null); setForm(vazio()); await load();
    } catch (e: any) { setErro(e.message); } finally { setBusy(false); }
  }
  async function remove(c: Conta) {
    if (!window.confirm(`Remover a conta "${c.label}"? As sessões perdem as tools ${c.mcp}.`)) return;
    try { await api(`/api/tools/cloudflare/${c.id}`, { method: 'DELETE' }); await load(); } catch (e: any) { setErro(e.message); }
  }

  return (
    <>
      <div className="tls-sec-head" style={{ marginTop: 28 }}>
        <h2>Cloudflare</h2>
        {admin && <button className="btn-primary" onClick={startCreate} style={{ marginLeft: 12 }}>+ Conta</button>}
      </div>
      <p className="muted small">Cada conta vira o MCP oficial da Cloudflare em toda sessão (Workers, KV, R2, D1, Hyperdrive). A explicação diz ao Claude o que vive em cada conta.</p>
      {erro && <div className="erro">{erro}</div>}

      {showForm && (
        <div className="tls-form">
          <div className="tls-form-grid">
            <label className="tls-form-name">nome (as tools ficam mcp__cloudflare-&lt;nome&gt;__*)
              <input value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} placeholder="ex.: fisioexpert" autoFocus />
            </label>
            <label>e-mail de login
              <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="quem@exemplo.com" />
            </label>
          </div>
          {!editing && (
            <>
              <label>account ID (32 hex, no painel da Cloudflare)
                <input value={form.account_id} onChange={e => setForm(f => ({ ...f, account_id: e.target.value }))} placeholder="8df20ec9…" autoComplete="off" />
              </label>
              <label>token de API
                <input type="password" value={form.token} onChange={e => setForm(f => ({ ...f, token: e.target.value }))} placeholder="cfat_… ou cfut_…" autoComplete="off" />
              </label>
            </>
          )}
          <label>o que tem nessa conta (entra no prompt de toda sessão)
            <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={4}
              placeholder="ex.: Pages fisio.bayerl.cloud, bucket R2 dos uploads…" />
          </label>
          <div className="tls-form-actions">
            <button className="btn-primary" onClick={save} disabled={busy || !form.label.trim() || (!editing && (!form.token.trim() || !form.account_id.trim()))}>{busy ? 'Validando…' : editing ? 'Salvar' : 'Conectar'}</button>
            <button onClick={() => { setShowForm(false); setEditing(null); }} disabled={busy}>Cancelar</button>
          </div>
        </div>
      )}

      {contas.length === 0 ? (
        <div className="tls-empty">Nenhuma conta Cloudflare ainda.{admin && <> Clique em <b>+ Conta</b> e cole o account ID e um token de API.</>}</div>
      ) : (
        <div className="tls-grid">
          {contas.map(c => (
            <div key={c.id} className="tls-card is-mcp">
              <div className="tls-card-top"><span className="tls-icon">☁️</span><span className="tls-badge is-mcp">MCP</span></div>
              <div className="tls-name">{c.label}</div>
              <p className="tls-desc">conta <span className="mono">{c.account_name || c.account_id}</span>{c.email && <> · <span className="mono">{c.email}</span></>} · tools <span className="mono">mcp__{c.mcp}__*</span> · token <span className="mono">{c.token_hint}</span></p>
              {c.notes && <p className="tls-desc">{c.notes}</p>}
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
