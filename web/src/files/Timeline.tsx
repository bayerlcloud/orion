import { useEffect, useState } from 'react';
import { filesApi } from './api';
import type { Commit } from './types';

export function relTime(unixSeconds: number, now = Date.now()): string {
  const s = Math.max(0, Math.round(now / 1000 - unixSeconds));
  if (s < 60) return `há ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `há ${h} h`;
  const d = Math.round(h / 24);
  if (d < 60) return `há ${d} d`;
  const mo = Math.round(d / 30);
  if (mo < 24) return `há ${mo} meses`;
  return `há ${Math.round(mo / 12)} anos`;
}

type Props = { rootId: number | null; rel: string | null; open: boolean };

/** Seção TIMELINE: os últimos commits que tocaram o arquivo selecionado. */
export default function Timeline({ rootId, rel, open }: Props) {
  const [state, setState] = useState<{ key: string; repo: boolean; commits: Commit[]; error?: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const key = rootId !== null && rel !== null ? `${rootId}|${rel}` : null;
  useEffect(() => {
    if (!open || !key || rootId === null || rel === null) return;
    if (state?.key === key) return;
    let alive = true;
    setLoading(true);
    filesApi.timeline(rootId, rel)
      .then(r => { if (alive) setState({ key, repo: r.repo, commits: r.commits }); })
      .catch(e => { if (alive) setState({ key, repo: true, commits: [], error: (e as Error).message }); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, key, rootId, rel, state?.key]);

  if (!open) return null;
  if (!key) return <div className="arq-section-body arq-empty">Selecione um arquivo para ver o histórico.</div>;
  if (loading && state?.key !== key) return <div className="arq-section-body arq-empty">carregando…</div>;
  if (!state || state.key !== key) return null;
  if (state.error) return <div className="arq-section-body arq-empty">{state.error}</div>;
  if (!state.repo) return <div className="arq-section-body arq-empty">Este projeto não é um repositório git.</div>;
  if (!state.commits.length) return <div className="arq-section-body arq-empty">Nenhum commit toca este arquivo.</div>;
  return (
    <div className="arq-section-body arq-timeline">
      {state.commits.map(c => (
        <div key={c.hash} className="arq-commit" title={`${c.hash}\n${c.author} · ${new Date(c.date * 1000).toLocaleString('pt-BR')}`}>
          <span className="arq-commit-subject">{c.subject}</span>
          <span className="arq-commit-meta">{c.author.split(' ')[0]} · {relTime(c.date)}</span>
        </div>
      ))}
    </div>
  );
}
