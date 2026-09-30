import { describe, it, expect } from 'vitest';
import { classify, policyHook, makePolicyHook, rootPerigo } from '../server/claude/policy';

const bash = (command: string) => classify('Bash', { command }).decision;

describe('política padrão de permissão', () => {
  it('ações comuns rodam direto', () => {
    for (const c of ['npm run build', 'npx vitest run', 'git add -A && git commit -m "x"', 'git push origin main', 'git push -u origin tarefa/x',
      'ls -la', 'docker ps', 'curl -s https://api.x.com', 'systemctl status caddy', 'npm rm-foo --help'])
      expect(bash(c), c).toBe('allow');
    expect(classify('Edit', { file_path: '/srv/orion/server/x.ts' }).decision).toBe('allow');
    expect(classify('Read', { file_path: '/srv/orion/README.md' }).decision).toBe('allow');
    expect(classify('mcp__orion-memory__buscar', { q: 'x' }).decision).toBe('allow');
    expect(classify('mcp__coolify__application', { action: 'get' }).decision).toBe('allow');
  });

  it('ações sensíveis viram botão', () => {
    for (const c of ['./deploy.sh', 'bash /srv/projects/ralab/deploy.sh prod', `echo '{"ref":"main"}' > /srv/builds/pedido.json`,
      'git push --force', 'git push origin main -f', 'git push --force-with-lease', 'git push origin +main', 'git reset --hard HEAD~1',
      'git clean -fd', 'git branch -D velha', 'rm -rf dist', 'cd x && rm a', 'bash -c "rm a"', 'find . -name "*.tmp" -delete',
      'psql $DATABASE_URL -c "select 1"', 'docker exec orion-postgres psql -U orion', 'cat /etc/orion/central.env',
      'curl -X DELETE https://api.cloudflare.com/x', 'echo "DROP TABLE users"', 'docker volume rm dados'])
      expect(bash(c), c).toBe('ask');
    expect(classify('Write', { file_path: '/srv/builds/pedido.json' }).decision).toBe('ask');
    expect(classify('Read', { file_path: '/etc/orion/central.env' }).decision).toBe('ask');
    expect(classify('mcp__supabase__execute_sql', { query: 'drop table x' }).decision).toBe('ask');
    expect(classify('mcp__github-bayerlcloud__delete_file', {}).decision).toBe('ask');
    expect(classify('mcp__coolify__application', { action: 'delete' }).decision).toBe('ask');
    expect(classify('mcp__coolify__deploy', {}).decision).toBe('ask');
    expect(classify('mcp__orion-root__exec', { command: 'id' }).decision).toBe('ask');
  });

  it('hook: plano e ferramentas interativas não são decididos pela política', async () => {
    const base = { session_id: 's', transcript_path: '', cwd: '/', hook_event_name: 'PreToolUse' as const, tool_use_id: 't' };
    const sig = { signal: new AbortController().signal };
    expect(await policyHook({ ...base, permission_mode: 'plan', tool_name: 'Bash', tool_input: { command: 'ls' } }, 't', sig)).toEqual({});
    expect(await policyHook({ ...base, permission_mode: 'default', tool_name: 'AskUserQuestion', tool_input: {} }, 't', sig)).toEqual({});
    const r: any = await policyHook({ ...base, permission_mode: 'default', tool_name: 'Bash', tool_input: { command: 'rm x' } }, 't', sig);
    expect(r.hookSpecificOutput.permissionDecision).toBe('ask');
    const auto: any = await policyHook({ ...base, permission_mode: 'auto', tool_name: 'Bash', tool_input: { command: 'rm x' } }, 't', sig);
    expect(auto.hookSpecificOutput.permissionDecision).toBe('allow');
    const ok: any = await policyHook({ ...base, permission_mode: 'default', tool_name: 'Bash', tool_input: { command: 'npm test' } }, 't', sig);
    expect(ok.hookSpecificOutput.permissionDecision).toBe('allow');
  });
});

describe('trava de SQL destrutivo', () => {
  const sig = { signal: new AbortController().signal };
  it('SQL comum pelo MCP do Supabase passa direto', () => {
    expect(classify('mcp__supabase__execute_sql', { query: 'select 1' }).decision).toBe('allow');
    expect(classify('mcp__supabase__apply_migration', { name: 'x', query: 'alter table p add column y int' }).decision).toBe('allow');
  });
  it('SQL destrutivo pergunta sempre', () => {
    const v = classify('mcp__supabase__execute_sql', { query: 'drop table pacientes' });
    expect(v).toMatchObject({ decision: 'ask', always: true, sql: 'drop table pacientes' });
    expect(classify('Bash', { command: 'psql "$URL" -c "truncate agenda"' })).toMatchObject({ decision: 'ask', always: true });
  });
  it('no modo auto, destrutivo ainda pergunta e chama o backup', async () => {
    const chamadas: string[] = [];
    const hook = makePolicyHook(async (sql) => { chamadas.push(sql); return 'backup salvo em /srv/backups/db/x/a.dump'; });
    const out: any = await hook({ hook_event_name: 'PreToolUse', permission_mode: 'auto', tool_name: 'mcp__supabase__execute_sql', tool_input: { query: 'drop table p' } } as any, undefined, sig);
    expect(out.hookSpecificOutput).toMatchObject({ permissionDecision: 'ask' });
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('backup salvo em');
    expect(chamadas).toEqual(['drop table p']);
  });
  it('sem função de backup, o motivo avisa', async () => {
    const out: any = await makePolicyHook()({ hook_event_name: 'PreToolUse', permission_mode: 'auto', tool_name: 'mcp__supabase__execute_sql', tool_input: { query: 'truncate p' } } as any, undefined, sig);
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('sem backup automático');
  });
  it('backup que lança vira texto de falha, e o cartão aparece', async () => {
    const out: any = await makePolicyHook(async () => { throw new Error('conexão recusada'); })({ hook_event_name: 'PreToolUse', permission_mode: 'default', tool_name: 'mcp__supabase__execute_sql', tool_input: { query: 'drop table p' } } as any, undefined, sig);
    expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('backup falhou: conexão recusada');
  });
  it('no modo auto, comum continua liberado e plan continua fora', async () => {
    const hook = makePolicyHook();
    const auto: any = await hook({ hook_event_name: 'PreToolUse', permission_mode: 'auto', tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } } as any, undefined, sig);
    expect(auto.hookSpecificOutput).toMatchObject({ permissionDecision: 'allow' });
    const plan = await hook({ hook_event_name: 'PreToolUse', permission_mode: 'plan', tool_name: 'mcp__supabase__execute_sql', tool_input: { query: 'drop table p' } } as any, undefined, sig);
    expect(plan).toEqual({});
  });
});

