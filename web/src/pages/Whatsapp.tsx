import type { User } from '../api';
import WhatsappCard from './WhatsappCard';
import WhatsappAppsCard from './WhatsappAppsCard';

/** Página WhatsApp (só o owner): a instância ligada ao Orion e as conexões dos SaaS no gateway orion-wa. */
export default function Whatsapp({ user }: { user: User }) {
  if (user.role !== 'owner') return <div className="cfg"><h1>WhatsApp</h1><p>Só o admin vê esta página.</p></div>;
  return (
    <div className="cfg">
      <h1>WhatsApp</h1>
      <WhatsappAppsCard />
      <WhatsappCard />
    </div>
  );
}
