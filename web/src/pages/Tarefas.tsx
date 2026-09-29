import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type User } from '../api';
import './tarefas.css';

type TaskStatus = 'backlog' | 'fazendo' | 'revisao' | 'feito' | 'arquivada';
type IntegrationStatus = 'pendente' | 'integrando' | 'integrada' | 'conflito' | 'testes_falharam' | null;

type Task = {
  id: number;
  project_id: number;
  title: string;
  goal: string;
  status: TaskStatus;
  assignee_id: number | null;
  assignee_name: string | null;
  created_by: number;
  branch: string | null;
  worktree_path: string | null;
  integration_status: IntegrationStatus;
  integration_log: string | null;
  position: number;
  project_name: string;
  project_slug: string;
  created_at: string;
  updated_at: string;
};

type Project = { id: number; slug: string; name: string };
type Person = { id: number; name: string };
type Meta = { projects: Project[]; users: Person[] };
type DiffData = { stat: string; diff: string; truncated: boolean; warning?: string };

const COLUMNS: { key: TaskStatus; label: string }[] = [
  { key: 'backlog', label: 'Backlog' },
  { key: 'fazendo', label: 'Fazendo' },
  { key: 'revisao', label: 'Revisão' },
  { key: 'feito', label: 'Feito' },
];

const INTEG: Record<Exclude<IntegrationStatus, null>, { label: string; tone: 'ok' | 'bad' | 'info' | 'warn' }> = {
  pendente: { label: 'Pendente', tone: 'warn' },
  integrando: { label: 'Integrando…', tone: 'info' },
  integrada: { label: 'Integrada', tone: 'ok' },
  conflito: { label: 'Conflito', tone: 'bad' },
  testes_falharam: { label: 'Testes falharam', tone: 'bad' },
};

function truncate(t: string, max: number): string {
  const s = t ?? '';
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function IntegBadge({ s }: { s: IntegrationStatus }) {
  if (!s) return null;
  const info = INTEG[s];
  return <span className={`tk-badge is-${info.tone}`}>{info.label}</span>;
}

/** Diff unificado colorido por linha usando os tokens do tema. */
function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n');
  return (
    <pre className="tk-diff">
      {lines.map((ln, i) => {
        let cls = '';
        if (ln.startsWith('+') && !ln.startsWith('+++')) cls = 'is-add';
        else if (ln.startsWith('-') && !ln.startsWith('---')) cls = 'is-del';
        else if (ln.startsWith('@@')) cls = 'is-hunk';
        else if (ln.startsWith('diff ') || ln.startsWith('+++') || ln.startsWith('---') || ln.startsWith('index ')) cls = 'is-meta';
        return (
          <div key={i} className={`tk-diff-line ${cls}`}>
            {ln || ' '}
          </div>
        );
      })}
    </pre>
  );
}

