import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import './tools.css';

type Kind = 'tool' | 'skill' | 'mcp';
type ToolItem = {
  id: number; kind: Kind; name: string; description: string; icon: string; status: 'ativo' | 'inativo';
  link: string | null; created_by_name: string | null; created_at: string; updated_at: string;
};

const KIND_LABEL: Record<Kind, string> = { tool: 'Tool', skill: 'Skill', mcp: 'MCP' };
const KIND_ORDER: Kind[] = ['tool', 'skill', 'mcp'];

function emptyForm(): { kind: Kind; name: string; description: string; icon: string; link: string } {
  return { kind: 'tool', name: '', description: '', icon: '⚙️', link: '' };
}

export default function Tools() {
  const [items, setItems] = useState<ToolItem[]>([]);
  const [filter, setFilter] = useState<Kind | 'todos'>('todos');
  const [erro, setErro] = useState('');
  const [form, setForm] = useState(emptyForm());
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);

  async function load() {
    try { const r = await api<{ tools: ToolItem[] }>('/api/tools'); setItems(r.tools); }
    catch (e: any) { setErro(e.message); }
  }
  useEffect(() => { void load(); }, []);

  const counts = useMemo(() => {
    const c: Record<string, number> = { todos: items.length, tool: 0, skill: 0, mcp: 0 };
    for (const it of items) c[it.kind]++;
    return c;
  }, [items]);
  const visible = useMemo(() => filter === 'todos' ? items : items.filter(i => i.kind === filter), [items, filter]);

  function startCreate() { setEditing(null); setForm(emptyForm()); setShowForm(true); }
  function startEdit(it: ToolItem) {
    setEditing(it.id);
    setForm({ kind: it.kind, name: it.name, description: it.description, icon: it.icon, link: it.link ?? '' });
    setShowForm(true);
  }
  async function save() {
    if (!form.name.trim()) { setErro('nome é obrigatório'); return; }
    setBusy(true); setErro('');
    try {
      if (editing) await api(`/api/tools/${editing}`, { method: 'PUT', body: JSON.stringify(form) });
      else await api('/api/tools', { method: 'POST', body: JSON.stringify(form) });
      setShowForm(false); setForm(emptyForm()); setEditing(null);
      await load();
    } catch (e: any) { setErro(e.message); } finally { setBusy(false); }
  }
  async function toggleStatus(it: ToolItem) {
    try { await api(`/api/tools/${it.id}`, { method: 'PUT', body: JSON.stringify({ status: it.status === 'ativo' ? 'inativo' : 'ativo' }) }); await load(); }
    catch (e: any) { setErro(e.message); }
  }
  async function remove(it: ToolItem) {
    if (!window.confirm(`Apagar "${it.name}"?`)) return;
    try { await api(`/api/tools/${it.id}`, { method: 'DELETE' }); await load(); }
    catch (e: any) { setErro(e.message); }
  }

  return (
    <div className="tls">
      <div className="tls-head">
        <h1>Tools</h1>
        <button className="btn-primary" onClick={startCreate}>+ Nova</button>
      </div>
      <p className="muted small">Catálogo de tools gerenciadas, skills do Claude e MCPs. Cada card é uma entrada — abasteça pelo botão acima ou peça pro Claude cadastrar via API.</p>
      {erro && <div className="erro">{erro}</div>}

      <div className="tls-filters">
        <button className={`tls-chip ${filter === 'todos' ? 'is-on' : ''}`} onClick={() => setFilter('todos')}>Todos <span className="tls-count">{counts.todos}</span></button>
        {KIND_ORDER.map(k => (
          <button key={k} className={`tls-chip is-${k} ${filter === k ? 'is-on' : ''}`} onClick={() => setFilter(k)}>{KIND_LABEL[k]} <span className="tls-count">{counts[k]}</span></button>
        ))}
      </div>

      {showForm && (
        <div className="tls-form">
          <div className="tls-form-grid">
            <label>tipo
              <select value={form.kind} onChange={e => setForm(f => ({ ...f, kind: e.target.value as Kind }))}>
                {KIND_ORDER.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>
            </label>
            <label>ícone (emoji)
              <input value={form.icon} onChange={e => setForm(f => ({ ...f, icon: e.target.value }))} maxLength={4} />
            </label>
            <label className="tls-form-name">nome
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} autoFocus />
            </label>
          </div>
          <label>descrição
            <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={2} />
          </label>
          <label>link (opcional)
            <input value={form.link} onChange={e => setForm(f => ({ ...f, link: e.target.value }))} placeholder="repo, docs, config…" />
          </label>
          <div className="tls-form-actions">
            <button className="btn-primary" onClick={save} disabled={busy}>{editing ? 'Salvar' : 'Criar'}</button>
            <button onClick={() => { setShowForm(false); setEditing(null); }} disabled={busy}>Cancelar</button>
          </div>
        </div>
      )}

      {visible.length === 0 ? (
        <div className="tls-empty">Nenhuma entrada ainda. Clique em <b>+ Nova</b> pra cadastrar a primeira.</div>
      ) : (
        <div className="tls-grid">
          {visible.map(it => (
            <div key={it.id} className={`tls-card is-${it.kind} ${it.status === 'inativo' ? 'is-off' : ''}`}>
              <div className="tls-card-top">
                <span className="tls-icon">{it.icon}</span>
                <span className={`tls-badge is-${it.kind}`}>{KIND_LABEL[it.kind]}</span>
              </div>
              <div className="tls-name">{it.name}</div>
              {it.description && <p className="tls-desc">{it.description}</p>}
              {it.link && <a className="tls-link" href={it.link} target="_blank" rel="noopener">{it.link}</a>}
              <div className="tls-card-foot">
                <span className={`tls-dot is-${it.status}`} title={it.status} />
                <span className="tls-meta">{it.created_by_name ?? '—'}</span>
                <span className="tls-spacer" />
                <button className="tls-icon-btn" onClick={() => toggleStatus(it)} title={it.status === 'ativo' ? 'Marcar inativo' : 'Marcar ativo'}>{it.status === 'ativo' ? '⏸' : '▶'}</button>
                <button className="tls-icon-btn" onClick={() => startEdit(it)} title="Editar">✎</button>
                <button className="tls-icon-btn" onClick={() => remove(it)} title="Apagar">🗑</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
