import { IconClose } from './icons';
import type { OpenFile } from './types';

type Props = {
  files: OpenFile[];
  active: string | null;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onPin: (key: string) => void;
};

/** Abas dos arquivos abertos: itálico = preview (some quando outro arquivo abre), ● = alterado. */
export default function Tabs({ files, active, onActivate, onClose, onPin }: Props) {
  return (
    <div className="arq-tabs" role="tablist">
      {files.map(f => (
        <div
          key={f.key}
          role="tab"
          aria-selected={f.key === active}
          className={`arq-tab${f.key === active ? ' is-active' : ''}${f.preview ? ' is-preview' : ''}${f.dirty ? ' is-dirty' : ''}`}
          title={f.rel}
          onClick={() => onActivate(f.key)}
          onDoubleClick={() => onPin(f.key)}
          onAuxClick={e => { if (e.button === 1) { e.preventDefault(); onClose(f.key); } }}
        >
          <span className="arq-tab-name">{f.name}</span>
          <button
            type="button"
            className="arq-tab-close"
            title={f.dirty ? 'alterado — fechar' : 'fechar'}
            onClick={e => { e.stopPropagation(); onClose(f.key); }}
          >
            {f.dirty ? <span className="arq-tab-dot" /> : <IconClose />}
          </button>
        </div>
      ))}
    </div>
  );
}
