// Coleta remota de mem/disco/docker por SSH, para as VPS fora da c3 (c1, c2, hostinger).
// Nunca lança: falha de ssh ou de parser vira entrada em `errors`.

import { runSsh } from '../ssh.js';
import { parseMeminfo, parseDf, parseDockerPs } from './parse.js';

export { REMOTE_HOSTS } from './remoteHosts.js';

export const REMOTE_CMD =
  "cat /proc/meminfo; echo '---DF---'; df -kP /; echo '---DOCKER---'; docker ps --format '{{json .}}'";

export type RemoteSample = {
  host: string;
  ts: string;
  mem: ReturnType<typeof parseMeminfo> | null;
  fs: ReturnType<typeof parseDf> | null;
  docker: ReturnType<typeof parseDockerPs> | null;
  errors: string[];
};

/** Separa a saída combinada de REMOTE_CMD nas 3 seções, pelos delimitadores únicos. */
export function parseRemoteOutput(raw: string): { mem: string; df: string; docker: string } {
  const [mem = '', rest = ''] = raw.split('---DF---');
  const [df = '', docker = ''] = rest.split('---DOCKER---');
  return { mem, df, docker };
}

export async function collectRemoteSample(
  host: { label: string; ip: string },
  ssh: (ip: string, cmd: string, timeoutMs?: number) => Promise<{ code: number; out: string }> = runSsh,
): Promise<RemoteSample> {
  const errors: string[] = [];
  const { code, out } = await ssh(host.ip, REMOTE_CMD, 12_000);
  if (code !== 0) errors.push('ssh');

  const { mem: memRaw, df: dfRaw, docker: dockerRaw } = parseRemoteOutput(out);

  const mem = parseMeminfo(memRaw);
  if (!mem) errors.push('/proc/meminfo');

  const fs = parseDf(dfRaw);
  if (!fs) errors.push('df /');

  const docker = code === 0 ? parseDockerPs(dockerRaw) : null;

  return { host: host.label, ts: new Date().toISOString(), mem, fs, docker, errors };
}
