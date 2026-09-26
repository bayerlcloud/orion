import { useEffect, useRef, useState } from 'react';
import { api, type User } from '../api';
import './perfil.css';

type Profile = {
  id: number;
  name: string;
  surname: string | null;
  email: string;
  phone: string | null;
  role: 'owner' | 'member' | string;
  theme: 'dark' | 'light';
  has_avatar: boolean;
  avatar_url: string | null;
};

type Nota = { tipo: 'ok' | 'erro'; texto: string } | null;

export default function Perfil({ user, onSaved }: { user: User; onSaved?: () => void }) {
  const [p, setP] = useState<Profile | null>(null);

  // formulário de dados
  const [nome, setNome] = useState('');
  const [sobrenome, setSobrenome] = useState('');
  const [telefone, setTelefone] = useState('');
  const [tema, setTema] = useState<'dark' | 'light'>('dark');
  const [notaDados, setNotaDados] = useState<Nota>(null);
  const [salvando, setSalvando] = useState(false);

  // senha
  const [atual, setAtual] = useState('');
  const [nova, setNova] = useState('');
  const [conf, setConf] = useState('');
  const [notaSenha, setNotaSenha] = useState<Nota>(null);
  const [trocando, setTrocando] = useState(false);

  // avatar
  const [notaFoto, setNotaFoto] = useState<Nota>(null);
  const [enviandoFoto, setEnviandoFoto] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function aplicar(r: Profile) {
    setP(r);
    setNome(r.name ?? '');
    setSobrenome(r.surname ?? '');
    setTelefone(r.phone ?? '');
    setTema(r.theme === 'light' ? 'light' : 'dark');
  }

  async function carregar() {
    try { aplicar(await api<Profile>('/api/profile')); }
    catch (e: any) { setNotaDados({ tipo: 'erro', texto: e.message }); }
  }
  useEffect(() => { void carregar(); }, []);

  const inicial = (nome || user.name || user.email).trim().charAt(0).toUpperCase() || '?';

  async function salvarDados(e: React.FormEvent) {
    e.preventDefault();
    setSalvando(true); setNotaDados(null);
    try {
      const r = await api<Profile>('/api/profile', {
        method: 'PUT',
        body: JSON.stringify({ name: nome, surname: sobrenome, phone: telefone, theme: tema }),
      });
      aplicar(r);
      setNotaDados({ tipo: 'ok', texto: 'Dados salvos.' });
      onSaved?.();
    } catch (e: any) {
      setNotaDados({ tipo: 'erro', texto: e.message });
    } finally { setSalvando(false); }
  }

  async function trocarSenha(e: React.FormEvent) {
    e.preventDefault();
    setNotaSenha(null);
    if (nova.length < 6) { setNotaSenha({ tipo: 'erro', texto: 'A nova senha precisa de ao menos 6 caracteres.' }); return; }
    if (nova !== conf) { setNotaSenha({ tipo: 'erro', texto: 'A confirmação não bate com a nova senha.' }); return; }
    setTrocando(true);
    try {
      await api('/api/profile/password', { method: 'POST', body: JSON.stringify({ current_password: atual, new_password: nova }) });
      setNotaSenha({ tipo: 'ok', texto: 'Senha redefinida.' });
      setAtual(''); setNova(''); setConf('');
    } catch (e: any) {
      setNotaSenha({ tipo: 'erro', texto: e.message });
    } finally { setTrocando(false); }
  }

  async function enviarFoto(file: File) {
    setEnviandoFoto(true); setNotaFoto(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/profile/avatar', { method: 'POST', body: fd, credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as any).error ?? `erro ${res.status}`);
      await carregar();
      setNotaFoto({ tipo: 'ok', texto: 'Foto atualizada.' });
      onSaved?.();
    } catch (e: any) {
      setNotaFoto({ tipo: 'erro', texto: e.message });
    } finally {
      setEnviandoFoto(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function removerFoto() {
    setEnviandoFoto(true); setNotaFoto(null);
    try {
      await api('/api/profile/avatar', { method: 'DELETE' });
      await carregar();
      setNotaFoto({ tipo: 'ok', texto: 'Foto removida.' });
      onSaved?.();
    } catch (e: any) {
      setNotaFoto({ tipo: 'erro', texto: e.message });
    } finally { setEnviandoFoto(false); }
  }

  function trocarTema(valor: 'dark' | 'light') {
    setTema(valor);
    document.documentElement.setAttribute('data-theme', valor);
    try { localStorage.setItem('orion-theme', valor); } catch { /* modo privado */ }
    setNotaDados(null);
    api<Profile>('/api/profile', { method: 'PUT', body: JSON.stringify({ theme: valor }) })
      .then(r => { setP(r); onSaved?.(); })
      .catch((e: any) => setNotaDados({ tipo: 'erro', texto: e.message }));
  }

  return (
    <div className="perfil">
      <h1>Meu perfil</h1>

      <section className="cfg-box perfil-avatar">
        <div className="perfil-foto" aria-hidden={!p?.has_avatar}>
          {p?.has_avatar && p.avatar_url
            ? <img src={p.avatar_url} alt="Sua foto de perfil" />
            : <span className="perfil-inicial">{inicial}</span>}
        </div>
        <div className="perfil-foto-acoes">
          <div className="cfg-actions">
            <button type="button" className="btn-primary" disabled={enviandoFoto} onClick={() => fileRef.current?.click()}>
              {enviandoFoto ? 'Enviando…' : 'Enviar foto'}
            </button>
            {p?.has_avatar && (
              <button type="button" disabled={enviandoFoto} onClick={removerFoto}>Remover</button>
            )}
          </div>
          <input
            ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden
            onChange={e => { const f = e.target.files?.[0]; if (f) void enviarFoto(f); }}
          />
          <p className="muted small">PNG, JPEG, WebP ou GIF, até 5 MB.</p>
          {notaFoto && <div className={notaFoto.tipo === 'ok' ? 'perfil-ok' : 'erro'}>{notaFoto.texto}</div>}
        </div>
      </section>

      <section className="cfg-box">
        <h2>Dados</h2>
        <form className="cfg-grid" onSubmit={salvarDados}>
          <label>telefone
            <input value={telefone} onChange={e => setTelefone(e.target.value)} placeholder="+55 (11) 90000-0000" autoComplete="tel" />
          </label>
          <label>nome
            <input value={nome} onChange={e => setNome(e.target.value)} maxLength={80} required autoComplete="given-name" />
          </label>
          <label>sobrenome
            <input value={sobrenome} onChange={e => setSobrenome(e.target.value)} maxLength={80} autoComplete="family-name" />
          </label>
          <label>email
            <input value={p?.email ?? user.email} readOnly className="perfil-ro" autoComplete="email" />
          </label>
          <div className="cfg-actions">
            <button type="submit" className="btn-primary" disabled={salvando}>{salvando ? 'Salvando…' : 'Salvar'}</button>
          </div>
        </form>
        {notaDados && <div className={notaDados.tipo === 'ok' ? 'perfil-ok' : 'erro'}>{notaDados.texto}</div>}
      </section>

      <section className="cfg-box">
        <h2>Senha</h2>
        <form className="cfg-grid" onSubmit={trocarSenha}>
          <label>senha atual
            <input type="password" value={atual} onChange={e => setAtual(e.target.value)} autoComplete="current-password" />
          </label>
          <label>nova senha
            <input type="password" value={nova} onChange={e => setNova(e.target.value)} autoComplete="new-password" />
          </label>
          <label>confirmar nova senha
            <input type="password" value={conf} onChange={e => setConf(e.target.value)} autoComplete="new-password" />
          </label>
          <div className="cfg-actions">
            <button type="submit" className="btn-primary" disabled={trocando}>{trocando ? 'Redefinindo…' : 'Redefinir senha'}</button>
          </div>
        </form>
        {notaSenha && <div className={notaSenha.tipo === 'ok' ? 'perfil-ok' : 'erro'}>{notaSenha.texto}</div>}
      </section>

      <section className="cfg-box">
        <h2>Aparência</h2>
        <p className="muted small">Escolha o tema da interface. Vale só para você.</p>
        <div className="perfil-tema" role="group" aria-label="Tema da interface">
          <button type="button" className={`perfil-tema-btn ${tema === 'dark' ? 'active' : ''}`}
            aria-pressed={tema === 'dark'} onClick={() => trocarTema('dark')}>Escuro</button>
          <button type="button" className={`perfil-tema-btn ${tema === 'light' ? 'active' : ''}`}
            aria-pressed={tema === 'light'} onClick={() => trocarTema('light')}>Claro</button>
        </div>
      </section>
    </div>
  );
}
