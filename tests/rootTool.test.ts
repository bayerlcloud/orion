import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pedirRoot } from '../server/claude/rootTool';

async function base() {
  const d = await mkdtemp(path.join(tmpdir(), 'orion-root-'));
  await mkdir(`${d}/pedidos`); await mkdir(`${d}/respostas`);
  return d;
}

describe('ponte de root (lado do servidor)', () => {
  it('grava o pedido e devolve a resposta do helper', async () => {
    const d = await base();
    const helper = (async () => {
      for (;;) {
        const fs = (await readdir(`${d}/pedidos`)).filter(f => f.endsWith('.json'));
        if (fs.length) {
          const p = JSON.parse(await readFile(`${d}/pedidos/${fs[0]}`, 'utf8'));
          expect(p).toMatchObject({ session_id: 's1', command: 'systemctl restart caddy' });
          await writeFile(`${d}/respostas/${p.id}.json`, JSON.stringify({ code: 0, out: 'ok' }));
          return;
        }
        await new Promise(r => setTimeout(r, 5));
      }
    })();
    const r = await pedirRoot('s1', 'systemctl restart caddy', { dir: d, intervaloMs: 5 });
    await helper;
    expect(r).toEqual({ code: 0, out: 'ok' });
    expect(await readdir(`${d}/respostas`)).toEqual([]);
  });

  it('sem helper: desiste, apaga o pedido e explica', async () => {
    const d = await base();
    const r = await pedirRoot('s1', 'id', { dir: d, esperaMs: 30, intervaloMs: 5 });
    expect(r.code).toBeNull();
    expect(r.out).toMatch(/orion-root\.path/);
    expect(await readdir(`${d}/pedidos`)).toEqual([]);
  });
});
