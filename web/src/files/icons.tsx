/* Ícones de 16px em traço, no espírito dos codicons (desenhados aqui, não copiados). */
const base = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

export const Chevron = ({ open }: { open: boolean }) => (
  <svg {...base} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .08s' }}>
    <path d="M6 3.5 10.5 8 6 12.5" />
  </svg>
);

export const IconNewFile = () => (
  <svg {...base}>
    <path d="M9 1.5H3.5v13h9V5.5z" /><path d="M9 1.5v4h3.5" /><path d="M8 8.5v4M6 10.5h4" />
  </svg>
);

export const IconNewFolder = () => (
  <svg {...base}>
    <path d="M1.5 3.5h4.5l1.5 1.5h7v8.5h-13z" /><path d="M8 7.5v4M6 9.5h4" />
  </svg>
);

export const IconRefresh = () => (
  <svg {...base}>
    <path d="M13 8a5 5 0 1 1-1.5-3.6" /><path d="M13 2.5v3h-3" />
  </svg>
);

export const IconCollapseAll = () => (
  <svg {...base}>
    <rect x="2.5" y="2.5" width="11" height="11" /><path d="M5.5 8h5" />
  </svg>
);

export const IconEllipsis = () => (
  <svg {...base} fill="currentColor" stroke="none">
    <circle cx="3.5" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="12.5" cy="8" r="1.2" />
  </svg>
);

export const IconClose = () => (
  <svg {...base}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);

export const IconSearch = () => (
  <svg {...base}>
    <circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" />
  </svg>
);

export const IconFile = () => (
  <svg {...base} style={{ opacity: .55 }}>
    <path d="M9.5 1.5H3.5v13h9V5z" /><path d="M9.5 1.5V5h3" />
  </svg>
);

export const IconLink = () => (
  <svg {...base}>
    <path d="M6.5 9.5 9.5 6.5" /><path d="M7 4.5 8.5 3a2.5 2.5 0 0 1 3.5 3.5L10.5 8" /><path d="M9 11.5 7.5 13A2.5 2.5 0 0 1 4 9.5L5.5 8" />
  </svg>
);
