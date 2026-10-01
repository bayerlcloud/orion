import React, { useEffect, useState, type MouseEvent } from 'react';
import { paraFala, pedacos } from './fala';

export { paraFala, pedacos };

/**
 * Ouvir a resposta em voz alta (pedido do Danilo: escutar no carro). Usa a voz do próprio navegador
 * (speechSynthesis), sem servidor nem custo. Um player só na página: dar play numa mensagem para a outra.
 * ponytail: voz do sistema operacional; trocar por TTS de servidor (OpenAI/ElevenLabs) se a voz ficar ruim.
 */

const RATES = [1, 1.25, 1.5, 2];
const RATE_KEY = 'orion.ouvir.rate';


type Estado = { id: string | null; paused: boolean; rate: number };
let estado: Estado = { id: null, paused: false, rate: (typeof localStorage !== 'undefined' && Number(localStorage.getItem(RATE_KEY))) || 1 };
let partes: string[] = [];
let idx = 0;
let geracao = 0;
const ouvintes = new Set<() => void>();
const avisa = (s: Partial<Estado>) => { estado = { ...estado, ...s }; ouvintes.forEach((f) => f()); };

function voz(): SpeechSynthesisVoice | undefined {
  const vs = speechSynthesis.getVoices();
  return vs.find((v) => v.lang === 'pt-BR' && /luciana|google|natural/i.test(v.name)) ?? vs.find((v) => v.lang === 'pt-BR') ?? vs.find((v) => v.lang.startsWith('pt'));
}

function falaDaqui() {
  const g = ++geracao;
  speechSynthesis.cancel();
  const proxima = () => {
    if (g !== geracao) return;
    if (idx >= partes.length) { avisa({ id: null, paused: false }); return; }
    const u = new SpeechSynthesisUtterance(partes[idx]);
    u.lang = 'pt-BR';
    const v = voz(); if (v) u.voice = v;
    u.rate = estado.rate;
    u.onend = () => { if (g === geracao) { idx++; proxima(); } };
    u.onerror = u.onend;
    speechSynthesis.speak(u);
  };
  proxima();
}

function tocar(id: string, texto: string) {
  if (estado.id === id) {
    if (estado.paused) { speechSynthesis.resume(); avisa({ paused: false }); }
    else { speechSynthesis.pause(); avisa({ paused: true }); }
    return;
  }
  partes = pedacos(paraFala(texto));
  idx = 0;
  avisa({ id, paused: false });
  falaDaqui();
}

function parar() { geracao++; speechSynthesis.cancel(); avisa({ id: null, paused: false }); }

function trocaVelocidade() {
  const rate = RATES[(RATES.indexOf(estado.rate) + 1) % RATES.length];
  localStorage.setItem(RATE_KEY, String(rate));
  avisa({ rate });
  if (estado.id) { avisa({ paused: false }); falaDaqui(); }
}

const svg = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const Falar = () => <svg {...svg}><path d="M2.5 6v4h2.5l3.5 3V3L5 6z" /><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4" /></svg>;
const Pausa = () => <svg {...svg}><path d="M5.5 3.5v9M10.5 3.5v9" /></svg>;
const Play = () => <svg {...svg}><path d="M5 3l8 5-8 5z" /></svg>;
const Parar = () => <svg {...svg}><rect x="4" y="4" width="8" height="8" rx="1" /></svg>;

export default function Ouvir({ id, text }: { id: string; text: string }) {
  const [, force] = useState(0);
  useEffect(() => { const f = () => force((n) => n + 1); ouvintes.add(f); return () => { ouvintes.delete(f); }; }, []);
  if (typeof speechSynthesis === 'undefined') return null;
  const ativo = estado.id === id;
  const clique = (fn: () => void) => (e: MouseEvent) => { e.stopPropagation(); fn(); };
  return (
    <div className={`cc-ouvir${ativo ? ' is-on' : ''}`}>
      {ativo && <button className="cc-ouvir-rate" onClick={clique(trocaVelocidade)} title="Velocidade">{estado.rate}x</button>}
      {ativo && <button onClick={clique(parar)} title="Parar" aria-label="Parar"><Parar /></button>}
      <button onClick={clique(() => tocar(id, text))} title={ativo ? (estado.paused ? 'Continuar' : 'Pausar') : 'Ouvir resposta'} aria-label="Ouvir resposta">
        {!ativo ? <Falar /> : estado.paused ? <Play /> : <Pausa />}
      </button>
    </div>
  );
}
