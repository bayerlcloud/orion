import { useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import { api, type User } from '../api';

type Doc = { id: string; title: string; markdown: string };
type Inventory = {
  coletado_em: string;
  c3: Record<string, string>;
  versoes: Record<string, string>;
  servicos: Record<string, string>;
  servidores: { apelido: string; ip: string; provedor: string; specs: string; papel: string; servicos: string }[];
};
type Usuario = { id: number; name: string; email: string; role: string; linux_user: string | null; ultimo_login: string | null };

export default function Spec({ user }: { user: User }) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [inv, setInv] = useState<Inventory | null>(null);
  const [users, setUsers] = useState<Usuario[]>([]);
  const [tab, setTab] = useState<string>('decisoes');
  const [erro, setErro] = useState('');

  useEffect(() => {
    api<{ docs: Doc[] }>('/api/spec/docs').then(r => setDocs(r.docs)).catch(e => setErro(e.message));
    api<Inventory>('/api/spec/inventory').then(setInv).catch(e => setErro(e.message));
    if (user.role === 'owner') api<{ users: Usuario[] }>('/api/users').then(r => setUsers(r.users)).catch(() => {});
  }, [user.role]);

  const tabs = useMemo(() => [
    ...docs.map(d => ({ id: d.id, label: d.title })),
    { id: 'instalado', label: 'Instalado' },
  ], [docs]);

  const doc = docs.find(d => d.id === tab);
  const html = useMemo(() => doc ? (marked.parse(doc.markdown) as string) : '', [doc]);

  return (
    <div>
      <h1>Spec</h1>
      {erro && <div className="erro">{erro}</div>}
      <div className="tabs">
        {tabs.map(t => <button key={t.id} className={t.id === tab ? 'active' : ''} onClick={() => setTab(t.id)}>{t.label}</button>)}
      </div>
      {doc && <article className="md" dangerouslySetInnerHTML={{ __html: html }} />}
      {tab === 'instalado' && (
        !inv ? <p className="muted">coletando…</p> : (
          <div className="md">
            <h2>c3 · 217.76.55.249 · Orion novo</h2>
            <table>
              <tbody>
                {Object.entries(inv.c3).map(([k, v]) => <tr key={k}><th>{k.replace('_', ' ')}</th><td>{v}</td></tr>)}
              </tbody>
            </table>
            <h3>Versões</h3>
            <table><tbody>{Object.entries(inv.versoes).map(([k, v]) => <tr key={k}><th>{k}</th><td>{v}</td></tr>)}</tbody></table>
            <h3>Serviços</h3>
            <table><tbody>{Object.entries(inv.servicos).map(([k, v]) => <tr key={k}><th>{k}</th><td className={v === 'active' ? '' : 'muted'}>{v}</td></tr>)}</tbody></table>
            <h2>Todos os servidores</h2>
            <table>
              <thead><tr><th>apelido</th><th>ip</th><th>provedor</th><th>specs</th><th>papel</th><th>principais serviços</th></tr></thead>
              <tbody>
                {inv.servidores.map(s => <tr key={s.ip}><td>{s.apelido}</td><td>{s.ip}</td><td>{s.provedor}</td><td>{s.specs}</td><td>{s.papel}</td><td>{s.servicos}</td></tr>)}
              </tbody>
            </table>
            {user.role === 'owner' && users.length > 0 && (
              <>
                <h2>Usuários</h2>
                <table>
                  <thead><tr><th>nome</th><th>email</th><th>papel</th><th>usuário linux</th><th>último login</th></tr></thead>
                  <tbody>
                    {users.map(u => <tr key={u.id}><td>{u.name}</td><td>{u.email}</td><td>{u.role === 'owner' ? 'admin' : 'membro'}</td><td>{u.linux_user ?? '—'}</td><td>{u.ultimo_login ? new Date(u.ultimo_login).toLocaleString('pt-BR') : 'nunca'}</td></tr>)}
                  </tbody>
                </table>
              </>
            )}
            <p className="muted small">coletado em {new Date(inv.coletado_em).toLocaleString('pt-BR')}</p>
          </div>
        )
      )}
    </div>
  );
}
