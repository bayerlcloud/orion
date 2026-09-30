import { useEffect, useState } from 'react';
import { api } from '../api';

type Projeto = { id: number; name: string; slug: string };
type Estado = { configurado: boolean; mascarado: string | null };

/**
 * Card "Banco de produção (backup)" da aba Configurações: a URL do banco de cada projeto, usada só
 * para o pg_dump antes de SQL destrutivo e para o backup noturno (spec 2026-09-30-preview-design, Parte 3).
 */
export default function DbBackupCard() {
  const [projetos, setProjetos] = useState<Projeto[]>([]);
  const [estado, setEstado] = useState<Record<number, Estado>>({});
  const [edit, setEdit] = useState<Record<number, string>>({});
  const [msg, setMsg] = useState('');

  async function load() {
    try {
      const ps = (await api<{ projects: Projeto[] }>('/api/claude/projects')).projects;
      setProjetos(ps);
      const pares = await Promise.all(ps.map(async p => [p.id, await api<Estado>(`/api/projects/${p.id}/db-url`)] as const));
      setEstado(Object.fromEntries(pares));
    } catch (e: any) { setMsg(e.message); }
  }
  useEffect(() => { void load(); }, []);

  async function salvar(id: number, url: string | null) {
    setMsg('');
    try {
      const r = await api<Estado>(`/api/projects/${id}/db-url`, { method: 'PUT', body: JSON.stringify({ url }) });
      setEstado(s => ({ ...s, [id]: r })); setEdit(e => ({ ...e, [id]: '' }));
    } catch (e: any) { setMsg(e.message); }
  }

  return (
    <section className="cfg-box">
      <h2>Banco de produção (backup)</h2>
      <p>URL <span className="mono">postgres://</span> do banco de cada projeto. Com ela, o Orion faz <span className="mono">pg_dump</span> da tabela antes de qualquer SQL destrutivo aprovado e um backup completo toda noite (7 dias em <span className="mono">/srv/backups/db</span>). Sem ela, o cartão de SQL destrutivo avisa que não há backup.</p>
      <table><tbody>
        {projetos.map(p => (
          <tr key={p.id}>
            <th>{p.name}</th>
            <td>
              {estado[p.id]?.configurado ? <span className="mono">{estado[p.id].mascarado}</span> : <span className="muted small">sem URL</span>}
              <div className="cfg-actions">
                <input type="password" placeholder="postgres://..." value={edit[p.id] ?? ''} onChange={e => setEdit(s => ({ ...s, [p.id]: e.target.value }))} />
                <button onClick={() => salvar(p.id, (edit[p.id] ?? '').trim())} disabled={!(edit[p.id] ?? '').trim()}>Salvar</button>
                {estado[p.id]?.configurado && <button onClick={() => salvar(p.id, null)}>Remover</button>}
              </div>
            </td>
          </tr>
        ))}
      </tbody></table>
      {msg && <p className="small bad">{msg}</p>}
    </section>
  );
}
