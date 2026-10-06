# Piloto Laya: triagem pré-turno — Plano de implementação

> **Para quem executar:** use superpowers:executing-plans ou superpowers:subagent-driven-development, tarefa por tarefa. Passos usam checkbox (`- [ ]`).

**Objetivo:** antes do turno do Claude, classificar a mensagem com um serviço local (Laya), em modo sombra: só grava o que decidiria, nada muda pra quem usa. Depois de medir o acerto em 200 turnos rotulados, liga decisões reais uma por vez.

**Arquitetura:** hook `UserPromptSubmit` novo (`server/claude/layaHook.ts`), registrado em `runner.ts` junto dos hooks de memória. Chama `laya-serve` local via HTTP com timeout curto; falha aberta (erro ou timeout não bloqueia o turno). Grava resultado em tabela nova `triagem_sombra`. Liga/desliga por chave em `settings`.

**Stack:** systemd (laya-serve, Python/torch CPU), Postgres, TypeScript (Agent SDK hooks).

**Spec:** `/home/danilo/neutro/laya-piloto-orion.md`

## Restrições globais

- Falha aberta: Laya fora do ar ou lento (>1,5s) nunca atrasa nem bloqueia o turno.
- `triagem_sombra` nunca guarda o texto do prompt, só respostas/probabilidades do Laya.
- `LAYA_REVISION` fixo num SHA; modelo não troca sozinho.
- Fase 1 é 100% sombra: nenhuma decisão do Laya muda comportamento visível até a Fase 3.
- Liga/desliga de cada decisão (Fase 3) por chave em `settings`, sem deploy.
- Segredo (`LAYA_API_KEY`) só em `/etc/orion/central.env`, nunca no repo.
- Ações de root (venv, systemd unit, apt/pip) passam por `mcp__orion-root__exec`, nunca SSH manual.

## Review Focus

1. **Laya nunca responde (serviço down o tempo todo):** turno segue normal, sem travar; hook não deve lançar exceção não tratada.
2. **Laya responde mas estoura 1,5s (lento, não caiu):** `AbortSignal.timeout` corta e trata como falha aberta, não espera o corpo.
3. **Mensagem sem prefixo `[Nome]` (ex.: hook interno, `source !== 'user'`):** hook não deve quebrar tentando remover um prefixo que não existe.
4. **Prompt gigante (> 2000 caracteres):** corta antes de mandar pro Laya, não manda tudo.
5. **`(sessao_id, seq)` não bate com `historico_turnos` ainda (materialização roda depois, assíncrona):** hook não pode depender de `claude_events.seq` já existir no momento do `UserPromptSubmit`; precisa de estratégia de junção tolerante a isso (ver Task 2 e 4).

---

## Decisão de design: como casar `triagem_sombra` com `historico_turnos`

`historico_turnos.seq` vem de `claude_events.seq`, que só existe depois que o evento do turno é persistido — o hook `UserPromptSubmit` roda *antes* disso, então não há `seq` confiável pra gravar na hora. Solução: `triagem_sombra.seq` fica **nullable**; a Fase 2 (medição) roda uma junção por `sessao_id` + o timestamp mais próximo **depois** do `ts` da triagem, dentro da mesma sessão, pra preencher `seq` antes de rotular os 200 turnos. Isso evita o hook ter que adivinhar ou bloquear esperando o evento.

---

## Tarefas

### Task 1: Infra do laya-serve (venv + systemd)

**Arquivos:**
- Criar (via `mcp__orion-root__exec`, não editado neste repo): `/srv/laya/.venv`, `/etc/systemd/system/laya-serve.service`
- Nada neste repositório muda nesta tarefa.

**Interfaces:**
- Produz: serviço HTTP em `127.0.0.1:8765`, endpoint `POST /v1/systemone`, autenticado por `LAYA_API_KEY` (vem de `/etc/orion/central.env`).

- [ ] **Passo 1: criar usuário de sistema e venv**
  Via `orion-root exec`: criar usuário dedicado sem login (`laya`), `python3.12 -m venv /srv/laya/.venv`, instalar `torch` CPU-only e depois `laya[serve]`.

