# Plano: Orion — Agente Autônomo Pessoal do Stack Bayerl

## O que o OpenClaw faz (referência)
Framework open-source (Clawd → Moltbot → OpenClaw, desde nov/2025, 68k+ stars).
- Roda Claude/GPT/Gemini como assistente pessoal **self-hosted**
- Memória persistente de longo prazo (nunca esquece entre conversas)
- Controla shell, arquivos, browser (Playwright), agenda tarefas (cron)
- Interface por WhatsApp, Telegram, Slack, Discord, Signal
- **Não** "entra" no code-server — roda diretamente no servidor com acesso ao filesystem/shell

## Por que NÃO instalar o OpenClaw diretamente
- Carroceria diferente — feita pra "tocar a vida", não pra codar
- Não herda contexto vivo do Claude Code (sessão, MCPs, plugins, CLAUDE.md)
- Começaria do zero em cada projeto — perderia vault, skills, superpowers, etc.
- **Motor igual (LLM), carroceria inferior pra código**

## Conclusão: montar o "nosso OpenClaw" com stack próprio

```
WhatsApp (Evolution)
    ↓
n8n (orquestra, agenda, UI visual)
    ↓
claude -p no projeto  ← carroceria COMPLETA do Claude Code
    ↓ (acesso a projetos + vault/memória)
Executa / faz deploy / responde no Zap
```

### Peças que já temos (90% pronto)
| Peça | Serviço | Status |
|---|---|---|
| Gatilho WhatsApp | Evolution (evo.bayerl.cloud) | ✅ rodando |
| Orquestração visual | n8n (workflow.bayerl.cloud) | ✅ rodando |
| Motor + carroceria | claude -p (headless Claude Code) | ✅ disponível |
| Memória | Vault SilverBullet (notas.bayerl.cloud) | ✅ rodando |
| Agendamento | cron do n8n ou /schedule do Claude Code | ✅ disponível |

### O que falta montar
1. **Agente de exemplo**: WhatsApp → n8n → `claude -p` no projeto → responde no Zap
2. (Opcional depois) **Dashboard "Agentes Bayerl"** em `agentes.bayerl.cloud` — lista agentes, on/off, histórico, via API do n8n. Com a nossa cara, não a do n8n.

## Nome do agente
**Orion** — nome definitivo do agente principal (antes chamado de "Hermes Bayerl" no plano técnico).

## Próximo passo (quando retomar)
Executar o plano em `/config/workspace/docs/superpowers/plans/2026-06-20-hermes-bayerl.md` — renomear referências internas de "hermes" para "orion" durante a implementação.