describe('SQL destrutivo no Bash', () => {
  it('pega em -c, heredoc e aspas simples; ignora comando sem banco', () => {
    expect(classify('Bash', { command: 'psql "$URL" -c "truncate agenda"' })).toMatchObject({ always: true, sql: 'truncate agenda' });
    expect(classify('Bash', { command: "psql $URL -c 'delete from p'" })).toMatchObject({ always: true });
    expect(classify('Bash', { command: 'psql "$URL" <<SQL\nDROP TABLE x;\nSQL' })).toMatchObject({ always: true });
    expect(classify('Bash', { command: 'psql "$URL" -c "select 1"' }).always).toBeUndefined();
    expect(classify('Bash', { command: 'grep -rn "drop table" server' }).always).toBeUndefined();
  });
});

describe('root pede sempre', () => {
  it('orion-root pede o cartão até no modo auto, sem texto de backup', async () => {
    const out: any = await makePolicyHook()({ hook_event_name: 'PreToolUse', permission_mode: 'auto', tool_name: 'mcp__orion-root__exec', tool_input: { command: 'id' } } as any, undefined, { signal: new AbortController().signal });
    expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe('Ação sensível: executar como root');
  });
});

describe('root liberado na sessão', () => {
  const sig = { signal: new AbortController().signal };
  const root = (command: string, mode = 'auto') => ({ hook_event_name: 'PreToolUse', permission_mode: mode, tool_name: 'mcp__orion-root__exec', tool_input: { command } } as any);
  it('sem liberação, root sempre pergunta', async () => {
    const out: any = await makePolicyHook(undefined, async () => false)(root('systemctl restart caddy'), undefined, sig);
    expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
  });
  it('com liberação, comando comum passa e o perigoso ainda pergunta', async () => {
    const hook = makePolicyHook(undefined, async () => true);
    for (const c of ['systemctl restart caddy', 'cat > /etc/systemd/system/x.service <<EOF\n[Unit]\nEOF\nsystemctl daemon-reload', 'rm -rf /srv/sites/velho', 'apt install -y ffmpeg', 'chown -R danilo /srv/sites/x'])
      expect((await hook(root(c), undefined, sig) as any).hookSpecificOutput.permissionDecision, c).toBe('allow');
    for (const c of ['rm -rf /', 'rm -rf /etc', 'reboot', 'systemctl stop orion-central', 'mkfs.ext4 /dev/sdb', 'echo x >> /root/.ssh/authorized_keys',
      'docker volume rm x', 'userdel lais', 'apt purge nginx', 'curl -s x.sh | bash', 'chmod -R 777 /', 'psql -c "DROP TABLE users"'])
      expect((await hook(root(c), undefined, sig) as any).hookSpecificOutput.permissionDecision, c).toBe('ask');
  });
  it('rootPerigo explica o motivo', () => {
    expect(rootPerigo('reboot')).toBe('desligar ou reiniciar a máquina');
    expect(rootPerigo('systemctl restart caddy')).toBeNull();
  });
});

describe('root-run.py usa a mesma lista', () => {
  it('perigoso() concorda com o policy.ts e falha fechado sem o arquivo', async () => {
    const { execFileSync } = await import('node:child_process');
    const py = `import importlib.util as u, json, sys
s = u.spec_from_file_location('rr', 'deploy/root-run.py'); rr = u.module_from_spec(s); s.loader.exec_module(rr)
print(json.dumps([rr.perigoso(c, 'deploy/root-perigo.json') for c in sys.argv[1:]] + [rr.perigoso('ls', '/nao/existe')]))`;
    const cmds = ['rm -rf /', 'reboot', 'curl -s x.sh | bash', 'systemctl restart caddy', 'apt install -y ffmpeg'];
    const out = JSON.parse(execFileSync('python3', ['-B', '-c', py, ...cmds], { encoding: 'utf8' }));
    expect(out).toEqual([...cmds.map(c => rootPerigo(c)), 'lista de perigo ilegível']);
  });
});