- [ ] **Passo 2: criar unit systemd**
  `/etc/systemd/system/laya-serve.service`, usuário `laya`, env:
  `LAYA_HOST=127.0.0.1`, `LAYA_PORT=8765`, `LAYA_DEVICE=cpu`, `LAYA_MODELS=multilingual`, `LAYA_PRELOAD=1`, `LAYA_DEFAULT_MODEL=multilingual`, `LAYA_THREADS=3`, `LAYA_REVISION=<SHA fixo, escolhido ao instalar>`, `LAYA_API_KEY` lido de `/etc/orion/central.env`.
  `MemoryMax=3G`, `CPUQuota=300%`, `Nice=5`.

- [ ] **Passo 3: habilitar e subir**
  `systemctl enable --now laya-serve`.

- [ ] **Passo 4: smoke test**
  Rodar via `orion-root exec`: 20 chamadas de
  `curl -s -X POST 127.0.0.1:8765/v1/systemone -H "Authorization: Bearer $LAYA_API_KEY" -d '{"text":"...", "questions":[...]}'`
  com uma pergunta em português, medir p50.
  **Critério pra seguir:** p50 < 1s com 4 perguntas, RSS do processo < 2,5GB (`systemctl status laya-serve` ou `ps`).

Nenhum commit nesta tarefa (nada no repo mudou).

---

### Task 2: Tabela `triagem_sombra`

**Arquivos:**
- Criar: `server/memories/triagemSombra.ts` (mesmo padrão de arquivo próprio por feature que `server/memories/historico.ts`, pra não disputar `migrations.ts` com outros agentes).
- Modificar: onde `ensureSettingsTable`/`ensureHistoricoTable`-like funções são chamadas no boot do servidor (mesmo ponto que chama a migration de `historico.ts` — localizar e seguir o padrão).
- Test: `server/memories/triagemSombra.test.ts`

**Interfaces:**
- Produz: `ensureTriagemSombraTable(pool: Pool): Promise<void>`, `gravarTriagemSombra(pool: Pool, row: TriagemSombraRow): Promise<void>`.
- Tipo `TriagemSombraRow = { sessaoId: string; ts: Date; latenciaMs: number | null; respostas: unknown; modeloUsado: string | null; esforcoUsado: string | null }` (sem `seq` — ver decisão de design acima).

- [ ] **Passo 1: escrever teste de criação e gravação**
```ts
test('cria tabela e grava uma linha sem seq', async () => {
  await ensureTriagemSombraTable(pool);
  await gravarTriagemSombra(pool, {
    sessaoId: 's1', ts: new Date(), latenciaMs: 180,
    respostas: { injecao: { label: 'nao', confidence: 0.9 } },
    modeloUsado: null, esforcoUsado: null,
  });
  const { rows } = await pool.query('SELECT * FROM triagem_sombra WHERE sessao_id = $1', ['s1']);
  expect(rows).toHaveLength(1);
  expect(rows[0].seq).toBeNull();
});
```

- [ ] **Passo 2: rodar teste, confirmar que falha** (tabela/função não existem)

- [ ] **Passo 3: implementar em `server/memories/triagemSombra.ts`**
```sql
CREATE TABLE IF NOT EXISTS triagem_sombra (
  id BIGSERIAL PRIMARY KEY,
  sessao_id TEXT NOT NULL,
  seq INTEGER,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  latencia_ms INTEGER,
  respostas JSONB NOT NULL,
  modelo_usado TEXT,
  esforco_usado TEXT
);
CREATE INDEX IF NOT EXISTS triagem_sombra_sessao_ts_idx ON triagem_sombra (sessao_id, ts);
```
Sem `UNIQUE (sessao_id, seq)` (spec original pedia, mas `seq` é nullable aqui — ver decisão de design). `gravarTriagemSombra` faz um `INSERT` simples.

- [ ] **Passo 4: rodar teste, confirmar que passa**

- [ ] **Passo 5: ligar `ensureTriagemSombraTable` no boot** (mesmo lugar que chama a de `historico.ts`)

