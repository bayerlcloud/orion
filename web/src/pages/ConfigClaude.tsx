import { useEffect, useState } from 'react';
import { claudeApi, type Project } from '../claude/api';
import SkillsHooksPanel from '../claude/SkillsHooksPanel';
import PermissionRules from '../claude/PermissionRules';
import Marketplace from '../claude/Marketplace';

/**
 * Configurações gerais do Claude (saíram do menu ⋮ da sessão em 01/10/2026: nada aqui é só da
 * sessão). Os painéis usam as variáveis de tema `--cc-*`, por isso ficam dentro de `.cc.cc-embed`.
 */
export default function ConfigClaude() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [aberto, setAberto] = useState<'' | 'skills' | 'perm' | 'plugins'>('');
  useEffect(() => {
    claudeApi.projects().then(r => { setProjects(r.projects); setProjectId(p => p ?? r.projects[0]?.id ?? null); }).catch(() => {});
  }, []);
  const proj = projects.find(p => p.id === projectId);
  return (
    <section className="cfg-box">
      <h2>Claude: skills, permissões e plugins</h2>
      <p className="muted">Valem para todas as sessões, não só para uma.</p>
      <div className="cfg-claude-grid">
        <div className="cfg-claude-card">
          <b>Skills e hooks</b>
          <span className="muted">Habilidades extras e ações automáticas ativas num projeto (servidor inteiro + projeto).</span>
          <div className="cfg-actions">
            <select value={projectId ?? ''} onChange={e => setProjectId(Number(e.target.value) || null)}>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button onClick={() => setAberto('skills')} disabled={!projectId}>Ver</button>
          </div>
        </div>
        <div className="cfg-claude-card">
          <b>Regras de permissão</b>
          <span className="muted">O que o Claude faz sem pedir, o que pergunta e o que é bloqueado. Por projeto ou para todos.</span>
          <div className="cfg-actions"><button onClick={() => setAberto('perm')}>Abrir</button></div>
        </div>
        <div className="cfg-claude-card">
          <b>Plugins</b>
          <span className="muted">Instalar, ligar e desligar pacotes do Claude Code. Valem para todos os projetos e pessoas.</span>
          <div className="cfg-actions"><button onClick={() => setAberto('plugins')}>Gerenciar</button></div>
        </div>
      </div>
      <div className="cc cc-embed">
        <SkillsHooksPanel open={aberto === 'skills'} onClose={() => setAberto('')} projectId={projectId} projectLabel={proj?.name} />
        <PermissionRules open={aberto === 'perm'} onClose={() => setAberto('')} projects={projects} defaultProjectId={projectId ?? undefined} canEditUser />
        <Marketplace open={aberto === 'plugins'} onClose={() => setAberto('')} isOwner />
      </div>
    </section>
  );
}
