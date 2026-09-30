# Integração automática a cada turno (Parte 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Em sessão de worktree, cada turno começa trazendo a base e termina enviando a mudança para a raiz por uma fila por projeto; conflito volta para a própria sessão resolver.

**Architecture:** Três funções git novas em `server/tasks/git.ts` ao lado do `integrate()` que já existe. Uma fila em memória serializa por projeto. O `Runner` ganha ganchos opcionais antes e depois do turno; `routes/claude.ts` liga os ganchos só em sessões cuja `cwd` difere da pasta do projeto. Avisos para a pessoa usam o mesmo mecanismo do aviso de reinício (`startFor` com `prefixPrompt('Orion', ...)`).

**Tech Stack:** TypeScript, git (execFile), vitest.

**Spec:** `docs/superpowers/specs/2026-09-30-preview-design.md` (Parte 2)

## Global Constraints

- Nunca travessão em texto gerado (inclusive nas mensagens `[Orion]`).
- Só sessões com `project_id` e `cwd` diferente de `projects.path` entram no fluxo. Sessão na raiz não muda.
- Base = `projects.default_branch`, ou `main` (mesma leitura defensiva de `server/routes/tasks.ts:101-105`).
- Uma integração por vez por projeto. Sem testes no automático.
- No máximo 3 tentativas seguidas de conflito por sessão; depois, só avisa.
- Raiz suja: tenta de novo a cada 60 s, até 10 vezes; depois, avisa.
- Git via worktree de tarefa; publicar só pela fila.

## Review Focus

- Turno que não mexeu em nada: não cria commit nem entra na fila. Teste em Task 1.
- Duas worktrees mudando linhas diferentes do mesmo arquivo: as duas mudanças ficam na raiz. Teste em Task 1.
- Turno interrompido (Parar) ou com erro: o que já foi editado ainda é enviado (é o mesmo que o Lovable faz). Teste em Task 3.
- Mensagem de conflito gerando outro conflito em sequência: para na 3ª e avisa, sem loop. Teste em Task 4.
- Servidor reinicia com item na fila: a fila é em memória e se perde; o próximo turno da sessão envia de novo porque o commit já está na branch. Teste em Task 4 (o enviar do turno seguinte leva os commits anteriores).

---

### Task 1: Funções git do turno

**Files:**
- Modify: `server/tasks/git.ts` (após `integrate`)
- Test: `tests/gitTurno.test.ts`

**Interfaces:**
- Consumes: `git()`, `safeBase` (internos de `git.ts`), `integrate(repo, branch, base)`.
- Produces:
  - `sincronizarComBase(worktree: string, base: string): Promise<{ ok: boolean; conflito: boolean; log: string }>` (roda `git merge --no-edit <base>` na worktree; em conflito, `merge --abort`).
  - `commitTurno(worktree: string, mensagem: string): Promise<{ commitou: boolean; branch: string | null; log: string }>` (`status --porcelain`; vazio não faz nada; senão `add -A` e `commit -m`; mensagem cortada em 72 letras, uma linha).
  - `raizLimpa(repo: string): Promise<boolean>` (`status --porcelain` vazio, ignorando arquivos não rastreados que estejam no `.gitignore`).

- [ ] **Step 1: Write the failing test**

Criar em `beforeEach` um repositório temporário com `index.html` de 3 linhas (`<h1>a</h1>`, `<p>x</p>`, `<h2>b</h2>`) commitado em `main`, e duas worktrees `wt-d` e `wt-g` com branches `d` e `g`.

