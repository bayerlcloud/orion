import { useEffect, useState } from 'react';
import { api } from '../api';

type Status = { estado: 'fila' | 'rodando' | 'ok' | 'falhou'; etapa: string; sha: string; msg: string; nome: string; por: string; inicio: string; fim: string | null };
type Resp = {
  main: { sha: string; data: string; msg: string }; no_ar: string; atual: Status | null;
  pedido: { ref: string; por: string; quando: string } | null; historico: Status[]; ativo: boolean;
};
const ESTADO: Record<Status['estado'], string> = { fila: 'na fila', rodando: 'rodando', ok: 'publicado', falhou: 'falhou' };
const quando = (iso: string) => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';

/** Card "Publicar" da aba Configurações: pede o build, acompanha o log e mostra o histórico. */
export default function DeployCard() {
  const [d, setD] = useState<Resp | null>(null);
  const [log, setLog] = useState('');
  const [verLog, setVerLog] = useState(false);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    try { setD(await api<Resp>('/api/deploy')); } catch (e: any) { setMsg(e.message); }
  }
  async function loadLog(nome?: string) {
    try { setLog((await api<{ log: string }>(`/api/deploy/log?n=300${nome ? `&nome=${nome}` : ''}`)).log); } catch { /* sem log ainda */ }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!d?.ativo) return;
    const t = setInterval(() => { void load(); if (verLog) void loadLog(); }, 2500);
    return () => clearInterval(t);
  }, [d?.ativo, verLog]);

  async function publicar() {
    if (!window.confirm('Publicar a main agora? Entra na fila, roda os testes e troca a versão no ar; se falhar, volta sozinho.')) return;
    setBusy(true); setMsg('');
    try { const r = await api<{ aviso: string }>('/api/deploy', { method: 'POST', body: JSON.stringify({ ref: 'main' }) }); setMsg(r.aviso); setVerLog(true); await load(); await loadLog(); }
    catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  }

  const a = d?.atual;
  const noAr = d?.no_ar ?? '?';
  const noArSha = noAr.split('-')[0];
  const atrasado = d && !d.ativo && d.main.sha && !noAr.startsWith(d.main.sha) && !noAr.startsWith('repo');

  return (
    <section className="cfg-box">
      <h2>Publicar (deploy do Orion)</h2>
      <p>Um clique: checkout limpo da <span className="mono">main</span>, typecheck, testes, build, troca da versão no ar e volta automática se o painel não responder. Um build por vez, em fila com os builds manuais dos agentes.</p>
      <table><tbody>
        <tr><th>main</th><td>{d ? <><span className="mono">{d.main.sha}</span> {d.main.msg} <span className="muted small">({d.main.data})</span></> : '…'}</td></tr>
        <tr><th>no ar</th><td><span className="mono">{noAr}</span>{noAr.startsWith('repo') && <span className="muted small"> (ainda é o checkout de trabalho; o primeiro build pelo botão troca para um build limpo)</span>}{atrasado && <span className="tls-flag is-warn" style={{ marginLeft: 8 }}>main à frente do que está no ar</span>}</td></tr>
        {d?.pedido && <tr><th>pedido</th><td>{d.pedido.ref} por {d.pedido.por} <span className="muted small">({quando(d.pedido.quando)})</span>, esperando o systemd pegar</td></tr>}
        {a && <tr><th>{a.estado === 'ok' || a.estado === 'falhou' ? 'último build' : 'agora'}</th><td>
          <b className={a.estado === 'falhou' ? 'bad' : a.estado === 'ok' ? 'ok' : ''}>{ESTADO[a.estado]}</b>: {a.etapa} <span className="muted small">({a.sha}, por {a.por}, {quando(a.inicio)}{a.fim ? ` até ${quando(a.fim)}` : ''})</span>
        </td></tr>}
      </tbody></table>
      {msg && <p className="small">{msg}</p>}
      <div className="cfg-actions">
        <button className="btn-primary" onClick={publicar} disabled={busy || !!d?.ativo}>{d?.ativo ? 'Build em andamento…' : 'Publicar main'}</button>
        <button onClick={() => { setVerLog(v => !v); if (!verLog) void loadLog(); }}>{verLog ? 'Esconder log' : 'Ver log'}</button>
        <button onClick={load} disabled={busy}>Atualizar</button>
      </div>
      {verLog && <pre className="tls-md" style={{ maxHeight: '40vh', whiteSpace: 'pre-wrap', fontSize: 12 }}>{log || '(sem log ainda)'}</pre>}
      {d && d.historico.length > 0 && (
        <>
          <h3>Histórico</h3>
          <table><tbody>
            {d.historico.map(h => (
              <tr key={h.nome}>
                <td><span className={h.estado === 'ok' ? 'ok' : 'bad'}>{ESTADO[h.estado]}</span></td>
                <td><span className="mono">{h.sha}</span> {h.msg}</td>
                <td className="muted small">{h.por}, {quando(h.inicio)}</td>
                <td><button className="tls-icon-btn" onClick={() => { setVerLog(true); void loadLog(h.nome); }}>log</button></td>
              </tr>
            ))}
          </tbody></table>
        </>
      )}
    </section>
  );
}
