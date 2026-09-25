import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';

const execFile = promisify(execFileCb);

async function run(cmd: string, args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFile(cmd, args, { timeout: 5000, cwd });
    return stdout.trim().split('\n')[0] ?? '';
  } catch {
    return 'indisponível';
  }
}

async function serviceState(unit: string): Promise<string> {
  try {
    const { stdout } = await execFile('systemctl', ['is-active', unit], { timeout: 3000 });
    return stdout.trim();
  } catch (e: any) {
    return (e?.stdout ?? '').toString().trim() || 'desconhecido';
  }
}

export async function collectInventory(pool: Pool, repoDir: string) {
  const [node, docker, caddy, git, kernel, uptime, nproc, mem, disk, commit] = await Promise.all([
    run('node', ['--version']),
    run('docker', ['--version']),
    run('caddy', ['version']),
    run('git', ['--version']),
    run('uname', ['-r']),
    run('uptime', ['-p']),
    run('nproc', []),
    run('sh', ['-c', "free -m | awk 'NR==2{printf \"%d MB usados de %d MB\", $3, $2}'"]),
    run('sh', ['-c', "df -h / | awk 'NR==2{printf \"%s usados de %s (%s)\", $3, $2, $5}'"]),
    run('git', ['log', '-1', '--format=%h %ad %s', '--date=short'], repoDir),
  ]);
  let postgres = 'indisponível';
  try {
    const { rows } = await pool.query('SELECT version() AS v');
    postgres = String(rows[0]?.v ?? '').split(' on ')[0];
  } catch { /* fica indisponível */ }
  const services: Record<string, string> = {};
  for (const u of ['orion-central', 'caddy', 'docker', 'ssh', 'ufw', 'fail2ban']) services[u] = await serviceState(u);

  let infra: unknown = [];
  try {
    infra = JSON.parse(await readFile(path.join(repoDir, 'docs', 'infra.json'), 'utf8'));
  } catch { /* sem arquivo */ }

  return {
    coletado_em: new Date().toISOString(),
    c3: { kernel, uptime, vcpus: nproc, memoria: mem, disco: disk, ultimo_commit: commit },
    versoes: { node, docker, caddy, git, postgres },
    servicos: services,
    servidores: infra,
  };
}
