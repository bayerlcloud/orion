import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type User } from '../api';
import { formatBytes, pasteFilename } from './driveUtils';
import './drive.css';

type DriveFile = { id: number; user_id: number; user_name: string; name: string; size: number; mime: string; path: string; created_at: string };
type Usage = { user_id: number; name: string; files: number; total: number };
type Listing = { files: DriveFile[]; usage: Usage[]; max_bytes: number; dir: string };
type Upload = { key: number; name: string; size: number; progress: number; status: 'fila' | 'enviando' | 'ok' | 'erro'; error?: string };

const MAX_BYTES = 2 * 1024 ** 3;
const PARALELOS = 2;

function enviar(file: File, onProgress: (frac: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/drive/upload');
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let msg = `erro ${xhr.status}`;
      try { msg = JSON.parse(xhr.responseText).error ?? msg; } catch { /* corpo não é JSON */ }
      reject(new Error(msg));
    };
    xhr.onerror = () => reject(new Error('falha de rede'));
    xhr.onabort = () => reject(new Error('cancelado'));
    const fd = new FormData();
    fd.append('file', file, file.name);
    xhr.send(fd);
  });
}

const isImagem = (m: string) => m.startsWith('image/');
function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toUpperCase().slice(0, 4) : 'ARQ';
}
function plural(n: number, um: string, varios: string) { return `${n} ${n === 1 ? um : varios}`; }
function statusLabel(u: Upload): string {
  switch (u.status) {
    case 'fila': return 'na fila';
    case 'enviando': return `${Math.round(u.progress * 100)}%`;
    case 'ok': return 'concluído';
    case 'erro': return `erro: ${u.error ?? 'desconhecido'}`;
  }
}

