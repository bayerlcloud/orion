import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { ago, agoIso, fmtBytes, fmtKBs, fmtNum, fmtPct, fmtUptime, sparkPath, unitStatus } from './dashUtils';
import './dash.css';

// Tipos espelham server/dash/types.ts, mas tudo opcional: a tela precisa renderizar com campo faltando.
type ProcRow = { pid?: number; name?: string; user?: string | null; state?: string; threads?: number; cpu?: number | null; rss?: number };
type Sample = {
  ts?: string; t?: number;
  host?: { hostname?: string; kernel?: string; uptime_s?: number; vcpus?: number; label?: string; ip?: string };
  cpu?: { pct?: number; iowait?: number; steal?: number } | null;
  load?: { l1?: number; l5?: number; l15?: number; running?: number; threads?: number } | null;
  mem?: { total?: number; used?: number; available?: number; pct?: number; swap_total?: number; swap_used?: number; swap_pct?: number } | null;
  psi?: { cpu?: { some10?: number; some60?: number } | null; io?: { some10?: number; some60?: number; full10?: number | null } | null; mem?: { some10?: number; some60?: number; full10?: number | null } | null };
  disk?: { device?: string | null; read_kbs?: number | null; write_kbs?: number | null; util_pct?: number | null; fs?: { total?: number; used?: number; avail?: number; pct?: number } | null };
  net?: { iface?: string | null; rx_kbs?: number | null; tx_kbs?: number | null };
  files?: { open?: number; max?: number } | null;
  tcp?: { total?: number | null; estab?: number | null; timewait?: number | null; orphaned?: number | null } | null;
  procs?: { top_cpu?: ProcRow[]; top_mem?: ProcRow[]; count?: number };
  docker?: { name?: string; status?: string; state?: string; image?: string }[] | null;
  units?: { unit?: string; load?: string; active?: string; sub?: string; description?: string }[] | null;
  errors?: string[];
};
type Point = { t: number } & Record<string, number | null>;
type Now = { host?: { label?: string; ip?: string }; tick_ms?: number; sample?: Sample | null; series?: Point[] };
type Stat = { max_24h: number | null; avg_7d: number | null };
type History = { hours?: number; rows?: (Record<string, number | null> & { ts: string })[]; stats?: Record<string, Stat>; minutes_7d?: number };
type Session = { id: string; title?: string; status?: string; cost_usd?: number | string | null; turns?: number | null; user_name?: string; project_name?: string | null; updated_at?: string; pending?: number };

const RING = 360;
const LABEL = 'c3', IP = '217.76.55.249';

function num(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null); }

