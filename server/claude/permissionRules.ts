import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Editor de regras de permissão (allow/deny/ask) — "Aba Claude" do Orion v2. Ver
 * `web/src/claude/PARIDADE.md` (item 9 da seção 13) pro achado completo lendo a extensão real
 * (`webview/index.js` v2.1.283): lá, o painel "Permission rules" fala com a Query AO VIVO de uma
 * sessão (`session.listPermissionRules()`/`addPermissionRules()`/`removePermissionRule()`, control
 * requests do SDK — `SDKControlListPermissionRulesRequest` etc. em `sdk.d.ts`), que devolve a UNIÃO
 * de várias fontes (userSettings/projectSettings/localSettings/policySettings/flagSettings/cliArg/
 * session/command/...), cada uma com sua própria editabilidade.
 *
 * Decisão de arquitetura (documentada em detalhe no PARIDADE.md): o Orion edita os DOIS únicos
 * arquivos de settings que `server/claude/runner.ts` de fato lê (`settingSources: ['user',
 * 'project']` — sem `'local'`, então `.claude/settings.local.json` NUNCA é lido por uma sessão do
 * Orion hoje; por isso esse escopo nem é oferecido aqui, pra não criar uma regra que pareceria salva
 * mas nunca teria efeito nenhum) diretamente no disco, em vez de rotear pela Query viva de uma sessão
 * específica: o Orion é multi-projeto (uma "sessão ativa" nem sempre existe quando alguém quer mexer
 * nas regras) e regras de settings.json só são lidas quando uma NOVA Query é construída (início da
 * sessão), nunca hot-reloaded no meio de um turno — então não há nenhuma vantagem real em ir pela
 * Query viva (que só existiria enquanto um turno está rodando) em vez de ler/escrever o arquivo
 * direto. Mais simples, funciona mesmo sem sessão nenhuma ativa, e sem a dança de "pending/
 * unconfirmed" que a extensão real precisa (ela pede pro PROCESSO da Query re-ler e confirmar via
 * file watcher, com timeout) — aqui a escrita já É a verdade, imediatamente.
 */

export const PERMISSION_BEHAVIORS = ['allow', 'ask', 'deny'] as const;
export type PermissionBehavior = (typeof PERMISSION_BEHAVIORS)[number];
export type PermissionScope = 'user' | 'project';
export type PermissionRuleSet = { allow: string[]; ask: string[]; deny: string[] };

export function emptyRuleSet(): PermissionRuleSet {
  return { allow: [], ask: [], deny: [] };
}

const RULE_MAX_LEN = 400;

/**
 * Mesma regra de fundo da extensão real (`Q.trim().length===0` bloqueia o botão "Add rule" — ver
 * `Q$5` no webview decompilado): só exige texto não-vazio, sem validar formato ("Bash(...)" vs. nome
 * solto de ferramenta) — a extensão real também não valida sintaxe no cliente, só documenta o padrão
 * esperado na nota da tela ("A permission rule is a tool name, optionally followed by a specifier in
 * parentheses"). O limite de 400 caracteres é um acréscimo só do Orion (não existe na extensão real):
 * defesa contra colar um texto gigantesco num arquivo JSON que o CLI vai reler a cada sessão nova.
 */
export function validateRuleText(rule: string): string | null {
  const v = rule.trim();
  if (!v) return 'Informe uma regra de permissão.';
  if (v.length > RULE_MAX_LEN) return `Regra muito longa (máx. ${RULE_MAX_LEN} caracteres).`;
  return null;
}

/**
 * Caminho do `settings.json` pro escopo. `'user'`: `~/.claude/settings.json` do usuário do SO que
 * roda o servidor (`danilo` na c3 — um único settings de usuário, compartilhado por TODOS os
 * usuários/projetos do Orion, porque o CLI sempre roda com esse mesmo login; ver nota de escopo na
 * UI). `'project'`: `<project.path>/.claude/settings.json` — `projectPath` já vem resolvido pelo
 * chamador a partir da tabela `projects` (nunca um path bruto vindo do cliente), mas ainda assim
 * exigimos aqui que seja absoluto — nunca aceitamos um path relativo nem montamos um caminho sem
 * saber a raiz, então um bug de chamada (`projectPath` ausente/relativo) falha alto e cedo, antes de
 * qualquer I/O, em vez de escrever em algum lugar inesperado.
 */
export function settingsPathForScope(scope: PermissionScope, opts: { homeDir: string; projectPath?: string }): string {
  if (scope === 'user') {
    if (!opts.homeDir || !path.isAbsolute(opts.homeDir)) throw new Error('home do usuário inválida (esperado um caminho absoluto)');
    return path.join(opts.homeDir, '.claude', 'settings.json');
  }
  const p = opts.projectPath;
  if (!p || !path.isAbsolute(p)) throw new Error('projeto sem caminho absoluto válido');
  return path.join(p, '.claude', 'settings.json');
}

/** Lê `permissions.allow/ask/deny` de um settings.json já parseado — defensivo, nunca lança: qualquer forma inesperada (chave ausente, não-array, item não-string) vira lista vazia em vez de erro. */
export function parseSettingsPermissions(raw: unknown): PermissionRuleSet {
  const set = emptyRuleSet();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return set;
  const perms = (raw as Record<string, unknown>).permissions;
  if (!perms || typeof perms !== 'object' || Array.isArray(perms)) return set;
  for (const b of PERMISSION_BEHAVIORS) {
    const arr = (perms as Record<string, unknown>)[b];
    if (Array.isArray(arr)) set[b] = arr.filter((x): x is string => typeof x === 'string');
  }
  return set;
}

