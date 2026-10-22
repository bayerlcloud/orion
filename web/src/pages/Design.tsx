import { useEffect, useRef, useState } from 'react';
import { api, type User } from '../api';
import { confirmar } from '../dialogo';
import './design.css';

type Item = { id: number; titulo: string; status: 'gerando' | 'pronto' | 'erro'; created_at: string; autor: string };
type HistoricoItem = { role: 'pedido' | 'ajuste'; texto: string; ts: string };
type Detalhe = Item & { tema: string; html: string | null; erro: string | null; historico: HistoricoItem[]; user_id: number; updated_at: string };

export default function Design({ user }: { user: User }) {
  const [itens, setItens] = useState<Item[]>([]);
  const [tema, setTema] = useState('');
  const [aberto, setAberto] = useState<Detalhe | null>(null);
  const [instrucao, setInstrucao] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  // Refs (não estado) porque o polling roda num único setInterval criado uma vez: ler estado
  // ali dentro pegaria o valor "congelado" de quando o efeito rodou, não o atual.
  const itensRef = useRef<Item[]>([]);
  const abertoIdRef = useRef<number | null>(null);

  async function carregar() {
    try { const r = await api<{ designs: Item[] }>('/api/design'); setItens(r.designs); itensRef.current = r.designs; } catch (e: any) { setMsg(e.message); }
  }
  async function abrir(id: number) {
    abertoIdRef.current = id;
    try { setAberto(await api<Detalhe>(`/api/design/${id}`)); } catch (e: any) { setMsg(e.message); }
  }
  function fechar() { abertoIdRef.current = null; setAberto(null); }

  useEffect(() => { void carregar(); }, []);

  // Um intervalo só, criado uma vez: a cada 3s, recarrega a lista se algo estiver "gerando" e
  // reabre o detalhe se algo estiver aberto (abertoIdRef, não o estado, pra nunca reabrir um
  // detalhe que a pessoa já fechou).
  useEffect(() => {
    const id = setInterval(() => {
      if (itensRef.current.some(i => i.status === 'gerando')) void carregar();
      if (abertoIdRef.current !== null) void abrir(abertoIdRef.current);
    }, 3000);
    return () => clearInterval(id);
  }, []);

  async function gerar() {
    if (!tema.trim()) return;
    setBusy(true); setMsg('');
    try { await api('/api/design', { method: 'POST', body: JSON.stringify({ tema }) }); setTema(''); await carregar(); }
    catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  }
  async function ajustar() {
    if (!aberto || !instrucao.trim() || aberto.status === 'gerando') return;
    setBusy(true); setMsg('');
    try { await api(`/api/design/${aberto.id}/ajustar`, { method: 'POST', body: JSON.stringify({ instrucao }) }); setInstrucao(''); await abrir(aberto.id); await carregar(); }
    catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  }
  async function apagar(item: Detalhe) {
    if (!(await confirmar(`Apagar "${item.titulo}"?`, { perigo: true }))) return;
    setBusy(true);
    try { await api(`/api/design/${item.id}`, { method: 'DELETE' }); fechar(); await carregar(); }
    catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="design">
      <h1>Design</h1>
      {msg && <div className="erro">{msg}</div>}

      <div className="design-form">
        <textarea value={tema} onChange={e => setTema(e.target.value)} placeholder="Descreva o design (ex.: cartão de visita minimalista, azul e branco)" rows={3} />
        <button className="btn-primary" onClick={gerar} disabled={busy || !tema.trim()}>gerar</button>
      </div>

      <div className="design-grade">
        {itens.map(it => (
          <button key={it.id} className="design-card" onClick={() => void abrir(it.id)}>
            <div className="design-card-titulo">{it.titulo}</div>
            <div className={`design-badge is-${it.status}`}>{it.status}</div>
            <div className="design-card-meta">{it.autor} · {new Date(it.created_at).toLocaleString('pt-BR')}</div>
          </button>
        ))}
      </div>

      {aberto && (
        <div className="design-detalhe-fundo" onClick={fechar}>
          <div className="design-detalhe" onClick={e => e.stopPropagation()}>
            <div className="design-detalhe-topo">
              <h2>{aberto.titulo}</h2>
              {(aberto.user_id === user.id || user.role === 'owner') && <button onClick={() => void apagar(aberto)} disabled={busy}>apagar</button>}
              <button onClick={fechar}>fechar</button>
            </div>
            {aberto.status === 'pronto' && aberto.html && (
              <iframe className="design-preview" sandbox="allow-scripts" src={`/api/design/${aberto.id}/preview`} title={aberto.titulo} />
            )}
            {aberto.status === 'gerando' && <p className="muted">gerando… ({Math.max(0, Math.round((Date.now() - new Date(aberto.updated_at).getTime()) / 1000))}s)</p>}
            {aberto.status === 'erro' && <div className="erro">Falhou: {aberto.erro}</div>}

            <div className="design-ajuste">
              <input value={instrucao} onChange={e => setInstrucao(e.target.value)} placeholder="Pedir um ajuste (ex.: deixa o fundo escuro)"
                onKeyDown={e => { if (e.key === 'Enter' && !busy && instrucao.trim() && aberto.status !== 'gerando') void ajustar(); }} disabled={aberto.status === 'gerando'} />
              <button onClick={ajustar} disabled={busy || !instrucao.trim() || aberto.status === 'gerando'}>ajustar</button>
            </div>

            {aberto.historico.length > 0 && (
              <ul className="design-historico">
                {aberto.historico.map((h, i) => <li key={i}><span className="design-historico-papel">{h.role}</span> {h.texto}</li>)}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
