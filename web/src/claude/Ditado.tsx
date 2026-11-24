import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { claudeApi } from './api';
import { Mic } from './icons';

/**
 * Ditado por voz da tela "Olá, Orion." (trazido do Cérebro DDC em 17/11/2026, pedido do Danilo:
 * mesmo fundo e parallax no Orion). Grava no navegador (MediaRecorder, opus 24 kbps mono) e transcreve no servidor
 * (POST /api/claude/transcribe; ver server/claude/transcribe.ts: nuvem se houver chave, senão o
 * Whisper local). O Composer da sessão tem a própria versão, mais completa (marcador no
 * texto, pedaços subindo durante a gravação); esta é a simples: grava, para, devolve o texto.
 */
export type DitadoEstado = 'parado' | 'gravando' | 'transcrevendo';
const LIMITE_SEGUNDOS = 300;

/**
 * Medidor de voz pro parallax da fibra (pedido do Danilo, 17/11/2026: "quando estiver falando
 * quero um efeito parallax"). Enquanto grava, lê o volume do microfone (AnalyserNode) e escreve
 * duas variáveis CSS no <html>: `--voz` (0..1, volume suavizado: sobe rápido, desce devagar) e
 * `--voz-sway` (-1..1, balanço lento no tempo). Fibra.tsx usa as duas pra mover cada camada
 * de arcos numa profundidade diferente (ui.css, `.fibra-camada`). Parou de gravar: tudo volta a 0.
 */
/** AudioContext criado ainda dentro do clique no microfone (antes do await do getUserMedia): fora do
 *  gesto do usuário o navegador cria o contexto suspenso e o medidor leria só zeros. */
function criarContextoAudio(): AudioContext | null {
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  try { return new AC(); } catch { return null; }
}
function iniciarMedidor(stream: MediaStream, ctx: AudioContext | null): () => void {
  const raiz = document.documentElement;
  if (!ctx) return () => {};
  const fonte = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  an.smoothingTimeConstant = 0.4;
  fonte.connect(an);
  const buf = new Uint8Array(an.fftSize);
  let suave = 0;
  let raf = 0;
  const t0 = performance.now();
  let tAnt = t0;
  const passo = (t: number) => {
    an.getByteTimeDomainData(buf);
    let soma = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; soma += v * v; }
    const rms = Math.sqrt(soma / buf.length);
    const nivel = Math.min(1, Math.max(0, (rms - 0.015) * 5));
    // Suavização por tempo, não por quadro: sobe em ~40 ms, desce em ~250 ms, igual a 60 fps ou a 10 fps.
    const dt = Math.min(0.25, (t - tAnt) / 1000); tAnt = t;
    suave += (nivel - suave) * (1 - Math.exp(-dt / (nivel > suave ? 0.04 : 0.25)));
    raiz.style.setProperty('--voz', suave.toFixed(3));
    raiz.style.setProperty('--voz-sway', Math.sin((t - t0) / 1400).toFixed(3));
    raf = requestAnimationFrame(passo);
  };
  raiz.style.setProperty('--voz-on', '1');
  raf = requestAnimationFrame(passo);
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  return () => {
    cancelAnimationFrame(raf);
    try { fonte.disconnect(); } catch { /* já desligado */ }
    void ctx.close().catch(() => {});
    raiz.style.setProperty('--voz', '0');
    raiz.style.setProperty('--voz-sway', '0');
    raiz.style.setProperty('--voz-on', '0');
  };
}

/** Junta o ditado ao texto que já estava na caixa, com um espaço quando precisa. */
export function juntarDitado(atual: string, ditado: string): string {
  if (!ditado) return atual;
  if (!atual.trim()) return ditado;
  return /\s$/.test(atual) ? atual + ditado : `${atual} ${ditado}`;
}

