# Orion novo — Entrega 1: a base

Data: 2026-09-25. Status: rascunho para aprovação do Bayerl.
Leitores: Bayerl, colaboradores que vão usar, e as sessões de Claude que vão implementar.

## 1. Objetivo

Ao fim da Entrega 1, o Bayerl e mais uma pessoa entram em orion.bayerl.cloud (ou no IP da c3 enquanto o DNS não migra), veem um kanban por projeto, criam uma tarefa, e a tarefa vira uma sessão do Claude Code rodando numa worktree própria na c3. O chat aparece ao vivo, pedidos de permissão chegam na tela, a pessoa fecha o laptop e a sessão continua.

## 2. Fora de escopo (vem nas entregas 2 e 3)

Agente integrador e merge automático, cobrador, sessões de outras pessoas, projetos privados, WhatsApp, memória injetada, custo e modelo por pessoa, editor próprio, code-server gerenciado.

## 3. Arquitetura

Três processos na c3, todos gerenciados pelo systemd:

- **orion-central** (Node/TypeScript). API HTTP + WebSocket, serve o painel React, fala com o Postgres. Roda como usuário `orion`. Nunca executa o Claude.
- **orion-runner** (Node/TypeScript), **um por pessoa**, rodando como o usuário Linux da pessoa (serviço systemd `orion-runner@<usuario>`). Contém o Agent SDK. Expõe um socket Unix em `/run/orion/<usuario>.sock`, acessível só por `orion` e pelo dono. É quem abre sessões, recebe pedidos de permissão e devolve eventos.
- **postgres** (container Docker `postgres:16`), volume em `/srv/postgres`, porta só em 127.0.0.1.

Por que o runner roda como a pessoa: o login do Claude fica em `~/.claude` do usuário Linux (credencial própria, cobrança própria), os arquivos que a sessão cria já nascem com o dono certo, e um runner travado não derruba os outros.

Fluxo de uma mensagem: painel → WebSocket → central → socket do runner → `query()` do SDK → eventos → central grava em `events` e retransmite ao painel.

## 4. Projetos e worktrees

- `/srv/repos/<slug>.git`: repositório bare, dono `orion`, grupo `orion-<slug>`, `core.sharedRepository=group`. É a única cópia do histórico. Espelha o GitHub (`git remote add origin`; push só pelo integrador na Entrega 2; na Entrega 1 o push é manual pelo Bayerl).
- `/srv/work/<slug>/<task_id>/`: worktree da tarefa, criada com `git worktree add -b task/<task_id> <caminho> <branch_base>`, dono = pessoa responsável. É o `cwd` da sessão.
- Encerrar tarefa (Entrega 1): a worktree fica; remoção manual. Na Entrega 2 o integrador remove após merge.
- `node_modules`: por worktree na Entrega 1. Cache compartilhado fica para depois.

## 5. Modelo de dados (Postgres)

| tabela | campos principais |
|---|---|
| users | id, name, email, linux_user, role (owner, member), password_hash, created_at |
| logins | id, user_id, ts, ip, user_agent |
| projects | id, slug, name, repo_path, default_branch, github_url, created_at |
| project_members | project_id, user_id, role (admin, member) |
| tasks | id, project_id, title, goal, status (backlog, doing, review, done), assignee_id, branch, worktree_path, created_by, created_at, updated_at |
| sessions | id (= session_id do SDK), task_id, user_id, project_id, cwd, model, permission_mode, status (running, waiting_approval, idle, ended, error), started_at, ended_at, cost_usd, input_tokens, output_tokens |
| events | id, session_id, ts, type, payload jsonb |
| approvals | id, session_id, tool_name, tool_input jsonb, decision (allow, deny, timeout), decided_by, requested_at, decided_at |

`events` guarda a forma compacta de cada mensagem do SDK (texto do assistente, uso de ferramenta e resultado resumido, pedido e resposta de permissão, resultado final com custo). O histórico bruto continua no `~/.claude/projects` do usuário e é lido sob demanda pelo runner com `listSessions()` e `getSessionMessages()` quando o painel abre uma sessão antiga.

## 6. Runner: protocolo com a central

Mensagens JSON por linha no socket Unix.

