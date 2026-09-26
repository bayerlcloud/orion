import { spawn, type ChildProcess } from 'node:child_process';
import { platform } from 'node:os';
import { extractAuthUrl, extractToken, looksLikeError, stripAnsi, wantsCode } from './loginParse.js';
import { tokenFromScreen, urlFromScreen } from './terminalScreen.js';

/** `script` dá um pseudo-terminal ao comando. As opções diferem entre util-linux (Ubuntu) e BSD (macOS, só nos testes). */
export function ptyCommand(cmd: string): [string, string[]] {
  return platform() === 'darwin' ? ['script', ['-q', '/dev/null', 'bash', '-c', cmd]] : ['script', ['-qfec', cmd, '/dev/null']];
}

export type LoginState = 'idle' | 'starting' | 'awaiting_code' | 'exchanging' | 'done' | 'error';

/**
 * Roda o login oficial do Claude Code (`claude setup-token`) num pseudo-terminal e faz a ponte com a tela:
 * captura o link de autorização, recebe o código colado e captura o token de 1 ano.
 * Igual ao que o plugin do VS Code faz por baixo, sem terminal para o usuário.
 */
export class LoginFlow {
  state: LoginState = 'idle';
  url: string | null = null;
  token: string | null = null;
  error: string | null = null;
  startedAt = 0;
  private out = '';
  private child: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private opts: { onToken: (t: string) => Promise<void>; timeoutMs?: number; command?: string }) {}

  snapshot() {
    return { state: this.state, url: this.url, error: this.error, started_at: this.startedAt || null, output_tail: stripAnsi(this.out).slice(-1500) };
  }

  start(): void {
    if (this.state === 'starting' || this.state === 'awaiting_code' || this.state === 'exchanging') return;
    this.state = 'starting'; this.url = null; this.token = null; this.error = null; this.out = ''; this.startedAt = Date.now();
    const cmd = this.opts.command ?? 'stty cols 2000 rows 50; claude setup-token';
    const [bin, args] = ptyCommand(cmd);
    const child = spawn(bin, args, { env: { ...process.env, TERM: 'xterm-256color', BROWSER: 'true' }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const onData = (b: Buffer) => { this.out += b.toString('utf8'); if (this.out.length > 400_000) this.out = this.out.slice(-200_000); void this.scan(); };
    child.stdout?.on('data', onData); child.stderr?.on('data', onData);
    child.on('error', (e) => { this.fail(`não consegui rodar o login: ${e.message}`); });
    child.on('exit', (code) => {
      this.child = null;
      if (this.state === 'done') return;
      if (this.state === 'exchanging' || this.state === 'awaiting_code' || this.state === 'starting') {
        void tokenFromScreen(this.out).then(t => { const tok = t ?? extractToken(this.out); if (tok) void this.finish(tok); else this.fail(looksLikeError(this.out) ?? `o login encerrou sem token (código ${code})`); });
      }
    });
    this.timer = setTimeout(() => this.cancel('tempo esgotado (10 min)'), this.opts.timeoutMs ?? 10 * 60_000);
  }

  private scanning = false;
  private async scan() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      if (!this.url) {
        const u = (await urlFromScreen(this.out)) ?? extractAuthUrl(this.out);
        if (u) { this.url = u; if (this.state === 'starting') this.state = 'awaiting_code'; }
      }
      if (this.state === 'starting' && wantsCode(this.out) && this.url) this.state = 'awaiting_code';
      if (this.state !== 'done') {
        const t = (await tokenFromScreen(this.out)) ?? extractToken(this.out);
        if (t) { await this.finish(t); return; }
      }
      if (this.state === 'exchanging') { const err = looksLikeError(this.out.slice(-2000)); if (err && /invalid|expired|failed/i.test(err)) this.fail(err); }
    } finally { this.scanning = false; }
  }

  submitCode(code: string): boolean {
    const c = code.trim();
    if (!c || !this.child?.stdin || this.state !== 'awaiting_code') return false;
    this.state = 'exchanging';
    // Texto e Enter no mesmo pacote viram "colagem" para a interface do CLI e o Enter é ignorado. Manda separado.
    const stdin = this.child.stdin;
    stdin.write(c);
    setTimeout(() => { try { stdin.write('\r'); } catch { /* processo já morreu */ } }, 400);
    return true;
  }

  private async finish(token: string) {
    if (this.state === 'done') return;
    this.state = 'done'; this.token = token;
    try { await this.opts.onToken(token); } catch (e: any) { this.fail(`token recebido mas não salvo: ${e?.message ?? e}`); return; }
    this.stopProcess();
  }

  private fail(msg: string) { if (this.state === 'done') return; this.state = 'error'; this.error = msg; this.stopProcess(); }

  cancel(reason = 'cancelado'): void {
    if (this.state === 'done' || this.state === 'idle') return;
    this.fail(reason);
  }

  private stopProcess() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const c = this.child; this.child = null;
    if (c && !c.killed) { try { c.kill('SIGTERM'); setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* já morreu */ } }, 2000).unref(); } catch { /* ignora */ } }
  }
}
