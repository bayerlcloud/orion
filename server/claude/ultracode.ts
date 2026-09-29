/**
 * Nível "Ultracode" do seletor de esforço — paridade com a extensão real v2.1.283 (ver
 * web/src/claude/PARIDADE-seletor.md). Na extensão, `enableUltracode()` faz duas coisas
 * (webview/index.js: `this.effortLevel.value="xhigh"` + `applySettings({[pf1]:!0},{flagsOnly:!0})`):
 * fixa o esforço em xhigh E liga uma flag interna que ativa o motor de workflows dela (o rótulo do
 * seletor diz exatamente isso: "Ultracode - xhigh + workflows").
 *
 * ponytail: o Agent SDK usado pelo Orion não tem esse motor de workflows — a simplificação
 * documentada é: esforço `xhigh` de verdade + uma instrução curta de orquestração agressiva de
 * subagentes acrescentada ao systemAppend do turno (abaixo). O valor `'ultracode'` é persistido
 * como está em `claude_sessions.effort` (o seletor restaura a escolha ao reabrir), mas NUNCA chega
 * ao SDK — `resolveUltracode` traduz antes de qualquer `startTurn`/`applyFlagSettings`.
 */

/** Valor de fio/persistência do degrau extra (rota HTTP, coluna `claude_sessions.effort`). */
export const ULTRACODE = 'ultracode';

/** Os 5 níveis que o SDK aceita de verdade (`Options.effort` em sdk.d.ts). */
export type SdkEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const SDK_EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Instrução padrão de orquestração agressiva de subagentes — o lado "workflows" do Ultracode no
 * Orion. Curta de propósito: entra no fim do systemAppend de TODO turno com Ultracode selecionado.
 */
export const ULTRACODE_APPEND =
  'Modo Ultracode: orquestre agressivamente com subagentes. Decomponha a tarefa em partes '
  + 'independentes e dispare subagentes (tool Task) em paralelo para investigar, implementar e '
  + 'verificar, reservando ao agente principal a coordenação e a integração dos resultados. '
  + 'Prefira varios subagentes focados a fazer tudo sequencialmente no agente principal.';

/**
 * Traduz o valor de fio (possivelmente 'ultracode') para o que o SDK aceita.
 * 'ultracode' → esforço xhigh + flag ultracode; nível real → ele mesmo; qualquer outra coisa
 * (null/undefined/lixo) → sem override de esforço, sem ultracode.
 */
export function resolveUltracode(effort: string | null | undefined): { effort?: SdkEffort; ultracode: boolean } {
  if (effort === ULTRACODE) return { effort: 'xhigh', ultracode: true };
  if (effort && SDK_EFFORTS.has(effort)) return { effort: effort as SdkEffort, ultracode: false };
  return { ultracode: false };
}

/** Acrescenta a instrução de orquestração ao systemAppend do turno quando Ultracode está ligado. */
export function withUltracodeAppend(systemAppend: string, ultracode: boolean): string {
  return ultracode ? `${systemAppend}\n\n${ULTRACODE_APPEND}` : systemAppend;
}