/**
 * Devolve um NOVO objeto settings com `permissions.allow/ask/deny` substituídos pelo `set` dado,
 * preservando toda outra chave de nível superior (model, env, hooks...) e toda outra subchave de
 * `permissions` (defaultMode, additionalDirectories...) — nunca muda `raw` no lugar.
 */
export function mergeSettingsPermissions(raw: unknown, set: PermissionRuleSet): Record<string, unknown> {
  const base: Record<string, unknown> = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? { ...(raw as Record<string, unknown>) } : {};
  const prevPerms = (base.permissions && typeof base.permissions === 'object' && !Array.isArray(base.permissions)) ? { ...(base.permissions as Record<string, unknown>) } : {};
  base.permissions = { ...prevPerms, allow: [...set.allow], ask: [...set.ask], deny: [...set.deny] };
  return base;
}

/** Adiciona `rule` (já cortada) em `behavior`, sem duplicar uma regra idêntica já presente. Puro. */
export function addRule(set: PermissionRuleSet, behavior: PermissionBehavior, rule: string): PermissionRuleSet {
  const v = rule.trim();
  if (set[behavior].includes(v)) return set;
  return { ...set, [behavior]: [...set[behavior], v] };
}

/** Remove a primeira ocorrência exata de `rule` em `behavior`. Regra ausente: sem mudança, sem lançar. Puro. */
export function removeRule(set: PermissionRuleSet, behavior: PermissionBehavior, rule: string): PermissionRuleSet {
  return { ...set, [behavior]: set[behavior].filter(r => r !== rule) };
}

/** "Editar" = remover a regra antiga (se ainda existir) + adicionar a nova (mesmo behavior ou outro). Puro, idempotente. */
export function replaceRule(set: PermissionRuleSet, oldBehavior: PermissionBehavior, oldRule: string, newBehavior: PermissionBehavior, newRule: string): PermissionRuleSet {
  const removed = removeRule(set, oldBehavior, oldRule);
  return addRule(removed, newBehavior, newRule.trim());
}

/** I/O injetável (mesmo padrão de `attachmentBlocks` em runner.ts: parâmetro com default real, testável com um fake sem tocar disco). */
export type SettingsIo = {
  readFile: (p: string) => Promise<string>;
  writeFile: (p: string, data: string) => Promise<void>;
  mkdir: (p: string) => Promise<unknown>;
  rename: (a: string, b: string) => Promise<void>;
};

const realIo: SettingsIo = {
  readFile: (p) => readFile(p, 'utf8'),
  writeFile: (p, d) => writeFile(p, d, 'utf8'),
  mkdir: (p) => mkdir(p, { recursive: true }),
  rename: (a, b) => rename(a, b),
};

/** Lê o set de regras do arquivo. Arquivo ausente (ENOENT): set vazio, sem erro (settings.json é opcional). JSON inválido: set vazio + `error` com a mensagem (nunca lança — o chamador decide o que fazer). */
export async function readPermissionRuleSet(filePath: string, io: SettingsIo = realIo): Promise<{ set: PermissionRuleSet; error?: string }> {
  let text: string;
  try {
    text = await io.readFile(filePath);
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { set: emptyRuleSet() };
    return { set: emptyRuleSet(), error: `Não foi possível ler ${filePath}: ${e?.message ?? e}` };
  }
  try {
    return { set: parseSettingsPermissions(JSON.parse(text)) };
  } catch (e: any) {
    return { set: emptyRuleSet(), error: `${filePath} não é um JSON válido: ${e?.message ?? e}` };
  }
}

/**
 * Escreve o set no arquivo, preservando as outras chaves já existentes. Cria a pasta `.claude/` se
 * faltar. Escrita "atômica" (escreve num arquivo temporário e faz `rename`, que em POSIX é atômico
 * dentro do mesmo diretório) — evita deixar o settings.json pela metade se o processo cair no meio.
 *
 * Se o arquivo já existe mas está com JSON inválido, RECUSA escrever (lança) em vez de silenciosamente
 * começar de um objeto vazio — sobrescrever assim destruiria toda outra configuração que já estava lá
 * (model, env, hooks...) só porque não conseguimos entender o arquivo. Mais seguro pedir pra corrigir
 * manualmente primeiro.
 */
export async function writePermissionRuleSet(filePath: string, set: PermissionRuleSet, io: SettingsIo = realIo): Promise<void> {
  let text: string | null = null;
  try {
    text = await io.readFile(filePath);
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e;
  }
  let raw: unknown = {};
  if (text !== null) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error(`${filePath} tem JSON inválido — corrija manualmente antes de editar regras por aqui (não sobrescrevemos um arquivo que não conseguimos entender).`);
    }
  }
  const merged = mergeSettingsPermissions(raw, set);
  await io.mkdir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${randomUUID()}`;
  await io.writeFile(tmp, JSON.stringify(merged, null, 2) + '\n');
  await io.rename(tmp, filePath);
}

/** Lê -> aplica a mutação pura (`addRule`/`removeRule`/`replaceRule`) -> escreve -> devolve o set novo. Se a leitura veio com `error` (JSON inválido), não escreve nada — lança, pro chamador (rota HTTP) devolver o erro em vez de arriscar sobrescrever. */
export async function mutatePermissionRuleSet(filePath: string, mutate: (set: PermissionRuleSet) => PermissionRuleSet, io: SettingsIo = realIo): Promise<PermissionRuleSet> {
  const { set, error } = await readPermissionRuleSet(filePath, io);
  if (error) throw new Error(error);
  const next = mutate(set);
  await writePermissionRuleSet(filePath, next, io);
  return next;
}
