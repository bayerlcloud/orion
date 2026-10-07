# Otimização das VPS (c1, c2, c3, hostinger)

Data: 2026-10-07
Pedido por: Guilherme

## Contexto

Hoje o painel Orion só enxerga métricas ao vivo (CPU, RAM, swap, disco,
containers) da própria c3, via `server/dash/sampler.ts` (tick 10s, agregado em
`dash_samples`, exibido em `/dash`). As outras 3 VPS (c1, c2, hostinger) só
aparecem como texto estático digitado à mão em `docs/infra.json` (specs e
papel), sem coleta nem histórico. `orion-inventory.timer` roda 1x/hora mas só
localmente na c3, não faz SSH para as outras.

Objetivo: enxergar as 4 VPS (performance e organização), e abrir uma frente
contínua de limpeza/otimização sobre o que for encontrado.

## Escopo

Duas partes independentes:

1. **Extensão do Orion** (código, dentro do repo `orion`): multi-host no
   sampler/dash existentes.
2. **Projeto novo `otimizacao-vps`** (kanban): tarefas de ação sobre os
   achados (limpar container órfão, resolver swap, consolidar serviço etc).

Fora de escopo nesta rodada: reescrever a aba "Instalado" de `Spec.tsx` para
ler do novo coletor (continua lendo `docs/infra.json` estático); dashboard de
custo; qualquer ação automática de remediação (tudo que for destrutivo vira
tarefa com aprovação manual, como já é regra do projeto).

## Parte 1: multi-host no Orion

### Coleta remota

- Novo script (`server/dash/remoteSampler.ts` ou similar), rodando via timer
  systemd próprio (`orion-vps-sampler.timer`, `OnUnitActiveSec=15min`),
  separado do sampler local de 10s.
- Para cada host remoto (c1, c2, hostinger), conecta por SSH com a chave da
  frota (`~danilo/.ssh/fleet_ed25519`, já usada hoje manualmente) e roda os
  mesmos comandos que o parser local já sabe interpretar: `df`, `free`/
  `/proc/meminfo`, `docker ps --format json`. Reaproveita os parsers existentes
  em `server/dash/parse.ts` (sem duplicar lógica de parsing).
- Não lê `/proc/stat` nem monta série de CPU por segundo nos remotos (custo de
  SSH a cada 15 min não sustenta granularidade fina); cobre disco, RAM, swap e
  containers, que foi o que motivou o pedido.
- Grava uma amostra agregada por host em `dash_samples`.

### Mudança de schema

- `dash_samples` hoje: `ts timestamptz primary key default now(), data jsonb`.
- Migração: adiciona coluna `host text not null default 'c3'`, troca a chave
  primária para `(host, ts)`. Linhas existentes (sem host) ficam com o default
  `c3`, preservando o histórico atual do sampler local.
- Sampler local (`server/dash/sampler.ts`) passa a gravar com `host = 'c3'`
  explícito em vez de depender do default.

### API e painel

- `server/routes/dash.ts`: `GET /api/dash/now`, `/history`, `/stream` ganham
  parâmetro opcional `?host=` (default `c3`, mantém comportamento atual para
  quem não manda o parâmetro).
- `web/src/pages/Dash.tsx`: adiciona seletor de host (abas c1/c2/c3/hostinger)
  acima dos cards existentes. Mesmo componente, troca a query string. Hosts
  remotos mostram só os cards que fazem sentido com os dados coletados (disco,
  mem/swap, containers); cards que dependem de série de 10s (CPU tick a tick,
  PSI, rede) ficam ocultos ou com "sem dado" quando o host não é c3.

### Alerta

- No fim de cada ciclo do coletor remoto (15 min), se `disk_pct > 85` ou
  `swap_pct > 50` em qualquer host, manda aviso único por host via WhatsApp do
  Orion (conector `whatsapp`, grupo "alertas"), com cooldown simples (não
  repete o mesmo alerta antes de ele normalizar e estourar de novo) para não
  floodar.

### Testes

- `server/dash/parse.ts` já tem parsers puros testáveis; o coletor remoto só
  precisa de um teste de integração leve: dado um output fixo de `df`/`docker
  ps`, confere que o registro gravado tem o `host` certo e os campos
  esperados. Sem mock de SSH de verdade (isso é infraestrutura, não lógica).

## Parte 2: projeto `otimizacao-vps`

- Pasta `/srv/projects/otimizacao-vps`, registrado no painel como projeto
  (slug `otimizacao-vps`), seguindo a convenção: repositório único, tarefas via
  worktree, integrador junta na principal.
- Conteúdo inicial: nada de código obrigatório — pode começar só com um
  `README.md` descrevendo o objetivo (performance, recursos, organização,
  limpeza das 4 VPS) e um `ACHADOS.md` ou backlog de tarefas conforme o painel
  `/dash` multi-host for revelando problemas.
- Cada achado concreto (ex: "hostinger com 66 containers, 73% disco, ver o que
  dá pra remover") vira uma tarefa normal no kanban desse projeto, com
  worktree própria. Ações destrutivas (apagar container, matar processo,
  redimensionar) seguem a regra já existente: nunca automático, sempre com
  aprovação explícita antes de rodar via `orion-root` ou SSH de frota.

## Decisões fechadas nesta rodada

- Alvo: as 4 VPS (c1, c2, c3, hostinger).
- Objetivo: performance/recursos e organização/limpeza juntos.
- Formato: projeto contínuo (não um relatório único).
- Gatilho: timer periódico (coleta) + tarefas sob demanda (ação).
- Reaproveita sampler/dash_samples/página `/dash` existentes em vez de criar
  tabela e aba novas.
- Slug do projeto de tarefas: `otimizacao-vps`.
- Cadência do coletor remoto: 15 min.
- Threshold de alerta: disco > 85% ou swap > 50%.
