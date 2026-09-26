import { useEffect, useState } from 'react';
import { api, type User } from '../api';

type Settings = {
  claude: { token_set: boolean; token_hint: string | null; linux_user: string | null };
  defaults: { permission_mode: string; model: string; max_budget_usd: number };
  meta: { key: string; updated_at: string; updated_by: string | null }[];
};
type LoginSnap = { state: 'idle' | 'starting' | 'awaiting_code' | 'exchanging' | 'done' | 'error'; url: string | null; error: string | null; output_tail: string };
type TestResult = { ok: boolean; model: string; reply: string; cost_usd: number; ms: number; error: string | null; via: string };

export default function Config({ user }: { user: User }) {
  const [s, setS] = useState<Settings | null>(null);
  const [token, setToken] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [mode, setMode] = useState('acceptEdits');
  const [model, setModel] = useState('');
  const [budget, setBudget] = useState(5);
  const [login, setLogin] = useState<LoginSnap | null>(null);
  const [code, setCode] = useState('');
  const [showLog, setShowLog] = useState(false);

  async function load() {
    try {
      const r = await api<Settings>('/api/settings');
      setS(r); setMode(r.defaults.permission_mode); setModel(r.defaults.model); setBudget(r.defaults.max_budget_usd);
    } catch (e: any) { setMsg(e.message); }
  }
  async function loadLoginFlow() {
    try {
      const r = await api<LoginSnap>('/api/settings/claude-login');
      if (r.state === 'awaiting_code' || r.state === 'exchanging' || r.state === 'starting') setLogin(r);
    } catch { /* sem fluxo */ }
  }
  useEffect(() => { void load(); void loadLoginFlow(); }, []);

  if (user.role !== 'owner') return <div><h1>Configurações</h1><p className="muted">Só o admin vê esta página.</p></div>;

  async function saveToken() {
    setBusy(true); setMsg(''); setTest(null);
    try { await api('/api/settings/claude-token', { method: 'PUT', body: JSON.stringify({ token }) }); setToken(''); setMsg('Token salvo. Ele vale para todas as sessões e para os agentes do Orion.'); await load(); }
    catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  }
  async function removeToken() {
    if (!window.confirm('Remover o token? As sessões param de funcionar até colocar outro.')) return;
    setBusy(true); try { await api('/api/settings/claude-token', { method: 'DELETE' }); setMsg('Token removido.'); await load(); } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  }
  async function runTest() {
    setBusy(true); setTest(null); setMsg('');
    try { setTest(await api<TestResult>('/api/settings/claude-token/test', { method: 'POST' })); } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  }
  async function startLogin() {
    setBusy(true); setMsg(''); setTest(null); setCode('');
    try { setLogin(await api<LoginSnap>('/api/settings/claude-login/start', { method: 'POST' })); } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  }
  async function sendCode() {
    setBusy(true); setMsg('');
    try {
      const r = await api<LoginSnap>('/api/settings/claude-login/code', { method: 'POST', body: JSON.stringify({ code }) });
      setLogin(r);
      if (r.state === 'done') { setMsg('Conta conectada. O token de 1 ano ficou salvo na Central.'); setCode(''); await load(); }
    } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  }
  async function cancelLogin() { try { setLogin(await api<LoginSnap>('/api/settings/claude-login/cancel', { method: 'POST' })); } catch { /* ignora */ } }
  async function saveDefaults() {
    setBusy(true); setMsg('');
    try { await api('/api/settings/defaults', { method: 'PUT', body: JSON.stringify({ permission_mode: mode, model, max_budget_usd: budget }) }); setMsg('Padrões salvos.'); await load(); }
    catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="cfg">
      <h1>Configurações</h1>
      {msg && <div className="erro">{msg}</div>}

      <section className="cfg-box">
        <h2>Conta Claude (Max 20x)</h2>
        <p>Uma conta alimenta tudo: as sessões de todo mundo e os agentes do próprio Orion. O login fica no servidor, na Central, e nunca no navegador.</p>
        <table><tbody>
          <tr><th>situação</th><td>{s ? (s.claude.token_set ? <>token configurado <span className="mono">{s.claude.token_hint}</span></> : 'sem token') : '…'}</td></tr>
          <tr><th>processo</th><td>usuário linux <span className="mono">{s?.claude.linux_user ?? '?'}</span> na c3</td></tr>
        </tbody></table>
        <h3>Conectar pelo navegador</h3>
        {(!login || login.state === 'idle' || login.state === 'error' || login.state === 'done') && (
          <div className="cfg-actions">
            <button className="btn-primary" onClick={startLogin} disabled={busy}>{s?.claude.token_set ? 'Conectar outra conta' : 'Conectar conta Claude'}</button>
            <button onClick={runTest} disabled={busy}>Testar conexão</button>
            {s?.claude.token_set && <button onClick={removeToken} disabled={busy}>Desconectar</button>}
          </div>
        )}
        {login && login.state === 'error' && <div className="cfg-test is-bad">Não deu: <span className="mono">{login.error}</span></div>}
        {login && (login.state === 'starting') && <p className="muted">Preparando o link…</p>}
        {login && (login.state === 'awaiting_code' || login.state === 'exchanging') && (
          <div className="cfg-login">
            <ol>
              <li>Abra o link e autorize com a conta Max: {login.url ? <a href={login.url} target="_blank" rel="noopener noreferrer">abrir claude.com para autorizar</a> : <span className="muted">gerando link…</span>}</li>
              <li>A página mostra um código. Cole aqui:</li>
            </ol>
            <div className="cfg-code-row">
              <input value={code} onChange={e => setCode(e.target.value)} placeholder="código de autorização" autoComplete="off" onKeyDown={e => { if (e.key === 'Enter' && code.trim()) void sendCode(); }} />
              <button className="btn-primary" onClick={sendCode} disabled={busy || !code.trim() || login.state !== 'awaiting_code'}>{login.state === 'exchanging' ? 'Validando…' : 'Enviar código'}</button>
              <button onClick={cancelLogin} disabled={busy}>Cancelar</button>
            </div>
          </div>
        )}
        {login && login.state === 'done' && <div className="cfg-test">Conectado. Clique em "Testar conexão" para ver o modelo respondendo.</div>}
        {login && login.output_tail && (
          <p className="muted small"><button className="link" onClick={() => setShowLog(v => !v)}>{showLog ? 'esconder' : 'ver'} o que o login está dizendo</button></p>
        )}
        {login && showLog && <pre className="cfg-log">{login.output_tail}</pre>}

        <details className="cfg-details">
          <summary>Ou colar um token gerado no terminal</summary>
          <p className="muted small">No Mac: <span className="mono">claude setup-token</span>. Cole o resultado aqui.</p>
          <label>token
            <input type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="sk-ant-…" autoComplete="off" />
          </label>
          <div className="cfg-actions"><button onClick={saveToken} disabled={busy || !token.trim()}>Salvar token</button></div>
        </details>
        {test && (
          <div className={`cfg-test ${test.ok ? '' : 'is-bad'}`}>
            {test.ok
              ? <>Funcionou via {test.via}. Modelo <span className="mono">{test.model}</span>, resposta "{test.reply}", {test.ms} ms, custo US$ {test.cost_usd.toFixed(4)}.</>
              : <>Falhou via {test.via}: <span className="mono">{test.error}</span></>}
          </div>
        )}
      </section>

      <section className="cfg-box">
        <h2>Padrões das sessões</h2>
        <div className="cfg-grid">
          <label>modo de permissão
            <select value={mode} onChange={e => setMode(e.target.value)}>
              <option value="acceptEdits">Edição automática (edita arquivos sem perguntar; comandos perguntam)</option>
              <option value="default">Manual (pergunta tudo)</option>
              <option value="plan">Plan (só lê e planeja)</option>
              <option value="auto">Auto (classificador aprova; exige conta com auto)</option>
            </select>
          </label>
          <label>modelo (vazio = padrão da conta)
            <input value={model} onChange={e => setModel(e.target.value)} placeholder="ex.: claude-fable-5-1" />
          </label>
          <label>orçamento máximo por sessão (US$)
            <input type="number" min={1} max={500} step={1} value={budget} onChange={e => setBudget(Number(e.target.value))} />
          </label>
        </div>
        <div className="cfg-actions"><button className="btn-primary" onClick={saveDefaults} disabled={busy}>Salvar padrões</button></div>
        <p className="muted small">O modo que pula permissões está bloqueado na c3 por configuração gerenciada e não aparece aqui de propósito.</p>
      </section>

      {s && s.meta.length > 0 && (
        <section className="cfg-box">
          <h2>Histórico</h2>
          <table><thead><tr><th>chave</th><th>alterado por</th><th>quando</th></tr></thead>
            <tbody>{s.meta.map(m => <tr key={m.key}><td className="mono">{m.key}</td><td>{m.updated_by ?? '—'}</td><td>{new Date(m.updated_at).toLocaleString('pt-BR')}</td></tr>)}</tbody></table>
        </section>
      )}
    </div>
  );
}
