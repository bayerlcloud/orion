// Tema da interface: catálogo de temas nomeados (escuros e claros) + variante AMOLED (preto puro)
// para quem estiver num tema escuro. Modo (sistema/claro/escuro) e tema de cada modo são
// independentes: a pessoa escolhe qual tema usar quando está em claro e qual usar quando está em
// escuro, e separadamente se quer seguir o sistema operacional ou fixar um dos dois.
export type TemaId = 'orion' | 'dark' | 'dracula' | 'nord' | 'one-dark' | 'branco' | 'light' | 'claude';
export type Modo = 'system' | 'light' | 'dark';
export type VarianteEscuro = 'dark' | 'black';

type InfoTema = { id: TemaId; label: string; escuro: boolean; cor: string };

/** Catálogo de temas. Orion primeiro: é o padrão para o modo escuro. */
export const TEMAS: InfoTema[] = [
  { id: 'orion', label: 'Orion', escuro: true, cor: '#000000' },
  { id: 'dark', label: 'Tokyo Night', escuro: true, cor: '#16161e' },
  { id: 'dracula', label: 'Dracula', escuro: true, cor: '#282a36' },
  { id: 'nord', label: 'Nord', escuro: true, cor: '#2e3440' },
  { id: 'one-dark', label: 'One Dark', escuro: true, cor: '#282c34' },
  { id: 'branco', label: 'Branco', escuro: false, cor: '#ffffff' },
  { id: 'light', label: 'Cinza', escuro: false, cor: '#d6d8df' },
  { id: 'claude', label: 'Claude', escuro: false, cor: '#f0eee6' },
];

const MODOS: Modo[] = ['system', 'light', 'dark'];

/** Valor vindo do servidor ou do localStorage: se não for um tema conhecido do lado pedido (claro
 * ou escuro), cai no padrão daquele lado ('branco' no claro, 'orion' no escuro). */
export function temaValido(v: unknown, escuro: boolean): TemaId {
  const info = TEMAS.find(t => t.id === v);
  if (info && info.escuro === escuro) return info.id;
  return escuro ? 'orion' : 'branco';
}

export function modoValido(v: unknown): Modo {
  return (MODOS as unknown[]).includes(v) ? (v as Modo) : 'dark';
}

const claroMq = () => matchMedia('(prefers-color-scheme: light)');

type Prefs = { modo: Modo; temaClaro: TemaId; temaEscuro: TemaId; variante: VarianteEscuro };
let atual: Prefs = { modo: 'dark', temaClaro: 'branco', temaEscuro: 'orion', variante: 'dark' };

/** 'system' vira 'light' ou 'dark' conforme o sistema operacional; os demais passam direto. */
function modoResolvido(modo: Modo): 'light' | 'dark' {
  if (modo === 'system') return claroMq().matches ? 'light' : 'dark';
  return modo;
}

function pintar() {
  const escuro = modoResolvido(atual.modo) === 'dark';
  const id = escuro ? atual.temaEscuro : atual.temaClaro;
  const info = TEMAS.find(t => t.id === id) ?? TEMAS[0];
  const preto = escuro && atual.variante === 'black';
  const root = document.documentElement;
  root.setAttribute('data-theme', id);
  root.toggleAttribute('data-black', preto);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', preto ? '#000000' : info.cor);
}

export function aplicarTema(prefs: Prefs) {
  atual = prefs;
  try {
    localStorage.setItem('orion-modo', prefs.modo);
    localStorage.setItem('orion-tema-claro', prefs.temaClaro);
    localStorage.setItem('orion-tema-escuro', prefs.temaEscuro);
    localStorage.setItem('orion-dark-variant', prefs.variante);
  } catch { /* modo privado */ }
  pintar();
}

/** Lê o que ficou salvo neste aparelho e passa a acompanhar o sistema operacional (modo Sistema). */
export function iniciarTema() {
  try {
    atual = {
      modo: modoValido(localStorage.getItem('orion-modo')),
      temaClaro: temaValido(localStorage.getItem('orion-tema-claro'), false),
      temaEscuro: temaValido(localStorage.getItem('orion-tema-escuro'), true),
      variante: localStorage.getItem('orion-dark-variant') === 'black' ? 'black' : 'dark',
    };
  } catch { /* sem storage */ }
  pintar();
  claroMq().addEventListener('change', () => { if (atual.modo === 'system') pintar(); });
}