export default function Drive({ user }: { user: User }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [erro, setErro] = useState('');
  const [arrastando, setArrastando] = useState(false);
  const [copiado, setCopiado] = useState<number | null>(null);
  const [preview, setPreview] = useState<DriveFile | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const fila = useRef<{ key: number; file: File }[]>([]);
  const ativos = useRef(0);
  const limite = useRef(MAX_BYTES);

  const refresh = useCallback(
    () => api<Listing>('/api/drive/files').then(l => { setListing(l); setErro(''); }).catch(e => setErro(e.message)),
    []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { if (listing) limite.current = listing.max_bytes; }, [listing]);

  const patch = useCallback((key: number, p: Partial<Upload>) =>
    setUploads(us => us.map(u => (u.key === key ? { ...u, ...p } : u))), []);

  const bombear = useCallback(function bombear() {
    while (ativos.current < PARALELOS && fila.current.length) {
      const { key, file } = fila.current.shift()!;
      ativos.current++;
      patch(key, { status: 'enviando' });
      enviar(file, frac => patch(key, { progress: frac }))
        .then(() => { patch(key, { status: 'ok', progress: 1 }); return refresh(); })
        .catch(e => patch(key, { status: 'erro', error: (e as Error).message }))
        .finally(() => { ativos.current--; bombear(); });
    }
  }, [patch, refresh]);

  const enfileirar = useCallback((files: File[]) => {
    if (!files.length) return;
    const novos: Upload[] = [];
    for (const f of files) {
      const key = ++seq.current;
      if (f.size > limite.current) {
        novos.push({ key, name: f.name, size: f.size, progress: 0, status: 'erro', error: `passa de ${formatBytes(limite.current)}` });
        continue;
      }
      novos.push({ key, name: f.name, size: f.size, progress: 0, status: 'fila' });
      fila.current.push({ key, file: f });
    }
    setUploads(us => [...novos, ...us]);
    bombear();
  }, [bombear]);

  useEffect(() => {
    let profundidade = 0;
    // Só age com o Drive na tela (a página continua montada escondida quando se troca de menu).
    const naTela = () => !document.body.dataset.page || document.body.dataset.page === '/drive';
    const temArquivo = (e: DragEvent) => naTela() && Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onEnter = (e: DragEvent) => { if (!temArquivo(e)) return; e.preventDefault(); profundidade++; setArrastando(true); };
    const onOver = (e: DragEvent) => { if (!temArquivo(e)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; };
    const onLeave = (e: DragEvent) => { if (!temArquivo(e)) return; profundidade = Math.max(0, profundidade - 1); if (profundidade === 0) setArrastando(false); };
    const onDrop = (e: DragEvent) => {
      if (!temArquivo(e)) return;
      e.preventDefault(); profundidade = 0; setArrastando(false);
      enfileirar(Array.from(e.dataTransfer?.files ?? []));
    };
    document.addEventListener('dragenter', onEnter);
    document.addEventListener('dragover', onOver);
    document.addEventListener('dragleave', onLeave);
    document.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('dragenter', onEnter);
      document.removeEventListener('dragover', onOver);
      document.removeEventListener('dragleave', onLeave);
      document.removeEventListener('drop', onDrop);
    };
  }, [enfileirar]);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (document.body.dataset.page && document.body.dataset.page !== '/drive') return;
      const alvo = e.target as HTMLElement | null;
      if (alvo && (alvo.tagName === 'INPUT' || alvo.tagName === 'TEXTAREA' || alvo.isContentEditable)) return;
      const files: File[] = [];
      for (const item of Array.from(e.clipboardData?.items ?? [])) {
        if (item.kind !== 'file') continue;
        const f = item.getAsFile();
        if (!f) continue;
        const nome = pasteFilename(f.name, f.type);
        files.push(nome === f.name ? f : new File([f], nome, { type: f.type, lastModified: f.lastModified }));
      }
      if (!files.length) return;
      e.preventDefault();
      enfileirar(files);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [enfileirar]);

  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => { if (document.body.dataset.page && document.body.dataset.page !== '/drive') return; if (e.key === 'Escape') setPreview(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [preview]);

  async function copiarCaminho(f: DriveFile) {
    try { await navigator.clipboard.writeText(f.path); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = f.path; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    setCopiado(f.id);
    setTimeout(() => setCopiado(c => (c === f.id ? null : c)), 1500);
  }

  async function renomear(f: DriveFile) {
    const novo = prompt('Novo nome do arquivo', f.name);
    if (novo == null) return;
    const nome = novo.trim();
    if (!nome || nome === f.name) return;
    try { await api(`/api/drive/files/${f.id}/rename`, { method: 'PATCH', body: JSON.stringify({ name: nome }) }); await refresh(); }
    catch (e) { setErro((e as Error).message); }
  }

  async function excluir(f: DriveFile) {
    if (!confirm(`Excluir "${f.name}"?`)) return;
    try { await api(`/api/drive/files/${f.id}`, { method: 'DELETE' }); await refresh(); }
    catch (e) { setErro((e as Error).message); }
  }

  const admin = user.role === 'owner';
  const totalGeral = listing?.usage.reduce((s, u) => s + u.total, 0) ?? 0;
  const arquivosGeral = listing?.usage.reduce((s, u) => s + u.files, 0) ?? 0;

  return (
    <div className="drive">
      <div className="drive-cabecalho">
        <h1>Drive</h1>
        {listing && <span className="muted small">{plural(arquivosGeral, 'arquivo', 'arquivos')} · {formatBytes(totalGeral)} · pasta <code>{listing.dir}</code> · máx {formatBytes(listing.max_bytes)}/arquivo</span>}
      </div>
      {erro && <div className="erro">{erro}</div>}

      {listing && (
        <div className="drive-cards">
          {listing.usage.map(u => (
            <div key={u.user_id} className="drive-card">
              <div className="drive-card-nome">{u.user_id === user.id ? 'você' : u.name}</div>
              <div className="drive-card-num">{formatBytes(u.total)}</div>
              <div className="muted small">{plural(u.files, 'arquivo', 'arquivos')}</div>
            </div>
          ))}
        </div>
      )}

      <input ref={inputRef} type="file" multiple hidden
        onChange={e => { enfileirar(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
      <div className={'drive-zona' + (arrastando ? ' ativa' : '')} role="button" tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}>
        <div className="drive-zona-icone">⬆</div>
        <div className="drive-zona-titulo">{arrastando ? 'solte para enviar' : 'arraste arquivos aqui ou clique para escolher'}</div>
        <div className="muted small">qualquer tipo, vários de uma vez · Ctrl/Cmd+V cola um print da área de transferência</div>
      </div>

      {uploads.length > 0 && (
        <ul className="drive-envios">
          {uploads.map(u => (
            <li key={u.key} className={'drive-envio ' + u.status}>
              <div className="drive-envio-linha">
                <span className="drive-envio-nome" title={u.name}>{u.name}</span>
                <span className="muted small">{formatBytes(u.size)}</span>
                <span className="small drive-envio-status">{statusLabel(u)}</span>
              </div>
              <div className="drive-barra"><div style={{ width: `${Math.round(u.progress * 100)}%` }} /></div>
            </li>
          ))}
          {uploads.some(u => u.status === 'ok' || u.status === 'erro') && (
            <li><button className="link small" onClick={() => setUploads(us => us.filter(u => u.status === 'fila' || u.status === 'enviando'))}>limpar concluídos</button></li>
          )}
        </ul>
      )}

      {listing && listing.files.length === 0 && uploads.length === 0 && <p className="muted">Nenhum arquivo ainda.</p>}
      {!listing && !erro && <p className="muted">carregando…</p>}

      {listing && listing.files.length > 0 && (
        <div className="drive-grade">
          {listing.files.map(f => (
            <div key={f.id} className="drive-item">
              <button className="drive-thumb" onClick={() => isImagem(f.mime) ? setPreview(f) : window.open(`/api/drive/files/${f.id}/download`, '_blank')} title={isImagem(f.mime) ? 'ver' : 'abrir'}>
                {isImagem(f.mime)
                  ? <img src={`/api/drive/files/${f.id}/view`} alt={f.name} loading="lazy" />
                  : <span className="drive-ext">{extOf(f.name)}</span>}
              </button>
              <div className="drive-item-nome" title={f.name}>{f.name}</div>
              <div className="drive-item-meta">
                {formatBytes(f.size)} · {new Date(f.created_at).toLocaleDateString('pt-BR')}
                {admin && f.user_id !== user.id && <> · {f.user_name}</>}
              </div>
              <div className="drive-acoes">
                <a href={`/api/drive/files/${f.id}/download`}>baixar</a>
                <button className="link" onClick={() => renomear(f)}>renomear</button>
                <button className="link" onClick={() => copiarCaminho(f)} title={f.path}>{copiado === f.id ? 'copiado' : 'copiar caminho'}</button>
                <button className="link" onClick={() => excluir(f)}>excluir</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {preview && (
        <div className="drive-lightbox" onClick={() => setPreview(null)}>
          <div className="drive-lightbox-topo">
            <span>{preview.name}</span>
            <div>
              <a href={`/api/drive/files/${preview.id}/download`} onClick={e => e.stopPropagation()}>baixar</a>
              <button className="link" onClick={e => { e.stopPropagation(); setPreview(null); }}>fechar</button>
            </div>
          </div>
          <img src={`/api/drive/files/${preview.id}/view`} alt={preview.name} onClick={e => e.stopPropagation()} />
        </div>
      )}
    </div>
  );
}
