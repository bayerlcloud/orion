import { useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import { api, type User } from '../api';

type Kind = 'skill' | 'command' | 'agent' | 'hook';
type Ativacao = 'auto' | 'manual' | 'modelo' | 'sempre';
type Origem = 'c3' | 'code-server' | 'projeto';
export type SkillItem = {
  id: string; kind: Kind; invocacao: string; name: string; description: string; origem: Origem; fonte: string;
  plugin: string | null; ativacao: Ativacao; habilitada: boolean; path: string; bytes: number;
  refs_code_server: boolean; credencial: boolean; argument_hint: string | null; allowed_tools: string | null;
  model: string | null; duplicada_de: string | null; descricao_pt: string | null;
  chave: string; ligavel: boolean; ligada_todos: boolean | null; ligada_eu: boolean | null; efetiva: boolean;
};
type Resp = { itens: SkillItem[]; faltam_pt: number; ativacao_label: Record<Ativacao, string>; catalogo_dir: string };
type Tri = 'padrao' | 'on' | 'off';
const triDe = (v: boolean | null): Tri => v === null ? 'padrao' : v ? 'on' : 'off';
const deTri = (t: Tri): boolean | null => t === 'padrao' ? null : t === 'on';

const KIND_LABEL: Record<Kind, string> = { skill: 'Skill', command: 'Command', agent: 'Subagente', hook: 'Hook' };
const KIND_ICON: Record<Kind, string> = { skill: '🧩', command: '⌨️', agent: '🤖', hook: '🪝' };
const ATIV_CURTA: Record<Ativacao, string> = { auto: 'automática', manual: 'só /nome', modelo: 'só o modelo', sempre: 'sempre' };
const ORIGEM_LABEL: Record<Origem, string> = { c3: 'c3 (catálogo)', 'code-server': 'code-server (c1)', projeto: 'projeto' };

export default function ToolsSkills({ user }: { user: User }) {
  const [data, setData] = useState<Resp | null>(null);
  const [erro, setErro] = useState('');
  const [busca, setBusca] = useState('');
  const [origem, setOrigem] = useState<Origem | 'todas'>('todas');
  const [kind, setKind] = useState<Kind | 'todos'>('todos');
  const [ativ, setAtiv] = useState<Ativacao | 'todas'>('todas');
  const [repetidas, setRepetidas] = useState(false);
  const [limite, setLimite] = useState(60);
  const [open, setOpen] = useState<SkillItem | null>(null);
  const [md, setMd] = useState<{ id: string; html: string; erro?: string } | null>(null);
  const [busy, setBusy] = useState('');
  const owner = user.role === 'owner';

  async function load() {
    try { setData(await api<Resp>('/api/tools/skills')); setErro(''); }
    catch (e: any) { setErro(e.message); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => { if (open && data) { const atual = data.itens.find(i => i.id === open.id); if (atual && atual !== open) setOpen(atual); } }, [data]);

  useEffect(() => {
    if (!open) { setMd(null); return; }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); };
    window.addEventListener('keydown', onKey);
    api<{ md: string }>(`/api/tools/skills/${open.id}/md`)
      .then(r => setMd({ id: open.id, html: marked.parse(r.md) as string }))
      .catch(e => setMd({ id: open.id, html: '', erro: e.message }));
    return () => window.removeEventListener('keydown', onKey);
  }, [open?.id]);

  const itens = data?.itens ?? [];
  const visiveis = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return itens.filter(i =>
      (repetidas || !i.duplicada_de)
      && (origem === 'todas' || i.origem === origem)
      && (kind === 'todos' || i.kind === kind)
      && (ativ === 'todas' || i.ativacao === ativ)
      && (!q || i.invocacao.toLowerCase().includes(q) || (i.descricao_pt ?? '').toLowerCase().includes(q) || i.description.toLowerCase().includes(q) || i.fonte.toLowerCase().includes(q)));
  }, [itens, busca, origem, kind, ativ, repetidas]);
  const contagem = useMemo(() => {
    const c: Record<string, number> = { todas: 0, c3: 0, 'code-server': 0, projeto: 0 };
    for (const i of itens) if (repetidas || !i.duplicada_de) { c.todas++; c[i.origem]++; }
    return c;
  }, [itens, repetidas]);

  async function explicar() {
    setBusy('explicando'); setErro('');
    try {
      for (let i = 0; i < 25; i++) {
        const r = await api<{ explicadas: number; faltam: number }>('/api/tools/skills/explicar', { method: 'POST' });
        await load();
        if (r.faltam <= 0 || r.explicadas === 0) break;
      }
    } catch (e: any) { setErro(e.message); } finally { setBusy(''); }
  }
  async function pref(it: SkillItem, escopo: 'todos' | 'eu', t: Tri) {
    setErro('');
    try { await api('/api/tools/skills/prefs', { method: 'PUT', body: JSON.stringify({ chave: it.chave, escopo, ligada: deTri(t) }) }); await load(); }
    catch (e: any) { setErro(e.message); }
  }
  function Toggles({ it }: { it: SkillItem }) {
    if (!it.ligavel) return null;
    return (
      <div className="tls-toggles" onClick={e => e.stopPropagation()}>
        {owner && (
          <label>Todos
            <select value={triDe(it.ligada_todos)} onChange={e => pref(it, 'todos', e.target.value as Tri)}>
              <option value="padrao">ligada (padrão)</option><option value="on">ligada</option><option value="off">desligada</option>
            </select>
          </label>
        )}
        <label>Eu
          <select value={triDe(it.ligada_eu)} onChange={e => pref(it, 'eu', e.target.value as Tri)}>
            <option value="padrao">seguir padrão</option><option value="on">ligada</option><option value="off">desligada</option>
          </select>
        </label>
        <span className={`tls-flag ${it.efetiva ? 'is-ok' : 'is-warn'}`}>{it.efetiva ? 'ligada para você' : 'desligada para você'}</span>
      </div>
    );
  }
  async function ativar(it: SkillItem) {
    if (!window.confirm(`Copiar "${it.invocacao}" para o catálogo do sistema? Passa a valer (ligada por padrão) em toda sessão nova.`)) return;
    setBusy('ativando'); setErro('');
    try {
      const r = await api<{ destino: string; aviso: string | null }>(`/api/tools/skills/${it.id}/ativar`, { method: 'POST' });
      window.alert(`Copiada para ${r.destino}${r.aviso ? `\n\nAtenção: ${r.aviso}` : ''}`);
      setOpen(null); await load();
    } catch (e: any) { setErro(e.message); } finally { setBusy(''); }
  }

  return (
    <section>
      <div className="tls-sec-head">
        <h2>Skills do Claude</h2>
        <span className="muted small">{itens.length} encontradas no disco{data ? `, ${data.faltam_pt} sem explicação em português` : ''}</span>
        <span className="tls-spacer" />
        {owner && data && data.faltam_pt > 0 && (
          <button className="btn-primary" onClick={explicar} disabled={!!busy}>{busy === 'explicando' ? 'Explicando…' : `Explicar em português (${data.faltam_pt})`}</button>
        )}
      </div>
      <p className="muted small">
        O Claude Code lê só o cabeçalho (nome + description) de cada arquivo e põe isso na lista de skills do prompt de sistema.
        <b> Automática</b> = o modelo decide chamar pela description. <b>Só /nome</b> = tem <code>disable-model-invocation: true</code>, só entra se alguém digitar.
        <b> Só o modelo</b> = <code>user-invocable: false</code> (fora do menu /). <b>Sempre</b> = hook, injetado por evento, não é chamado. O corpo do .md só é carregado quando a skill é acionada.
        Itens do catálogo do sistema têm liga/desliga: o admin define o padrão de todos, cada pessoa escolhe o seu, e a escolha da pessoa vale mais. Uma skill desligada não entra nas suas sessões novas (nem no próximo turno de uma retomada).
        As sincronizadas da claude.ai vêm com a conta e ficam sempre ligadas.
      </p>
      {erro && <div className="erro">{erro}</div>}

      <div className="tls-filters">
        {(['todas', 'c3', 'code-server', 'projeto'] as const).map(o => (
          <button key={o} className={`tls-chip ${origem === o ? 'is-on' : ''}`} onClick={() => setOrigem(o)}>{o === 'todas' ? 'Todas' : ORIGEM_LABEL[o]} <span className="tls-count">{contagem[o]}</span></button>
        ))}
        <span style={{ width: 8 }} />
        <select className="tls-search" value={kind} onChange={e => setKind(e.target.value as Kind | 'todos')} style={{ minWidth: 0 }}>
          <option value="todos">todos os tipos</option>
          {(Object.keys(KIND_LABEL) as Kind[]).map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        <select className="tls-search" value={ativ} onChange={e => setAtiv(e.target.value as Ativacao | 'todas')} style={{ minWidth: 0 }}>
          <option value="todas">toda ativação</option>
          {(Object.keys(ATIV_CURTA) as Ativacao[]).map(a => <option key={a} value={a}>{ATIV_CURTA[a]}</option>)}
        </select>
        <input className="tls-search" placeholder="buscar…" value={busca} onChange={e => setBusca(e.target.value)} />
        <label className="tls-toggle"><input type="checkbox" checked={repetidas} onChange={e => setRepetidas(e.target.checked)} /> mostrar repetidas (já ativas na c3)</label>
      </div>

      {!data && !erro && <div className="tls-empty">Varrendo o disco…</div>}
      {data && visiveis.length === 0 && <div className="tls-empty">Nada com esses filtros.</div>}
      {visiveis.length > 0 && (
        <div className="tls-grid">
          {visiveis.slice(0, limite).map(it => (
            <div key={it.id} className={`tls-card is-${it.kind} ${!it.habilitada || (it.ligavel && !it.efetiva) ? 'is-off' : ''}`} onClick={() => setOpen(it)}>
              <div className="tls-card-top">
                <span className="tls-icon">{KIND_ICON[it.kind]}</span>
                <span className={`tls-ativ is-${it.ativacao}`} title={data?.ativacao_label[it.ativacao]}>{ATIV_CURTA[it.ativacao]}</span>
                <span className={`tls-badge is-${it.kind}`}>{KIND_LABEL[it.kind]}</span>
              </div>
              <div className="tls-name">{it.invocacao}</div>
              <p className="tls-desc">{it.descricao_pt ?? (it.description ? it.description.slice(0, 180) + (it.description.length > 180 ? '…' : '') : 'sem description')}</p>
              <div className="tls-flags">
                <span className="tls-flag">{it.origem === 'projeto' ? it.fonte : ORIGEM_LABEL[it.origem]}</span>
                {it.origem !== 'projeto' && it.fonte !== 'usuário' && <span className="tls-flag">{it.fonte}</span>}
                {!it.habilitada && <span className="tls-flag is-warn">plugin desligado</span>}
                {it.duplicada_de && <span className="tls-flag is-ok">também na c3</span>}
                {it.refs_code_server && <span className="tls-flag is-warn">cita /config do code-server</span>}
                {it.credencial && <span className="tls-flag is-bad">credencial?</span>}
              </div>
              <Toggles it={it} />
            </div>
          ))}
        </div>
      )}
      {visiveis.length > limite && <p className="tls-more"><button className="tls-icon-btn" onClick={() => setLimite(l => l + 60)}>mostrar mais ({visiveis.length - limite} restantes)</button></p>}

      {open && (
        <div className="tls-modal-bg" onClick={() => setOpen(null)}>
          <div className="tls-modal is-wide" role="dialog" aria-modal="true" aria-label={open.invocacao} onClick={e => e.stopPropagation()}>
            <div className="tls-card-top">
              <span className="tls-icon">{KIND_ICON[open.kind]}</span>
              <span className={`tls-badge is-${open.kind}`}>{KIND_LABEL[open.kind]}</span>
              <span className="tls-spacer" />
              <button className="tls-icon-btn" onClick={() => setOpen(null)} title="Fechar" autoFocus>✕</button>
            </div>
            <h2 className="tls-modal-title">{open.invocacao}</h2>
            <p className="tls-desc">{open.descricao_pt ?? 'Sem explicação em português ainda.'}</p>
            <div className="tls-kv">
              <span>ativação</span><b>{data?.ativacao_label[open.ativacao]}</b>
              <span>o que dispara</span><b>{open.ativacao === 'auto' && open.description ? open.description : open.ativacao === 'sempre' ? 'evento do Claude Code' : 'só quando chamada explicitamente'}</b>
              <span>onde está</span><b>{open.origem === 'projeto' ? open.fonte : ORIGEM_LABEL[open.origem]}{open.fonte !== 'usuário' && open.origem !== 'projeto' ? `, ${open.fonte}` : ''}{!open.habilitada ? ' (plugin desligado)' : ''}</b>
              <span>arquivo</span><code>{open.path}</code>
              {open.argument_hint && <><span>argumentos</span><b>{open.argument_hint}</b></>}
              {open.allowed_tools && <><span>ferramentas</span><b>{open.allowed_tools}</b></>}
              {open.model && <><span>modelo</span><b>{open.model}</b></>}
              {open.duplicada_de && <><span>repetida</span><b>já existe ativa na c3 com o mesmo nome</b></>}
            </div>
            {(open.refs_code_server || open.credencial) && (
              <div className="tls-flags">
                {open.refs_code_server && <span className="tls-flag is-warn">cita caminhos /config/… do code-server: revisar antes de ativar na c3</span>}
                {open.credencial && <span className="tls-flag is-bad">parece conter senha ou token: corpo visível só para o admin</span>}
              </div>
            )}
            <Toggles it={open} />
            {owner && open.origem === 'code-server' && !open.plugin && open.kind !== 'hook' && !open.duplicada_de && (
              <div className="tls-form-actions">
                <button className="btn-primary" onClick={() => ativar(open)} disabled={!!busy}>Ativar (copiar para o catálogo {data?.catalogo_dir})</button>
              </div>
            )}
            <div className="tls-modal-sec">Arquivo</div>
            {!md || md.id !== open.id ? <p className="muted small">Carregando…</p>
              : md.erro ? <div className="erro">{md.erro}</div>
              : <article className="md tls-md" dangerouslySetInnerHTML={{ __html: md.html }} />}
          </div>
        </div>
      )}
    </section>
  );
}
