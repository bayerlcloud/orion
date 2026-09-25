import { useState, type FormEvent } from 'react';
import { api, type User } from '../api';

export default function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [erro, setErro] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErro(''); setBusy(true);
    try {
      const r = await api<{ user: User }>('/api/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      onLogin(r.user);
    } catch (err: any) {
      setErro(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <form className="login" onSubmit={submit}>
        <div className="brand">ORION</div>
        <label>email<input type="email" value={email} onChange={e => setEmail(e.target.value)} autoFocus required /></label>
        <label>senha<input type="password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
        {erro && <div className="erro">{erro}</div>}
        <button type="submit" disabled={busy}>{busy ? '…' : 'entrar'}</button>
      </form>
    </div>
  );
}
