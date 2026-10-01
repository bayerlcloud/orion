# Preview ao vivo, integração por turno e trava do banco

Data: 2026-09-30. Autor da decisão: Danilo (com Laís). Status: design aprovado em conversa, spec aguardando revisão.

## Objetivo

Ver cada micro mudança ao vivo, como no Lovable: a pessoa pede "aumenta o h1" e o navegador atualiza em menos de um segundo, sem git e sem deploy. Várias pessoas mexem no mesmo projeto ao mesmo tempo, cada uma na sua worktree, e as mudanças de todas se juntam sozinhas na raiz sem uma sobrescrever a outra. Produção continua separada, só pelo publicar.

Critérios de sucesso:

- Clicar em Preview na sessão abre o site da worktree daquela sessão e ele atualiza sozinho (HMR) a cada edição.
- A mudança de uma pessoa aparece na raiz e no preview das outras no turno seguinte, sem perder a mudança de ninguém.
- Preview parado não gasta RAM; preview nunca derruba o orion-central.
- A IA mantém acesso total ao Supabase, mas nada destrutivo roda sem clique e sem backup.

## Decisões fechadas nesta conversa

1. Endereço pessoal `<pessoa>.<projeto>.bayerl.cloud`, só com login do Orion. Endereço raiz `<projeto>.bayerl.cloud`, público, usado raramente para cliente testar antes da produção.
2. Os dois ligam no primeiro acesso e desligam após 1 hora sem conexão.
3. Proteções nos dois: bloqueio de caminhos perigosos no Caddy e vite rodando como usuário Linux `preview`, sem acesso a segredos.
4. Mudanças sobem para a raiz automaticamente ao fim de cada turno, por uma fila por projeto.
5. Preview usa o mesmo banco da produção (opção A, para todos os projetos). Proteção: trava de SQL destrutivo e backup.
6. Limite de memória: fatia de 3 GB para todos os previews, 600 MB por vite, e 4 GB de swap na c3.

Worktree por tarefa (docs/DECISOES.md) continua valendo: o preview pessoal mostra a worktree da sessão onde a pessoa clicou.

## Parte 1: Preview

### Endereços e portas

- Nome da pessoa no endereço: `users.name` em minúsculas, sem acento, só `[a-z0-9-]` (Laís vira `lais`).
- Nome do projeto: `projects.slug`.
- Tabela nova `previews`: `id`, `project_id`, `user_id` (nulo para a raiz), `host` (único), `port` (única, faixa 9100 a 9999), `worktree_path` (pasta servida agora), `updated_at`.
- A porta é fixa por par pessoa e projeto e nunca muda depois de criada.

### Script `sync-previews` (roda como root, via orion-root)

Chamado quando entra pessoa ou projeto (e manualmente). Idempotente. Para cada linha de `previews`:

1. Garante o registro A `<host>` apontando para 217.76.55.249, TTL 14400, pelo hostinger-dns. Nunca wildcard.
2. Escreve `/etc/caddy/previews.d/<host>.caddy` (importado pelo Caddyfile) e dá `caddy reload`.
3. Escreve `/etc/orion/previews/<nome>.env` com `PREVIEW_DIR` e `PREVIEW_PORT_INTERNA`.
4. Habilita `preview@<nome>.socket`.

Com 4 pessoas e 7 projetos são 35 nomes (28 pessoais e 7 raízes), emitidos uma vez. Abaixo do limite de 50 certificados por semana do Let's Encrypt; se passar, o script emite em lotes.

O bloco atual `fisioexpert.bayerl.cloud` (vite solto na porta 8083) é substituído pelo preview raiz do fisioexpert.

### Ligar e desligar (systemd, sem código)

- `preview@.socket`: escuta `127.0.0.1:<porta>`. Não gasta RAM.
- `preview@.service`: `systemd-socket-proxyd --exit-idle-time=1h 127.0.0.1:<porta interna>`, com `Requires=` e `After=` no vite.
- `preview-vite@.service`: `User=preview`, `Slice=preview.slice`, `MemoryMax=600M`, `StopWhenUnneeded=yes`, `WorkingDirectory=${PREVIEW_DIR}`, roda `node_modules/.bin/vite --host 127.0.0.1 --port <porta interna> --strictPort`. `ExecStartPost` espera a porta responder, para o proxy só começar com o vite pronto.
- `preview.slice`: `MemoryMax=3G`. Se estourar, o kernel mata um vite dentro da fatia, nunca o orion-central.
- Trocar a pasta de um preview pessoal (clicar em Preview em outra sessão) regrava o `.env` e reinicia só aquele vite.
- Swap de 4 GB na c3 (`/swapfile`), como proteção geral.

