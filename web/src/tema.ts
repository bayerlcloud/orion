// Tema da interface: catálogo de temas nomeados (escuros e claros) + variante AMOLED (preto puro)
// para quem estiver num tema escuro.
export type Tema = 'dark' | 'light' | 'system' | 'dracula' | 'nord' | 'one-dark' | 'branco' | 'claude';
export type VarianteEscuro = 'dark' | 'black';

type InfoTema = { id: Exclude<Tema, 'system'>; label: string; escuro: boolean; cor: string };

/** Catálogo de temas (sem 'system', que é só "siga o sistema" e resolve para 'dark' ou 'light'). */
export const TEMAS: InfoTema[] = [
  { id: 'dark', label: 'Tokyo Night', escuro: true, cor: '#1b1b1c' },
  { id: 'dracula', label: 'Dracula', escuro: true, cor: '#282a36' },
  { id: 'nord', label: 'Nord', escuro: true, cor: '#2e3440' },
  { id: 'one-dark', label: 'One Dark', escuro: true, cor: '#282c34' },
  { id: 'light', label: 'Cinza', escuro: false, cor: '#d6d8df' },
  { id: 'branco', label: 'Branco', escuro: false, cor: '#ffffff' },
  { id: 'claude', label: 'Claude', escuro: false, cor: '#f0eee6' },
];

const TEMA_IDS: Tema[] = ['dark', 'light', 'system', ...TEMAS.map(t => t.id).filter(id => id !== 'dark' && id !== 'light')];

/** Valor vindo do servidor ou do localStorage: se não for um tema conhecido, cai no padrão ('dark'). */
export function temaValido(v: unknown): Tema {
  return (TEMA_IDS as unknown[]).includes(v) ? (v as Tema) : 'dark';
}

const claroMq = () => matchMedia('(prefers-color-scheme: light)');
let atual: { tema: Tema; variante: VarianteEscuro } = { tema: 'dark', variante: 'dark' };

/** 'system' vira 'dark' ou 'light' conforme o sistema operacional; os demais temas passam direto. */
function resolver(tema: Tema): Exclude<Tema, 'system'> {
  if (tema !== 'system') return tema;
  return claroMq().matches ? 'light' : 'dark';
}

function pintar() {
  const resolvido = resolver(atual.tema);
  const info = TEMAS.find(t => t.id === resolvido) ?? TEMAS[0];
  const preto = info.escuro && atual.variante === 'black';
  const root = document.documentElement;
  root.setAttribute('data-theme', resolvido);
  root.toggleAttribute('data-black', preto);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', preto ? '#000000' : info.cor);
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
    atual = { tema: temaValido(t), variante: v === 'black' ? 'black' : 'dark' };
  } catch { /* sem storage */ }
  pintar();
  claroMq().addEventListener('change', () => { if (atual.tema === 'system') pintar(); });
}
