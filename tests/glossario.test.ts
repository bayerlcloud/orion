import { describe, it, expect } from 'vitest';
import { SEM_DESCRICAO, explicaApt, explicaBinario, explicaContainer, explicaPacote, explicaPorta, explicaUnidade } from '../web/src/pages/glossario';

describe('glossário leigo', () => {
  it('explica os binários que existem na c3', () => {
    for (const b of ['node', 'npm', 'npx', 'bun', 'python3', 'docker', 'caddy', 'git', 'claude', 'kanna', 'jq', 'curl', 'rsync', 'ufw', 'fail2ban-client', 'ss']) {
      expect(explicaBinario(b), b).not.toBe(SEM_DESCRICAO);
    }
  });
  it('binário desconhecido cai no texto padrão, sem lançar', () => {
    expect(explicaBinario('zzz-inventado')).toBe(SEM_DESCRICAO);
  });
  it('pacotes globais conhecidos', () => {
    expect(explicaPacote('@anthropic-ai/claude-code')).toMatch(/Claude Code/);
    expect(explicaPacote('kanna-code')).toMatch(/kanna/);
    expect(explicaPacote('corepack')).toMatch(/Node/);
  });
  it('unidades do systemd, inclusive timer e socket', () => {
    expect(explicaUnidade('orion-central.service')).toMatch(/Central/);
    expect(explicaUnidade('orion-inventory.timer')).toMatch(/hora em hora/);
    expect(explicaUnidade('docker.socket')).toMatch(/Docker/);
    expect(explicaUnidade('ssh.service')).toMatch(/chave/);
    expect(explicaUnidade('coisa-aleatoria.service')).toBe(SEM_DESCRICAO);
  });
  it('containers pela imagem ou pelo nome', () => {
    expect(explicaContainer('orion-postgres', 'postgres:16')).toMatch(/banco de dados/i);
    expect(explicaContainer('x', 'redis:7')).toMatch(/memória/);
    expect(explicaContainer('caddy', 'sha256:abc')).toMatch(/entrada/);
  });
  it('portas conhecidas, e porta estranha usa o processo', () => {
    expect(explicaPorta(443)).toMatch(/https/);
    expect(explicaPorta(5432)).toMatch(/Postgres/);
    expect(explicaPorta(9999, 'node')).toMatch(/JavaScript/);
    expect(explicaPorta(9999, '—')).toBe(SEM_DESCRICAO);
  });
  it('apt: kernel, docker e peças do ubuntu', () => {
    expect(explicaApt('linux-image-6.8.0-142-generic')).toMatch(/kernel/i);
    expect(explicaApt('containerd.io')).toMatch(/Docker/);
    expect(explicaApt('unzip')).toMatch(/zip/);
    expect(explicaApt('systemd-timesyncd')).toMatch(/Ubuntu/);
  });
});
