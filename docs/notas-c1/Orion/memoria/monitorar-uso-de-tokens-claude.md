---
name: Monitorar uso de tokens Claude
confidence: 0.95
usage_count: 12
generated: 2026-06-24
---

Monitorar uso de tokens Claude
- Chamar GET https://api.anthropic.com/api/oauth/usage com header Authorization: Bearer <token>
- Incluir header anthropic-beta: oauth-2025-04-20
- Token em /config/.claude/.credentials.json
- Parsear five_hour.utilization (sessão atual), seven_day.utilization (semana), resets_at
- Ref: /config/workspace/hermes/agent/account_usage.py::_fetch_anthropic_account_usage()
