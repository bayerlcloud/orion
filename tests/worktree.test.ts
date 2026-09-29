import { describe, it, expect } from 'vitest';
import { validateWorktreeName, worktreesBaseDir, createWorktreeForProject } from '../server/claude/worktree.js';

/**
 * Regras extraídas lendo `fF0` no webview decompilado da extensão real (v2.1.283,
 * `/srv/orion-reference-2.1.283/webview/index.js` — ver PARIDADE.md seção 14):
 * `function fF0($){if(!$)return"Name is required";if($.length>64)return"Name must be 64 characters
 * or fewer";if(!yY5.test($))return"Only letters, numbers, dots, hyphens, and underscores";if($==="."
 * ||$===".."||$.includes(".."))return'Name cannot be "." or ".." or contain ".."';if($.endsWith(".")
 * ||$.endsWith(".lock"))return'Name cannot end with "." or ".lock"';if(xY5($))return'Name cannot be
 * ".git"';return null}` com `yY5=/^[a-zA-Z0-9._-]+$/` e `xY5($)=$.toLowerCase().replace(/\.+$/,"")
 * ===".git"`. Mensagens aqui traduzidas pro padrão PT-BR do resto do Orion (mesma regra, texto
 * diferente) — mesma lógica duplicada (nunca compartilhada) em `web/src/claude/mapper.ts`, pro lado
 * cliente validar ao vivo sem nunca ser a autoridade final: o servidor sempre revalida.
 */
describe('validateWorktreeName — mesma regra da extensão real (fF0), mensagens em PT-BR', () => {
  it('aceita nomes normais', () => {
    expect(validateWorktreeName('minha-feature')).toBeNull();
    expect(validateWorktreeName('Fix_Bug.123')).toBeNull();
    expect(validateWorktreeName('a')).toBeNull();
    expect(validateWorktreeName('a'.repeat(64))).toBeNull();
  });
  it('vazio é obrigatório', () => {
    expect(validateWorktreeName('')).toMatch(/obrigat/);
  });
  it('mais de 64 caracteres', () => {
    expect(validateWorktreeName('a'.repeat(65))).toMatch(/64/);
  });
  it('só letras, números, ponto, hífen e sublinhado', () => {
    expect(validateWorktreeName('tem espaço')).not.toBeNull();
    expect(validateWorktreeName('a/b')).not.toBeNull();
    expect(validateWorktreeName('a$b')).not.toBeNull();
    expect(validateWorktreeName('café')).not.toBeNull();
  });
  it('não pode ser "." nem ".." nem conter ".."', () => {
    expect(validateWorktreeName('.')).not.toBeNull();
    expect(validateWorktreeName('..')).not.toBeNull();
    expect(validateWorktreeName('a..b')).not.toBeNull();
  });
  it('não pode terminar em "." nem ".lock"', () => {
    expect(validateWorktreeName('foo.')).not.toBeNull();
    expect(validateWorktreeName('foo.lock')).not.toBeNull();
  });
  it('não pode ser ".git" (mesmo com pontos finais ou maiúsculas — xY5 real)', () => {
    expect(validateWorktreeName('.git')).not.toBeNull();
    expect(validateWorktreeName('.GIT')).not.toBeNull();
    expect(validateWorktreeName('.git...')).not.toBeNull();
  });
});

describe('worktreesBaseDir — pasta irmã <repo>-worktrees', () => {
  it('monta a partir do path do projeto, sem barra dupla', () => {
    expect(worktreesBaseDir('/srv/orion')).toBe('/srv/orion-worktrees');
    expect(worktreesBaseDir('/srv/projects/brandspace')).toBe('/srv/projects/brandspace-worktrees');
  });
  it('remove barra(s) final(is) do path do projeto antes de sufixar', () => {
    expect(worktreesBaseDir('/srv/orion/')).toBe('/srv/orion-worktrees');
  });
});

describe('createWorktreeForProject — nome inválido nunca chega a chamar o git', () => {
  it('nome vazio: erro imediato, sem tocar disco/git', async () => {
    const r = await createWorktreeForProject('/nao-existe-de-verdade-para-teste', '', 'main');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/obrigat/);
  });
  it('nome inválido (barra): erro imediato, sem tocar disco/git', async () => {
    const r = await createWorktreeForProject('/nao-existe-de-verdade-para-teste', 'a/b', 'main');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toBe('');
  });
});
