import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { arquivoDePlano, textoDoPlano } from '../server/claude/planoArquivo';

describe('plano do ExitPlanMode', () => {
  it('acha o arquivo de plano escrito pelo Claude', () => {
    const content = [
      { type: 'tool_use', name: 'Write', input: { file_path: '/home/x/projeto/README.md' } },
      { type: 'tool_use', name: 'Write', input: { file_path: '/home/danilo/.claude/plans/abc-def.md' } },
    ];
    expect(arquivoDePlano(content)).toBe('/home/danilo/.claude/plans/abc-def.md');
    expect(arquivoDePlano([{ type: 'text', text: 'oi' }])).toBeUndefined();
  });

  it('lê o arquivo conhecido, ou o plano recente da pasta', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'planos-'));
    const f = path.join(dir, 'p.md');
    await writeFile(f, '# Plano X');
    expect(await textoDoPlano(f, dir)).toEqual({ plan: '# Plano X', planFilePath: f });
    expect((await textoDoPlano(undefined, dir))?.plan).toBe('# Plano X');
    expect(await textoDoPlano(undefined, path.join(dir, 'nada'))).toBeNull();
  });
});