export function useDitado(onTexto: (texto: string) => void) {
  const suportado = useMemo(() => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined', []);
  const [estado, setEstado] = useState<DitadoEstado>('parado');
  const [erro, setErro] = useState<string | null>(null);
  const [segundos, setSegundos] = useState(0);
  const recRef = useRef<MediaRecorder | null>(null);
  const medidorRef = useRef<(() => void) | null>(null);
  const pendenteRef = useRef<Promise<string> | null>(null);
  const onTextoRef = useRef(onTexto);
  onTextoRef.current = onTexto;

  /** Para a gravação e resolve com o texto transcrito ('' se não estava gravando ou se falhou). */
  const parar = useCallback((): Promise<string> => {
    const rec = recRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
    return pendenteRef.current ?? Promise.resolve('');
  }, []);

  const iniciar = useCallback(async () => {
    if (!suportado || recRef.current) return;
    setErro(null);
    const ctxAudio = criarContextoAudio();
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } }); }
    catch (e) {
      void ctxAudio?.close().catch(() => {});
      const name = (e as { name?: string }).name;
      setErro(name === 'NotAllowedError' || name === 'SecurityError' ? 'Microfone bloqueado. Libere o acesso no navegador.' : 'Não consegui abrir o microfone.');
      return;
    }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported?.(t)) ?? '';
    const rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 24000 });
    const type0 = mime || 'audio/webm';
    const ext = type0.includes('mp4') ? 'm4a' : type0.includes('ogg') ? 'ogg' : 'webm';
    const chunks: Blob[] = [];
    rec.ondataavailable = ev => { if (ev.data.size) chunks.push(ev.data); };
    let resolver: (t: string) => void = () => {};
    pendenteRef.current = new Promise<string>(r => { resolver = r; });
    rec.onstop = async () => {
      medidorRef.current?.(); medidorRef.current = null;
      stream.getTracks().forEach(t => t.stop());
      recRef.current = null;
      setEstado('transcrevendo');
      let texto = '';
      try {
        const blob = new Blob(chunks, { type: rec.mimeType || type0 });
        const r = await claudeApi.transcribe(blob, `ditado.${ext}`);
        texto = r.text;
        if (texto) onTextoRef.current(texto);
        else setErro('Não ouvi nada. Fale mais perto do microfone e tente de novo.');
      } catch (e) { setErro((e as Error).message || 'Não consegui transcrever agora.'); }
      finally { setEstado('parado'); setSegundos(0); pendenteRef.current = null; resolver(texto); }
    };
    recRef.current = rec;
    rec.start(1000);
    medidorRef.current = iniciarMedidor(stream, ctxAudio);
    setEstado('gravando'); setSegundos(0);
  }, [suportado]);

  useEffect(() => {
    if (estado !== 'gravando') return;
    const t = setInterval(() => setSegundos(s => s + 1), 1000);
    return () => clearInterval(t);
  }, [estado]);
  useEffect(() => { if (estado === 'gravando' && segundos >= LIMITE_SEGUNDOS) void parar(); }, [estado, segundos, parar]);
  // Saiu da tela no meio da gravação: solta o microfone sem transcrever.
  useEffect(() => () => {
    const rec = recRef.current;
    medidorRef.current?.(); medidorRef.current = null;
    if (rec && rec.state !== 'inactive') { rec.onstop = null; rec.stop(); rec.stream.getTracks().forEach(t => t.stop()); }
  }, []);

  const alternar = useCallback(() => {
    if (estado === 'gravando') void parar();
    else if (estado === 'parado') void iniciar();
  }, [estado, iniciar, parar]);
  const limparErro = useCallback(() => setErro(null), []);

  return { suportado, estado, erro, segundos, alternar, parar, limparErro };
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** Botão de microfone: vermelho pulsando enquanto grava (com o tempo), spinner enquanto transcreve. */
export function BotaoDitado({ ditado, className }: { ditado: ReturnType<typeof useDitado>; className?: string }) {
  if (!ditado.suportado) return null;
  const gravando = ditado.estado === 'gravando';
  const transcrevendo = ditado.estado === 'transcrevendo';
  const titulo = gravando ? 'Parar e transcrever' : transcrevendo ? 'Transcrevendo…' : 'Ditar por voz';
  return (
    <span className={`ditado${className ? ` ${className}` : ''}`}>
      <button type="button" className={`ditado-btn${gravando ? ' is-recording' : ''}${transcrevendo ? ' is-busy' : ''}`}
        onClick={ditado.alternar} disabled={transcrevendo} aria-label={titulo} title={titulo} aria-pressed={gravando}>
        {transcrevendo ? <span className="ditado-spinner" aria-hidden="true" /> : <Mic size={16} className="ditado-icon" />}
        {gravando && <span className="ditado-tempo">{fmt(ditado.segundos)}</span>}
        {transcrevendo && <span className="ditado-tempo">Transcrevendo…</span>}
      </button>
      {ditado.erro && <span className="ditado-erro" role="alert" onClick={ditado.limparErro}>{ditado.erro}</span>}
    </span>
  );
}
