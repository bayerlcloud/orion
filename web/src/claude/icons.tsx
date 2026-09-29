type P = { size?: number; className?: string };
const base = (size = 14) => ({ width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const });

export const Chevron = ({ size, className }: P) => <svg {...base(size)} className={className}><path d="M6 3l5 5-5 5" /></svg>;
export const ArrowLeft = ({ size, className }: P) => <svg {...base(size)} className={className}><path d="M12 3L5 8l7 5" /></svg>;
export const ArrowRight = ({ size, className }: P) => <svg {...base(size)} className={className}><path d="M4 3l7 5-7 5" /></svg>;
export const Plus = ({ size, className }: P) => <svg {...base(size)} className={className}><path d="M8 3v10M3 8h10" /></svg>;
export const ArrowUp = ({ size, className }: P) => <svg {...base(size)} className={className}><path d="M8 13V3M4 7l4-4 4 4" /></svg>;
export const Bolt = ({ size, className }: P) => <svg {...base(size)} className={className}><path d="M9 2L4 9h4l-1 5 5-7H8l1-5z" /></svg>;
export const Clock = ({ size, className }: P) => <svg {...base(size)} className={className}><circle cx="8" cy="8" r="6" /><path d="M8 5v3l2 1" /></svg>;
export const Search = ({ size, className }: P) => <svg {...base(size)} className={className}><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></svg>;
export const Slash = ({ size, className }: P) => <svg {...base(size)} className={className}><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="M10 5l-4 6" /></svg>;
export const X = ({ size, className }: P) => <svg {...base(size)} className={className}><path d="M4 4l8 8M12 4l-8 8" /></svg>;
export const Filter = ({ size, className }: P) => <svg {...base(size)} className={className}><path d="M2 4h12M4 8h8M6 12h4" /></svg>;
export const Power = ({ size, className }: P) => <svg {...base(size)} className={className}><path d="M8 2v6" /><path d="M4.5 4.5a5 5 0 1 0 7 0" /></svg>;
export const Sync = ({ size, className }: P) => <svg {...base(size)} className={className}><path d="M13 8a5 5 0 0 1-8.7 3.4M3 8a5 5 0 0 1 8.7-3.4" /><path d="M11 2v3h-3M5 14v-3h3" /></svg>;
export const Dots = ({ size, className }: P) => <svg {...base(size)} className={className}><circle cx="8" cy="3.5" r=".8" /><circle cx="8" cy="8" r=".8" /><circle cx="8" cy="12.5" r=".8" /></svg>;
export const Spark = ({ size = 14, className }: P) => <svg width={size} height={size} viewBox="0 0 16 16" className={className} fill="currentColor"><path d="M8 1l1.6 4.4L14 7l-4.4 1.6L8 13l-1.6-4.4L2 7l4.4-1.6z" /></svg>;
export const Copy = ({ size, className }: P) => <svg {...base(size)} className={className}><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 2.5H3.5A1 1 0 0 0 2.5 3.5v7" /></svg>;
export const Check = ({ size, className }: P) => <svg {...base(size)} className={className}><path d="M3 8.5l3.5 3.5L13 4" /></svg>;
export const Archive = ({ size, className }: P) => <svg {...base(size)} className={className}><rect x="2.5" y="3" width="11" height="3" rx="1" /><path d="M3.5 6v6.5A.5.5 0 0 0 4 13h8a.5.5 0 0 0 .5-.5V6M6.5 9h3" /></svg>;
export const Pencil = ({ size, className }: P) => <svg {...base(size)} className={className}><path d="M11 2.5l2.5 2.5L6 12.5 3 13l.5-3z" /></svg>;
export const Image = ({ size, className }: P) => <svg {...base(size)} className={className}><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><circle cx="6" cy="6.5" r="1" /><path d="M3 11l3-3 2.5 2.5L11 7l2 2" /></svg>;
export const File = ({ size, className }: P) => <svg {...base(size)} className={className}><path d="M4 2.5h5l3 3v8a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5z" /><path d="M9 2.5V6h3.5" /></svg>;
/** Raiz→agentes (tronco + 3 galhos) — ícone do gatilho do "Mapa de agentes" (ver AgentMap.tsx). Sem
 * equivalente pronto neste arquivo; desenhado seguindo o mesmo estilo minimalista (traço 1.5, 16x16). */
export const AgentMap = ({ size, className }: P) => <svg {...base(size)} className={className}><circle cx="3" cy="8" r="1.6" /><circle cx="13" cy="3" r="1.6" /><circle cx="13" cy="8" r="1.6" /><circle cx="13" cy="13" r="1.6" /><path d="M4.6 8H7M7 3h3M7 3v10M7 8h4M7 13h3" /></svg>;
export const GitBranch = ({ size, className }: P) => <svg {...base(size)} className={className}><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="7" r="1.5" /><path d="M4.5 5v6M4.5 8c0 1.7 1.8 2 5 2v-1.5" /></svg>;
/** Ícone REAL do "agents pill" (gatilho do Mapa de agentes no rodapé do compositor) — path literal
 * do componente `U11` do webview decompilado v2.1.283 (`/srv/orion-reference-2.1.283/webview/index.js`),
 * 20x20 com `fill:currentColor`, copiado byte a byte (não redesenhado — ver PARIDADE-agentmap.md). */
