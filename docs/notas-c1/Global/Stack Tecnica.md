# Stack Técnica

## Infraestrutura
- **VPS**: 72.61.135.82 (root)
- **Deploy**: Coolify — coolify.bayerl.cloud
- **Proxy**: Traefik v3 (gerenciado pelo Coolify)
- **DNS**: Hostinger — domínio bayerl.cloud
- **Wildcard DNS**: *.bayerl.cloud → 72.61.135.82

## Desenvolvimento
- **IDE**: code-server — code.bayerl.studio
- **AI**: Claude Code (claude-sonnet-4-6)
- **Notas**: SilverBullet — notas.bayerl.cloud

## Serviços Ativos
- n8n: n8n.bayerl.cloud
- Supabase: supabase.bayerl.cloud
- Evolution API: evolution.bayerl.cloud

## Playwright / Browser compartilhado — Arquitetura em migração

**Estado atual:** playwright-mcp roda com Chromium próprio interno (porta 8931).

**Roadmap (não alterar configuração do container até a migração):**
1. Instalar **Hermes** — sobe com Chromium próprio. Dois Chromiums em paralelo temporariamente.
2. **Migração definitiva:**
   - Derrubar Chromium interno do playwright-mcp
   - `PLAYWRIGHT_WS_ENDPOINT` → Chromium do Hermes
   - `HERMES_BROWSER_CDP_URL` → mesmo Chromium
   - noVNC na frente → `browser.bayerl.cloud`
3. **Resultado:** um único Chromium compartilhado servindo playwright-mcp, Hermes, e futuros agentes (Orion/Salim) — visível ao vivo via noVNC.

> ⚠️ Até lá: não alterar config de browser no container playwright-mcp — usar o MCP normalmente.

## Transcrição de Áudio (Whisper local)
- **faster-whisper** instalado no code-server (Python): `from faster_whisper import WhisperModel`
- Modelo `small` em cache: `/config/.cache/huggingface/hub/models--Systran--faster-whisper-small/`
- Script de transcrição do Orion: `/config/workspace/orion2/src/gateway/whisper_transcribe.py`
- **Uso:** `python3 whisper_transcribe.py <arquivo.ogg>` → texto transcrito no stdout
- Foi instalado originalmente para o Rastracking100 (`/config/workspace/rastracking100/pipeline.py`)
- **NÃO precisamos de OpenAI Whisper API** — temos local e gratuito

## MCP google — 3 contas (Workspace + 2 Gmails pessoais) — 2026-07-09
- Servidor: `/config/.google/mcp_google.py` (stdio, registrado em `~/.claude.json`). Tools: `gmail_*`, `drive_*`, `calendar_*`, `list_accounts`.
- **Parâmetro `account=`** (em todas as tools) escolhe a conta:
  - `""` (default) → `danilo@bayerlstudio.com.br` — service account + domain-wide delegation (`sa.json`); qualquer outro usuário `@bayerlstudio.com.br` também funciona (ex: `account="francisco"`).
  - `"studio"` → `bayerlstudio@gmail.com` · `"pessoal"` → `danilobayerl@gmail.com` — OAuth refresh token (aliases em `/config/.google/aliases.json`, tokens em `/config/.google/tokens/<email>.json`, chmod 600).
- **Autorizar nova conta pessoal:** `python3 /config/.google/authorize.py url <email>` → usuário loga no navegador → cai em erro `localhost:8765` (esperado) → colar a URL com `code=` em `authorize.py finish <email> '<url>'`.
- OAuth client: `/config/.google/oauth_client.json` (tipo Desktop, projeto GCP `gen-lang-client-0438053561`, app "Tracking Machine" **publicado em produção** → refresh token não expira; em "Testing" expiraria em 7 dias e daria 403 no login).
- **Cron do Orion** `email-agenda-briefing` verifica as 3 contas (agenda só na Workspace). Labels `Orion/Propaganda`/`Orion/Reportado` existem nas 3 contas: Workspace e studio = `Label_1`/`Label_2`; pessoal = `Label_14`/`Label_15`.

## VPS Nova (Contabo 2) — 212.47.70.170
- 2ª Contabo (Ubuntu 24.04, 6 vCPU, 11GB RAM), contratada 2026-07 pra sair do egress cap do Supabase cloud.
- Roda **Supabase self-hosted** → `supabase.bayerl.cloud` (banco novo de Brandspace/Sirius/Academix).
- Folgada — vai hospedar o **Browser Service** (Playwright+stealth+Chrome).
- Acesso: MCP `ssh-vpsnova` (chave id_ed25519). Não confundir com a Contabo principal 86.48.28.10.

### 🔴 GRAVADO EM PEDRA — 3 Supabase self-hosted na MESMA VPS (não confundir!)
> Dor real 2026-07-27: quase rodei migração no banco errado. São TRÊS stacks com containers de nome quase idêntico, e `pipelines` existe em DOIS (Brandspace E TrackingMachine).

| Projeto | Domínio | Container DB | Kong (REST) | Studio | Fingerprint ÚNICO |
|---|---|---|---|---|---|
| Brandspace (+sirius, academix) | supabase.bayerl.cloud | `supabase-db` | :8000 | :3001 | `sirius_memory` (`sirius_*`) |
| TrackingMachine | tm-supabase.bayerl.cloud | `tm-supabase-db` | :8100 | :3002 | `tracking_events`, `leads` |
| RALab | ralab-supabase.bayerl.cloud | `ralab-supabase-db` | :8200 | :3243 | `lab_invite_codes`, `clinics` |

**Armadilhas:** `pipelines` existe em BS **e** TM (nunca use pra identificar — use `sirius_*`); a **porta 5432 externa da VPS é do TrackingMachine** (tm-supabase-pooler); nomes de container quase iguais; o MCP `supabase` do Claude é o cloud Bayerl Studio (não é self-hosted).

**✅ Regra obrigatória antes de qualquer migração/DDL:** usar o guardião **`dbfor <projeto>`** (`/config/.local/bin/dbfor`) — valida o fingerprint e roda no db certo, ou aborta. Ex: `dbfor brandspace psql "SELECT ..."`.

## Backup off-site (vps-backup)
- Backup diário criptografado dos bancos + configs das 2 VPSs pro Google Drive (Shared Drive `VPS-Backups`).
- Motor: **restic** (cifra+dedup+retenção+check); rclone só transporte (Service Account impersona danilo@bayerlstudio.com.br). 1 repo por host: `rclone:gdrive:VPS-Backups/{c1,c2}`.
- Cron C1 4h30, C2 5h; dead man's switch 9h no code-server (alerta WhatsApp se >26h sem snapshot).
- 🔴 Senha do restic (`/config/.secrets` VPS_BACKUP_C{1,2}_RESTIC_PASS) TEM que estar num cofre EXTERNO à stack, senão desastre leva a chave junto.
- Deploy idempotente: `/config/workspace/vps-backup/deploy.sh`. Restore testado 2026-09-08.
