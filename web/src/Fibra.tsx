import { useId, useMemo, type CSSProperties } from 'react';

// Fibra ótica do Orion: um "O" feito de dezenas de anéis concêntricos que "fluem" (stroke-dashoffset
// animado em ui.css, `.fibra circle`). Fica atrás da tela "Olá, Orion." do Claude e do cartão de
// login. Puro SVG, sem imagem; as cores vêm dos tokens --fibra/--fibra-clara (ui.css) e acompanham o
// tema. Os ids do filtro/gradiente vêm de useId() porque o componente pode estar montado duas vezes na
// mesma página. Enquanto a pessoa dita, as camadas de anéis se mexem em profundidades diferentes
// (parallax de voz: claude/Ditado.tsx escreve --voz e --voz-sway no <html>).
export default function Fibra() {
  const uid = useId().replace(/:/g, '');
  const camadas = useMemo(() => {
    type Traco = { r: number; w: number; brilho: boolean; op: number; delay: number };
    // Parallax de voz (ui.css `.fibra-camada`): os anéis de dentro ficam "longe" (mexem pouco) e os de
    // fora "perto" (mexem mais). Cada camada é um SVG separado pra transformar só no compositor,
    // sem redesenhar o blur dos anéis a cada quadro.
    const PROF = [0.3, 0.65, 1, 1.4];
    const out: { prof: number; tracos: Traco[] }[] = PROF.map(prof => ({ prof, tracos: [] }));
    const N = 33;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const r = 70 + t * 230;
      const camada = out[Math.min(PROF.length - 1, Math.floor(t * PROF.length))];
      for (const brilho of [true, false]) {
        camada.tracos.push({ r, w: brilho ? 2.4 : 1, brilho, op: brilho ? 0.45 : 0.35 + 0.6 * Math.sin(t * Math.PI), delay: -i * 1.3 });
      }
    }
    return out;
  }, []);
  return (
    <div className="fibra" aria-hidden="true">
      <div className="fibra-halo" />
      {camadas.map((c, k) => {
        const brilhoId = `fibra-brilho-${uid}-${k}`;
        const corId = `fibra-cor-${uid}-${k}`;
        return (
          <div key={k} className="fibra-camada" style={{ '--prof': c.prof } as CSSProperties}>
            <svg viewBox="0 0 800 800" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <filter id={brilhoId} x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="6" /></filter>
                <linearGradient id={corId} x1="0" x2="1">
                  <stop offset="0" style={{ stopColor: 'var(--fibra)', stopOpacity: 0.15 }} />
                  <stop offset=".5" style={{ stopColor: 'var(--fibra-clara)' }} />
                  <stop offset="1" style={{ stopColor: 'var(--fibra)', stopOpacity: 0.15 }} />
                </linearGradient>
              </defs>
              {c.tracos.map((p, i) => (
                <circle key={i} cx="400" cy="400" r={p.r} fill="none" strokeWidth={p.w} strokeOpacity={p.op}
                  filter={p.brilho ? `url(#${brilhoId})` : undefined}
                  style={{ stroke: p.brilho ? 'var(--fibra)' : `url(#${corId})`, animationDelay: `${p.delay}s` }} />
              ))}
            </svg>
          </div>
        );
      })}
    </div>
  );
}