function Spark({ values, minMax, max, className = 'card-spark', h = 38 }: { values: (number | null)[]; minMax?: number; max?: number; className?: string; h?: number }) {
  const W = 200;
  const p = useMemo(() => sparkPath(values, W, h, { minMax, max }), [values, minMax, max, h]);
  return (
    <svg className={className} viewBox={`0 0 ${W} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      {p.line ? <><path className="area" d={p.area} /><path className="line" d={p.line} /></> : <text className="vazio" x={4} y={h - 6}>sem histórico ainda</text>}
    </svg>
  );
}

function Card({ title, right, big, unit, sub, values, minMax, max, stat, statFmt, bar, alerta }: {
  title: string; right?: ReactNode; big: string; unit?: string; sub?: ReactNode; values: (number | null)[]; minMax?: number; max?: number;
  stat?: Stat | null; statFmt?: (v: number | null) => string; bar?: number | null; alerta?: boolean;
}) {
  const f = statFmt ?? ((v: number | null) => fmtPct(v));
  return (
    <div className={`card${alerta ? ' alerta' : ''}`}>
      <div className="card-title"><span>{title}</span>{right && <span className="muted">{right}</span>}</div>
      <div className="card-big">{big}{unit && <small> {unit}</small>}</div>
      <div className="card-sub">{sub ?? ' '}</div>
      {typeof bar === 'number' && <div className="card-bar"><div style={{ width: `${Math.max(0, Math.min(100, bar))}%` }} /></div>}
      <Spark values={values} minMax={minMax} max={max} />
      <div className="card-stats">
        <span>pico 24h <b>{stat ? f(stat.max_24h) : '—'}</b></span>
        <span>média 7d <b>{stat ? f(stat.avg_7d) : '—'}</b></span>
      </div>
    </div>
  );
}

function Wide({ title, right, rows, k, minMax, max, fmt }: { title: string; right?: string; rows: History['rows']; k: string; minMax?: number; max?: number; fmt: (v: number | null) => string }) {
  const vals = (rows ?? []).map(r => num(r[k]));
  const nums = vals.filter((v): v is number => v !== null);
  const first = rows?.[0]?.ts, last = rows?.[rows.length - 1]?.ts;
  const hhmm = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '');
  return (
    <div className="wide">
      <div className="wide-title"><span>{title}</span><span className="muted">{right ?? (nums.length ? `máx ${fmt(Math.max(...nums))} · méd ${fmt(nums.reduce((a, b) => a + b, 0) / nums.length)}` : '')}</span></div>
      <Spark values={vals} minMax={minMax} max={max} className="wide-spark" h={64} />
      <div className="wide-axis"><span>{hhmm(first)}</span><span>{nums.length ? `${nums.length} min` : 'sem dados ainda'}</span><span>{hhmm(last)}</span></div>
    </div>
  );
}

function sessionTag(status?: string): string {
  const s = (status ?? '').toLowerCase();
  if (s === 'running' || s === 'streaming') return 'solid';
  if (s === 'waiting' || s === 'permission') return '';
  return 'off';
}

export default function Dash() {
  const [now, setNow] = useState<Sample | null>(null);
  const [series, setSeries] = useState<Point[]>([]);
  const [hist, setHist] = useState<History | null>(null);
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [erro, setErro] = useState('');
  const [live, setLive] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [clock, setClock] = useState(Date.now());
  const liveRef = useRef(false);

  function pushSample(s: Sample | null | undefined) {
    if (!s) return;
    setNow(s);
    setUpdatedAt(Date.now());
    const t = typeof s.t === 'number' ? s.t : Date.now();
    const p: Point = {
      t,
      cpu: s.cpu?.pct ?? null, iowait: s.cpu?.iowait ?? null, steal: s.cpu?.steal ?? null,
      load1: s.load?.l1 ?? null, mem_used_pct: s.mem?.pct ?? null, swap_pct: s.mem?.swap_pct ?? null,
      disk_util: s.disk?.util_pct ?? null, disk_read: s.disk?.read_kbs ?? null, disk_write: s.disk?.write_kbs ?? null, fs_pct: s.disk?.fs?.pct ?? null,
      net_rx: s.net?.rx_kbs ?? null, net_tx: s.net?.tx_kbs ?? null,
      psi_cpu: s.psi?.cpu?.some10 ?? null, psi_io: s.psi?.io?.some10 ?? null, psi_mem: s.psi?.mem?.some10 ?? null,
      files_open: s.files?.open ?? null, tcp_estab: s.tcp?.estab ?? null, tcp_timewait: s.tcp?.timewait ?? null,
    };
    setSeries(prev => (prev.length && prev[prev.length - 1].t >= t ? prev : [...prev, p].slice(-RING)));
  }

  async function loadNow() {
    try {
      const r = await api<Now>('/api/dash/now');
      if (Array.isArray(r.series)) setSeries(r.series.slice(-RING));
      if (r.sample) { setNow(r.sample); setUpdatedAt(Date.now()); }
      setErro('');
    } catch (e) { setErro((e as Error).message); }
  }
  async function loadHist() { try { setHist(await api<History>('/api/dash/history?hours=24')); } catch { /* fica sem histórico */ } }
  async function loadSessions() { try { const r = await api<{ sessions: Session[] }>('/api/claude/sessions'); setSessions(Array.isArray(r.sessions) ? r.sessions : []); } catch { setSessions(s => s ?? []); } }

  useEffect(() => {
    void loadNow(); void loadHist(); void loadSessions();
    const hb = setInterval(() => setClock(Date.now()), 1000);
    const histTimer = setInterval(loadHist, 5 * 60_000);
    const sessTimer = setInterval(loadSessions, 30_000);
    const pollTimer = setInterval(() => { if (!liveRef.current) void loadNow(); }, 15_000);

    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const connect = () => {
      if (closed || typeof EventSource === 'undefined') return;
      es = new EventSource('/api/dash/stream');
      es.onopen = () => { liveRef.current = true; setLive(true); };
      es.onmessage = ev => {
        try {
          const m = JSON.parse(ev.data) as { type?: string; sample?: Sample | null };
          // pushSample ignora ponto com t já presente, então o hello não duplica o que /now trouxe
          if (m.type === 'hello' || m.type === 'sample') pushSample(m.sample);
        } catch { /* mensagem inválida */ }
      };
      es.onerror = () => {
        liveRef.current = false; setLive(false);
        es?.close(); es = null;
        if (!closed) retry = setTimeout(connect, 5000);
      };
    };
    connect();
    return () => {
      closed = true;
      es?.close();
      if (retry) clearTimeout(retry);
      clearInterval(hb); clearInterval(histTimer); clearInterval(sessTimer); clearInterval(pollTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const col = (k: string) => series.map(p => num(p[k]));
  const st = hist?.stats ?? {};
  const s = now;
  const vcpus = s?.host?.vcpus ?? null;
  const load1 = s?.load?.l1 ?? null;
  const fs = s?.disk?.fs ?? null;
  const memPct = s?.mem?.pct ?? null;
  const cpuPct = s?.cpu?.pct ?? null;
  const spanMin = series.length > 1 ? Math.round((series[series.length - 1].t - series[0].t) / 60000) : 0;
  const spanLabel = spanMin >= 55 ? 'última hora' : spanMin > 0 ? `últimos ${spanMin} min` : 'coletando';
  const units = s?.units ?? null;
  const docker = s?.docker ?? null;
  const topCpu = s?.procs?.top_cpu ?? [];
  const topMem = s?.procs?.top_mem ?? [];
  const activeSessions = (sessions ?? []).filter(x => ['running', 'streaming', 'waiting', 'permission'].includes((x.status ?? '').toLowerCase()));
  const recent = (sessions ?? []).slice(0, 12);
  const kbsStat = (v: number | null) => (v === null ? '—' : fmtKBs(v));

  return (
    <div className="dash">
      <div className="dash-head">
        <h1>Dash</h1>
        <span className={`dash-live${live ? '' : ' off'}`}>{live ? 'ao vivo' : 'polling 15 s'}</span>
        <span className="muted small">{updatedAt ? `atualizado ${ago(clock - updatedAt)}` : 'aguardando a primeira amostra…'}</span>
        {s?.errors && s.errors.length > 0 && <span className="muted small">sondas com falha: {s.errors.join(', ')}</span>}
      </div>
      {erro && <div className="dash-erro">{erro}</div>}

      <section>
        <h2>
          <span>Nossa VPS · {s?.host?.label ?? LABEL} · {s?.host?.ip ?? IP}</span>
          <span className="muted">sparklines: {spanLabel} · amostra a cada 10 s</span>
        </h2>
        <div className="dash-facts">
          <span><b>host</b> {s?.host?.hostname ?? '—'}</span>
          <span><b>kernel</b> {s?.host?.kernel ?? '—'}</span>
          <span><b>uptime</b> {fmtUptime(s?.host?.uptime_s)}</span>
          <span><b>vCPUs</b> {vcpus ?? '—'}</span>
          <span><b>RAM</b> {fmtBytes(s?.mem?.total, 0)}</span>
          <span><b>disco</b> {fmtBytes(fs?.total, 0)} em {s?.disk?.device ?? '—'}</span>
          <span><b>rede</b> {s?.net?.iface ?? '—'}</span>
          <span><b>processos</b> {s?.procs?.count ?? '—'}</span>
          <span><b>threads</b> {s?.load?.threads ?? '—'}</span>
        </div>
        <div className="dash-grid">
          <Card title="CPU" right={`steal ${fmtPct(s?.cpu?.steal, 1)}`} big={fmtPct(cpuPct, 1)} sub={`de ${vcpus ?? '?'} vCPUs · ${fmtPct(s?.cpu?.iowait, 1)} em iowait`}
            values={col('cpu')} minMax={10} stat={st.cpu} bar={cpuPct} alerta={cpuPct !== null && cpuPct >= 90} />
          <Card title="I/O wait" big={fmtPct(s?.cpu?.iowait, 1)} sub="CPU parada esperando disco" values={col('iowait')} minMax={5} stat={st.iowait} alerta={(s?.cpu?.iowait ?? 0) >= 25} />
          <Card title="Load" right={`${vcpus ?? '?'} vCPUs`} big={fmtNum(load1, 2)}
            sub={`5 min ${fmtNum(s?.load?.l5, 2)} · 15 min ${fmtNum(s?.load?.l15, 2)} · ${s?.load?.running ?? '—'} rodando`}
            values={col('load1')} minMax={vcpus ?? 1} stat={st.load1} statFmt={v => fmtNum(v, 2)} alerta={load1 !== null && vcpus !== null && load1 > vcpus} />
          <Card title="RAM" right={fmtBytes(s?.mem?.total, 0)} big={fmtPct(memPct, 0)} sub={`${fmtBytes(s?.mem?.used)} usados · ${fmtBytes(s?.mem?.available)} disponíveis`}
            values={col('mem_used_pct')} max={100} stat={st.mem_used_pct} bar={memPct} alerta={memPct !== null && memPct >= 90} />
          <Card title="Swap" right={fmtBytes(s?.mem?.swap_total, 0)} big={s?.mem?.swap_total ? fmtPct(s?.mem?.swap_pct, 0) : (s?.mem ? 'sem swap' : '—')}
            sub={s?.mem?.swap_total ? `${fmtBytes(s?.mem?.swap_used)} de ${fmtBytes(s?.mem?.swap_total)}` : 'nenhuma área de troca configurada'}
            values={col('swap_pct')} max={100} bar={s?.mem?.swap_total ? s?.mem?.swap_pct ?? null : undefined} alerta={(s?.mem?.swap_pct ?? 0) >= 50} />
          <Card title="Disco" right={s?.disk?.device ?? undefined} big={fmtPct(fs?.pct, 0)} unit={fs ? `de ${fmtBytes(fs.total, 0)}` : undefined}
            sub={`${fmtBytes(fs?.used)} usados · leitura ${fmtKBs(s?.disk?.read_kbs)} · escrita ${fmtKBs(s?.disk?.write_kbs)}`}
            values={col('disk_util')} max={100} stat={st.disk_util} bar={fs?.pct ?? null} alerta={(fs?.pct ?? 0) >= 90 || (s?.disk?.util_pct ?? 0) >= 90} />
          <Card title="Disco · util" big={fmtPct(s?.disk?.util_pct, 0)} sub="tempo com I/O em andamento" values={col('disk_util')} max={100} stat={st.disk_util} />
          <Card title="Rede ↓ rx" right={s?.net?.iface ?? undefined} big={fmtKBs(s?.net?.rx_kbs)} sub={`↑ tx ${fmtKBs(s?.net?.tx_kbs)}`} values={col('net_rx')} minMax={50} stat={{ max_24h: null, avg_7d: null }} statFmt={kbsStat} />
          <Card title="Rede ↑ tx" right={s?.net?.iface ?? undefined} big={fmtKBs(s?.net?.tx_kbs)} sub={`↓ rx ${fmtKBs(s?.net?.rx_kbs)}`} values={col('net_tx')} minMax={50} stat={{ max_24h: null, avg_7d: null }} statFmt={kbsStat} />
          <Card title="Pressão · PSI" right="some avg10" big={s?.psi ? `${fmtNum(s.psi.cpu?.some10, 1)} / ${fmtNum(s.psi.io?.some10, 1)} / ${fmtNum(s.psi.mem?.some10, 1)}` : '—'}
            sub={`cpu / io / mem · avg60: ${fmtNum(s?.psi?.cpu?.some60, 1)} / ${fmtNum(s?.psi?.io?.some60, 1)} / ${fmtNum(s?.psi?.mem?.some60, 1)}`}
            values={col('psi_io')} minMax={5} statFmt={v => fmtNum(v, 1)} alerta={(s?.psi?.io?.some10 ?? 0) >= 20 || (s?.psi?.mem?.some10 ?? 0) >= 10} />
          <Card title="Arquivos abertos" right={s?.files?.max ? `máx ${fmtNum(s.files.max, 0)}` : undefined} big={fmtNum(s?.files?.open, 0)} sub="descritores em uso no kernel (file-nr)"
            values={col('files_open')} minMax={1000} statFmt={v => fmtNum(v, 0)} />
          <Card title="Conexões TCP" right={s?.tcp?.total !== null && s?.tcp?.total !== undefined ? `${fmtNum(s.tcp.total, 0)} sockets` : undefined} big={fmtNum(s?.tcp?.estab, 0)} unit="estab"
            sub={`${fmtNum(s?.tcp?.timewait, 0)} em time-wait · ${fmtNum(s?.tcp?.orphaned, 0)} órfãs`} values={col('tcp_estab')} minMax={20} statFmt={v => fmtNum(v, 0)} />
        </div>
        {hist && (
          <div className="dash-wide">
            <Wide title="CPU · 24 h" rows={hist.rows} k="cpu" max={100} fmt={v => fmtPct(v, 0)} />
            <Wide title="Load 1 · 24 h" rows={hist.rows} k="load1" minMax={vcpus ?? 1} fmt={v => fmtNum(v, 2)} />
            <Wide title="RAM · 24 h" rows={hist.rows} k="mem_used_pct" max={100} fmt={v => fmtPct(v, 0)} />
            <Wide title="Disco util · 24 h" rows={hist.rows} k="disk_util" max={100} fmt={v => fmtPct(v, 0)} />
          </div>
        )}
      </section>

      <section>
        <h2><span>Serviços</span><span className="muted">{units ? `${units.length} unidades` : 'systemd indisponível'} · {docker ? `${docker.length} containers` : 'docker indisponível'}</span></h2>
        <div className="dash-two">
          <div className="dash-bloco">
            <h3><span>systemd</span><span className="muted">{units ? `${units.filter(u => unitStatus(u.active, u.sub).failed).length} failed` : ''}</span></h3>
            {!units ? <div className="vazio">systemctl não respondeu</div> : units.length === 0 ? <div className="vazio">nenhuma unidade de interesse</div> : (
              <table className="dash-table">
                <thead><tr><th>unidade</th><th>estado</th><th>descrição</th></tr></thead>
                <tbody>
                  {units.map((u, i) => { const x = unitStatus(u.active, u.sub); return (
                    <tr key={u.unit ?? i} className={x.failed ? 'failed' : x.ok ? '' : 'off'}>
                      <td className="nome">{u.unit ?? '—'}</td>
                      <td><span className={`tag${x.ok ? ' solid' : x.failed ? '' : ' off'}`}>{x.label}</span></td>
                      <td className="nome">{u.description ?? ''}</td>
                    </tr>); })}
                </tbody>
              </table>
            )}
          </div>
          <div className="dash-bloco">
            <h3><span>docker</span><span className="muted">{docker ? `${docker.filter(c => (c.state ?? '').toLowerCase() === 'running').length} rodando` : ''}</span></h3>
            {!docker ? <div className="vazio">docker não respondeu (ausente ou parado)</div> : docker.length === 0 ? <div className="vazio">nenhum container</div> : (
              <table className="dash-table">
                <thead><tr><th>container</th><th>status</th><th>imagem</th></tr></thead>
                <tbody>
                  {docker.map((c, i) => { const run = (c.state ?? '').toLowerCase() === 'running'; return (
                    <tr key={c.name ?? i} className={run ? '' : 'off'}>
                      <td className="nome">{c.name ?? '—'}</td>
                      <td><span className={`tag${run ? ' solid' : ' off'}`}>{c.status ?? c.state ?? '—'}</span></td>
                      <td className="nome">{c.image ?? ''}</td>
                    </tr>); })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </section>

      <section>
        <h2><span>Processos</span><span className="muted">{s?.procs?.count ?? '—'} processos · top 8 · CPU em % de um núcleo</span></h2>
        <div className="dash-two">
          {([['por CPU', topCpu], ['por memória (RSS)', topMem]] as [string, ProcRow[]][]).map(([titulo, rows]) => (
            <div className="dash-bloco" key={titulo}>
              <h3><span>{titulo}</span></h3>
              {rows.length === 0 ? <div className="vazio">{s ? 'nada acima de zero nesta amostra' : 'aguardando amostra'}</div> : (
                <table className="dash-table">
                  <thead><tr><th className="num">pid</th><th>comando</th><th>usuário</th><th className="num">cpu</th><th className="num">rss</th><th className="num">thr</th></tr></thead>
                  <tbody>
                    {rows.map((p, i) => (
                      <tr key={p.pid ?? i}>
                        <td className="num">{p.pid ?? '—'}</td>
                        <td className="nome" title={p.name}>{p.name ?? '—'}</td>
                        <td>{p.user ?? '—'}</td>
                        <td className="num">{p.cpu === null || p.cpu === undefined ? '—' : fmtPct(p.cpu, 1)}</td>
                        <td className="num">{fmtBytes(p.rss)}</td>
                        <td className="num">{p.threads ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2><span>Sessões do Claude</span><span className="muted">{sessions === null ? 'carregando…' : `${activeSessions.length} ativas · ${sessions.length} no total`}</span></h2>
        <div className="dash-bloco">
          {sessions === null ? <div className="vazio">carregando…</div> : recent.length === 0 ? <div className="vazio">nenhuma sessão ainda</div> : (
            <table className="dash-table">
              <thead><tr><th>título</th><th>estado</th><th>quem</th><th>projeto</th><th className="num">turnos</th><th className="num">custo</th><th className="num">atualizada</th></tr></thead>
              <tbody>
                {recent.map(x => (
                  <tr key={x.id} className={sessionTag(x.status) === 'off' ? 'off' : ''}>
                    <td className="nome" title={x.title}>{x.title ?? x.id}</td>
                    <td><span className={`tag ${sessionTag(x.status)}`}>{x.status ?? '—'}{x.pending ? ` · ${x.pending} pendente${x.pending > 1 ? 's' : ''}` : ''}</span></td>
                    <td>{x.user_name ?? '—'}</td>
                    <td>{x.project_name ?? '—'}</td>
                    <td className="num">{x.turns ?? '—'}</td>
                    <td className="num">{num(x.cost_usd) === null ? '—' : `US$ ${fmtNum(num(x.cost_usd), 2)}`}</td>
                    <td className="num">{agoIso(x.updated_at, clock)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <div className="dash-rodape">
        <span>histórico: {hist ? `${hist.rows?.length ?? 0} min nas últimas 24 h · ${hist.minutes_7d ?? 0} min em 7 dias` : 'indisponível'}</span>
        <span>amostra: {s?.ts ? new Date(s.ts).toLocaleString('pt-BR') : '—'}</span>
        <span>leituras só de /proc e comandos leves; nada de du/find.</span>
      </div>
    </div>
  );
}
