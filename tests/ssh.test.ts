import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { sshArgs } from '../server/ssh.js';

describe('sshArgs', () => {
  it('monta o argv com a chave da frota e BatchMode', () => {
    const key = path.join(os.homedir(), '.ssh/fleet_ed25519');
    expect(sshArgs('212.47.70.170', 'echo oi')).toEqual([
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', '-i', key, 'root@212.47.70.170', 'echo oi',
    ]);
  });
  it('aceita chave custom (para teste)', () => {
    expect(sshArgs('1.2.3.4', 'ls', '/tmp/key')).toEqual([
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', '-i', '/tmp/key', 'root@1.2.3.4', 'ls',
    ]);
  });
});