Primeiro acesso depois de parado: 2 a 5 segundos, ou 10 a 30 segundos quando o vite otimiza dependências pela primeira vez. O Caddy segura o pedido com `lb_try_duration 60s` em vez de devolver 502.

### Segurança

- Usuário Linux `preview`, sem shell, sem sudo. ACL de leitura em `/srv/projects` e `/srv/worktrees`; escrita só em `node_modules/.vite` de cada pasta servida. Sem acesso a `~danilo`, `/etc/orion`, `/srv/postgres`.
- Caddy responde 404 para: caminhos começando em `/@fs`, qualquer `/.env*`, `/.git`, e query com `raw` ou `import` junto de `..` ou `%2e`.
- O Caddy continua mandando `Host: localhost` para o vite (como o bloco atual do fisioexpert faz), então o `allowedHosts` do vite não precisa mudar.
- Preview pessoal exige login do Orion:
  1. O botão Preview chama `GET v2.bayerl.cloud/api/preview/open?session=<id>`. O servidor confere a sessão web, grava `worktree_path` na linha `previews` da pessoa, gera um token assinado (HMAC com `SESSION_SECRET`, validade 60 s, contém `user_id` e `host`) e redireciona para `https://<host>/__orion_auth?t=<token>`.
  2. O Caddy manda `/__orion_auth` para o orion-central, que valida o token e grava o cookie `orion_preview` (httpOnly, secure, só daquele host, 7 dias), e redireciona para `/`.
  3. Todo o resto passa por `forward_auth` para `127.0.0.1:3000/api/preview/check`, que aceita se o cookie for válido para aquele host. Sem cookie, redireciona para o login do Orion.
  - O cookie do painel (`orion_session`) não sai de `v2.bayerl.cloud`: o preview nunca recebe a sessão do painel.
- Preview raiz: público, sem `forward_auth`, com as mesmas proteções de caminho e de usuário.

### Worktree sem node_modules

Ao ligar, se a pasta não tem `node_modules`, cria um symlink para o `node_modules` da raiz do projeto. Se o `package.json` da worktree difere do da raiz, roda `npm ci` na worktree no lugar do symlink (uma vez, no próximo clique em Preview).

### Interface

Botão Preview na barra de ferramentas da sessão. Abre o endereço pessoal numa nova janela. Split de tela fica para depois.

### Tipos de projeto cobertos

Projetos com vite (fisioexpert, ralab, trackingmachine, brandspace, abcprimecred) e HTML estático (o vite serve pasta com `index.html`). Projeto que é servidor Node (seo-engine) fica fora desta entrega.

## Parte 2: Integração automática a cada turno

> **Atualização 01/10/2026 (Danilo): worktree por usuário.** Cada pessoa tem uma worktree fixa por projeto,
> `<projeto>-worktrees/<pessoa>`, na branch `usuario/<pessoa>`, saída da branch em que a raiz está. Toda sessão
> nova da pessoa no projeto nasce nela (a pílula "Worktree" do compositor saiu), o preview do usuário mostra ela,
> e cada turno sobe para a raiz pela fila abaixo. A base da integração é a branch atual da raiz, não `main` fixo.
> Raiz com mudança sem commit (ou fora de git): a sessão fica na raiz, como antes, e a conversa mostra o motivo.
> Duas sessões da mesma pessoa no projeto dividem a worktree; a conversa avisa quando outra está rodando.
> Deploy sai da raiz pela fila de deploy; próxima leva: lista do que entra por pessoa, com opção de publicar só
> as mudanças selecionadas (aplicadas sobre a versão em produção, com aviso quando uma depende de outra).

Vale para sessões cuja pasta é uma worktree de projeto. Sessão aberta direto na raiz continua como hoje (grava na raiz).

