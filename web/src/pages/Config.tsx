import { useEffect, useState } from 'react';
import { api, type User } from '../api';

type Settings = {
  claude: { token_set: boolean; token_hint: string | null; linux_user: string | null };
  defaults: { permission_mode: string; model: string; max_budget_usd: number };
  meta: { key: string; updated_at: string; updated_by: string | null }[];
};
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

  async function load() {
    try {
      const r = await api<Settings>('/api/settings');
      setS(r); setMode(r.defaults.permission_mode); setModel(r.defaults.model); setBudget(r.defaults.max_budget_usd);
    } catch (e: any) { setMsg(e.message); }
  }
  useEffect(() => { void load(); }, []);

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
        <h3>Como gerar o token</h3>
        <ol>
          <li>No seu Mac, no terminal, logado na conta Max: <span className="mono">claude setup-token</span></li>
          <li>Ele abre o navegador, você autoriza, e o terminal mostra um token que começa com <span className="mono">sk-ant-</span>.</li>
          <li>Cole aqui e salve. Depois clique em "Testar conexão".</li>
        </ol>
        <label>token
          <input type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="sk-ant-…" autoComplete="off" />
        </label>
        <div className="cfg-actions">
          <button className="btn-primary" onClick={saveToken} disabled={busy || !token.trim()}>Salvar token</button>
          <button onClick={runTest} disabled={busy}>Testar conexão</button>
          {s?.claude.token_set && <button onClick={removeToken} disabled={busy}>Remover</button>}
        </div>
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
