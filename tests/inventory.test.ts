import { describe, it, expect } from 'vitest';
import { diffInventory, emptyDiff, flattenDiff, totalChanges, versaoCurta } from '../server/inventoryDiff.js';
import {
  parseListUnits, parseListTimers, parseSs, parseDockerPs, parseDpkgLog, parseNpmLs, parseBunLs, parseMeminfo, parseDf,
  primeiraLinhaDeVersao, unidadeRelevante, formatarUptime, type Inventory,
} from '../server/inventory.js';

function base(): Inventory {
  return {
    coletado_em: '2026-09-25T18:00:00.000Z',
    coletor: { usuario: 'danilo', origem: 'timer', host: 'c3' },
    maquina: { kernel: '6.8.0' },
    binarios: [
      { nome: 'node', versao: 'v22.14.0', caminho: '/usr/bin/node' },
      { nome: 'git', versao: 'git version 2.43.0', caminho: '/usr/bin/git' },
    ],
    pacotes: [{ gerenciador: 'npm', nome: 'pnpm', versao: '9.1.0' }],
    servicos: [
      { unidade: 'orion-central.service', tipo: 'service', load: 'loaded', estado: 'active', sub: 'running', descricao: 'Orion Central' },
      { unidade: 'orion-inventory.timer', tipo: 'timer', load: 'loaded', estado: 'active', sub: 'waiting', descricao: 'inventário', proximo: 'Thu 2026-09-25 19:00:00 UTC', ultimo: '-' },
    ],
    containers: [{ nome: 'n8n', imagem: 'n8nio/n8n:1.60', estado: 'running', status: 'Up 3 hours', portas: '5678/tcp' }],
    portas: [
      { porta: 22, endereco: 'todas', processo: 'sshd', pid: 900 },
      { porta: 3000, endereco: '127.0.0.1', processo: 'node', pid: 1234 },
    ],
    apt: [{ quando: '2026-09-24 10:11:12', acao: 'install', pacote: 'jq', versao: '1.7.1-3build1', anterior: '' }],
    servidores: [],
    avisos: [],
  };
}

