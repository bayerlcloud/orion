import { useEffect, useState } from 'react';
import { api } from './api';
import { avisar, confirmar } from './dialogo';

type Estado = { publico: boolean; ate: string | null; host: string };

const quando = (iso: string) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/**
 * Interruptor "preview público" de um projeto (tela da sessão e card do Dash). Ligado, o endereço raiz
 * abre sem login por 48 h (religar renova); desligado, pede login do Orion. Qualquer pessoa logada mexe.
 */
export default function PreviewPublico({ projectId, compacto = false }: { projectId: number; compacto?: boolean }) {
  const [e, setE] = useState<Estado | null>(null);
  const [ocupado, setOcupado] = useState(false);
  useEffect(() => {
    setE(null);
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
      <button type="button" role="switch" aria-checked={e.publico} className={`pv-switch ${e.publico ? 'on' : ''}`} disabled={ocupado} onClick={alternar} title={dica}>
        <span className="pv-knob" />{e.publico ? 'Ligado' : 'Desligado'}
      </button>
      <span className="pv-info" title={dica}>
        {e.publico && <>público até {quando(e.ate!)} · </>}
        <a href={`https://${e.host}`} target="_blank" rel="noreferrer">{e.host}</a>
      </span>
    </span>
  );
}