- [ ] **Passo 6: commit**
```bash
git add server/memories/triagemSombra.ts server/memories/triagemSombra.test.ts
git commit -m "feat: tabela triagem_sombra para o piloto Laya"
```

---

### Task 3: chave de settings `layaAtivo`

**Arquivos:**
- Modificar: `server/settings.ts` (objeto `KEYS`, linha ~18-24)
- Test: `server/settings.test.ts` (se já existir; senão criar um teste mínimo junto do arquivo de teste existente do módulo)

**Interfaces:**
- Produz: `KEYS.layaAtivo = 'laya_ativo'`. Lido com `getSetting(pool, KEYS.layaAtivo)`, que devolve `'1'`/`null`/outro valor.

- [ ] **Passo 1: escrever teste**
```ts
test('layaAtivo desligado por padrão', async () => {
  const v = await getSetting(pool, KEYS.layaAtivo);
  expect(v).toBeNull();
});
```

- [ ] **Passo 2: rodar, confirmar falha** (chave não existe em `KEYS`)

- [ ] **Passo 3: adicionar `layaAtivo: 'laya_ativo'` em `KEYS`** (`server/settings.ts:18-24`)

- [ ] **Passo 4: rodar, confirmar que passa**

- [ ] **Passo 5: commit**
```bash
git add server/settings.ts server/settings.test.ts
git commit -m "feat: chave de settings laya_ativo"
```

---

### Task 4: Hook `UserPromptSubmit` do Laya (modo sombra)

**Arquivos:**
- Criar: `server/claude/layaHook.ts`
- Modificar: `server/claude/runner.ts` (bloco `hooks: {...}`, linhas ~439-442)
- Test: `server/claude/layaHook.test.ts`

**Interfaces:**
- Consome: `getSetting`/`KEYS` (Task 3), `gravarTriagemSombra` (Task 2), tipo `HookCallback`/`UserPromptSubmitHookInput` do SDK.
- Produz: `makeLayaHook(pool: Pool, sessaoId: string): HookCallback`.

- [ ] **Passo 1: escrever teste — falha aberta quando `laya_ativo` desligado**
```ts
test('nao chama Laya quando layaAtivo desligado', async () => {
  const hook = makeLayaHook(pool, 's1');
  const result = await hook(
    { hook_event_name: 'UserPromptSubmit', prompt: '[Guilherme] oi' } as UserPromptSubmitHookInput,
    undefined,
    { signal: new AbortController().signal },
  );
  expect(result).toEqual({});
});
```

- [ ] **Passo 2: escrever teste — falha aberta quando fetch estoura timeout**
Mockar `fetch` pra nunca resolver; com `laya_ativo = '1'` em settings, o hook deve devolver `{}` em até ~1,5s (usar `jest.useFakeTimers` ou medir que resolve antes de um timeout de teste maior).

- [ ] **Passo 3: escrever teste — corta prompt em 2000 caracteres e remove prefixo `[Nome]`**
```ts
test('remove prefixo [Nome] e corta em 2000 chars antes de mandar', async () => {
  const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ answers: {} }) });
  global.fetch = fetchMock;
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: '[Guilherme] ' + 'x'.repeat(3000) } as UserPromptSubmitHookInput, undefined, { signal: new AbortController().signal });
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.text.startsWith('[Guilherme]')).toBe(false);
  expect(body.text.length).toBeLessThanOrEqual(2000);
});
```

- [ ] **Passo 4: rodar os 3 testes, confirmar que falham** (`makeLayaHook` não existe)