describe('diffInventory', () => {
  it('sem snapshot anterior, tudo aparece como adicionado', () => {
    const d = diffInventory(null, base());
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([]);
    const rotulos = d.added.map(c => c.rotulo);
    expect(rotulos).toContain('node 22.14.0 apareceu');
    expect(rotulos).toContain('git 2.43.0 apareceu');
    expect(rotulos).toContain('npm: pnpm 9.1.0 instalado');
    expect(rotulos).toContain('orion-central.service apareceu (active)');
    expect(rotulos).toContain('container n8n apareceu (n8nio/n8n:1.60, running)');
    expect(rotulos).toContain('porta 3000 aberta (node)');
    expect(rotulos).toContain('apt: jq 1.7.1-3build1 instalado');
    expect(d.added.length).toBe(2 + 1 + 2 + 1 + 2 + 1);
  });

  it('snapshot anterior vazio ({}) equivale a null', () => {
    expect(diffInventory({}, base())).toEqual(diffInventory(null, base()));
    expect(diffInventory(undefined, base())).toEqual(diffInventory(null, base()));
  });

  it('nada mudou → diff vazio, mesmo com campos voláteis diferentes', () => {
    const prev = base();
    const next = base();
    next.coletado_em = '2026-09-25T19:00:00.000Z';
    next.containers[0].status = 'Up 4 hours';       // status textual muda a cada hora, não é mudança
    next.portas[1].pid = 4321;                        // pid muda ao reiniciar, não é mudança
    next.servicos[1].proximo = 'Thu 2026-09-25 20:00:00 UTC';
    const d = diffInventory(prev, next);
    expect(d).toEqual(emptyDiff());
    expect(totalChanges(d)).toBe(0);
  });

  it('binário novo (o caso do claude) aparece com a versão curta', () => {
    const next = base();
    next.binarios.push({ nome: 'claude', versao: '2.1.283 (Claude Code)', caminho: '/home/danilo/.bun/bin/claude' });
    const d = diffInventory(base(), next);
    expect(d.added).toEqual([{ tipo: 'adicionado', categoria: 'binario', chave: 'claude', rotulo: 'claude 2.1.283 apareceu' }]);
    expect(d.changed).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it('versão de binário mudou', () => {
    const next = base();
    next.binarios[0].versao = 'v22.16.0';
    const d = diffInventory(base(), next);
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0]).toMatchObject({ tipo: 'alterado', categoria: 'binario', chave: 'node', rotulo: 'node: 22.14.0 → 22.16.0', antes: 'v22.14.0', depois: 'v22.16.0' });
    expect(d.added).toEqual([]);
  });

  it('binário removido', () => {
    const next = base();
    next.binarios = next.binarios.filter(b => b.nome !== 'git');
    const d = diffInventory(base(), next);
    expect(d.removed).toEqual([{ tipo: 'removido', categoria: 'binario', chave: 'git', rotulo: 'git sumiu (era 2.43.0)' }]);
  });

  it('serviço mudou de estado (active → failed)', () => {
    const next = base();
    next.servicos[0].estado = 'failed';
    next.servicos[0].sub = 'failed';
    const d = diffInventory(base(), next);
    expect(d.changed).toEqual([{ tipo: 'alterado', categoria: 'servico', chave: 'orion-central.service', rotulo: 'orion-central.service: active → failed', antes: 'active', depois: 'failed' }]);
  });

  it('serviço/timer novo e serviço que sumiu', () => {
    const next = base();
    next.servicos = [
      next.servicos[0],
      { unidade: 'kanna.service', tipo: 'service', load: 'loaded', estado: 'active', sub: 'running', descricao: 'Kanna' },
    ];
    const d = diffInventory(base(), next);
    expect(d.added.map(c => c.rotulo)).toEqual(['kanna.service apareceu (active)']);
    expect(d.removed.map(c => c.rotulo)).toEqual(['orion-inventory.timer sumiu (era active)']);
  });

  it('container removido', () => {
    const next = base();
    next.containers = [];
    const d = diffInventory(base(), next);
    expect(d.removed).toEqual([{ tipo: 'removido', categoria: 'container', chave: 'n8n', rotulo: 'container n8n sumiu (era n8nio/n8n:1.60)' }]);
  });

  it('container parou ou trocou de imagem', () => {
    const parou = base();
    parou.containers[0].estado = 'exited';
    parou.containers[0].status = 'Exited (1) 2 minutes ago';
    expect(diffInventory(base(), parou).changed.map(c => c.rotulo)).toEqual(['container n8n: running → exited']);

    const trocou = base();
    trocou.containers[0].imagem = 'n8nio/n8n:1.61';
    expect(diffInventory(base(), trocou).changed.map(c => c.rotulo)).toEqual(['container n8n: imagem n8nio/n8n:1.60 → n8nio/n8n:1.61']);
  });

  it('porta aberta, fechada e trocada de processo', () => {
    const next = base();
    next.portas = [
      { porta: 22, endereco: 'todas', processo: 'sshd', pid: 900 },
      { porta: 80, endereco: 'todas', processo: 'caddy', pid: 77 },
    ];
    const d = diffInventory(base(), next);
    expect(d.added.map(c => c.rotulo)).toEqual(['porta 80 aberta (caddy)']);
    expect(d.removed.map(c => c.rotulo)).toEqual(['porta 3000 fechada (era node)']);

    const trocada = base();
    trocada.portas[1].processo = 'bun';
    expect(diffInventory(base(), trocada).changed.map(c => c.rotulo)).toEqual(['porta 3000: node → bun']);
  });

  it('pacote global: instalado, atualizado e removido (npm e bun separados)', () => {
    const next = base();
    next.pacotes = [
      { gerenciador: 'npm', nome: 'pnpm', versao: '9.2.0' },
      { gerenciador: 'bun', nome: '@anthropic-ai/claude-code', versao: '2.1.283' },
    ];
    const d = diffInventory(base(), next);
    expect(d.changed.map(c => c.rotulo)).toEqual(['npm: pnpm 9.1.0 → 9.2.0']);
    expect(d.added.map(c => c.rotulo)).toEqual(['bun: @anthropic-ai/claude-code 2.1.283 instalado']);

    const removido = base();
    removido.pacotes = [];
    expect(diffInventory(base(), removido).removed.map(c => c.rotulo)).toEqual(['npm: pnpm removido (era 9.1.0)']);
  });

  it('apt: só eventos novos contam; o que saiu da janela de 7 dias não é "removido"', () => {
    const next = base();
    next.apt = [{ quando: '2026-09-25 09:00:00', acao: 'upgrade', pacote: 'curl', versao: '8.5.0-2ubuntu10.6', anterior: '8.5.0-2ubuntu10.5' }];
    const d = diffInventory(base(), next);
    expect(d.added.map(c => c.rotulo)).toEqual(['apt: curl atualizado para 8.5.0-2ubuntu10.6']);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([]);
  });

  it('snapshot antigo com formato diferente não quebra', () => {
    const antigo = { coletado_em: 'x', versoes: { node: 'v20' }, servicos: { caddy: 'active' } } as any;
    const d = diffInventory(antigo, base());
    expect(d.removed).toEqual([]);
    expect(d.added.length).toBeGreaterThan(0);
    expect(flattenDiff(d)).toHaveLength(totalChanges(d));
  });

  it('flattenDiff ordena adicionados, alterados, removidos', () => {
    const next = base();
    next.binarios[0].versao = 'v23.0.0';
    next.binarios.push({ nome: 'jq', versao: 'jq-1.7.1', caminho: '/usr/bin/jq' });
    next.containers = [];
    const f = flattenDiff(diffInventory(base(), next)).map(c => c.tipo);
    expect(f).toEqual(['adicionado', 'alterado', 'removido']);
  });
});

