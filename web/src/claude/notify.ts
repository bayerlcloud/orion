// Aviso de fim de turno quando a aba do Orion está em segundo plano: notificação do navegador + bipe.

export function pedirPermissaoAviso() {
  if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
}

let ctx: AudioContext | null = null;
function bip() {
  try {
    ctx ??= new AudioContext();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.08, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    o.connect(g).connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.25);
  } catch { /* sem áudio */ }
}

export function avisarFimTurno(id: string, titulo: string, ok: boolean) {
  if (!document.hidden) return;
  bip();
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const n = new Notification(ok ? 'Claude terminou' : 'Claude parou com erro', { body: titulo, tag: `orion-${id}` });
  n.onclick = () => { window.focus(); n.close(); };
}
