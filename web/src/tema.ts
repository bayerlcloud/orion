// Tema da interface: escolha (escuro/claro/sistema) + variante do escuro (normal ou black AMOLED).
export type Tema = 'dark' | 'light' | 'system';
export type VarianteEscuro = 'dark' | 'black';

const claroMq = () => matchMedia('(prefers-color-scheme: light)');
let atual: { tema: Tema; variante: VarianteEscuro } = { tema: 'dark', variante: 'dark' };

function pintar() {
  const claro = atual.tema === 'light' || (atual.tema === 'system' && claroMq().matches);
  const root = document.documentElement;
  root.setAttribute('data-theme', claro ? 'light' : 'dark');
  root.toggleAttribute('data-black', !claro && atual.variante === 'black');
  const cor = claro ? '#d6d8df' : atual.variante === 'black' ? '#000000' : '#1b1b1c';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', cor);
}

export function aplicarTema(tema: Tema, variante: VarianteEscuro) {
  atual = { tema, variante };
  try { localStorage.setItem('orion-theme', tema); localStorage.setItem('orion-dark-variant', variante); } catch { /* modo privado */ }
  pintar();
}

/** Lê o que ficou salvo neste aparelho e passa a acompanhar o sistema operacional (modo Sistema). */
export function iniciarTema() {
  try {
    const t = localStorage.getItem('orion-theme');
    const v = localStorage.getItem('orion-dark-variant');
    atual = { tema: t === 'light' || t === 'system' ? t : 'dark', variante: v === 'black' ? 'black' : 'dark' };
  } catch { /* sem storage */ }
  pintar();
  claroMq().addEventListener('change', () => { if (atual.tema === 'system') pintar(); });
}
