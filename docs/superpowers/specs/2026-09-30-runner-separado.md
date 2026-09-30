# Runner separado (motor das sessões fora do servidor web)

Status: proposta, trilho paralelo. Não entra na main até ser testado a fundo e aprovado pelo Danilo.

## Problema

Hoje as sessões do Claude rodam dentro do processo `orion-central` (o mesmo do Fastify). Todo deploy
reinicia esse processo e corta os turnos no meio. A retomada automática (RESUME_PROMPT, vigia, limite de
3 seguidas) remenda o sintoma, mas cada corte custa contexto e às vezes trabalho em andamento (Bash
longo, espera de build).

## Objetivo

Deploy da parte web não corta nenhum turno. Mudança no próprio runner corta o mínimo possível (drenagem).
Base para multiagente e kanban: o runner vira operário que consome trabalho de uma fila.

## Desenho

Dois serviços systemd, mesmo usuário `danilo`:

- `orion-central` (web): rotas HTTP, SSE para a tela, autenticação, tudo que não é turno.
- `orion-runner` (motor): a classe `Runner` de hoje (`server/claude/runner.ts`), sem HTTP público.

Contrato entre os dois, tudo pelo Postgres (já existe, sem dependência nova):

| Hoje (em memória) | Runner separado |
|---|---|
| `runner.startTurn(p)` | `INSERT INTO claude_turnos` (pedido) + `NOTIFY turno_novo` |
| `runner.subscribe` / `emit` (SSE ao vivo, parciais) | runner faz `NOTIFY sessao_<id>` com o evento; web faz `LISTEN` e repassa no SSE. Parciais (stream_event) só por NOTIFY, nunca gravados |
| `runner.decide` (aprovação) | web grava a decisão em `claude_approvals`; `NOTIFY aprovacao`; runner resolve o `canUseTool` pendente |
| `runner.stop` | `NOTIFY parar` com o id |
| `setPermissionModeLive` / `setModelLive` / esforço / estilo | `NOTIFY controle` com o id e o valor |
| `runner.status` / `pendingPermissions` / `commandsFor` | colunas em `claude_sessions` (status já existe) + tabela ou jsonb de comandos |

Limite do NOTIFY: 8000 bytes por payload. Evento maior vai só com o id; a web lê o corpo em `claude_events`.

### Drenagem (troca do runner sem cortar)

1. O build sobe o runner novo (`orion-runner@<build>`), que passa a pegar pedidos novos da fila.
2. O runner velho recebe SIGTERM: para de pegar pedidos, termina os turnos em andamento (limite de 30 min,
   o mesmo da permissão) e sai.
3. Passou do limite: corta, e a retomada automática de hoje cuida do resto.

Um turno fica preso a um runner (coluna `runner_id` em `claude_turnos`). Mensagem nova numa sessão com
turno rodando entra na fila da própria sessão, como hoje (`l.queue`).

### Ganchos e integração

`ganchos.antes/depois` (integração por turno, commit da worktree) e `FilaIntegracao` vão junto para o
runner: são efeitos do turno, não da web. O aviso ao usuário (`avisar`) vira pedido de turno na fila.

## Plano de testes (antes de pensar em main)

- Os testes de `tests/runner.test.ts` rodam contra o runner separado, com um fake de Postgres LISTEN/NOTIFY.
- Ambiente de sombra: `orion-runner` roda em paralelo na c3 atendendo só sessões marcadas (flag por
  sessão, `claude_sessions.motor = 'separado'`). O resto segue no motor atual.
- Roteiro manual: turno longo + deploy da web no meio (não pode cortar); aprovação de ferramenta com a web
  reiniciando no meio da espera; Parar; troca de modo/modelo ao vivo; deploy do runner com turno rodando
  (drenagem); 3 sessões em paralelo; queda do runner (kill -9) e retomada.
- Critério para ir à main: uma semana de uso real em sessões marcadas sem regressão na tela.

## Fora do escopo agora

Runner em outra VPS, um runner por pessoa ou projeto, container por pessoa. O contrato pelo Postgres
deixa isso possível depois sem mudar a web.
