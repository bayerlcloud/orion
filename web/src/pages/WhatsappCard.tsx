import { useEffect, useState } from 'react';
import { api } from '../api';
import { confirmar } from '../dialogo';

type Inst = { nome: string; status: string; numero: string; perfil: string };
type Msg = { id: number; direcao: 'entra' | 'sai'; remoto: string; nome: string; tipo: string; texto: string; ts: string; enviado_por: string | null };
type Estado = { instancia: string | null; atual: Inst | null; webhook: { url: string; ligado: boolean; nosso: boolean } | null; disponiveis: Inst[]; mensagens: Msg[] };

/** Card "WhatsApp do Orion" em Configurações: vincula uma instância da Evolution (webhook aponta para o Orion),
 *  mostra o que entra e sai e manda uma mensagem de teste. Fase 1 do gateway. */
export default function WhatsappCard() {
  const [s, setS] = useState<Estado | null>(null);
  const [escolha, setEscolha] = useState('');
  const [numero, setNumero] = useState('');
  const [texto, setTexto] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    try { const r = await api<Estado>('/api/whatsapp'); setS(r); setEscolha(e => e || r.instancia || ''); } catch (e: any) { setMsg(e.message); }
  }
  useEffect(() => { void load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, []);

  async function vincular() {
    if (s?.instancia && s.instancia !== escolha && !(await confirmar(`Trocar de ${s.instancia} para ${escolha}? O webhook de ${escolha} passa a apontar para o Orion.`))) return;
    const outro = s?.disponiveis.find(i => i.nome === escolha);
    if (s?.webhook && !s.webhook.nosso && s.instancia === escolha && !(await confirmar('O webhook dessa instância aponta para outro lugar. Trocar para o Orion?', { perigo: true }))) return;
    setBusy(true); setMsg('');
    try { await api('/api/whatsapp', { method: 'PUT', body: JSON.stringify({ instancia: escolha }) }); setMsg(`${outro?.nome ?? escolha} vinculada ao Orion.`); await load(); }
    catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  }
  async function enviar() {
    setBusy(true); setMsg('');
    try { await api('/api/whatsapp/enviar', { method: 'POST', body: JSON.stringify({ numero, texto }) }); setTexto(''); await load(); }
    catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  }

  const a = s?.atual;
  return (
    <section className="cfg-box">
      <h2>WhatsApp do Orion</h2>
      <p>Uma instância da Evolution (<span className="mono">evo.bayerl.cloud</span>, contabo 01) ligada ao Orion: o webhook dela aponta para cá e tudo que entra e sai fica registrado.</p>
      {msg && <div className="cfg-test">{msg}</div>}
      <table><tbody>
        <tr><th>instância</th><td>
          <select value={escolha} onChange={e => setEscolha(e.target.value)}>
            <option value="">escolha…</option>
            {s?.disponiveis.map(i => <option key={i.nome} value={i.nome}>{i.nome} ({i.status})</option>)}
          </select>{' '}
          <button className="btn-primary" onClick={vincular} disabled={busy || !escolha || (escolha === s?.instancia && !!s?.webhook?.nosso && !!s?.webhook?.ligado)}>
            {escolha && escolha === s?.instancia ? 'Religar webhook' : 'Conectar ao Orion'}
          </button>
        </td></tr>
        {a && <tr><th>situação</th><td>{a.status === 'open' ? 'conectada' : a.status}{a.numero && <> · <span className="mono">+{a.numero}</span></>}{a.perfil && <> · {a.perfil}</>}</td></tr>}
        {s?.webhook && <tr><th>webhook</th><td>{s.webhook.nosso && s.webhook.ligado ? 'apontando para o Orion' : <span className="is-bad">não aponta para o Orion</span>} <span className="mono small">{s.webhook.url || 'nenhum'}</span></td></tr>}
      </tbody></table>

      {s?.instancia && (
        <>
          <div className="cfg-code-row">
            <input value={numero} onChange={e => setNumero(e.target.value)} placeholder="5511999999999" style={{ maxWidth: 170 }} />
            <input value={texto} onChange={e => setTexto(e.target.value)} placeholder="mensagem de teste" onKeyDown={e => { if (e.key === 'Enter' && numero && texto.trim()) void enviar(); }} />
            <button onClick={enviar} disabled={busy || !numero || !texto.trim()}>Enviar</button>
          </div>
          <h3 className="small">Últimas mensagens</h3>
          {s.mensagens.length === 0 ? <p className="muted small">Nada ainda. Mande uma mensagem para o número da instância.</p> : (
            <table className="small"><tbody>
              {s.mensagens.map(m => (
                <tr key={m.id}>
                  <td className="muted">{new Date(m.ts).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</td>
                  <td>{m.direcao === 'entra' ? '←' : '→'}</td>
                  <td className="mono">{m.nome || `+${m.remoto}`}</td>
                  <td>{m.texto || <span className="muted">({m.tipo})</span>}{m.enviado_por && <span className="muted"> · {m.enviado_por}</span>}</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </>
      )}
    </section>
  );
}