- [ ] **Passo 5: implementar `makeLayaHook` em `server/claude/layaHook.ts`**
```ts
export function makeLayaHook(pool: Pool, sessaoId: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'UserPromptSubmit') return {};
    try {
      if ((await getSetting(pool, KEYS.layaAtivo)) !== '1') return {};
      const texto = input.prompt.replace(/^\[[^\]]+\]\s*/, '').slice(0, 2000);
      const t0 = Date.now();
      const resp = await fetch('http://127.0.0.1:8765/v1/systemone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LAYA_API_KEY ?? ''}` },
        body: JSON.stringify({ text: texto, questions: PERGUNTAS }),
        signal: AbortSignal.timeout(1500),
      });
      const latenciaMs = Date.now() - t0;
      if (!resp.ok) return {};
      const data = await resp.json();
      await gravarTriagemSombra(pool, { sessaoId, ts: new Date(), latenciaMs, respostas: data.answers, modeloUsado: null, esforcoUsado: null });
    } catch {
      // falha aberta: Laya fora do ar ou lento não afeta o turno
    }
    return {};
  };
}
```
`PERGUNTAS` é a constante com as 4 perguntas da spec (`complexidade`, `precisa_memoria`, `injecao`, `projeto`), definida no mesmo arquivo.

- [ ] **Passo 6: rodar os 3 testes, confirmar que passam**

- [ ] **Passo 7: registrar no runner**
Em `server/claude/runner.ts`, no bloco `hooks: {...}` (~linha 439-442), adicionar:
```ts
UserPromptSubmit: [{ hooks: [makeLayaHook(this.deps.pool, l.id)] }],
```
(usar o `pool` já disponível em `deps` do Runner e o id de sessão do turno, seguindo o mesmo padrão de closure usado para `makeStopMemoriaHook(turno)`).

- [ ] **Passo 8: rodar suite completa do projeto, confirmar que nada quebrou**
Comando: o script de teste já configurado no projeto (`package.json`).

- [ ] **Passo 9: commit**
```bash
git add server/claude/layaHook.ts server/claude/layaHook.test.ts server/claude/runner.ts
git commit -m "feat: hook UserPromptSubmit do piloto Laya (modo sombra)"
```

---

### Task 5: ligar em produção (sombra) e checklist de medição

Esta tarefa é operacional, não só código: liga a chave, deixa rodar 2 semanas, mede.

**Arquivos:**
- Nenhum arquivo novo. Usa `settings` (via UI/rota existente) e consultas SQL diretas.

- [ ] **Passo 1: confirmar Task 1-4 publicadas e no ar** (via `publica`/`deploy`, não nesta worktree).

- [ ] **Passo 2: ligar `laya_ativo = '1'`** via rota de settings já existente.

- [ ] **Passo 3: esperar 2 semanas rodando em sombra.**

- [ ] **Passo 4: antes de rotular, rodar a junção que preenche `seq`**
Query (documentar, não precisa virar código de produção — é uma query de manutenção pontual):
```sql
UPDATE triagem_sombra ts
SET seq = ht.seq
FROM historico_turnos ht
WHERE ht.sessao_id = ts.sessao_id
  AND ht.ts = (
    SELECT MIN(ht2.ts) FROM historico_turnos ht2
    WHERE ht2.sessao_id = ts.sessao_id AND ht2.ts >= ts.ts
  )
  AND ts.seq IS NULL;
```

- [ ] **Passo 5: sortear 200 turnos** de `triagem_sombra` (com `seq` preenchido) join `historico_turnos`, espalhados entre pessoas e projetos.

- [ ] **Passo 6: rotular à mão as 4 perguntas** nesses 200 turnos.

- [ ] **Passo 7: medir acerto** por pergunta (geral, e só acima de um corte de confiança) contra a tabela de metas da spec (`injecao` recall ≥0,9 / FP ≤5%; `precisa_memoria` ≥0,8; `projeto` ≥0,85 em sessão neutra; `complexidade` ≥0,85 sem "grande"→"conversa").

- [ ] **Passo 8: decidir por pergunta** — liga (Fase 3, fora deste plano, planos separados por decisão) ou fine-tuning ou desiste.

Sem commit (não é código).

---

## Fora deste plano

- Ligar cada decisão real (`precisa_memoria`, `injecao`, `projeto`, `complexidade`) — cada uma é um plano próprio, só depois da Task 5 medir e passar da meta.
- Fine-tuning do checkpoint.
- Triagem do WhatsApp (`wa_mensagens`).
