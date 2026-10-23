import { useEffect, useRef, useState } from 'react';
import { api, type User } from '../api';
import { confirmar } from '../dialogo';
import './design.css';

type Item = { id: number; titulo: string; status: 'gerando' | 'pronto' | 'erro'; created_at: string; autor: string };
type HistoricoItem = { role: 'pedido' | 'ajuste'; texto: string; ts: string };
type Detalhe = Item & { tema: string; html: string | null; erro: string | null; historico: HistoricoItem[]; user_id: number; updated_at: string };

type Projeto = { id: number; nome: string; created_at: string; autor: string; arquivos: number };
type ProjetoArquivo = { id: number; nome: string; mime: string; size: number; created_at: string };
type ProjetoDetalhe = { id: number; nome: string; created_at: string; autor: string; arquivos: ProjetoArquivo[] };

export default function Design({ user }: { user: User }) {
  const [aba, setAba] = useState<'designs' | 'projetos'>('designs');
  const [itens, setItens] = useState<Item[]>([]);
  const [tema, setTema] = useState('');
  const [projetoRef, setProjetoRef] = useState('');
  const [aberto, setAberto] = useState<Detalhe | null>(null);
  const [instrucao, setInstrucao] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  // Refs (não estado) porque o polling roda num único setInterval criado uma vez: ler estado
  // ali dentro pegaria o valor "congelado" de quando o efeito rodou, não o atual.
  const itensRef = useRef<Item[]>([]);
  const abertoIdRef = useRef<number | null>(null);

  const [projetos, setProjetos] = useState<Projeto[]>([]);
  const [nomeProjetoNovo, setNomeProjetoNovo] = useState('');
  const [projetoAberto, setProjetoAberto] = useState<ProjetoDetalhe | null>(null);

  async function carregar() {
    try { const r = await api<{ designs: Item[] }>('/api/design'); setItens(r.designs); itensRef.current = r.designs; } catch (e: any) { setMsg(e.message); }
  }
  async function abrir(id: number) {
    abertoIdRef.current = id;
    try { setAberto(await api<Detalhe>(`/api/design/${id}`)); } catch (e: any) { setMsg(e.message); }
  }
  function fechar() { abertoIdRef.current = null; setAberto(null); }

  async function carregarProjetos() {
    try { setProjetos((await api<{ projects: Projeto[] }>('/api/design/projects')).projects); } catch (e: any) { setMsg(e.message); }
  }
  async function abrirProjeto(id: number) {
    try { setProjetoAberto(await api<ProjetoDetalhe>(`/api/design/projects/${id}`)); } catch (e: any) { setMsg(e.message); }
  }

  useEffect(() => { void carregar(); void carregarProjetos(); }, []);

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
    try {
      await api('/api/design', { method: 'POST', body: JSON.stringify({ tema, project_id: projetoRef ? Number(projetoRef) : undefined }) });
      setTema(''); await carregar();
    } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
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

  async function criarProjeto() {
    if (!nomeProjetoNovo.trim()) return;
    setBusy(true); setMsg('');
    try { await api('/api/design/projects', { method: 'POST', body: JSON.stringify({ nome: nomeProjetoNovo }) }); setNomeProjetoNovo(''); await carregarProjetos(); }
    catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  }
  async function subirArquivos(projectId: number, arquivos: FileList | null) {
    if (!arquivos || !arquivos.length) return;
    setBusy(true); setMsg('');
    try {
      const form = new FormData();
      for (const f of Array.from(arquivos)) form.append('files', f);
      // fetch direto (não api()): FormData precisa do boundary que o navegador gera sozinho no
      // Content-Type; api() força application/json sempre que tem corpo, o que quebraria o upload.
      const res = await fetch(`/api/design/projects/${projectId}/files`, { method: 'POST', body: form, credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as any).error ?? `erro ${res.status}`);
      await abrirProjeto(projectId); await carregarProjetos();
    } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  }
  async function apagarArquivo(projectId: number, fileId: number) {
    if (!(await confirmar('Apagar este arquivo?', { perigo: true }))) return;
    setBusy(true);
    try { await api(`/api/design/projects/${projectId}/files/${fileId}`, { method: 'DELETE' }); await abrirProjeto(projectId); await carregarProjetos(); }
    catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  }
  async function apagarProjeto(projeto: ProjetoDetalhe) {
    if (!(await confirmar(`Apagar o projeto "${projeto.nome}" e todos os arquivos dele?`, { perigo: true }))) return;
    setBusy(true);
    try { await api(`/api/design/projects/${projeto.id}`, { method: 'DELETE' }); setProjetoAberto(null); await carregarProjetos(); }
    catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="design">
      <h1>Design</h1>
      {msg && <div className="erro">{msg}</div>}

      <div className="design-abas">
        <button className={aba === 'designs' ? 'ativa' : ''} onClick={() => setAba('designs')}>Designs</button>
        <button className={aba === 'projetos' ? 'ativa' : ''} onClick={() => setAba('projetos')}>Projetos</button>
      </div>

      {aba === 'designs' && (
        <>
          <div className="design-form">
            <textarea value={tema} onChange={e => setTema(e.target.value)} placeholder="Descreva o design (ex.: cartão de visita minimalista, azul e branco)" rows={3} />
            <div className="design-form-linha">
              <select value={projetoRef} onChange={e => setProjetoRef(e.target.value)}>
                <option value="">usar projeto como referência: nenhum</option>
                {projetos.map(p => <option key={p.id} value={p.id}>usar como referência: {p.nome}</option>)}
              </select>
              <button className="btn-primary" onClick={gerar} disabled={busy || !tema.trim()}>gerar</button>
            </div>
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
        </>
      )}

      {aba === 'projetos' && (
        <>
          <div className="design-form">
            <input value={nomeProjetoNovo} onChange={e => setNomeProjetoNovo(e.target.value)} placeholder="Nome do cliente/projeto"
              onKeyDown={e => { if (e.key === 'Enter' && nomeProjetoNovo.trim()) void criarProjeto(); }} />
            <button className="btn-primary" onClick={criarProjeto} disabled={busy || !nomeProjetoNovo.trim()}>criar projeto</button>
          </div>

          <div className="design-grade">
            {projetos.map(p => (
              <button key={p.id} className="design-card" onClick={() => void abrirProjeto(p.id)}>
                <div className="design-card-titulo">{p.nome}</div>
                <div className="design-card-meta">{p.arquivos} arquivo(s) · {p.autor} · {new Date(p.created_at).toLocaleString('pt-BR')}</div>
              </button>
            ))}
          </div>

          {projetoAberto && (
            <div className="design-detalhe-fundo" onClick={() => setProjetoAberto(null)}>
              <div className="design-detalhe" onClick={e => e.stopPropagation()}>
                <div className="design-detalhe-topo">
                  <h2>{projetoAberto.nome}</h2>
                  <button onClick={() => void apagarProjeto(projetoAberto)} disabled={busy}>apagar projeto</button>
                  <button onClick={() => setProjetoAberto(null)}>fechar</button>
                </div>

                <label className="design-upload">
                  subir arquivo(s) ou .zip
                  <input type="file" multiple onChange={e => void subirArquivos(projetoAberto.id, e.target.files)} disabled={busy} />
                </label>

                <div className="design-arquivos-grade">
                  {projetoAberto.arquivos.map(a => (
                    <div key={a.id} className="design-arquivo">
                      {a.mime.startsWith('image/')
                        ? <img src={`/api/design/projects/${projetoAberto.id}/files/${a.id}/view`} alt={a.nome} />
                        : <div className="design-arquivo-ext">{a.nome.split('.').pop()}</div>}
                      <div className="design-arquivo-nome" title={a.nome}>{a.nome}</div>
                      <button onClick={() => void apagarArquivo(projetoAberto.id, a.id)} disabled={busy}>apagar</button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
