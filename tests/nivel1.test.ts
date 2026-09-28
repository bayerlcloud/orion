import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  renderMapa, renderEquipe, renderCapacidades, versaoClaudeDe, escreverAtomico, limpo,
  type UsuarioPainel, type ProjetoPainel, type Customizacoes,
} from '../server/nivel1/generate';

const users: UsuarioPainel[] = [
  { name: 'Danilo', email: 'danilo@bayerlstudio.com.br', role: 'owner' },
  { name: 'Laís', email: 'lais@bayerlstudio.com.br', role: 'member' },
];
const projects: ProjetoPainel[] = [
  { name: 'Orion (este sistema)', slug: 'orion', path: '/srv/orion' },
  { name: 'Projeto — com travessão | e pipe', slug: 'trav', path: '/srv/projects/trav' },
];
const custom: Customizacoes = { skills: ['minha-skill'], commands: ['deploy'], plugins: [] };

const renders = () => [renderMapa(), renderEquipe(users, projects), renderCapacidades('2.1.283', custom)];

describe('renders do nível 1', () => {
  it('nunca contêm travessão (regra do nível 0), mesmo com travessão nos dados', () => {
    for (const texto of renders()) expect(texto).not.toMatch(/[—–]/);
  });

  it('cada arquivo fica em até 40 linhas e termina com newline', () => {
    for (const texto of renders()) {
      expect(texto.endsWith('\n')).toBe(true);
      expect(texto.split('\n').length).toBeLessThanOrEqual(40);
    }
  });

  it('mapa traz servidores, acesso, DNS e o vital da c3 (tudo curado)', () => {
    const mapa = renderMapa();
    for (const secao of ['## Servidores Bayerl Cloud', '## Acesso', '## DNS (bayerl.cloud)', '## Vital na c3']) {
      expect(mapa).toContain(secao);
    }
    expect(mapa).toContain('217.76.55.249');
    expect(mapa).toContain('fleet_ed25519');
  });

  it('equipe interpola pessoas (owner com rótulo curado) e projetos do banco', () => {
    const md = renderEquipe(users, projects);
    expect(md).toContain('| Danilo | danilo@bayerlstudio.com.br | owner (o dono; "Bayerl") |');
    expect(md).toContain('| Laís | lais@bayerlstudio.com.br | member |');
    expect(md).toContain('| orion | Orion (este sistema) | /srv/orion |');
    expect(md).toContain('| trav | Projeto - com travessão / e pipe | /srv/projects/trav |');
    expect(md).toContain('## Convenção de trabalho');
  });

  it('capacidades interpola a versão do claude e as customizações', () => {
    const md = renderCapacidades('2.1.283', custom);
    expect(md).toContain('- Claude Code 2.1.283, invocado pelo painel via Agent SDK');
    expect(md).toContain('- Skills custom: minha-skill.');
    expect(md).toContain('- Commands custom: deploy.');
    expect(md).not.toContain('Plugins custom');
    expect(md).toContain('## Memória (como usar)');
  });

  it('fontes indisponíveis viram linha honesta, nunca abortam o render', () => {
    const md = renderCapacidades(null, null);
    expect(md).toContain('- Claude Code (versão indisponível neste ciclo), invocado');
    expect(md).toContain('- Skills/commands custom: listagem indisponível neste ciclo.');
  });

  it('sem nada custom, mantém a linha modelo', () => {
    const md = renderCapacidades('2.1.283', { skills: [], commands: [], plugins: [] });
    expect(md).toContain('- Skills/commands custom: nenhum instalado ainda (só os sincronizados por plugin).');
  });
});

describe('versaoClaudeDe', () => {
  it('extrai o número do snapshot de inventário', () => {
    expect(versaoClaudeDe([{ nome: 'claude', versao: '2.1.283 (Claude Code)' }])).toBe('2.1.283');
  });
  it('sem claude no inventário devolve null', () => {
    expect(versaoClaudeDe([{ nome: 'node', versao: 'v22.1.0' }])).toBe(null);
    expect(versaoClaudeDe([{ nome: 'claude', versao: 'versão desconhecida' }])).toBe(null);
  });
});

describe('limpo', () => {
  it('troca travessão e pipe, colapsa espaços', () => {
    expect(limpo('a — b | c\nd')).toBe('a - b / c d');
  });
});

describe('escreverAtomico', () => {
  it('escreve o conteúdo e não deixa .tmp para trás', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nivel1-'));
    const destino = path.join(dir, 'mapa.md');
    await escreverAtomico(destino, 'antes\n');
    await escreverAtomico(destino, 'depois\n');
    expect(await readFile(destino, 'utf8')).toBe('depois\n');
    expect(await readdir(dir)).toEqual(['mapa.md']);
  });
});
