import { useEffect, useState } from 'react';
import { api } from './api';
import { avisar, confirmar } from './dialogo';

type Estado = { publico: boolean; ate: string | null; host: string };

// Estado já conhecido por projeto: o menu abre com o interruptor pronto (sem aparecer depois do resto).
const cache = new Map<number, Estado>();
/** Busca o estado antes de precisar (ex.: ao abrir a aba da sessão), para o menu ⋮ abrir completo. */
export function prefetchPreviewPublico(projectId: number): Promise<void> {
  return api<Estado>(`/api/projects/${projectId}/preview-publico`).then(e => { cache.set(projectId, e); }).catch(() => {});
}

const quando = (iso: string) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/**
 * Interruptor "preview público" de um projeto (tela da sessão e card do Dash). Ligado, o endereço raiz
 * abre sem login por 48 h (religar renova); desligado, pede login do Orion. Qualquer pessoa logada mexe.
 */
export default function PreviewPublico({ projectId, compacto = false }: { projectId: number; compacto?: boolean }) {
  const [e, setEstado] = useState<Estado | null>(() => cache.get(projectId) ?? null);
  const setE = (v: Estado) => { cache.set(projectId, v); setEstado(v); };
  const [ocupado, setOcupado] = useState(false);
  const [copiado, setCopiado] = useState(false);
  useEffect(() => {
    setEstado(cache.get(projectId) ?? null);
    // Mostra o que já sabe na hora e confirma com o servidor por trás.
    api<Estado>(`/api/projects/${projectId}/preview-publico`).then(setE).catch(() => {});
  }, [projectId]);
  if (!e) return null;
  async function alternar() {
    if (!e || ocupado) return;
    const liga = !e.publico;
    if (liga && !(await confirmar(`Ligar o preview público por 48 h? Qualquer pessoa com o link ${e.host} abre sem login.`))) return;
    setOcupado(true);
    try { setE(await api<Estado>(`/api/projects/${projectId}/preview-publico`, { method: 'PUT', body: JSON.stringify({ publico: liga }) })); }
    catch (err) { void avisar((err as Error).message); }
    finally { setOcupado(false); }
  }
  const dica = e.publico ? `${e.host} abre sem login até ${quando(e.ate!)}. Clique para desligar.` : `${e.host} pede login do Orion. Clique para ligar por 48 h.`;
  return (
    <span className={`pv-pub ${compacto ? 'is-compacto' : ''}`} onClick={ev => ev.stopPropagation()}>
      <span className="pv-row">
        {/* Interruptor (trilho + bolinha) com o rótulo ao lado. */}
        <button type="button" role="switch" aria-checked={e.publico} className={`pv-toggle ${e.publico ? 'on' : ''}`} disabled={ocupado} onClick={alternar} title={dica}>
          <span className="pv-track"><span className="pv-thumb" /></span>
          <span className="pv-lbl">{e.publico ? 'Público' : 'Privado'}</span>
        </button>
        <span className="pv-addr">
          <button type="button" className="pv-copy" title={copiado ? 'Copiado!' : 'Copiar endereço'}
            onClick={() => { void navigator.clipboard?.writeText(`https://${e.host}`).then(() => { setCopiado(true); setTimeout(() => setCopiado(false), 1500); }); }}>
            {copiado ? '✓' : '⧉'}
          </button>
          <a href={`https://${e.host}`} target="_blank" rel="noreferrer" title={dica}>{e.host}</a>
        </span>
      </span>
      <span className="pv-sub">{e.publico ? `Abre sem login até ${quando(e.ate!)}` : 'Pede login do Orion · ligar libera por 48 h'}</span>
    </span>
  );
}