describe('versaoCurta', () => {
  it('extrai o número da versão de saídas comuns', () => {
    expect(versaoCurta('v22.14.0')).toBe('22.14.0');
    expect(versaoCurta('git version 2.43.0')).toBe('2.43.0');
    expect(versaoCurta('Docker version 28.0.1, build abc123')).toBe('28.0.1');
    expect(versaoCurta('go version go1.23.1 linux/amd64')).toBe('1.23.1');
    expect(versaoCurta('claude 2.1.283 (Claude Code)')).toBe('2.1.283');
    expect(versaoCurta('jq-1.7.1')).toBe('1.7.1');
    expect(versaoCurta('versão desconhecida')).toBe('versão desconhecida');
    expect(versaoCurta(undefined)).toBe('');
  });
});

describe('parsers do coletor', () => {
  it('primeiraLinhaDeVersao prefere a linha com número', () => {
    expect(primeiraLinhaDeVersao('Copyright\nufw 0.36.2\n')).toBe('ufw 0.36.2');
    expect(primeiraLinhaDeVersao('  deno 2.1.4 (stable)\nv8 13.0\n')).toBe('deno 2.1.4 (stable)');
    expect(primeiraLinhaDeVersao('')).toBe('');
  });

  it('parseListUnits lê UNIT LOAD ACTIVE SUB DESCRIPTION e filtra o ruído', () => {
    const txt = [
      'orion-central.service loaded active running Orion Central (painel e API)',
      'caddy.service loaded active running Caddy',
      'snapd.service loaded active running Snap Daemon',
      'apt-daily.service loaded inactive dead Daily apt download activities',
      'foo.service not-found failed failed foo.service',
      'orion-inventory.timer loaded active waiting inventário',
    ].join('\n');
    const svc = parseListUnits(txt, 'service');
    expect(svc.map(u => u.unidade)).toEqual(['orion-central.service', 'caddy.service', 'snapd.service', 'apt-daily.service', 'foo.service']);
    expect(svc[0]).toEqual({ unidade: 'orion-central.service', tipo: 'service', load: 'loaded', estado: 'active', sub: 'running', descricao: 'Orion Central (painel e API)' });
    expect(svc.filter(unidadeRelevante).map(u => u.unidade)).toEqual(['orion-central.service', 'caddy.service', 'foo.service']);
    expect(parseListUnits(txt, 'timer').map(u => u.unidade)).toEqual(['orion-inventory.timer']);
  });

  it('parseListTimers separa datas, relativos, unidade e ativação', () => {
    const txt = [
      'Thu 2026-09-25 20:00:00 UTC 32min left     Thu 2026-09-25 19:00:00 UTC 27min ago    orion-inventory.timer orion-inventory.service',
      'Fri 2026-09-26 06:12:00 UTC 10h 44min left Thu 2026-09-25 06:12:00 UTC 13h ago      apt-daily.timer apt-daily.service',
      '-                           -              -                           -             logrotate.timer logrotate.service',
      'Thu 2026-09-25 20:00:00 UTC 32min left     -                           -             novo.timer novo.service',
    ].join('\n');
    const t = parseListTimers(txt);
    expect(t).toEqual([
      { unidade: 'orion-inventory.timer', ativa: 'orion-inventory.service', proximo: 'Thu 2026-09-25 20:00:00 UTC', ultimo: 'Thu 2026-09-25 19:00:00 UTC' },
      { unidade: 'apt-daily.timer', ativa: 'apt-daily.service', proximo: 'Fri 2026-09-26 06:12:00 UTC', ultimo: 'Thu 2026-09-25 06:12:00 UTC' },
      { unidade: 'logrotate.timer', ativa: 'logrotate.service', proximo: '-', ultimo: '-' },
      { unidade: 'novo.timer', ativa: 'novo.service', proximo: 'Thu 2026-09-25 20:00:00 UTC', ultimo: '-' },
    ]);
  });

  it('parseSs junta IPv4/IPv6 da mesma porta e lê o processo', () => {
    const txt = [
      'LISTEN 0 4096 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=1234,fd=18))',
      'LISTEN 0 511 *:80 *:* users:(("caddy",pid=567,fd=7))',
      'LISTEN 0 128 0.0.0.0:22 0.0.0.0:*',
      'LISTEN 0 128 [::]:22 [::]:*',
      'LISTEN 0 244 127.0.0.1:5432 0.0.0.0:*',
    ].join('\n');
    expect(parseSs(txt)).toEqual([
      { porta: 22, endereco: 'todas', processo: '—', pid: null },
      { porta: 80, endereco: 'todas', processo: 'caddy', pid: 567 },
      { porta: 3000, endereco: '127.0.0.1', processo: 'node', pid: 1234 },
      { porta: 5432, endereco: '127.0.0.1', processo: '—', pid: null },
    ]);
  });

  it('parseDockerPs lê uma linha JSON por container e ignora lixo', () => {
    const txt = '{"Names":"n8n","Image":"n8nio/n8n:1.60","State":"running","Status":"Up 3 hours","Ports":"5678/tcp"}\nnão é json\n{"Names":"db","Image":"postgres:16","State":"exited","Status":"Exited (0)","Ports":""}';
    expect(parseDockerPs(txt)).toEqual([
      { nome: 'db', imagem: 'postgres:16', estado: 'exited', status: 'Exited (0)', portas: '' },
      { nome: 'n8n', imagem: 'n8nio/n8n:1.60', estado: 'running', status: 'Up 3 hours', portas: '5678/tcp' },
    ]);
  });

  it('parseDpkgLog pega install/upgrade dos últimos 7 dias, limita e ordena', () => {
    const txt = [
      '2026-09-10 10:00:00 install velho:amd64 <none> 1.0',
      '2026-09-24 10:11:12 install jq:amd64 <none> 1.7.1-3build1',
      '2026-09-24 10:11:12 status installed jq:amd64 1.7.1-3build1',
      '2026-09-25 08:00:00 upgrade curl:amd64 8.5.0-2ubuntu10.5 8.5.0-2ubuntu10.6',
      '2026-09-23 09:00:00 remove foo:amd64 1.0 <none>',
    ].join('\n');
    const agora = new Date('2026-09-25T18:00:00Z');
    expect(parseDpkgLog(txt, agora)).toEqual([
      { quando: '2026-09-24 10:11:12', acao: 'install', pacote: 'jq', versao: '1.7.1-3build1', anterior: '' },
      { quando: '2026-09-25 08:00:00', acao: 'upgrade', pacote: 'curl', versao: '8.5.0-2ubuntu10.6', anterior: '8.5.0-2ubuntu10.5' },
    ]);
    expect(parseDpkgLog(txt, agora, 7, 1)).toHaveLength(1);
    expect(parseDpkgLog(txt, agora, 7, 1)[0].pacote).toBe('curl');
  });

  it('parseNpmLs e parseBunLs listam pacotes globais', () => {
    expect(parseNpmLs('{"name":"lib","dependencies":{"pnpm":{"version":"9.1.0"},"corepack":{"version":"0.29.4"}}}'))
      .toEqual([{ gerenciador: 'npm', nome: 'corepack', versao: '0.29.4' }, { gerenciador: 'npm', nome: 'pnpm', versao: '9.1.0' }]);
    expect(parseNpmLs('')).toEqual([]);
    expect(parseNpmLs('lixo')).toEqual([]);
    const bun = '/home/danilo/.bun/install/global node_modules (2)\n├── @anthropic-ai/claude-code@2.1.283\n└── kanna@0.3.0\n';
    expect(parseBunLs(bun)).toEqual([
      { gerenciador: 'bun', nome: '@anthropic-ai/claude-code', versao: '2.1.283' },
      { gerenciador: 'bun', nome: 'kanna', versao: '0.3.0' },
    ]);
  });

  it('memória, disco e uptime em português', () => {
    expect(parseMeminfo('MemTotal:       12288000 kB\nMemFree:  100 kB\nMemAvailable:    8192000 kB\n')).toBe('4000 MB usados de 12000 MB');
    expect(parseMeminfo('')).toBe('indisponível');
    expect(parseDf('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 304087040 41943040 262144000 14% /\n')).toBe('40,0 GB usados de 290,0 GB (14%)');
    expect(parseDf('')).toBe('indisponível');
    expect(formatarUptime(3 * 86400 + 2 * 3600 + 15 * 60)).toBe('3 dias, 2 h, 15 min');
    expect(formatarUptime(90)).toBe('1 min');
  });
});
