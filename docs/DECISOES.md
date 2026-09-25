# Decisões estruturais (fechadas em 2026-09-25)

1. Orion novo é do zero. O Orion antigo (c1) é só fonte de conhecimento. orion.bayerl.cloud migra quando o novo estiver pronto.
2. Host: c3, Contabo Cloud VPS Plus 6, Ubuntu 24.04, 6 vCPU / 12 GB / 290 GB.
3. Repositório único por projeto na c3 + worktree por tarefa + agente integrador. Ninguém faz git na mão. GitHub é espelho.
4. Editor próprio: adiado. Não é pré-requisito. Enquanto isso, code.bayerl.cloud aponta para a worktree.
5. Isolamento: usuário Linux por pessoa. Container por pessoa é opcional, não obrigatório.
6. Banco: Postgres puro em container. Sem Supabase.
7. Motor: Claude Agent SDK (TypeScript). Nunca --dangerously-skip-permissions.
8. Stack: Node + TypeScript, Postgres, React.
9. MVP em 3 entregas: (1) base, (2) integrador + cobrador + visão do time, (3) memória + WhatsApp + custo/modelo.
