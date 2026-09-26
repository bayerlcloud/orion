/** Nota de saúde da VPS de 0 a 10, a partir da amostra atual. Puro e testável. */
type S = {
  cpu?: { pct?: number; iowait?: number; steal?: number } | null;
  load?: { l1?: number } | null;
  mem?: { pct?: number; swap_pct?: number } | null;
  disk?: { util_pct?: number | null; fs?: { pct?: number } | null } | null;
  psi?: { cpu?: { some10?: number } | null; io?: { some10?: number } | null } | null;
  host?: { vcpus?: number } | null;
  units?: { active?: string }[] | null;
};

export type Health = { score: number; grade: 'ok' | 'atencao' | 'ruim'; label: string; motivos: string[] };

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pen = (motivos: string[], texto: string, valor: number) => { if (valor > 0.05) motivos.push(texto); return valor; };

export function healthScore(s: S | null | undefined): Health {
  if (!s) return { score: 0, grade: 'ruim', label: 'sem dados', motivos: ['ainda não recebi métricas'] };
  const motivos: string[] = [];
  let desconto = 0;
  const cpu = n(s.cpu?.pct), io = n(s.cpu?.iowait), steal = n(s.cpu?.steal);
  const memp = n(s.mem?.pct), swap = n(s.mem?.swap_pct);
  const util = n(s.disk?.util_pct), fs = n(s.disk?.fs?.pct);
  const l1 = n(s.load?.l1), vc = n(s.host?.vcpus) ?? 1;
  const psiCpu = n(s.psi?.cpu?.some10), psiIo = n(s.psi?.io?.some10);

  if (cpu !== null && cpu > 75) desconto += pen(motivos, `CPU alta (${cpu.toFixed(0)}%)`, Math.min(2, (cpu - 75) / 12));
  if (io !== null && io > 8) desconto += pen(motivos, `iowait alto (${io.toFixed(0)}%)`, Math.min(3, io / 12));
  if (steal !== null && steal > 5) desconto += pen(motivos, `steal do provedor (${steal.toFixed(0)}%)`, Math.min(1.5, steal / 15));
  if (memp !== null && memp > 85) desconto += pen(motivos, `RAM apertada (${memp.toFixed(0)}%)`, Math.min(2, (memp - 85) / 6));
  if (swap !== null && swap > 20) desconto += pen(motivos, `swap em uso (${swap.toFixed(0)}%)`, Math.min(1.5, swap / 50));
  if (fs !== null && fs > 85) desconto += pen(motivos, `disco quase cheio (${fs.toFixed(0)}%)`, Math.min(1.5, (fs - 85) / 8));
  if (util !== null && util > 80) desconto += pen(motivos, `disco saturado (${util.toFixed(0)}%)`, Math.min(1, (util - 80) / 20));
  if (l1 !== null) { const r = l1 / vc; if (r > 1) desconto += pen(motivos, `load acima dos núcleos (${l1.toFixed(1)}/${vc})`, Math.min(2, (r - 1) * 2)); }
  if (psiCpu !== null && psiCpu > 20) desconto += pen(motivos, 'pressão de CPU (PSI)', Math.min(1, psiCpu / 60));
  if (psiIo !== null && psiIo > 20) desconto += pen(motivos, 'pressão de I/O (PSI)', Math.min(1.5, psiIo / 50));
  const failed = (s.units ?? []).filter(u => (u.active ?? '') === 'failed').length;
  if (failed > 0) desconto += pen(motivos, `${failed} serviço(s) em falha`, Math.min(2, failed));

  const score = Math.max(0, Math.min(10, Math.round((10 - desconto) * 10) / 10));
  const grade: Health['grade'] = score >= 8 ? 'ok' : score >= 5 ? 'atencao' : 'ruim';
  const label = grade === 'ok' ? 'saudável' : grade === 'atencao' ? 'atenção' : 'crítico';
  if (!motivos.length) motivos.push('tudo dentro do normal');
  return { score, grade, label, motivos: motivos.slice(0, 4) };
}
