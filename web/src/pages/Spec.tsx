import { useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import { api, type User } from '../api';

type Doc = { id: string; title: string; markdown: string };

// Espelho do snapshot montado em server/inventory.ts
type Binario = { nome: string; versao: string; caminho: string };
type PacoteGlobal = { gerenciador: 'npm' | 'bun'; nome: string; versao: string };
type Unidade = { unidade: string; tipo: 'service' | 'timer'; load: string; estado: string; sub: string; descricao: string; proximo?: string; ultimo?: string };
type Container = { nome: string; imagem: string; estado: string; status: string; portas: string };
type Porta = { porta: number; endereco: string; processo: string; pid: number | null };
type EventoApt = { quando: string; acao: 'install' | 'upgrade'; pacote: string; versao: string; anterior: string };
type Servidor = { apelido: string; ip: string; provedor: string; specs: string; papel: string; servicos: string };
type Snapshot = {
  coletado_em: string;
  coletor?: { usuario: string; origem: string; host: string };
  maquina?: Record<string, string>;
  binarios?: Binario[];
  pacotes?: PacoteGlobal[];
  servicos?: Unidade[];
  containers?: Container[];
  portas?: Porta[];
  apt?: EventoApt[];
  servidores?: Servidor[];
  avisos?: string[];
};
type Change = { tipo: 'adicionado' | 'removido' | 'alterado'; categoria: string; chave: string; rotulo: string };
type Inventory = {
  snapshot: Snapshot;
  snapshot_ts: string;
  previous_ts: string | null;
  changes: { added: Change[]; removed: Change[]; changed: Change[] };
  history: string[];
};
type Usuario = { id: number; name: string; email: string; role: string; linux_user: string | null; ultimo_login: string | null };

const MAQUINA_ROTULOS: Record<string, string> = {
  sistema: 'sistema', kernel: 'kernel', uptime: 'ligada há', vcpus: 'vCPUs', memoria: 'memória', disco: 'disco (/)',
  ultimo_commit: 'último commit', postgres: 'postgres',
};

function quando(ts: string | null | undefined): string {
  return ts ? new Date(ts).toLocaleString('pt-BR') : '—';
}

const botao: React.CSSProperties = {
  font: 'inherit', fontSize: 13, padding: '4px 10px', border: '1px solid var(--line)', background: 'var(--bg)',
  color: 'var(--fg)', cursor: 'pointer', borderRadius: 0, marginLeft: 8,
};

export default function Spec({ user }: { user: User }) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [inv, setInv] = useState<Inventory | null>(null);
  const [users, setUsers] = useState<Usuario[]>([]);
  const [tab, setTab] = useState<string>('decisoes');
  const [erro, setErro] = useState('');
  const [atualizando, setAtualizando] = useState(false);

  useEffect(() => {
    api<{ docs: Doc[] }>('/api/spec/docs').then(r => setDocs(r.docs)).catch(e => setErro(e.message));
    api<Inventory>('/api/spec/inventory').then(setInv).catch(e => setErro(e.message));
    if (user.role === 'owner') api<{ users: Usuario[] }>('/api/users').then(r => setUsers(r.users)).catch(() => {});
  }, [user.role]);

  async function atualizarAgora() {
    setAtualizando(true);
    setErro('');
    try {
      setInv(await api<Inventory>('/api/spec/inventory/refresh', { method: 'POST' }));
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setAtualizando(false);
    }
  }

  const tabs = useMemo(() => [
    ...docs.map(d => ({ id: d.id, label: d.title })),
    { id: 'instalado', label: 'Instalado' },
  ], [docs]);

  const doc = docs.find(d => d.id === tab);
  const html = useMemo(() => doc ? (marked.parse(doc.markdown) as string) : '', [doc]);

  const s = inv?.snapshot;
  const mudancas = inv ? [...inv.changes.added, ...inv.changes.changed, ...inv.changes.removed] : [];
  const servicos = s?.servicos ?? [];
  const falhas = servicos.filter(u => u.estado === 'failed').length;

  return (
    <div>
      <h1>Spec</h1>
      {erro && <div className="erro">{erro}</div>}
      <div className="tabs">
        {tabs.map(t => <button key={t.id} className={t.id === tab ? 'active' : ''} onClick={() => setTab(t.id)}>{t.label}</button>)}
      </div>
      {doc && <article className="md" dangerouslySetInnerHTML={{ __html: html }} />}
      {tab === 'instalado' && (
        !inv || !s ? <p className="muted">coletando…</p> : (
          <div className="md">
            <p className="muted small">
              coletado em {quando(inv.snapshot_ts)} · próxima coleta automática em 1h
              {s.coletor && <> · por {s.coletor.origem === 'timer' ? 'timer' : 'pedido na página'} (usuário {s.coletor.usuario})</>}
              <button type="button" style={botao} onClick={atualizarAgora} disabled={atualizando}>
                {atualizando ? 'coletando…' : 'Atualizar agora'}
              </button>
            </p>
            {(s.avisos?.length ?? 0) > 0 && (
              <p className="muted small">avisos: {s.avisos!.join(' · ')}</p>
            )}

            <h2>Novidades desde a última coleta</h2>
            {!inv.previous_ts ? (
              <p className="muted">primeira coleta — ainda não há com o que comparar</p>
            ) : mudancas.length === 0 ? (
              <p className="muted">nada mudou desde {quando(inv.previous_ts)}</p>
            ) : (
              <>
                <p className="muted small">comparado com a coleta de {quando(inv.previous_ts)} · {mudancas.length} {mudancas.length === 1 ? 'mudança' : 'mudanças'}</p>
                <table>
                  <thead><tr><th>o quê</th><th>categoria</th><th>mudança</th></tr></thead>
                  <tbody>
                    {mudancas.map(c => (
                      <tr key={`${c.categoria}:${c.chave}:${c.tipo}`}>
                        <td>{c.tipo === 'removido' ? <strong>{c.tipo}</strong> : c.tipo}</td>
                        <td>{c.categoria}</td>
                        <td>{c.rotulo}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            <h2>Máquina</h2>
            <table>
              <tbody>
                {Object.entries(s.maquina ?? {}).map(([k, v]) => <tr key={k}><th>{MAQUINA_ROTULOS[k] ?? k.replace(/_/g, ' ')}</th><td>{v}</td></tr>)}
                {s.coletor && <tr><th>host</th><td>{s.coletor.host}</td></tr>}
              </tbody>
            </table>

            <h2>Binários e versões</h2>
            {(s.binarios?.length ?? 0) === 0 ? <p className="muted">nenhum binário encontrado</p> : (
              <table>
                <thead><tr><th>binário</th><th>versão</th><th>caminho</th></tr></thead>
                <tbody>
                  {s.binarios!.map(b => <tr key={b.nome}><td>{b.nome}</td><td>{b.versao}</td><td><code>{b.caminho}</code></td></tr>)}
                </tbody>
              </table>
            )}

            <h2>Pacotes globais (npm/bun)</h2>
            {(s.pacotes?.length ?? 0) === 0 ? <p className="muted">nenhum pacote global encontrado</p> : (
              <table>
                <thead><tr><th>gerenciador</th><th>pacote</th><th>versão</th></tr></thead>
                <tbody>
                  {s.pacotes!.map(p => <tr key={`${p.gerenciador}:${p.nome}`}><td>{p.gerenciador}</td><td>{p.nome}</td><td>{p.versao}</td></tr>)}
                </tbody>
              </table>
            )}

            <h2>Serviços e timers</h2>
            {servicos.length === 0 ? <p className="muted">systemd não respondeu</p> : (
              <>
                {falhas > 0 && <p><strong>{falhas} {falhas === 1 ? 'unidade em failed' : 'unidades em failed'}</strong></p>}
                <table>
                  <thead><tr><th>unidade</th><th>tipo</th><th>estado</th><th>sub</th><th>descrição</th><th>próxima / última</th></tr></thead>
                  <tbody>
                    {servicos.map(u => (
                      <tr key={u.unidade}>
                        <td>{u.estado === 'failed' ? <strong>{u.unidade}</strong> : u.unidade}</td>
                        <td>{u.tipo}</td>
                        <td className={u.estado === 'active' ? '' : 'muted'}>{u.estado === 'failed' ? <strong>failed</strong> : u.estado}</td>
                        <td className="muted">{u.sub}</td>
                        <td>{u.descricao}</td>
                        <td className="muted small">{u.tipo === 'timer' ? `${u.proximo ?? '-'} / ${u.ultimo ?? '-'}` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            <h2>Containers</h2>
            {(s.containers?.length ?? 0) === 0 ? <p className="muted">nenhum container (ou docker indisponível para o coletor)</p> : (
              <table>
                <thead><tr><th>nome</th><th>imagem</th><th>estado</th><th>status</th><th>portas</th></tr></thead>
                <tbody>
                  {s.containers!.map(c => (
                    <tr key={c.nome}>
                      <td>{c.nome}</td><td>{c.imagem}</td>
                      <td className={c.estado === 'running' ? '' : 'muted'}>{c.estado === 'running' ? c.estado : <strong>{c.estado}</strong>}</td>
                      <td className="muted">{c.status}</td><td className="small">{c.portas || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h2>Portas abertas</h2>
            {(s.portas?.length ?? 0) === 0 ? <p className="muted">nenhuma porta TCP em escuta encontrada</p> : (
              <table>
                <thead><tr><th>porta</th><th>endereço</th><th>processo</th></tr></thead>
                <tbody>
                  {s.portas!.map(p => <tr key={p.porta}><td>{p.porta}</td><td>{p.endereco}</td><td>{p.processo}{p.pid ? <span className="muted small"> (pid {p.pid})</span> : null}</td></tr>)}
                </tbody>
              </table>
            )}

            <h2>Pacotes apt recentes</h2>
            {(s.apt?.length ?? 0) === 0 ? <p className="muted">nada instalado ou atualizado via apt nos últimos 7 dias</p> : (
              <table>
                <thead><tr><th>quando</th><th>ação</th><th>pacote</th><th>versão</th></tr></thead>
                <tbody>
                  {[...s.apt!].reverse().map(e => (
                    <tr key={`${e.quando}:${e.acao}:${e.pacote}:${e.versao}`}>
                      <td className="small">{e.quando}</td>
                      <td>{e.acao === 'install' ? 'instalado' : 'atualizado'}</td>
                      <td>{e.pacote}</td>
                      <td>{e.anterior ? <><span className="muted">{e.anterior} → </span>{e.versao}</> : e.versao}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h2>Todos os servidores</h2>
            <table>
              <thead><tr><th>apelido</th><th>ip</th><th>provedor</th><th>specs</th><th>papel</th><th>principais serviços</th></tr></thead>
              <tbody>
                {(s.servidores ?? []).map(sv => <tr key={sv.ip}><td>{sv.apelido}</td><td>{sv.ip}</td><td>{sv.provedor}</td><td>{sv.specs}</td><td>{sv.papel}</td><td>{sv.servicos}</td></tr>)}
              </tbody>
            </table>

            {user.role === 'owner' && users.length > 0 && (
              <>
                <h2>Usuários</h2>
                <table>
                  <thead><tr><th>nome</th><th>email</th><th>papel</th><th>usuário linux</th><th>último login</th></tr></thead>
                  <tbody>
                    {users.map(u => <tr key={u.id}><td>{u.name}</td><td>{u.email}</td><td>{u.role === 'owner' ? 'admin' : 'membro'}</td><td>{u.linux_user ?? '—'}</td><td>{u.ultimo_login ? new Date(u.ultimo_login).toLocaleString('pt-BR') : 'nunca'}</td></tr>)}
                  </tbody>
                </table>
              </>
            )}

            <p className="muted small">
              {inv.history.length} {inv.history.length === 1 ? 'coleta guardada' : 'coletas guardadas'}
              {inv.history.length > 1 && <> · a mais antiga mostrada: {quando(inv.history[inv.history.length - 1])}</>}
              {' '}· o timer <code>orion-inventory</code> roda de hora em hora
            </p>
          </div>
        )
      )}
    </div>
  );
}
