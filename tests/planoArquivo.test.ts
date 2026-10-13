import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { arquivoDePlano, textoDoPlano } from '../server/claude/planoArquivo';

describe('plano do ExitPlanMode', () => {
  it('acha o arquivo de plano escrito pelo Claude', () => {
    const content = [
      { type: 'tool_use', name: 'Write', input: { file_path: '/home/x/projeto/README.md' } },
      { type: 'tool_use', name: 'Write', input: { file_path: '/home/danilo/.claude/plans/abc-def.md', content: '# Novo' } },
    ];
    expect(arquivoDePlano(content)).toEqual({ file: '/home/danilo/.claude/plans/abc-def.md', text: '# Novo' });
    expect(arquivoDePlano([{ type: 'tool_use', name: 'Edit', input: { file_path: '/h/.claude/plans/a.md' } }])).toEqual({ file: '/h/.claude/plans/a.md', text: undefined });
    expect(arquivoDePlano([{ type: 'text', text: 'oi' }])).toBeUndefined();
  });

  it('lê o arquivo conhecido, ou o plano recente da pasta', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'planos-'));
    const f = path.join(dir, 'p.md');
    await writeFile(f, '# Plano X');
    expect(await textoDoPlano({ file: f }, dir)).toEqual({ plan: '# Plano X', planFilePath: f });
    expect((await textoDoPlano({ file: f, text: '# Recém escrito' }, dir))?.plan).toBe('# Recém escrito');
    expect((await textoDoPlano(undefined, dir))?.plan).toBe('# Plano X');
    expect(await textoDoPlano(undefined, path.join(dir, 'nada'))).toBeNull();
  });
});
