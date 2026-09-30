import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { agoIso } from './dashUtils';
import { formatTokens } from '../claude/mapper';

// Espelha server/projetos/coletar.ts (Ficha). Tudo opcional no uso: a tela aguenta campo faltando.
type Alerta = { nivel: 'ruim' | 'atencao'; texto: string };
type Ficha = {
  id: number; slug: string; name: string; path: string; existe: boolean;
  meta: { prod_url?: string; banco?: string; notas?: string };
  git: null | {
    branch: string; remote: string | null; github: string | null; ultimo: { sha: string; quando: string; autor: string; msg: string } | null;
    upstream: string | null; ahead: number | null; behind: number | null; ultimo_push: string | null; sujos: number; commits_7d: number;
    worktrees: { path: string; branch: string }[];
  };
  bancos: { tipo: string; onde: string; ref: string; url: string; principal: boolean; mencoes: number }[]; banco_fonte: string | null;
  arquitetura: { stack: string[]; resumo: string; fonte: string | null; atualizado: string | null; pastas: string[]; edge_functions: number };
  sessoes: { id: string; title: string; status: string; quem: string; quando: string; tokens: number }[]; sessoes_total: number;
  tokens: { quem: string; t7: number; t30: number }[];
  tarefas: { id: number; title: string; status: string; integracao: string | null; quem: string | null; quando: string }[];
  ultimo_mexeu: { quem: string; quando: string; onde: string } | null;
  backup: { itens: { oque: string; quando: string | null; detalhe: string }[] };
  deploy: null | { onde: string; quando: string | null; estado: string; detalhe: string; dominios: string[] };
  prod: null | { url: string; status: number | null; ms: number | null; ip: string | null; servidor: string | null; ssl_expira: string | null; erro: string | null };
  env: { usadas: string[]; faltando: string[]; edge: string[]; definidas: number; fonte: string[] };
  conectores: string[]; alertas: Alerta[]; coletado: string;
};

const grau = (f: Ficha) => (f.alertas.some(a => a.nivel === 'ruim') ? 'ruim' : f.alertas.length ? 'atencao' : 'ok');
const data = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const dias = (iso: string | null) => (iso ? Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000) : null);

/** Quando cada informação foi atualizada: data absoluta no title, relativa no texto. */
function Quando({ iso, clock, prefixo = '' }: { iso: string | null | undefined; clock: number; prefixo?: string }) {
  return <span className="muted small" title={data(iso)}>{prefixo}{agoIso(iso, clock)}</span>;
}

function Bloco({ titulo, quando, children }: { titulo: string; quando?: ReactNode; children: ReactNode }) {
  return (
    <div className="pj-bloco">
      <div className="pj-bloco-h"><span>{titulo}</span>{quando}</div>
      {children}
    </div>
  );
}

