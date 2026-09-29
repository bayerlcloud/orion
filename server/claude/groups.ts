// "Aba Claude" — agrupamento de sessões em pastas nomeadas (ver PARIDADE.md, item 12 da seção 13:
// classes `newGroupButton`/`groupHeader`/`groupChevron`/`groupName`/`groupNameEditing`/`groupCount`
// da extensão real, `getSessionGroups`/`updateSessionGroups`/`createGroupFromSelection`/
// `moveSelectionToGroup`/`removeSelectionFromGroups` no webview decompilado v2.1.283). Diferente do
// "Agrupar por Nenhum/Projeto/Atividade" já existente (`GroupBy`/`groupSessions` em
// web/src/claude/mapper.ts) — aquele é automático e nunca persistido; isto aqui é criado à mão pelo
// usuário e sobrevive a reload (tabela `claude_session_groups`, migração `010_claude_session_groups`
// em server/migrations.ts).

export const GROUP_NAME_MAX = 120;

/**
 * Valida o nome de uma pasta — autoridade final do lado servidor (nunca confia no que
 * `web/src/claude/mapper.ts` — `validateGroupName`, cópia deliberada pro lado cliente validar ao
 * vivo — já validou). Diferente de `validateWorktreeName` (server/claude/worktree.ts): um nome de
 * pasta é só um rótulo livre guardado no Postgres (nunca vira nome de arquivo/branch git), então não
 * há restrição de caractere nenhuma na extensão real (não achamos validação dedicada de `groupName`
 * no webview decompilado — só o limite implícito de UI). Mesma regra/limite que `POST
 * /api/claude/sessions/:id/rename` já usa pro título da sessão (`title.trim().slice(0, 120)`), em vez
 * de inventar um limite novo só pra pastas.
 */
export function validateGroupName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'nome é obrigatório';
  if (trimmed.length > GROUP_NAME_MAX) return `nome deve ter até ${GROUP_NAME_MAX} caracteres`;
  return null;
}

/** Nome sanitizado pronto pra gravar (trim + corte no limite) — usado pelas rotas depois de `validateGroupName` já ter aprovado. */
export function sanitizeGroupName(name: string): string {
  return name.trim().slice(0, GROUP_NAME_MAX);
}
