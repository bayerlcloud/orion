import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export function sshArgs(ip: string, cmd: string, key?: string): string[] {
  const keyPath = key ?? path.join(os.homedir(), '.ssh/fleet_ed25519');
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', '-i', keyPath, `root@${ip}`, cmd];
}

export async function runSsh(ip: string, cmd: string, timeoutMs?: number): Promise<{ code: number; out: string }> {
  return new Promise(resolve =>
    execFile('ssh', sshArgs(ip, cmd), { timeout: timeoutMs ?? 15_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, out) => resolve({ code: err ? 1 : 0, out: String(out ?? '').trim() })));
}
