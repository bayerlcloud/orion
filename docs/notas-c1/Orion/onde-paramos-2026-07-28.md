# Orion — Onde paramos (28/07/2026)

> Semente da sessão nova. A sessão antiga `[Orion] Infraestrutura (Online)` (6.126 msgs, 38MB)
> foi **aposentada** em 28/07 — grande demais (190k tokens) e envenenada com thinking órfão
> após rodar nos fluxos OpenRouter. O estado técnico do Orion já vive no `orion/CLAUDE.md` e no
> vault `notes/Orion/`; aqui ficam só pendências soltas que se perderiam.

## Pendência aberta: limpeza de Gmail (conta danilobayerl@gmail.com)
A última atividade da sessão antiga foi uma limpeza de caixa de e-mail (arquivados + spam):
- **SPAM:** esvaziado (movido pra lixeira).
- **Arquivados:** ~200 movidos pra lixeira; **restam centenas/milhares**.
- ⚠️ **Limitação:** o MCP Google só tem `gmail_trash` (move pra lixeira), sem exclusão permanente.
- **Ação pendente do Danilo (30s):** abrir gmail.com → Lixeira → **"Esvaziar lixeira agora"** pra apagar de vez.
- Se quiser continuar movendo arquivados antigos pra lixeira em lote, dá pra rodar em background.

## Estado do Orion (referência rápida)
Tudo detalhado em `/config/workspace/orion/CLAUDE.md`. Frentes recentes desta janela de trabalho:
- **Modo Time** (Camadas 1-3) construído: pipeline Opus→Fable→Sonnet + Supervisor (retomada/guardrails) + página `/team`.
- **LLM Switch** com guard novo: bloqueia trocar sessão grande (>10MB) pros fluxos OpenRouter.