function Card({ f, clock, onOpen }: { f: Ficha; clock: number; onOpen: () => void }) {
  const g = f.git, b = f.bancos.find(x => x.principal), bk = f.backup.itens.find(i => i.oque.startsWith('banco'));
  return (
    <button className={`pj-card pj-${grau(f)}`} onClick={onOpen}>
      <div className="pj-card-top">
        <b>{f.name}</b>
        {f.prod && <span className={`pj-dot ${f.prod.erro || (f.prod.status ?? 0) >= 400 ? 'ruim' : 'ok'}`} title={f.prod.erro ?? `HTTP ${f.prod.status} em ${f.prod.ms} ms`} />}
      </div>
      <div className="pj-stack">{f.arquitetura.stack.slice(0, 5).map(s => <span key={s} className="tag off">{s}</span>)}</div>
      <dl className="pj-kv">
        <dt>pasta</dt><dd className="mono">{f.path}</dd>
        <dt>git</dt><dd>{g ? <>{g.github ?? 'sem GitHub'} · <span className="mono">{g.branch}</span></> : 'sem git'}</dd>
        <dt>banco</dt><dd>{f.meta.banco ?? (b ? `${b.tipo} · ${b.onde}` : '—')}</dd>
        <dt>produção</dt><dd>{f.prod ? f.prod.url.replace(/^https?:\/\//, '') : '—'}</dd>
        <dt>backup</dt><dd>{bk ? (bk.quando ? agoIso(bk.quando, clock) : 'não verificável') : '—'}</dd>
        <dt>mexeu</dt><dd>{f.ultimo_mexeu ? `${f.ultimo_mexeu.quem}, ${agoIso(f.ultimo_mexeu.quando, clock)}` : '—'}</dd>
      </dl>
      {f.alertas.length > 0 && <ul className="pj-alertas">{f.alertas.slice(0, 3).map(a => <li key={a.texto} className={a.nivel}>{a.texto}</li>)}{f.alertas.length > 3 && <li className="muted">+{f.alertas.length - 3}</li>}</ul>}
    </button>
  );
}

function Detalhe({ f, clock, onClose, onSaved }: { f: Ficha; clock: number; onClose: () => void; onSaved: () => void }) {
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState({ prod_url: f.meta.prod_url ?? '', banco: f.meta.banco ?? '', notas: f.meta.notas ?? '' });
  const [erro, setErro] = useState('');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  async function salvar() {
    try { await api(`/api/dash/projects/${f.id}`, { method: 'PATCH', body: JSON.stringify(form) }); setEdit(false); onSaved(); }
    catch (e) { setErro((e as Error).message); }
  }
  const g = f.git, a = f.arquitetura, p = f.prod, d = f.deploy;
  const ssl = p ? dias(p.ssl_expira) : null;
  return (
    <div className="pj-modal-bg" onClick={onClose}>
      <div className="pj-modal" role="dialog" aria-modal="true" aria-label={f.name} onClick={e => e.stopPropagation()}>
        <div className="pj-modal-top">
          <h2>{f.name} <span className="muted small mono">{f.slug}</span></h2>
          <span className="muted small">coletado {agoIso(f.coletado, clock)}</span>
          <button className="pj-x" onClick={onClose} title="Fechar" autoFocus>✕</button>
        </div>
        {f.alertas.length > 0 && <ul className="pj-alertas grande">{f.alertas.map(x => <li key={x.texto} className={x.nivel}>{x.texto}</li>)}</ul>}
        {f.meta.notas && !edit && <p className="pj-notas">{f.meta.notas}</p>}

        <div className="pj-grid">
          <Bloco titulo="Onde está">
            <dl className="pj-kv">
              <dt>pasta</dt><dd className="mono">{f.path}{f.existe ? '' : ' (não existe)'}</dd>
              <dt>servidor</dt><dd>c3 (217.76.55.249)</dd>
              <dt>conectores</dt><dd>{f.conectores.length ? f.conectores.join(', ') : '—'}</dd>
            </dl>
          </Bloco>

          <Bloco titulo="Git" quando={g?.ultimo && <Quando iso={g.ultimo.quando} clock={clock} prefixo="commit " />}>
            {!g ? <div className="vazio">sem repositório git</div> : (
              <dl className="pj-kv">
                <dt>GitHub</dt><dd>{g.github ? <a href={`https://github.com/${g.github}`} target="_blank" rel="noreferrer">{g.github}</a> : (g.remote ?? 'sem espelho')}</dd>
                <dt>branch</dt><dd className="mono">{g.branch}{g.upstream ? ` → ${g.upstream}` : ''}</dd>
                <dt>último commit</dt><dd>{g.ultimo ? <><span className="mono">{g.ultimo.sha}</span> {g.ultimo.msg} <span className="muted">({g.ultimo.autor}, {data(g.ultimo.quando)})</span></> : '—'}</dd>
                <dt>espelho</dt><dd>{g.ahead === null ? 'sem upstream' : `${g.ahead} à frente · ${g.behind} atrás`}{g.ultimo_push && <> · último push {agoIso(g.ultimo_push, clock)}</>}</dd>
                <dt>pasta principal</dt><dd>{g.sujos ? `${g.sujos} arquivo(s) sem commit` : 'limpa'} · {g.commits_7d} commits em 7 dias</dd>
                <dt>worktrees</dt><dd>{g.worktrees.length ? g.worktrees.map(w => <div key={w.path} className="mono small">{w.branch || '(detached)'} <span className="muted">{w.path}</span></div>) : 'nenhum'}</dd>
              </dl>
            )}
          </Bloco>

          <Bloco titulo="Banco" quando={<span className="muted small">{f.banco_fonte ? `fonte: ${f.banco_fonte}` : ''}</span>}>
            {f.meta.banco && <p className="pj-p">{f.meta.banco}</p>}
            {f.bancos.length === 0 && !f.meta.banco ? <div className="vazio">nenhum banco encontrado no código</div> : (
              <table className="dash-table">
                <tbody>{f.bancos.map(b => (
                  <tr key={b.url}><td>{b.principal ? <b>{b.tipo}</b> : b.tipo}</td><td>{b.onde}</td><td className="mono small">{b.ref}</td></tr>
                ))}</tbody>
              </table>
            )}
          </Bloco>

          <Bloco titulo="Backup">
            {f.backup.itens.length === 0 ? <div className="vazio">nenhum backup encontrado</div> : (
              <table className="dash-table">
                <tbody>{f.backup.itens.map((i, k) => (
                  <tr key={k}><td>{i.oque}</td><td className="num" title={data(i.quando)}>{i.quando ? agoIso(i.quando, clock) : '—'}</td><td className="small">{i.detalhe}</td></tr>
                ))}</tbody>
              </table>
            )}
          </Bloco>

          <Bloco titulo="Produção e deploy" quando={d?.quando && <Quando iso={d.quando} clock={clock} prefixo="deploy " />}>
            {!p && !d ? <div className="vazio">sem produção conhecida (defina a URL em Editar)</div> : (
              <dl className="pj-kv">
                {p && <><dt>URL</dt><dd><a href={p.url} target="_blank" rel="noreferrer">{p.url}</a></dd>
                  <dt>agora</dt><dd>{p.erro ? `fora do ar: ${p.erro}` : `HTTP ${p.status} em ${p.ms} ms`}</dd>
                  <dt>DNS</dt><dd>{p.ip ? `${p.ip} (${p.servidor})` : '—'}</dd>
                  <dt>SSL</dt><dd>{p.ssl_expira ? `vence ${data(p.ssl_expira).slice(0, 8)} (${ssl} dias)` : '—'}</dd></>}
                {d && <><dt>deploy</dt><dd>{d.onde} · {d.estado} · {d.detalhe} · {data(d.quando)}</dd>
                  <dt>domínios</dt><dd>{d.dominios.join(', ')}</dd></>}
              </dl>
            )}
          </Bloco>

          <Bloco titulo="Arquitetura" quando={a.atualizado && <Quando iso={a.atualizado} clock={clock} prefixo={`${a.fonte} `} />}>
            <div className="pj-stack">{a.stack.map(s => <span key={s} className="tag off">{s}</span>)}</div>
            {a.resumo ? <p className="pj-p">{a.resumo}</p> : <div className="vazio">{a.fonte ? `${a.fonte} sem texto descritivo (só regras ou TODO)` : 'sem CLAUDE.md nem README'}</div>}
            {a.pastas.length > 0 && <div className="muted small mono">pastas: {a.pastas.join('  ')}</div>}
          </Bloco>

          <Bloco titulo={`Sessões do Claude (${f.sessoes_total})`} quando={f.sessoes[0] && <Quando iso={f.sessoes[0].quando} clock={clock} />}>
            {f.sessoes.length === 0 ? <div className="vazio">nenhuma sessão neste projeto</div> : (
              <table className="dash-table">
                <tbody>{f.sessoes.map(s => (
                  <tr key={s.id}><td className="nome" title={s.title}>{s.title || 'sem título'}</td><td>{s.quem}</td><td className="num">{formatTokens(s.tokens)}</td><td className="num">{agoIso(s.quando, clock)}</td></tr>
                ))}</tbody>
              </table>
            )}
            {f.tokens.length > 0 && <div className="muted small pj-p">tokens por pessoa: {f.tokens.map(t => `${t.quem} ${formatTokens(t.t7)} (7d) / ${formatTokens(t.t30)} (30d)`).join(' · ')}</div>}
          </Bloco>

          <Bloco titulo="Trabalho pendurado">
            {f.tarefas.length === 0 ? <div className="vazio">nenhuma tarefa aberta</div> : (
              <table className="dash-table">
                <tbody>{f.tarefas.map(t => (
                  <tr key={t.id}><td className="nome" title={t.title}>{t.title}</td><td>{t.status}{t.integracao ? ` · ${t.integracao}` : ''}</td><td>{t.quem ?? '—'}</td><td className="num">{agoIso(t.quando, clock)}</td></tr>
                ))}</tbody>
              </table>
            )}
          </Bloco>

          <Bloco titulo="Variáveis de ambiente" quando={<span className="muted small">{f.env.fonte.join(', ') || 'nenhum .env na pasta'}</span>}>
            <p className="pj-p small">{f.env.usadas.length} lidas pelo código · {f.env.definidas} definidas na c3{f.env.edge.length ? ` · ${f.env.edge.length} nas edge functions (secrets do Supabase)` : ''}</p>
            {f.env.faltando.length > 0 && <div className="small">sem valor na c3: <span className="mono">{f.env.faltando.join(', ')}</span></div>}
          </Bloco>
        </div>

        <div className="pj-edit">
          {!edit ? <button onClick={() => setEdit(true)}>Editar URL de produção, banco e notas</button> : (
            <>
              <label>URL de produção <input value={form.prod_url} placeholder="detectada sozinha se ficar vazio" onChange={e => setForm({ ...form, prod_url: e.target.value })} /></label>
              <label>Banco (texto livre, substitui o detectado no card) <input value={form.banco} onChange={e => setForm({ ...form, banco: e.target.value })} /></label>
              <label>Notas <textarea rows={3} value={form.notas} onChange={e => setForm({ ...form, notas: e.target.value })} /></label>
              {erro && <div className="dash-erro">{erro}</div>}
              <div className="pj-edit-bt"><button onClick={() => void salvar()}>Salvar</button><button onClick={() => setEdit(false)}>Cancelar</button></div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function DashProjetos({ clock }: { clock: number }) {
  const [dados, setDados] = useState<{ coletado: string; projetos: Ficha[] } | null>(null);
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(false);
  const [aberto, setAberto] = useState<number | null>(null);

  async function carregar(refresh = false) {
    setCarregando(true);
    try { setDados(await api(`/api/dash/projects${refresh ? '?refresh=1' : ''}`)); setErro(''); }
    catch (e) { setErro((e as Error).message); }
    finally { setCarregando(false); }
  }
  useEffect(() => { void carregar(); const t = setInterval(() => void carregar(), 5 * 60_000); return () => clearInterval(t); }, []);

  const lista = dados?.projetos ?? [];
  const f = lista.find(x => x.id === aberto);
  return (
    <section>
      <h2>
        <span>Projetos</span>
        <span className="muted">
          {dados ? `${lista.length} projetos · coletado ${agoIso(dados.coletado, clock)} · ` : ''}
          <button className="pj-refresh" onClick={() => void carregar(true)} disabled={carregando}>{carregando ? 'coletando…' : 'atualizar'}</button>
        </span>
      </h2>
      {erro && <div className="dash-erro">{erro}</div>}
      {!dados ? <div className="vazio">{carregando ? 'coletando git, bancos, backups e produção…' : '—'}</div> : (
        <div className="pj-cards">{lista.map(x => <Card key={x.id} f={x} clock={clock} onOpen={() => setAberto(x.id)} />)}</div>
      )}
      {f && <Detalhe key={f.id} f={f} clock={clock} onClose={() => setAberto(null)} onSaved={() => void carregar(true)} />}
    </section>
  );
}