Central → runner:
- `start {session_client_id, cwd, prompt, model?, permission_mode, resume_session_id?}`
- `send {session_id, prompt}` (novo turno numa sessão viva, via `resume`)
- `approve {approval_id, decision}`
- `abort {session_id}`
- `list_sessions {cwd}` / `get_session {session_id}`

Runner → central:
- `event {session_id, type, payload}` para cada mensagem do SDK
- `approval_request {session_id, approval_id, tool_name, tool_input}` vindo de `canUseTool`
- `ended {session_id, result, cost_usd, input_tokens, output_tokens}`
- `error {session_id?, message}`

Detalhes do SDK usados (verificados na doc oficial em 2026-09-25): `query({prompt, options})` com `cwd`, `permissionMode`, `canUseTool`, `resume`, `abortController`, `maxTurns`, `maxBudgetUsd`, `env`, `settingSources`; `listSessions()`, `getSessionMessages()`.

## 7. Permissões

- `/etc/claude-code/managed-settings.json` na c3: `permissions.disableBypassPermissionsMode = "disable"`; `permissions.deny` com `Read(./.env)` e `Read(./.env.*)`. Vale para todos os usuários e para qualquer CLI ou plugin na máquina.
- Sessões começam em `acceptEdits`. O que passa disso chega em `canUseTool`, vira `approval_request`, aparece no painel. Sem resposta em 30 minutos: `deny`, e a sessão segue.
- `bypassPermissions` nunca é passado pela central. `auto` fica disponível como opção por sessão para contas que o têm.
- Limite por sessão: `maxBudgetUsd` (padrão 5 USD, editável na tarefa) e `maxTurns` (padrão 200).

## 8. Painel (React)

Páginas da Entrega 1:
1. **Login** (email + senha; sessão em cookie HttpOnly; registro só pelo owner).
2. **Projetos** (lista; owner cria projeto apontando para um repositório existente ou URL do GitHub para clonar como bare).
3. **Kanban** do projeto: colunas backlog, doing, review, done. Criar tarefa = título + objetivo. Mover para doing = cria worktree e abre a sessão.
4. **Tarefa**: chat ao vivo (stream), cartão de aprovação com allow/deny, aba "arquivos alterados" com `git diff` da worktree, custo acumulado, botão parar. Sobrevive a fechar o navegador: ao reabrir, recarrega de `events`.
5. **Minhas sessões**: lista das sessões do usuário logado com status e custo.

## 9. Segurança

- SSH só por chave (já feito). ufw com 22, 80, 443. Caddy na frente com TLS automático.
- Cada runner só enxerga o socket do próprio usuário; central conecta como `orion` via grupo.
- Segredos de projeto entram por `env` na `query()` a partir de uma tabela `project_secrets` cifrada (Entrega 2). Na Entrega 1 não há segredos de projeto.
- Nada de chave de API compartilhada: cada pessoa faz `claude` login uma vez no terminal como o próprio usuário Linux.

## 10. Falhas

- Runner cai: systemd reinicia; central marca sessões `running` daquele usuário como `error` e oferece retomar por `resume`.
- Central cai: runners continuam; ao voltar, a central reconecta nos sockets e pede `list_sessions` para reconciliar.
- Postgres cai: central responde 503 e não abre sessão nova; runners seguem.
- Sem nada síncrono no event loop: driver `pg` assíncrono, diff e listagens grandes no runner, não na central.

## 11. Testes

- Unitários do protocolo runner ↔ central com um SDK falso (gerador de eventos gravados), sem gastar token.
- Integração da central com Postgres real em container.
- Fumaça de ponta a ponta na c3: cria tarefa num repositório de teste, sessão real com prompt curto, aprovação pela API, diff aparece. Roda no GitHub Actions a cada PR usando um runner self-hosted na c3.

## 12. Critério de pronto da Entrega 1

1. Bayerl e um colaborador fazem login com contas separadas e logins separados no Claude.
2. Uma tarefa em `doing` tem worktree própria, branch `task/<id>`, dono correto no disco.
3. O chat mostra o stream ao vivo, com aprovação funcionando pela tela e timeout de 30 min negando.
4. Fechar o navegador e voltar 10 minutos depois mostra a sessão ainda rodando e o histórico completo.
5. A aba de arquivos mostra o diff da worktree.
6. Custo da sessão bate com o que o SDK reporta.
7. `bypassPermissions` é recusado pelo CLI na c3 mesmo quando pedido à mão.