```ts
it('turno sem mudança não commita', async () => {
  expect((await commitTurno(wtD, 'nada')).commitou).toBe(false);
});
it('h1 e h2 de pessoas diferentes juntam sem conflito', async () => {
  await edit(wtD, 0, '<h1 class="big">a</h1>'); await edit(wtG, 2, '<h2 class="red">b</h2>');
  expect((await commitTurno(wtD, 'aumenta o h1')).commitou).toBe(true);
  expect((await integrate(repo, 'd', 'main')).ok).toBe(true);
  expect((await commitTurno(wtG, 'h2 vermelho')).commitou).toBe(true);
  expect((await integrate(repo, 'g', 'main')).ok).toBe(true);
  const raiz = await readFile(path.join(repo, 'index.html'), 'utf8');
  expect(raiz).toContain('class="big"'); expect(raiz).toContain('class="red"');
});
it('sincronizarComBase traz a mudança do outro', async () => {
  await edit(wtD, 0, '<h1 class="big">a</h1>'); await commitTurno(wtD, 'x'); await integrate(repo, 'd', 'main');
  expect((await sincronizarComBase(wtG, 'main')).ok).toBe(true);
  expect(await readFile(path.join(wtG, 'index.html'), 'utf8')).toContain('class="big"');
});
it('mesma linha dá conflito e aborta limpo', async () => {
  await edit(wtD, 0, '<h1>D</h1>'); await commitTurno(wtD, 'd'); await integrate(repo, 'd', 'main');
  await edit(wtG, 0, '<h1>G</h1>'); await commitTurno(wtG, 'g');
  const r = await sincronizarComBase(wtG, 'main');
  expect(r).toMatchObject({ ok: false, conflito: true });
  expect(await raizLimpa(wtG)).toBe(true);
});
it('raizLimpa detecta edição direta', async () => {
  await edit(repo, 1, '<p>y</p>'); expect(await raizLimpa(repo)).toBe(false);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run tests/gitTurno.test.ts`
Expected: FAIL, funções não existem.

