import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const deploy = path.resolve('deploy'); // vitest roda da raiz do repo
const build = readFileSync(path.join(deploy, 'build.sh'), 'utf8');

describe('deploy/build.sh (plano B1, T3: orion-runner)', () => {
  it('sintaxe ok (bash -n)', () => {
    expect(() => execFileSync('bash', ['-n', path.join(deploy, 'build.sh')])).not.toThrow();
  });

  it('só reinicia o orion-runner dentro do if do runner_hash (um deploy só de painel não corta sessão)', () => {
    const bloco = /if \[ -z "\$ANTERIOR" \] \|\| \[ "\$\(runner_hash "\$ANTERIOR"\)" != "\$\(runner_hash "\$DIR"\)" \]; then([\s\S]*?)\nfi\n/.exec(build);
    expect(bloco, 'if do runner_hash').not.toBeNull();
    expect(bloco![1]).toMatch(/systemctl try-restart orion-runner/);
    // Nenhum restart do runner fora desse if.
    expect(build.replace(bloco![0], '')).not.toMatch(/restart orion-runner/);
    // O hash cobre o que o runner carrega: o próprio entrypoint e o código das sessões.
    expect(build).toMatch(/runner_hash\(\) \{[^\n]*dist\/server\/claude[^\n]*dist\/server\/runnerMain\.js/);
  });

  it('instala a unit no laço e habilita o serviço', () => {
    expect(build).toMatch(/for u in [^\n]*orion-runner\.service[^\n]*; do/);
    expect(build).toMatch(/systemctl enable --now orion-runner\b/);
    expect(readFileSync(path.join(deploy, 'orion-runner.service'), 'utf8')).toMatch(/ExecStart=\/usr\/bin\/node \/srv\/orion-live\/dist\/server\/runnerMain\.js/);
  });
});