- Início do turno: na worktree, `git merge <base>` para trazer o que as outras pessoas já enviaram. Se der conflito aqui, aborta e o turno segue; o conflito aparece no fim.
- Fim do turno, se `git status` mostra mudança: `git add -A` e `git commit` com a primeira linha do pedido como mensagem, e entra na fila do projeto.
- Fila: uma integração por vez por projeto (tabela `integration_queue` ou mutex em memória por projeto; o worker roda dentro do orion-central).
- Worker: chama `integrate(repo, branch, base)` já existente em `server/tasks/git.ts`.
  - Sucesso: a raiz recebe o merge e o vite da raiz atualiza sozinho.
  - Conflito: o merge é abortado e a mesma sessão recebe uma mensagem automática do sistema, por exemplo: "Conflito com a mudança de Guilherme em index.html. Traga a base com git merge, junte as duas mudanças mantendo a intenção de cada um e termine o turno." O Claude dessa sessão resolve, e o fim desse turno tenta de novo. Depois de 3 tentativas seguidas sem sucesso, para e avisa a pessoa no chat.
- A raiz precisa estar limpa para o merge. Se estiver suja (alguém editando direto nela), a integração espera e avisa no chat.
- Sem testes no automático. Testes rodam no publicar, como hoje.

## Parte 3: Trava do banco

Mudança em `server/claude/policy.ts`:

- Nova classe "SQL destrutivo", que vira `ask` em qualquer modo, inclusive `auto` (exceção explícita à regra "se é Auto é Auto", decidida pelo Danilo em 30/09/2026).
- Onde olha: `mcp__supabase__execute_sql` e `mcp__supabase__apply_migration` (campo `query`), e comandos Bash com `psql`, `supabase db` ou `pg_restore`.
- O que é destrutivo: `DROP`, `TRUNCATE`, `ALTER TABLE ... DROP`, `ALTER TABLE ... RENAME`, `DELETE` sem `WHERE`, `UPDATE` sem `WHERE`.
- O que deixa de pedir clique: `execute_sql` e `apply_migration` sem nada destrutivo passam direto (hoje sempre pedem). Criar linha, tabela, coluna, edge function, `UPDATE` e `DELETE` com `WHERE` fluem.
- O cartão de aprovação mostra o SQL e o motivo em vermelho.

Backup:

- Configuração do projeto ganha `db_url` (segredo na tabela `settings`, nunca no repositório nem na memória).
- Antes de executar um destrutivo aprovado, o servidor roda `pg_dump -t <tabela>` para `/srv/backups/db/<projeto>/<data>-<tabela>.sql.gz`. Se não conseguir identificar a tabela, faz dump completo. Sem `db_url` configurado, o cartão avisa "sem backup automático".
- Timer diário (`orion-db-backup.timer`, 03:00): `pg_dump` completo de cada projeto com `db_url`, guardando 7 dias.
- Um restore de teste feito na implantação, com o resultado registrado.

## Ordem de implementação

1. Parte 3 (menor, fecha um risco que já existe hoje).
2. Parte 1 (preview).
3. Parte 2 (integração automática).

Cada parte tem o seu plano e pode ser publicada sozinha.

## Tratamento de erros

- Vite não sobe (erro de build, porta ocupada): o proxy fecha a conexão; o Caddy mostra uma página "preview não ligou" com as últimas linhas do `journalctl` daquele vite, visível só para quem está logado.
- Vite morto pelo limite de memória: volta a subir no próximo acesso.
- Registro DNS ou certificado falhou no `sync-previews`: o script registra o erro e segue com os outros; roda de novo sem efeito colateral.
- Integração: todos os resultados (sucesso, conflito, raiz suja) aparecem no chat da sessão que originou.

## Testes

- `policy.ts`: tabela de casos (SQL destrutivo e não destrutivo, com e sem `WHERE`, em comentário, em minúsculas) com a decisão esperada em cada modo.
- Token do `/api/preview/open`: expira, não serve em outro host, não é aceito duas vezes.
- `forward_auth`: sem cookie redireciona; cookie de outro host é recusado.
- Caddy: `curl` nos caminhos bloqueados devolve 404.
- Integração: repositório de teste com duas worktrees editando linhas diferentes (junta as duas) e a mesma linha (conflito vai para a sessão).
- Liga e desliga: `curl` acorda o preview; sem acesso, o vite sai depois do tempo configurado (teste com tempo curto).

## Fora desta entrega

Split de tela, segundo botão para preview do cliente, preview de servidor Node, banco dev, usuário de banco somente leitura, testes no merge automático, backup no R2.
