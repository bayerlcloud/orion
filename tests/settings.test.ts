import { describe, it, expect } from 'vitest';
import { looksLikeClaudeToken, maskToken, sdkEnv } from '../server/settings';

describe('token do Claude', () => {
  it('aceita formato plausível e recusa lixo', () => {
    expect(looksLikeClaudeToken('sk-ant-oat01-' + 'a'.repeat(60))).toBe(true);
    expect(looksLikeClaudeToken('sk-ant-curto')).toBe(false);
    expect(looksLikeClaudeToken('123456')).toBe(false);
    expect(looksLikeClaudeToken('')).toBe(false);
    expect(looksLikeClaudeToken('  sk-ant-oat01-' + 'b'.repeat(60) + '  ')).toBe(true);
  });
  it('mascara sem vazar o meio', () => {
    const t = 'sk-ant-oat01-' + 'x'.repeat(50) + 'WXYZ';
    expect(maskToken(t)).toBe('sk-ant-oat…WXYZ');
    expect(maskToken(null)).toBeNull();
  });
  it('env injeta o token por cima do ambiente e é undefined sem token', () => {
    expect(sdkEnv(null)).toBeUndefined();
    const e = sdkEnv('sk-ant-teste')!;
    expect(e.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-teste');
    expect(e.PATH).toBe(process.env.PATH);
  });
});
