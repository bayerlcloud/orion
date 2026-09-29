import { Fragment, useEffect } from 'react';
import { copiar } from './ToolsNotas';

type Props = {
  icone: string; badge: string; badgeClass: string; titulo: string; sub?: string;
  linhas: [string, string][]; notas: string; onEdit?: () => void; onClose: () => void;
};

/** Popup de uma conta (GitHub, Cloudflare): mesmo visual do popup do catálogo, com os valores inteiros e a explicação completa. */
export default function ToolsContaModal({ icone, badge, badgeClass, titulo, sub, linhas, notas, onEdit, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="tls-modal-bg" onClick={onClose}>
      <div className="tls-modal" role="dialog" aria-modal="true" aria-label={titulo} onClick={e => e.stopPropagation()}>
        <div className="tls-card-top">
          <span className="tls-icon">{icone}</span>
          <span className={`tls-badge ${badgeClass}`}>{badge}</span>
          <span className="tls-spacer" />
          <button className="tls-icon-btn" onClick={onClose} title="Fechar" autoFocus>✕</button>
        </div>
        <h2 className="tls-modal-title">{titulo}</h2>
        {sub && <p className="tls-desc">{sub}</p>}
        <dl className="tls-rows">
          {linhas.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd className="cp" title="clique para copiar" onClick={() => copiar(v)}>{v}</dd></Fragment>)}
        </dl>
        <div className="tls-modal-sec">Explicação (entra no prompt de toda sessão)</div>
        {notas.trim() ? <div className="tls-details">{notas}</div> : <p className="muted small">Nada descrito ainda.{onEdit && ' Clique em ✎ para preencher.'}</p>}
        {onEdit && <div className="tls-form-actions"><button onClick={onEdit}>✎ Editar</button></div>}
      </div>
    </div>
  );
}
