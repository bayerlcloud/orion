import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Runner, attachmentBlocks, type Attachment, type Store, type QueryFn } from '../server/claude/runner';
import { isUnderRoot } from '../server/routes/claude';

const read = async (p: string) => Buffer.from(`bytes:${p}`);

describe('attachmentBlocks', () => {
  it('imagem vira bloco image base64', async () => {
    const atts: Attachment[] = [{ kind: 'image', media_type: 'image/png', name: 'foto.png', path: '/srv/claude-uploads/1/x-foto.png' }];
    const { blocks, textSuffix } = await attachmentBlocks(atts, read);
    expect(textSuffix).toBe('');
    expect(blocks).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('bytes:/srv/claude-uploads/1/x-foto.png').toString('base64') } }]);
  });

  it('arquivo não-imagem vira nota de texto, não bloco', async () => {
    const atts: Attachment[] = [{ kind: 'file', media_type: 'application/pdf', name: 'contrato.pdf', path: '/srv/claude-uploads/1/y-contrato.pdf' }];
    const { blocks, textSuffix } = await attachmentBlocks(atts, read);
    expect(blocks).toHaveLength(0);
    expect(textSuffix).toContain('[arquivo anexado: contrato.pdf em /srv/claude-uploads/1/y-contrato.pdf');
  });

  it('sem anexos: sem blocos e sem sufixo', async () => {
    expect(await attachmentBlocks([], read)).toEqual({ blocks: [], textSuffix: '' });
  });

  it('mistura imagens e arquivos preservando a ordem (media_type é case-insensitive)', async () => {
    const atts: Attachment[] = [
      { kind: 'image', media_type: 'image/jpeg', name: 'a.jpg', path: '/u/a.jpg' },
      { kind: 'file', media_type: 'text/csv', name: 'dados.csv', path: '/u/dados.csv' },
      { kind: 'image', media_type: 'IMAGE/WEBP', name: 'b.webp', path: '/u/b.webp' },
    ];
    const { blocks, textSuffix } = await attachmentBlocks(atts, read);
    expect(blocks.map(b => b.source.media_type)).toEqual(['image/jpeg', 'image/webp']);
    expect(textSuffix).toContain('dados.csv');
    expect(textSuffix).not.toContain('a.jpg');
  });
});

function memStore() {
  const events: { sessionId: string; type: string; payload: any }[] = [];
  const sessions = new Map<string, any>();
  const store: Store = {
    async appendEvent(sessionId, type, payload) { events.push({ sessionId, type, payload }); },
    async updateSession(sessionId, patch) { sessions.set(sessionId, { ...(sessions.get(sessionId) ?? {}), ...patch }); },
    async createApproval() {},
    async decideApproval() {},
  };
  return { store, events, sessions };
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 2000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await wait(5); } }
const base = { cwd: '/tmp/x', permissionMode: 'acceptEdits' as const, systemAppend: 'h' };

describe('Runner com anexos', () => {
  it('turno com anexos entrega ao SDK um AsyncIterable com [texto, imagem] e persiste a nota compacta', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'orion-att-'));
    const imgPath = path.join(dir, 'x.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    await writeFile(imgPath, bytes);

    let captured: any = null;
    let promptWasIterable = false;
    const fn: QueryFn = ({ prompt }) => {
      async function* gen() {
        if (typeof prompt !== 'string') { promptWasIterable = true; for await (const msg of prompt) captured = msg; }
        yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, num_turns: 1, duration_ms: 1 } as any;
      }
      return gen() as any;
    };
    const m = memStore();
    const r = new Runner({ queryFn: fn, store: m.store });
    r.startTurn({ ...base, sessionId: 'sa', isNew: true, prompt: { text: '[D] olha isso', attachments: [{ kind: 'image', media_type: 'image/png', name: 'x.png', path: imgPath }] } });
    await until(() => m.sessions.get('sa')?.status === 'idle');

    expect(promptWasIterable).toBe(true);
    expect(captured?.type).toBe('user');
    const content = captured.message.content;
    expect(content[0]).toEqual({ type: 'text', text: '[D] olha isso' });
    expect(content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') } });

    const up = m.events.find(e => e.type === 'user_prompt');
    expect(up?.payload.prompt).toBe('[D] olha isso');
    // `path` agora vai junto na nota persistida (popup de imagem de 28/09/2026, ver PARIDADE.md): é
    // o que permite a miniatura clicável no histórico buscar a imagem de volta em
    // GET /api/claude/attachments?path=...&type=... depois de recarregar a página — sem ele, o
    // anexo continuaria só com nome/ícone, como já acontecia antes desta rodada.
    expect(up?.payload.attachments).toEqual([{ kind: 'image', name: 'x.png', media_type: 'image/png', path: imgPath }]);
  });

  it('sem anexos, o prompt passado ao SDK continua sendo string', async () => {
    let seen: any;
    const fn: QueryFn = ({ prompt }) => {
      seen = prompt;
      async function* gen() { yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, num_turns: 1 } as any; }
      return gen() as any;
    };
    const m = memStore();
    const r = new Runner({ queryFn: fn, store: m.store });
    r.startTurn({ ...base, sessionId: 'sb', isNew: true, prompt: '[D] só texto' });
    await until(() => m.sessions.get('sb')?.status === 'idle');
    expect(typeof seen).toBe('string');
    expect(seen).toBe('[D] só texto');
    const up = m.events.find(e => e.type === 'user_prompt');
    expect(up?.payload.attachments).toBeUndefined();
  });
});

/**
 * Checagem de path traversal reaproveitada por `sanitizeAttachments` (upload) e pelo novo endpoint
 * `GET /api/claude/attachments` (serve de volta a imagem pra miniatura clicável do histórico — ver
 * PARIDADE.md, popup de imagem de 28/09/2026). Extraída como função pura e exportada de
 * `server/routes/claude.ts` justamente pra poder testar essa regra de segurança isolada do Fastify
 * (sem precisar subir um servidor de verdade) — mesma regra que já existia inline em
 * `sanitizeAttachments` antes desta rodada, só fatorada, não mudada.
 */
describe('isUnderRoot', () => {
  it('caminho dentro da raiz: true', () => {
    expect(isUnderRoot('/srv/claude-uploads/1/x-foto.png', '/srv/claude-uploads')).toBe(true);
  });

  it('a própria raiz: true', () => {
    expect(isUnderRoot('/srv/claude-uploads', '/srv/claude-uploads')).toBe(true);
  });

  it('fora da raiz: false', () => {
    expect(isUnderRoot('/etc/passwd', '/srv/claude-uploads')).toBe(false);
  });

  it('prefixo de nome parecido mas fora da raiz (sem separador): false — pegaria "/srv/claude-uploads-evil" sem essa checagem', () => {
    expect(isUnderRoot('/srv/claude-uploads-evil/x', '/srv/claude-uploads')).toBe(false);
  });
});