export const AgentsPill = ({ size = 16, className }: P) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} style={{ display: 'block' }}>
    <path d="M6.42857 4.64286C7.09408 4.64286 7.65168 5.09834 7.81041 5.71429H12.6786C13.9607 5.71429 15 6.75362 15 8.03571C15 9.3178 13.9607 10.3571 12.6786 10.3571H11.9336L10.2525 12.0382C10.113 12.1777 9.88696 12.1777 9.74749 12.0382L8.06641 10.3571H7.32143C6.43383 10.3571 5.71429 11.0767 5.71429 11.9643C5.71429 12.8519 6.43383 13.5714 7.32143 13.5714H12.1896C12.3483 12.9555 12.9059 12.5 13.5714 12.5C14.3604 12.5 15 13.1396 15 13.9286C15 14.7175 14.3604 15.3571 13.5714 15.3571C12.9059 15.3571 12.3483 14.9017 12.1896 14.2857H7.32143C6.03934 14.2857 5 13.2464 5 11.9643C5 10.6822 6.03934 9.64286 7.32143 9.64286H8.06641L9.74749 7.96177L9.80329 7.91574C9.94192 7.82419 10.1305 7.83973 10.2525 7.96177L11.9336 9.64286H12.6786C13.5662 9.64286 14.2857 8.92331 14.2857 8.03571C14.2857 7.14811 13.5662 6.42857 12.6786 6.42857H7.81041C7.65168 7.04451 7.09408 7.5 6.42857 7.5C5.63959 7.5 5 6.86041 5 6.07143C5 5.28245 5.63959 4.64286 6.42857 4.64286ZM13.5714 13.2143C13.1769 13.2143 12.8571 13.5341 12.8571 13.9286C12.8571 14.3231 13.1769 14.6429 13.5714 14.6429C13.9659 14.6429 14.2857 14.3231 14.2857 13.9286C14.2857 13.5341 13.9659 13.2143 13.5714 13.2143ZM8.71931 10L10 11.2807L11.2807 10L10 8.71931L8.71931 10ZM6.42857 5.35714C6.03408 5.35714 5.71429 5.67694 5.71429 6.07143C5.71429 6.46592 6.03408 6.78571 6.42857 6.78571C6.82306 6.78571 7.14286 6.46592 7.14286 6.07143C7.14286 5.67694 6.82306 5.35714 6.42857 5.35714Z" fill="currentColor" />
  </svg>
);
/** Microfone — botão de ditado por voz do compositor (ver PARIDADE.md, `micButton` da extensão real). */
export const Mic = ({ size, className }: P) => <svg {...base(size)} className={className}><rect x="6" y="1.5" width="4" height="7.5" rx="2" /><path d="M4 7.5a4 4 0 0 0 8 0M8 11.5v2.5M6 14h4" /></svg>;
/** Chave inglesa — gatilho do painel de skills + hooks (ver SkillsHooksPanel.tsx). Sem equivalente pronto neste arquivo; mesmo estilo minimalista (traço 1.5, 16x16). */
export const Wrench = ({ size, className }: P) => <svg {...base(size)} className={className}><path d="M10.5 3a3 3 0 0 0-3.9 3.5L2.5 10.6a1.4 1.4 0 0 0 2 2l4.1-4.1A3 3 0 0 0 13 5.5l-2 2-1.5-1.5z" /></svg>;
/** Escudo — gatilho do editor de "Regras de permissão" (ver PermissionRules.tsx). Sem equivalente
 * pronto neste arquivo; desenhado seguindo o mesmo estilo minimalista (traço 1.5, 16x16). */
export const Shield = ({ size, className }: P) => <svg {...base(size)} className={className}><path d="M8 2l5 2v4c0 3.3-2.1 5.5-5 6.5C5.1 13.5 3 11.3 3 8V4l5-2z" /><path d="M6 8l1.4 1.4L10.5 6" /></svg>;
/** Pasta — "Nova pasta"/pastas nomeadas na lateral de sessões (ver Sidebar.tsx, PARIDADE.md item 12 da seção 13: `newGroupButton`/`newGroupIcon` da extensão real). Sem equivalente pronto neste arquivo; desenhado seguindo o mesmo estilo minimalista (traço 1.5, 16x16). */
export const Folder = ({ size, className }: P) => <svg {...base(size)} className={className}><path d="M2.5 4.5a1 1 0 0 1 1-1h2.8l1.3 1.6h5.4a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1z" /></svg>;
/** Extensões (3 quadrados + um "+", como o glifo de extensions do VS Code) — gatilho do "Gerenciar
 * plugins" (ver Marketplace.tsx, PARIDADE-marketplace.md). Sem equivalente pronto neste arquivo;
 * mesmo estilo minimalista (traço 1.5, 16x16). */
export const Puzzle = ({ size, className }: P) => <svg {...base(size)} className={className}><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="2.5" y="9" width="4.5" height="4.5" rx="1" /><rect x="9" y="9" width="4.5" height="4.5" rx="1" /><path d="M11.2 2v4.5M9 4.2h4.5" /></svg>;
