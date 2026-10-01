# MCP enxuto: conector simples por padrão, MCP só quando precisa

Data: 01/10/2026. Motivo: cada sessão aberta custava ~1,8 a 2 GB de RAM, e ~85% vinha de ~19 MCPs stdio
(`npx`, 2 processos node cada) que cada sessão subia sozinha. Com 3 sessões a c3 entrava no swap e o deploy
desligava previews para caber.

## Regra

| Tipo | Quando usar | Exemplos |
|---|---|---|
| MCP em processo (SDK) | ferramenta do próprio Orion | orion-memory, orion-root, orion-publicar |
| MCP remoto (HTTP) | o fornecedor hospeda | GitHub (api.githubcopilot.com) |
| MCP compartilhado (um processo, HTTP local) | precisa de estado vivo | cofre (Playwright no Chrome da c3), porta 8931, filho do orion-central |
| Conector simples (`/conector/<nome>`) | API REST com token | Cloudflare, Evolution, WhatsApp, Hostinger, Coolify, n8n, Supabase |

MCP stdio por sessão: proibido para integração nova. Se uma API REST aparecer, vira conector.

## Conector genérico

`server/tools/conectoresHttp.ts`. Hostinger sai do token `hostinger_api_token`; os demais vivem em
`settings.conectores_http` (JSON: nome, base, header, valor, dica, bloqueios). O proxy injeta `header: valor`;
a sessão só vê URL local e a dica (rotas principais). `bloqueios` = lista "MÉTODO regex" recusada com 403.

## Resultado esperado

~300 MB por sessão (motor do Claude) em vez de ~2 GB. O cofre custa ~150 MB uma vez só.

## Pendente

Plugin pdf-viewer (sincronizado da conta claude.ai) ainda sobe 2 MCPs por sessão (~180 MB). Desligar pela
conta, não pelo Orion.
