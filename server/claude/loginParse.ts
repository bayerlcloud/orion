/** Helpers puros para ler a saída do `claude setup-token` rodando num pseudo-terminal. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')   // OSC
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')      // CSI
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .replace(/\r/g, '');
}
export function extractAuthUrl(out: string): string | null {
  const clean = stripAnsi(out);
  const m = clean.match(/https:\/\/[^\s"'<>]+\/oauth\/authorize\?[^\s"'<>]+/);
  return m ? m[0] : null;
}
export function extractToken(out: string): string | null {
  const clean = stripAnsi(out).replace(/\n/g, '');
  const m = clean.match(/sk-ant-oat01-[A-Za-z0-9_-]{20,}/);
  return m ? m[0] : null;
}
export function wantsCode(out: string): boolean {
  return /Paste\s*code\s*here/i.test(stripAnsi(out).replace(/\n/g, ''));
}
export function looksLikeError(out: string): string | null {
  const clean = stripAnsi(out);
  const m = clean.match(/(Invalid code|invalid_grant|expired|Authentication failed|Error:[^\n]{0,200}|Failed[^\n]{0,200})/i);
  return m ? m[0].trim() : null;
}
