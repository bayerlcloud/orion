import { useState } from 'react';
import { type User } from '../api';
import ToolsSkills from './ToolsSkills';
import ToolsConectores from './ToolsConectores';
import './tools.css';

type Aba = 'conectores' | 'skills';
const ABAS: [Aba, string][] = [['conectores', 'Conectores'], ['skills', 'Skills']];

/** Aba Tools: Conectores (contas GitHub/Cloudflare + catálogo manual, tudo numa lista) e Skills (varredura do disco). */
export default function Tools({ user }: { user: User }) {
  const [aba, setAba] = useState<Aba>('conectores');
  return (
    <div className="tls">
      <div className="tls-head"><h1>Tools</h1></div>
      <div className="tabs" style={{ marginTop: 14 }}>
        {ABAS.map(([id, label]) => <button key={id} className={aba === id ? 'active' : ''} onClick={() => setAba(id)}>{label}</button>)}
      </div>
      {aba === 'conectores' && <ToolsConectores user={user} />}
      {aba === 'skills' && <ToolsSkills user={user} />}
    </div>
  );
}
