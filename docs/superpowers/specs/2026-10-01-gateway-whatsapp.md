# Gateway de WhatsApp do Orion (versão fechada em 01/10/2026)

Consenso entre a sessão do Orion e a do Brandspace, com o Danilo como ponte.

## Princípio

O Orion é dono das instâncias da Evolution e o único que recebe o webhook delas. Os SaaS nunca falam com a
Evolution nem veem a chave mestra: cada um tem um conector no Orion com chave própria e fala com o contrato
`/api/wa/v1`. Uma fila de envio por número real, porque o WhatsApp bane o volume do número, não do SaaS.

## Conector (um por SaaS)

- `nome`, hash da `chave` (mostrada uma vez; `Authorization: Bearer <chave>`), `segredo` do HMAC.
- `webhook_url` opcional: sem webhook = só dispara; com webhook = recebe mensagens e status.
- `limite_diario` de envios. Passou: 429.
- **Destinos liberados** (grupos `...@g.us` e números): pode enviar para eles e recebe a resposta deles com
  `pode_responder: false` (verificação de resposta do Supervisor). Um destino pode estar em vários conectores.
- **Autorizados** (números): conversa de ida e volta, recebe com `pode_responder: true`. Um dono só por número
  (índice único). Autorizado também conta como destino liberado.
- Mensagem de quem não está em nenhuma lista fica só no Orion (`wa_mensagens`) e não vai para SaaS nenhum.

## Canais (apelidos)

O SaaS escolhe `canal: "alertas" | "conversa"` no envio; a tabela `wa_canais (canal, instancia_real)` no Orion
diz qual instância usa. Hoje os dois apontam para `DANILO-BAYERL-IA-ORION`; com o segundo chip, troca uma linha.

## API v1

- `POST /api/wa/v1/enviar` `{ para, texto?, canal?, midia_url?, midia_tipo?: image|document|video, nome_arquivo?, responde_a? }`
  - 403 se `para` não é destino liberado nem autorizado; 429 acima do limite diário.
  - Responde `{ id, status: "na_fila" }`. O resultado chega pelo webhook (`evento: "status"`).
- `GET /api/wa/v1/destinos`: destinos liberados e autorizados do conector, com nome do grupo/contato.

## Repasse para o SaaS

`POST <webhook_url>` com `x-orion-assinatura: sha256=<HMAC do corpo>`:

```json
{ "evento": "mensagem", "id": "...", "de": "5511...", "nome": "...", "grupo": null,
  "texto": "...", "tipo": "conversation", "ts": "...", "pode_responder": false, "bruto": { } }
{ "evento": "status", "id": "<id do Orion>", "status": "enviada|entregue|lida|falhou", "motivo": null }
```

- `bruto` é o payload da Evolution **sem** `apikey`, e com `server_url` e `instance` trocados pelo canal.
- Sem 2xx, reenvio com espera crescente. O SaaS deduplica pelo `id`.

## Proteção do número

Fila única por instância real: 3 a 8 s aleatórios entre envios, "digitando" antes de mensagem de conversa,
limite diário por conector.

## Serviço separado desde a etapa 1

`orion-wa` (mesmo repositório, mesmo Postgres, systemd próprio) recebe o webhook da Evolution, grava em
`wa_mensagens`, roda a fila e o repasse, e serve `/api/wa/v1`. A publicação do painel não o reinicia. O painel
só lê e configura (Configurações › WhatsApp: conectores, destinos, autorizados, lista de grupos da instância
para liberar com um clique).

## Ordem

1. Orion, serviço `orion-wa`: conectores e chave, `/enviar` com checagem e fila, receptor do webhook.
2. Orion: repasse assinado com `pode_responder`, reenvio, eventos de status; tela de destinos e autorizados.
3. Brandspace: `connector_type: "orion"` (chave e segredo em `app_connection_secrets`), rota
   `POST /api/public/orion/webhook` (HMAC, dedup, ingest, Sirius só com `pode_responder`), desvio no
   supervisor-fire, ContactPicker usando `/destinos`.
4. Teste: 1 tarefa para grupo e 1 para número; resposta de destino chega sem o Sirius responder, de autorizado
   o Sirius responde, de desconhecido nada acontece.