export default function Tarefas({ user }: { user: User }) {
  const [meta, setMeta] = useState<Meta>({ projects: [], users: [] });
  const [projectId, setProjectId] = useState<number | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [showArquivadas, setShowArquivadas] = useState(false);
  const [erro, setErro] = useState('');
  const [toast, setToast] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);

  // formulário de nova tarefa
  const [novaOpen, setNovaOpen] = useState(false);
  const [nTitle, setNTitle] = useState('');
  const [nGoal, setNGoal] = useState('');
  const [nAssignee, setNAssignee] = useState<number | ''>('');
  const [busy, setBusy] = useState(false);

  // painel de detalhe
  const [selId, setSelId] = useState<number | null>(null);
  const [diff, setDiff] = useState<DiffData | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [integrating, setIntegrating] = useState(false);
  const dragId = useRef<number | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => tasks.find((t) => t.id === selId) ?? null, [tasks, selId]);

  useEffect(() => {
    api<Meta>('/api/tasks/projects')
      .then((m) => {
        setMeta(m);
        setProjectId((prev) => prev ?? m.projects[0]?.id ?? null);
      })
      .catch((e: any) => setErro(e.message));
  }, []);

  async function loadTasks(pid: number | null) {
    if (!pid) {
      setTasks([]);
      return;
    }
    try {
      const r = await api<{ tasks: Task[] }>(`/api/tasks?project_id=${pid}`);
      setTasks(r.tasks);
    } catch (e: any) {
      setErro(e.message);
    }
  }

  useEffect(() => {
    loadTasks(projectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  function flash(kind: 'ok' | 'bad', text: string) {
    setToast({ kind, text });
    setTimeout(() => setToast(null), 4000);
  }

  async function criar() {
    if (!projectId || !nTitle.trim()) return;
    setBusy(true);
    try {
      await api<{ task: Task }>('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          project_id: projectId,
          title: nTitle.trim(),
          goal: nGoal.trim(),
          assignee_id: nAssignee === '' ? null : nAssignee,
        }),
      });
      setNTitle('');
      setNGoal('');
      setNAssignee('');
      setNovaOpen(false);
      await loadTasks(projectId);
      flash('ok', 'Tarefa criada.');
    } catch (e: any) {
      flash('bad', e.message);
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: number, body: Record<string, unknown>) {
    try {
      const r = await api<{ task: Task; warning?: string }>(`/api/tasks/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      await loadTasks(projectId);
      if (r.warning) flash('bad', r.warning);
      return r.task;
    } catch (e: any) {
      flash('bad', e.message);
    }
  }

  async function moveTo(id: number, status: TaskStatus) {
    const col = tasks.filter((t) => t.status === status);
    const position = col.length ? Math.max(...col.map((t) => t.position)) + 1 : 0;
    await patch(id, { status, position });
  }

  const [publicando, setPublicando] = useState(false);
  async function publicar() {
    setPublicando(true);
    try { const r = await api<{ aviso: string }>('/api/deploy', { method: 'POST', body: JSON.stringify({ ref: 'main' }) }); flash('ok', `Deploy: ${r.aviso}`); }
    catch (e: any) { flash('bad', e.message); } finally { setPublicando(false); }
  }
  async function integrar(id: number) {
    setIntegrating(true);
    try {
      const r = await api<{ task: Task; integration_status: string }>(`/api/tasks/${id}/integrate`, { method: 'POST' });
      await loadTasks(projectId);
      const info = INTEG[r.integration_status as Exclude<IntegrationStatus, null>];
      flash(r.integration_status === 'integrada' ? 'ok' : 'bad', `Integração: ${info?.label ?? r.integration_status}`);
    } catch (e: any) {
      flash('bad', e.message);
    } finally {
      setIntegrating(false);
    }
  }

  async function verDiff(id: number) {
    setDiffOpen(true);
    setDiff(null);
    try {
      const d = await api<DiffData>(`/api/tasks/${id}/diff`);
      setDiff(d);
    } catch (e: any) {
      setDiff({ stat: '', diff: '', truncated: false, warning: e.message });
    }
  }

  async function excluir(id: number) {
    if (!window.confirm('Excluir esta tarefa? O worktree também será removido.')) return;
    try {
      await api(`/api/tasks/${id}`, { method: 'DELETE' });
      setSelId(null);
      await loadTasks(projectId);
      flash('ok', 'Tarefa excluída.');
    } catch (e: any) {
      flash('bad', e.message);
    }
  }

  function abrir(id: number) {
    setSelId(id);
    setDiffOpen(false);
    setDiff(null);
    if (window.innerWidth < 900) setTimeout(() => panelRef.current?.scrollIntoView({ behavior: 'smooth' }), 40);
  }

  const cols = showArquivadas ? [...COLUMNS, { key: 'arquivada' as TaskStatus, label: 'Arquivadas' }] : COLUMNS;

  return (
    <div className="tk">
      <div className="tk-head">
        <h1>Tarefas</h1>
        <select
          className="tk-proj"
          value={projectId ?? ''}
          onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : null)}
        >
          {meta.projects.length === 0 && <option value="">sem projetos</option>}
          {meta.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button className="tk-btn tk-primary" onClick={() => setNovaOpen((o) => !o)} disabled={!projectId}>
          + Nova tarefa
        </button>
        <label className="tk-toggle">
          <input type="checkbox" checked={showArquivadas} onChange={(e) => setShowArquivadas(e.target.checked)} />
          <span>mostrar arquivadas</span>
        </label>
        {toast && <span className={`tk-toast is-${toast.kind}`}>{toast.text}</span>}
      </div>

      {erro && <div className="erro">{erro}</div>}

      {novaOpen && (
        <div className="tk-nova">
          <input placeholder="Título da tarefa" value={nTitle} onChange={(e) => setNTitle(e.target.value)} autoFocus />
          <textarea placeholder="Objetivo (o que precisa ser feito)" rows={2} value={nGoal} onChange={(e) => setNGoal(e.target.value)} />
          <div className="tk-nova-row">
            <select value={nAssignee} onChange={(e) => setNAssignee(e.target.value ? Number(e.target.value) : '')}>
              <option value="">sem responsável</option>
              {meta.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
            <button className="tk-btn tk-primary" onClick={criar} disabled={busy || !nTitle.trim()}>
              Criar
            </button>
            <button className="tk-btn" onClick={() => setNovaOpen(false)}>
              Cancelar
            </button>
          </div>
        </div>
      )}

      <div className="tk-board">
        {cols.map((col) => {
          const list = tasks.filter((t) => t.status === col.key);
          return (
            <div
              key={col.key}
              className="tk-col"
              onDragOver={(e) => {
                e.preventDefault();
                e.currentTarget.classList.add('is-over');
              }}
              onDragLeave={(e) => e.currentTarget.classList.remove('is-over')}
              onDrop={(e) => {
                e.preventDefault();
                e.currentTarget.classList.remove('is-over');
                const id = dragId.current;
                dragId.current = null;
                if (id != null) moveTo(id, col.key);
              }}
            >
              <div className="tk-col-head">
                <span>{col.label}</span>
                <span className="tk-count">{list.length}</span>
              </div>
              <div className="tk-cards">
                {list.map((t) => (
                  <div
                    key={t.id}
                    className={`tk-card ${t.id === selId ? 'is-active' : ''}`}
                    draggable
                    onDragStart={() => {
                      dragId.current = t.id;
                    }}
                    onClick={() => abrir(t.id)}
                  >
                    <div className="tk-card-title">{t.title}</div>
                    {t.goal && <div className="tk-card-goal">{truncate(t.goal, 90)}</div>}
                    <div className="tk-card-foot">
                      {t.assignee_name && <span className="tk-chip">{t.assignee_name}</span>}
                      {t.branch && <span className="tk-chip is-branch mono">{t.branch}</span>}
                      <IntegBadge s={t.integration_status} />
                    </div>
                  </div>
                ))}
                {list.length === 0 && <div className="tk-empty">vazio</div>}
              </div>
            </div>
          );
        })}
      </div>

      {selected && (
        <div className="tk-panel" ref={panelRef}>
          <div className="tk-panel-head">
            <input
              className="tk-panel-title"
              value={selected.title}
              onChange={(e) => setTasks((ts) => ts.map((t) => (t.id === selected.id ? { ...t, title: e.target.value } : t)))}
              onBlur={(e) => patch(selected.id, { title: e.target.value })}
            />
            <button className="tk-x" onClick={() => setSelId(null)} aria-label="fechar">
              ×
            </button>
          </div>

          <label className="tk-field">
            <span>objetivo</span>
            <textarea
              rows={3}
              value={selected.goal}
              onChange={(e) => setTasks((ts) => ts.map((t) => (t.id === selected.id ? { ...t, goal: e.target.value } : t)))}
              onBlur={(e) => patch(selected.id, { goal: e.target.value })}
            />
          </label>

          <div className="tk-field-grid">
            <label className="tk-field">
              <span>status</span>
              <select value={selected.status} onChange={(e) => patch(selected.id, { status: e.target.value })}>
                {COLUMNS.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
                <option value="arquivada">Arquivada</option>
              </select>
            </label>
            <label className="tk-field">
              <span>responsável</span>
              <select
                value={selected.assignee_id ?? ''}
                onChange={(e) => patch(selected.id, { assignee_id: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">sem responsável</option>
                {meta.users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="tk-meta">
            <div>
              <span className="muted small">branch</span>
              <div className="mono small">{selected.branch ?? '—'}</div>
            </div>
            <div>
              <span className="muted small">worktree</span>
              <div className="mono small">{selected.worktree_path ?? '—'}</div>
            </div>
            <div>
              <span className="muted small">integração</span>
              <div>
                <IntegBadge s={selected.integration_status} /> {!selected.integration_status && <span className="small muted">—</span>}
              </div>
            </div>
          </div>

          <div className="tk-panel-actions">
            <button className="tk-btn tk-primary" onClick={() => integrar(selected.id)} disabled={integrating || !selected.worktree_path}>
              {integrating ? <span className="tk-spin" /> : null} Integrar
            </button>
            <button className="tk-btn" onClick={() => verDiff(selected.id)} disabled={!selected.worktree_path}>
              Ver diff
            </button>
            {selected.integration_status === 'integrada' && (
              <button className="tk-btn tk-primary" onClick={() => publicar()} disabled={publicando} title="Pede o build da main (fila, testes, troca com rollback)">
                {publicando ? <span className="tk-spin" /> : null} Publicar
              </button>
            )}
            {user.role === 'owner' && (
              <button className="tk-btn tk-danger" onClick={() => excluir(selected.id)}>
                Excluir
              </button>
            )}
          </div>

          {selected.integration_log && (
            <details className="tk-log-box">
              <summary>log da integração</summary>
              <pre className="tk-log">{selected.integration_log}</pre>
            </details>
          )}

          {diffOpen && (
            <div className="tk-diff-box">
              {!diff ? (
                <div className="muted small">carregando diff…</div>
              ) : diff.warning ? (
                <div className="muted small">{diff.warning}</div>
              ) : (
                <>
                  {diff.stat && <pre className="tk-diff-stat">{diff.stat}</pre>}
                  {diff.diff ? <DiffView diff={diff.diff} /> : <div className="muted small">sem diferenças em relação à base.</div>}
                  {diff.truncated && <div className="muted small">diff cortado em 4000 linhas.</div>}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
