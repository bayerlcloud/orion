// Materializa a tabela `previews` na c3: .env, porta do socket, bloco do Caddy, registro DNS e units.
// Roda como root (pelo orion-root), com DATABASE_URL de /etc/orion/central.env. Idempotente:
// rodar de novo só cria o que falta. Erro num host é registrado e o resto segue.
// Uso: node dist/scripts/sync-previews.js [--sem-dns]
import { execFile } from 'node:child_process';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createPool } from '../server/db.js';
import { KEYS, getSetting } from '../server/settings.js';
import { DOMINIO, garantirPreviews, instancia } from '../server/preview/model.js';
import { escreverEnv, liberarCache } from '../server/preview/pasta.js';
import { IP_C3, blocoCaddy, registrosFaltando } from '../server/preview/sync.js';

const CADDY_DIR = '/etc/caddy/previews.d';
const UNIT_DIR = '/etc/systemd/system';
const DNS_API = `https://developers.hostinger.com/api/dns/v1/zones/${DOMINIO}`;

function sh(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: 60_000 }, (err, out, errOut) =>
    err ? reject(new Error(`${cmd} ${args.join(' ')}: ${String(errOut || err.message).trim()}`)) : resolve(String(out))));
}

async function escreverSeMudou(arq: string, conteudo: string): Promise<boolean> {
  if ((await readFile(arq, 'utf8').catch(() => null)) === conteudo) return false;
  await writeFile(arq, conteudo);
  return true;
}

async function dns(hosts: string[], token: string): Promise<void> {
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const r = await fetch(DNS_API, { headers: auth, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`DNS: leitura da zona devolveu ${r.status}`);
  const { faltam, conflitos } = registrosFaltando(hosts, await r.json());
  for (const c of conflitos) console.log(`dns conflito: ${c}.${DOMINIO} já tem registro A para outro IP; não mexi`);
  if (!faltam.length) return;
  const zone = faltam.map(name => ({ name, type: 'A', ttl: 14400, records: [{ content: IP_C3 }] }));
  const w = await fetch(DNS_API, { method: 'PUT', headers: auth, body: JSON.stringify({ overwrite: false, zone }), signal: AbortSignal.timeout(20_000) });
  if (!w.ok) throw new Error(`DNS: criação devolveu ${w.status} ${await w.text()}`);
  console.log(`dns criado: ${faltam.join(', ')}`);
}

async function main(): Promise<number> {
  const semDns = process.argv.includes('--sem-dns');
  const pool = createPool();
  let falhas = 0;
  try {
    const rows = await garantirPreviews(pool);
    await mkdir(CADDY_DIR, { recursive: true });
    let unitsMudaram = false;
    for (const p of rows) {
      const inst = instancia(p.host);
      try {
        // Roda como root: o .env e o cache voltam para o danilo, que é quem os reescreve depois (orion-central).
        await liberarCache(p.worktree_path);
        await sh('/usr/bin/chown', ['-R', 'danilo:danilo', path.join(p.worktree_path, 'node_modules', '.vite')]).catch(() => {});
        const env = await escreverEnv(p, '/srv/previews', async (i) => { await sh('/usr/bin/systemctl', ['stop', `preview-vite@${i}.service`]); });
        if (env.erroParar) console.log(`aviso ${p.host}: ${env.erroParar}`);
        await sh('/usr/bin/chown', ['danilo:danilo', `/srv/previews/${inst}.env`]);
        const dropin = `${UNIT_DIR}/preview@${inst}.socket.d`;
        await mkdir(dropin, { recursive: true });
        unitsMudaram = (await escreverSeMudou(`${dropin}/porta.conf`, `[Socket]\nListenStream=127.0.0.1:${p.port}\n`)) || unitsMudaram;
        await escreverSeMudou(`${CADDY_DIR}/${inst}.caddy`, blocoCaddy(p));
      } catch (e) {
        falhas++;
        console.log(`falhou ${p.host}: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (!semDns) {
      const token = await getSetting(pool, KEYS.hostingerToken);
      if (!token) { falhas++; console.log('dns: sem token da Hostinger na tabela settings'); }
      else await dns(rows.map(r => r.host), token).catch((e) => { falhas++; console.log(e instanceof Error ? e.message : e); });
    }
    if (unitsMudaram) await sh('/usr/bin/systemctl', ['daemon-reload']);
    for (const p of rows) {
      await sh('/usr/bin/systemctl', ['enable', '--now', `preview@${instancia(p.host)}.socket`]).catch((e) => { falhas++; console.log(e.message); });
    }
    await sh('/usr/bin/caddy', ['validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']);
    await sh('/usr/bin/systemctl', ['reload', 'caddy']);
    console.log(`ok: ${rows.length} previews sincronizados, ${falhas} falha(s)`);
  } finally {
    await pool.end();
  }
  return falhas ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
