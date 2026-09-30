import { describe, it, expect } from 'vitest';
import { classify, policyHook } from '../server/claude/policy';

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
    expect(classify('mcp__supabase__execute_sql', { query: 'select 1' }).decision).toBe('ask');
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
