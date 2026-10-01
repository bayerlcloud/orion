import { Fragment, useEffect, useState } from 'react';
import { api } from '../api';
import { confirmar } from '../dialogo';

type App = { id: number; nome: string; webhook_url: string | null; apelidos: string[]; limite_diario: number; ativo: boolean; enviados_hoje: number; pendentes: number; falhos: number; ultimo_erro: string | null };
type Regra = { id: number; app_id: number; contato: string; modo: 'ouvir' | 'conversar'; nome: string };
type Contato = { contato: string; nome: string };
type Estado = { apps: App[]; regras: Regra[]; apelidos: { apelido: string; instancia: string }[] };
const APELIDOS = ['alertas', 'conversa'];

/** Card "Apps do WhatsApp" em Configurações: os SaaS que usam o gateway orion-wa (token, webhook, apelidos, limite)
 *  e as regras de entrada de cada um (ouvir = recebe sem responder; conversar = recebe e responde, um dono só). */
export default function WhatsappAppsCard() {
  const [s, setS] = useState<Estado | null>(null);
  const [contatos, setContatos] = useState<{ grupos: Contato[]; pessoas: Contato[] }>({ grupos: [], pessoas: [] });
  const [novo, setNovo] = useState({ nome: '', webhook_url: '', apelidos: ['alertas'] });
  const [segredos, setSegredos] = useState<{ app: string; token: string; segredo?: string } | null>(null);
  const [regra, setRegra] = useState<Record<number, { contato: string; modo: string }>>({});
  const [msg, setMsg] = useState('');

  async function load() {
    try { setS(await api<Estado>('/api/whatsapp/apps')); } catch (e: any) { setMsg(e.message); }
  }
  useEffect(() => { void load(); api<typeof contatos>('/api/whatsapp/contatos').then(setContatos, () => {}); }, []);

  async function agir(fn: () => Promise<unknown>) {
    setMsg('');
    try { await fn(); await load(); } catch (e: any) { setMsg(e.message); }
  }
  const criar = () => agir(async () => {
    const r = await api<{ token: string; segredo: string }>('/api/whatsapp/apps', { method: 'POST', body: JSON.stringify(novo) });
    setSegredos({ app: novo.nome, ...r }); setNovo({ nome: '', webhook_url: '', apelidos: ['alertas'] });
  });
  const mudar = (a: App, b: Partial<App>) => agir(() => api(`/api/whatsapp/apps/${a.id}`, { method: 'PUT', body: JSON.stringify(b) }));
  const trocarToken = (a: App) => agir(async () => {
    if (!(await confirmar(`Gerar token novo para ${a.nome}? O atual para de funcionar na hora.`, { perigo: true }))) return;
    const r = await api<{ token: string }>(`/api/whatsapp/apps/${a.id}/token`, { method: 'POST' });
    setSegredos({ app: a.nome, token: r.token });
  });
  const apagar = (a: App) => agir(async () => {
    if (!(await confirmar(`Apagar o app ${a.nome} e as regras dele?`, { perigo: true }))) return;
    await api(`/api/whatsapp/apps/${a.id}`, { method: 'DELETE' });
  });
  const addRegra = (a: App) => agir(async () => {
    const r = regra[a.id]; if (!r?.contato) return;
    const nome = [...contatos.grupos, ...contatos.pessoas].find(c => c.contato === r.contato)?.nome ?? '';
    await api('/api/whatsapp/regras', { method: 'POST', body: JSON.stringify({ app_id: a.id, contato: r.contato, modo: r.modo || 'ouvir', nome }) });
    setRegra(x => ({ ...x, [a.id]: { contato: '', modo: r.modo } }));
  });
  const delRegra = (r: Regra) => agir(() => api(`/api/whatsapp/regras/${r.id}`, { method: 'DELETE' }));

  return (
    <section className="cfg-box">
      <h2>Apps do WhatsApp (gateway)</h2>
      <p>Cada SaaS fala com <span className="mono">https://orion.bayerl.cloud/wa</span> como se fosse uma Evolution, com token próprio e um apelido: <b>alertas</b> envia para qualquer destino; <b>conversa</b> só para quem tem regra conversar. Regras de entrada: <b>ouvir</b> repassa sem permitir resposta; <b>conversar</b> repassa e permite resposta (um dono por contato). Contato sem regra fica só no Orion.</p>
      {s && <p className="muted small">Apelidos: {s.apelidos.map(a => <Fragment key={a.apelido}><span className="mono">{a.apelido}</span> → {a.instancia} </Fragment>)}</p>}
      {msg && <div className="cfg-test is-bad">{msg}</div>}
      {segredos && (
        <div className="cfg-test">
          Guarde agora, não aparece de novo ({segredos.app}): token <span className="mono">{segredos.token}</span>
          {segredos.segredo && <> · segredo HMAC <span className="mono">{segredos.segredo}</span></>}{' '}
          <button onClick={() => setSegredos(null)}>ok</button>
        </div>
      )}

      {s?.apps.map(a => (
        <div key={a.id} className="cfg-details" style={{ marginTop: 12 }}>
          <table><tbody>
            <tr><th>{a.nome}</th><td>
              <label><input type="checkbox" checked={a.ativo} onChange={e => mudar(a, { ativo: e.target.checked })} /> ativo</label>{' · '}
              {APELIDOS.map(ap => <label key={ap}><input type="checkbox" checked={a.apelidos.includes(ap)} onChange={e => mudar(a, { apelidos: e.target.checked ? [...a.apelidos, ap] : a.apelidos.filter(x => x !== ap) })} /> {ap} </label>)}
              {' · '}hoje {a.enviados_hoje}/{a.limite_diario}
              {a.pendentes > 0 && <> · <span className="is-bad">{a.pendentes} repasses pendentes</span></>}
              {a.falhos > 0 && <> · <span className="is-bad">{a.falhos} desistidos</span></>}
              {a.ultimo_erro && <div className="muted small mono">{a.ultimo_erro}</div>}
            </td></tr>
            <tr><th>webhook</th><td>
              <input defaultValue={a.webhook_url ?? ''} placeholder="sem webhook: só dispara" onBlur={e => e.target.value.trim() !== (a.webhook_url ?? '') && mudar(a, { webhook_url: e.target.value.trim() })} style={{ width: '100%' }} />
            </td></tr>
            <tr><th>limite/dia</th><td>
              <input type="number" min={1} defaultValue={a.limite_diario} onBlur={e => Number(e.target.value) !== a.limite_diario && mudar(a, { limite_diario: Number(e.target.value) })} style={{ width: 90 }} />{' '}
              <button onClick={() => trocarToken(a)}>Novo token</button> <button onClick={() => apagar(a)}>Apagar app</button>
            </td></tr>
            <tr><th>regras</th><td>
              {s.regras.filter(r => r.app_id === a.id).map(r => (
                <div key={r.id} className="small">
                  <span className={r.modo === 'conversar' ? '' : 'muted'}>{r.modo}</span> · {r.nome || '—'} <span className="mono muted">{r.contato}</span>{' '}
                  <button className="tls-icon-btn" title="Remover regra" onClick={() => delRegra(r)}>✕</button>
                </div>
              ))}
              <div className="cfg-code-row">
                <input list={`wa-contatos-${a.id}`} value={regra[a.id]?.contato ?? ''} placeholder="grupo (jid) ou número com DDI"
                  onChange={e => setRegra(x => ({ ...x, [a.id]: { contato: e.target.value, modo: x[a.id]?.modo ?? 'ouvir' } }))} />
                <datalist id={`wa-contatos-${a.id}`}>
                  {contatos.grupos.map(c => <option key={c.contato} value={c.contato}>{`grupo: ${c.nome}`}</option>)}
                  {contatos.pessoas.map(c => <option key={c.contato} value={c.contato}>{c.nome || c.contato}</option>)}
                </datalist>
                <select value={regra[a.id]?.modo ?? 'ouvir'} onChange={e => setRegra(x => ({ ...x, [a.id]: { contato: x[a.id]?.contato ?? '', modo: e.target.value } }))}>
                  <option value="ouvir">ouvir</option><option value="conversar">conversar</option>
                </select>
                <button onClick={() => addRegra(a)} disabled={!regra[a.id]?.contato}>Adicionar</button>
              </div>
            </td></tr>
          </tbody></table>
        </div>
      ))}

      <h3 className="small" style={{ marginTop: 16 }}>Novo app</h3>
      <div className="cfg-code-row">
        <input value={novo.nome} onChange={e => setNovo({ ...novo, nome: e.target.value })} placeholder="nome (ex.: trackingmachine)" style={{ maxWidth: 200 }} />
        <input value={novo.webhook_url} onChange={e => setNovo({ ...novo, webhook_url: e.target.value })} placeholder="webhook (opcional)" />
        {APELIDOS.map(ap => <label key={ap} className="small"><input type="checkbox" checked={novo.apelidos.includes(ap)} onChange={e => setNovo({ ...novo, apelidos: e.target.checked ? [...novo.apelidos, ap] : novo.apelidos.filter(x => x !== ap) })} /> {ap}</label>)}
        <button className="btn-primary" onClick={criar} disabled={!novo.nome.trim()}>Criar</button>
      </div>
    </section>
  );
}