- [ ] **Step 3: Implement** as três funções.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/gitTurno.test.ts tests/tasks.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/tasks/git.ts tests/gitTurno.test.ts
git commit -m "feat(integracao): merge da base, commit do turno e checagem da raiz"
```

### Task 2: Fila por projeto

**Files:**
- Create: `server/integracao/fila.ts`
- Test: `tests/filaIntegracao.test.ts`

**Interfaces:**
- Produces: `class FilaIntegracao { enfileirar(projetoId: number, job: () => Promise<void>): Promise<void>; tamanho(projetoId: number): number }` (cadeia de promises por projeto; erro de um job é registrado e não trava os próximos).

- [ ] **Step 1: Write the failing test**

```ts
it('serializa por projeto e paraleliza entre projetos', async () => {
  const f = new FilaIntegracao(); const log: string[] = [];
  const job = (n: string, ms: number) => async () => { log.push(`+${n}`); await wait(ms); log.push(`-${n}`); };
  await Promise.all([f.enfileirar(1, job('a', 30)), f.enfileirar(1, job('b', 1)), f.enfileirar(2, job('c', 1))]);
  expect(log.indexOf('-a')).toBeLessThan(log.indexOf('+b'));
  expect(log.indexOf('+c')).toBeLessThan(log.indexOf('-a'));
});
it('job com erro não trava a fila', async () => {
  const f = new FilaIntegracao(); let rodou = false;
  await f.enfileirar(1, async () => { throw new Error('x'); }).catch(() => {});
  await f.enfileirar(1, async () => { rodou = true; });
  expect(rodou).toBe(true);
});
```

- [ ] **Step 2: Run to verify fail**, **Step 3: Implement**, **Step 4: Run to verify pass**

Run: `npx vitest run tests/filaIntegracao.test.ts`

- [ ] **Step 5: Commit**

```bash
git add server/integracao/fila.ts tests/filaIntegracao.test.ts
git commit -m "feat(integracao): fila por projeto"
```

### Task 3: Ganchos de turno no Runner

**Files:**
- Modify: `server/claude/runner.ts` (`TurnParams`, método `run`)
- Test: `tests/runner.test.ts`

**Interfaces:**
- Produces: `TurnParams.ganchos?: { antes?: () => Promise<void>; depois?: (ok: boolean) => Promise<void> }`. `antes` roda antes da primeira mensagem ao SDK (erro é registrado com `deps.log` e o turno segue). `depois` roda no `finally` do turno, depois do `turn_end` ou `interrupted`, sem bloquear o status `idle` (fire and forget com `.catch(log)`).

- [ ] **Step 1: Write the failing tests** (no padrão do `tests/runner.test.ts`, com o `queryFn` falso)

```ts
it('chama antes e depois do turno', async () => {
  const ordem: string[] = [];
  runner.startTurn({ ...base, ganchos: { antes: async () => { ordem.push('antes'); }, depois: async (ok) => { ordem.push(`depois:${ok}`); } } });
  await until(() => ordem.length === 2);
  expect(ordem).toEqual(['antes', 'depois:true']);
});
it('depois roda também quando o turno é interrompido', async () => { /* startTurn com slow, stop(), espera 'depois:false' */ });
it('erro no antes não impede o turno', async () => { /* antes lança; turno termina idle */ });
```

- [ ] **Step 2: Run to verify fail**, **Step 3: Implement**, **Step 4: Run to verify pass**

Run: `npx vitest run tests/runner.test.ts`

- [ ] **Step 5: Commit**

```bash
git add server/claude/runner.ts tests/runner.test.ts
git commit -m "feat(runner): ganchos antes e depois do turno"
```

### Task 4: Ligar tudo nas sessões de worktree

**Files:**
- Create: `server/integracao/turno.ts`
- Modify: `server/routes/claude.ts` (passar `ganchos` nos dois `startTurn`, linhas ~116 e ~323)
- Test: `tests/integracaoTurno.test.ts`

**Interfaces:**
- Consumes: Task 1, `FilaIntegracao` (Task 2), `TurnParams.ganchos` (Task 3), `integrate`.
- Produces: `ganchosDaSessao(o: { sessaoId: string; cwd: string; projeto: { id: number; path: string; default_branch: string } | null; prompt: string; avisar: (texto: string) => void; fila: FilaIntegracao; esperar?: (ms: number) => Promise<void> }): TurnParams['ganchos'] | undefined`. Devolve `undefined` quando não há projeto ou `cwd === projeto.path`. Estado de tentativas por sessão num `Map<string, number>` do módulo (zera em sucesso).

Textos exatos de `avisar` (entram como `prefixPrompt('Orion', texto)` via `startFor`, como o `RESUME_PROMPT`):
- Conflito: `Conflito ao juntar sua mudança na raiz (${arquivos}). Rode git merge ${base} nesta pasta, junte as duas mudanças mantendo a intenção de cada uma, e termine o turno. Não descarte a mudança de ninguém.`
- 3 conflitos seguidos: `Não consegui juntar sua mudança na raiz depois de 3 tentativas (${arquivos}). Pare de tentar e explique o conflito para a pessoa, em poucas linhas.`
- Raiz suja depois de 10 tentativas: `A pasta raiz do projeto tem edição direta não enviada, e sua mudança não pôde entrar. Avise a pessoa, em uma linha, que alguém precisa enviar ou descartar o que está na raiz.`

- [ ] **Step 1: Write the failing tests** (repositório temporário como na Task 1; `avisar` captura textos; `esperar` instantâneo)

```ts
it('sessão na raiz não recebe ganchos', () => expect(ganchosDaSessao({ ...o, cwd: repo })).toBeUndefined());
it('fim do turno envia para a raiz', async () => { /* edit wtD; await g.depois(true); await fila drenar; raiz contém mudança; avisar não chamado */ });
it('conflito avisa a sessão e conta tentativas', async () => { /* 3 conflitos seguidos: 2 avisos de conflito e 1 de desistência; 4º conflito não avisa mais */ });
it('raiz suja espera e desiste depois de 10', async () => { /* raiz editada; depois(true); esperar chamado 10x; aviso de raiz suja */ });
it('início do turno traz a base', async () => { /* integra d; g.antes(); wtG contém mudança de d */ });
```

- [ ] **Step 2: Run to verify fail**, **Step 3: Implement**, **Step 4: Run to verify pass**

Run: `npx vitest run tests/integracaoTurno.test.ts && npm run typecheck`

- [ ] **Step 5: Commit, integrar e publicar**

```bash
git add server/integracao/turno.ts server/routes/claude.ts tests/integracaoTurno.test.ts
git commit -m "feat(integracao): envio automático para a raiz a cada turno"
```

Publicar pela fila. Verificar com duas sessões de worktree no mesmo projeto de teste (um projeto `andromeda` com um `index.html`): pedir "aumenta o h1" numa e "h2 vermelho" na outra; `git -C /srv/projects/andromeda log --oneline -3` mostra os dois merges, e `curl -s https://andromeda.bayerl.cloud/ | grep -c 'class='` confirma as duas mudanças na raiz (depende da Parte 1 no ar).
