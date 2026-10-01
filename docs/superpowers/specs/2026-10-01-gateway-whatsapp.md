# Gateway de WhatsApp do Orion (versão fechada em 01/10/2026)

Consenso entre a sessão do Orion e a do Brandspace, com o Danilo como ponte.

## Princípio

O Orion é dono das instâncias da Evolution e o único que recebe o webhook delas (a Evolution aceita um
webhook por instância). Os SaaS nunca veem a chave mestra: cada um é um **app** no Orion com token próprio.
O Orion **imita a Evolution** em `https://orion.bayerl.cloud/wa`, para o SaaS plugar como se fosse uma
Evolution comum (no Brandspace: `connector_type: "orion"` com `endpointUrl`, `apiKey` = token, `instance` = apelido).
Uma fila de envio por número real, porque o WhatsApp bane o volume do número, não do SaaS.

## Apelidos

O SaaS só conhece apelidos. `wa_apelidos (apelido, instancia_real)`:

| apelido | uso | destino do envio |
|---|---|---|
| `alertas` | Supervisor, grupos e cobrança | livre, com limite diário por app |
| `conversa` | Sirius, ida e volta | só contatos com regra `conversar` daquele app |

Hoje os dois apontam para `DANILO-BAYERL-IA-ORION` (5511978705527). Com o segundo chip, troca uma linha.

## O que o `/wa` aceita (token do app no header `apikey`)

| caminho | comportamento |
|---|---|
| `message/sendText/<apelido>`, `message/sendMedia/<apelido>` | espera a vez na fila, envia e devolve **o corpo e o status reais da Evolution** (o SaaS usa `key.id` e o 400 `exists:false`). Espera acima de ~60 s: 429. Acima do limite diário: 429. Destino proibido no `conversa`: 403. |
| `instance/connectionState/<apelido>` | estado real da instância por trás do apelido |
| `instance/fetchInstances` | só os apelidos daquele app |
| `group/fetchAllGroups/<apelido>`, `chat/findContacts/<apelido>` | leitura, repassada |
| todo o resto (`instance/create`, `delete`, `connect`, `logout`, `webhook/*`, `settings/*`...) | 403 |

## Regras de entrada

`wa_regras (app, contato, modo)`, `contato` = número ou jid de grupo, `modo` = `ouvir` | `conversar`.

- `ouvir`: o app recebe a mensagem (verificação de resposta), ninguém responde. Um contato pode ter `ouvir` em vários apps.
- `conversar`: o app recebe e pode responder. Um dono só por contato (índice único parcial).
- Contato sem regra: fica só no Orion (`wa_mensagens`).

## Repasse para o app

`POST <webhook_url do app>` (no Brandspace, `/api/public/evolution/webhook?k=...`), no formato original
`messages.upsert` da Evolution, com:

- `apikey` **removida** do corpo, `server_url` trocado pelo Orion;
- `instance` trocado pelo apelido escolhido pelo modo da regra: `conversar` vira `conversa`, `ouvir` vira `alertas`
  (assim o bot responde pelo apelido certo e a trava do `conversa` vale);
- headers `x-orion-modo: ouvir|conversar` e `x-orion-assinatura: sha256=<HMAC do corpo>` (o app valida quando puder; o `?k=` segura o começo);
- sem 2xx, reenvio com espera crescente.

## Proteção do número

Fila única por instância real: 3 a 8 s aleatórios entre envios, "digitando" antes de mensagem do `conversa`,
limite diário por app.

## Serviço separado desde a etapa 1

`orion-wa` (mesmo repositório, mesmo Postgres, systemd próprio, Caddy manda `/wa/*` e o webhook da Evolution
para ele) recebe o webhook, grava em `wa_mensagens`, roda a fila e o repasse e serve o `/wa`. A publicação do
painel não o reinicia. O painel só lê e configura (Configurações › WhatsApp: apps e tokens, regras, lista de
grupos da instância para liberar com um clique).

## Ordem

1. Orion: tabelas `wa_apps` (nome, hash do token, webhook_url, segredo, limite diário), `wa_regras`, `wa_apelidos`;
   serviço `orion-wa` com o `/wa` (lista de permitidos e fila síncrona) e o receptor do webhook.
2. Orion: repasse com limpeza do payload, apelido pelo modo, `x-orion-modo`, HMAC e reenvio; tela de apps e regras.
3. Brandspace: `connector_type: "orion"` (token em `app_connection_secrets`); o Sirius responde só com
   `x-orion-modo: conversar`. HMAC depois.
4. Teste: 1 tarefa do Supervisor para grupo e 1 para número (reação 👍 aparece no histórico); resposta de contato
   `ouvir` chega sem o Sirius responder, de `conversar` o Sirius responde, de desconhecido nada acontece.
