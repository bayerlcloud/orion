// Aba estática "Arquitetura de Memória" da página Spec.
// Conteúdo verificado em 29/09/2026 — descreve o estado real do código (runner.ts,
// header.ts, memoryTool.ts, curador/, routes/memories.ts) e da memória de arquivos do Claude Code na c3.

// Estilos dos SVGs (tokens do tema; presentation attributes não aceitam var(), então vai via style)
const svgEstilo: React.CSSProperties = { width: '100%', height: 'auto', display: 'block', margin: '14px 0', fontFamily: 'var(--font)' };
const caixa: React.CSSProperties = { fill: 'var(--bg2)', stroke: 'var(--line)', strokeWidth: 1 };
const linha: React.CSSProperties = { stroke: 'var(--fg2)', strokeWidth: 1.2, fill: 'none' };
const tTitulo: React.CSSProperties = { fill: 'var(--fg)', fontSize: 12, fontWeight: 600 };
const tTexto: React.CSSProperties = { fill: 'var(--fg2)', fontSize: 11 };
const tMono: React.CSSProperties = { fill: 'var(--fg2)', fontSize: 10.5, fontFamily: 'var(--mono)' };

function Seta({ id }: { id: string }) {
  return (
    <defs>
      <marker id={id} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
        <path d="M0,0 L8,4 L0,8 z" style={{ fill: 'var(--fg2)' }} />
      </marker>
    </defs>
  );
}

function DiagramaCiclo() {
  const m = 'url(#seta-ciclo)';
  return (
    <svg viewBox="0 0 760 215" style={{ ...svgEstilo, maxWidth: 760 }} role="img" aria-label="Ciclo de um turno: cliente remonta o contexto, envia à API, recebe o delta e anexa ao histórico">
      <Seta id="seta-ciclo" />
      {/* cliente */}
      <rect x="10" y="15" width="260" height="140" rx="6" style={caixa} />
      <text x="24" y="38" style={tTitulo}>Cliente (CLI / SDK)</text>
      <text x="24" y="56" style={tTexto}>remonta TUDO a cada turno:</text>
      <text x="24" y="76" style={tTexto}>· system prompt</text>
      <text x="24" y="92" style={tTexto}>· CLAUDE.md + MEMORY.md (índice)</text>
      <text x="24" y="108" style={tTexto}>· histórico inteiro + resultados de tools</text>
      <text x="24" y="124" style={tTexto}>· mensagem nova</text>
      {/* api */}
      <rect x="340" y="55" width="140" height="60" rx="6" style={caixa} />
      <text x="410" y="80" textAnchor="middle" style={tTitulo}>API</text>
      <text x="410" y="98" textAnchor="middle" style={tTexto}>stateless — não guarda nada</text>
      {/* resposta */}
      <rect x="550" y="55" width="200" height="60" rx="6" style={caixa} />
      <text x="650" y="80" textAnchor="middle" style={tTitulo}>Resposta</text>
      <text x="650" y="98" textAnchor="middle" style={tTexto}>só o delta do turno</text>
      {/* setas */}
      <line x1="270" y1="85" x2="332" y2="85" style={linha} markerEnd={m} />
      <line x1="480" y1="85" x2="542" y2="85" style={linha} markerEnd={m} />
      <path d="M 650 115 L 650 185 L 140 185 L 140 162" style={linha} markerEnd={m} />
      <text x="395" y="178" textAnchor="middle" style={tTexto}>o cliente anexa a resposta ao histórico local e repete no próximo turno</text>
    </svg>
  );
}

function DiagramaDoisSistemas() {
  const m = 'url(#seta-mem)';
  return (
    <svg viewBox="0 0 800 430" style={{ ...svgEstilo, maxWidth: 800 }} role="img" aria-label="Dois sistemas de memória em paralelo: arquivos do Claude Code e tabela memories no Postgres, com importar/exportar entre eles e os dois alimentando a sessão">
      <Seta id="seta-mem" />
      {/* lado A */}
      <rect x="10" y="10" width="340" height="175" rx="6" style={caixa} />
      <text x="24" y="34" style={tTitulo}>Lado A — memória de arquivos</text>
      <text x="24" y="52" style={tMono}>~/.claude/projects/&lt;cwd&gt;/memory/</text>
      <text x="24" y="76" style={tTexto}>· MEMORY.md = índice (injetado no prompt)</text>
      <text x="24" y="93" style={tTexto}>· .md lidos sob demanda (tool Read)</text>
      <text x="24" y="110" style={tTexto}>· frontmatter: name, description, type</text>
      <text x="24" y="127" style={tTexto}>· secundária: a fonte da verdade é o lado B</text>
      <text x="24" y="144" style={tTexto}>· por pasta de projeto (cwd)</text>
      {/* lado B */}
      <rect x="450" y="10" width="340" height="175" rx="6" style={caixa} />
      <text x="464" y="34" style={tTitulo}>Lado B — tabela memories</text>
      <text x="464" y="52" style={tMono}>Postgres do painel</text>
      <text x="464" y="76" style={tTexto}>· code, title, summary (144), body_md</text>
      <text x="464" y="93" style={tTexto}>· level 0 a 4; nota 1 a 10 só no nível 4</text>
      <text x="464" y="110" style={tTexto}>· escopo, keywords, rewritable, rastreio</text>
      <text x="464" y="127" style={tTexto}>· embedding vector(384) (pgvector)</text>
      <text x="464" y="144" style={tTexto}>· UI do painel, tool orion-memory, curador</text>
      {/* ponte */}
      <line x1="350" y1="65" x2="442" y2="65" style={linha} markerEnd={m} />
      <text x="400" y="55" textAnchor="middle" style={tTexto}>importar</text>
      <line x1="450" y1="125" x2="358" y2="125" style={linha} markerEnd={m} />
      <text x="400" y="115" textAnchor="middle" style={tTexto}>exportar</text>
      {/* sessão */}
      <rect x="230" y="330" width="340" height="80" rx="6" style={caixa} />
      <text x="400" y="356" textAnchor="middle" style={tTitulo}>Sessão do Claude no Orion</text>
      <text x="400" y="374" textAnchor="middle" style={tTexto}>runner.ts — Agent SDK query()</text>
      <text x="400" y="391" textAnchor="middle" style={tTexto}>system prompt + append + histórico</text>
      {/* setas para a sessão */}
      <line x1="180" y1="185" x2="328" y2="326" style={linha} markerEnd={m} />
      <text x="20" y="243" style={tTexto}>injeção padrão do SDK:</text>
      <text x="20" y="259" style={tTexto}>índice MEMORY.md; corpo via Read</text>
      <line x1="620" y1="185" x2="472" y2="326" style={linha} markerEnd={m} />
      <text x="780" y="243" textAnchor="end" style={tTexto}>append: nível 2 com corpo,</text>
      <text x="780" y="259" textAnchor="end" style={tTexto}>nível 3 só índice; tool orion-memory</text>
    </svg>
  );
}

// Pilha do que uma sessão recebe (na ordem em que entra no contexto)
const camadas: { titulo: string; detalhe: string }[] = [
  { titulo: 'System prompt do Claude Code', detalhe: 'preset claude_code do Agent SDK' },
  { titulo: 'Append do Orion', detalhe: 'buildSystemAppend (server/claude/header.ts): projeto, pasta, criador, aviso de painel multi-pessoa, pt-BR, regras do projeto, contas conectadas, até 10 regras nível 2 (título + corpo, até 15 linhas cada) e até 20 decisões nível 3 (só a linha do índice)' },
  { titulo: '~/.claude/CLAUDE.md do danilo', detalhe: 'nível 0 (constituição) + @import dos 3 mapas do nível 1 em ~/.claude/nivel1/' },
  { titulo: 'CLAUDE.md do projeto + MEMORY.md (índice)', detalhe: "injeção padrão do SDK ligada: settingSources: ['user','project'] no runner.ts" },
  { titulo: 'Histórico da sessão', detalhe: 'retomável via sessionId/resume; arquivos em /home/danilo/.claude/projects/-srv-orion/ — mesmo formato do CLI, compartilhado com plugin/CLI' },
  { titulo: 'Tool MCP orion-memory', detalhe: 'ligada em toda sessão: buscar (corpo das decisões nível 3 e micro-fatos nível 4) e salvar (níveis 2 a 4, escopo herdado da sessão)' },
  { titulo: 'Mensagem nova', detalhe: 'prefixada com [Nome] de quem mandou' },
];

const camadaEstilo: React.CSSProperties = {
  border: '1px solid var(--line)', background: 'var(--bg2)', padding: '7px 12px', marginTop: -1, maxWidth: 640,
};

const buracos: { buraco: string; efeito: string; estado: string }[] = [
  {
    buraco: 'O corpo (body_md) nunca chegava ao Claude: a injeção mandava só o resumo de 144 caracteres.',
    efeito: 'Ele só lia o corpo de uma memória se alguém exportasse para o disco antes.',
    estado: 'resolvido: nível 2 entra com corpo no append; níveis 3 e 4 pelo buscar da tool orion-memory',
  },
  {
    buraco: 'Rastreio de acesso (last_accessed_at/session/reason) só funcionava pelo painel.',
    efeito: 'A IA não registrava "acessei X por causa de Y".',
    estado: 'resolvido: o buscar grava sessão e motivo em cada memória devolvida',
  },
  {
    buraco: 'rewritable era stub.',
    efeito: 'O ciclo "IA analisa e reescreve memórias" estava só no schema.',
    estado: 'resolvido: o curador propõe reescrita, e o servidor só aceita em memória rewritable',
  },
  {
    buraco: 'Export destrutivo no índice: reescreve o MEMORY.md inteiro a partir da tabela.',
    efeito: 'Memória criada pelo Claude nos arquivos e nunca importada some do índice no próximo export.',
    estado: 'aberto (importe antes de exportar)',
  },
  {
    buraco: 'Import atribui memória type: user a quem clicou no botão.',
    efeito: 'O dono registrado pode não ser o dono real da memória.',
    estado: 'aberto',
  },
  {
    buraco: '/api/memories/:id/analyzed ainda é stub.',
    efeito: 'last_analyzed_at só muda pelo import; o curador não marca o que analisou.',
    estado: 'aberto',
  },
];

// Os 5 níveis da arquitetura decidida em 28/09/2026
const niveis: { nivel: string; oQueE: string; quemEscreve: string; dinamica: string; injecao: string }[] = [
  { nivel: '0', oQueE: 'Constituição (um só CLAUDE.md raiz)', quemEscreve: 'só o Danilo', dinamica: 'imutável', injecao: 'sempre, em toda sessão' },
  { nivel: '1', oQueE: 'Mapas auto-atualizáveis (mapa, equipe-e-projetos, capacidades)', quemEscreve: 'só script determinístico', dinamica: 'regenerado a cada 1h pelo ciclo do inventário', injecao: 'sempre, via @import no CLAUDE.md' },
  { nivel: '2', oQueE: 'Regras e preferências por projeto e por usuário', quemEscreve: 'IA e pessoas', dinamica: 'editada ou removida quando muda; binário, sem nota', injecao: 'quando o escopo da sessão bate' },
  { nivel: '3', oQueE: 'Decisões fechadas e conclusões', quemEscreve: 'promoção do nível 4 ou registro direto', dinamica: 'só sai por revogação explícita', injecao: 'só a linha do índice; corpo sob demanda' },
  { nivel: '4', oQueE: 'Enxame de micro-memórias (fatos de 1 a 3 linhas)', quemEscreve: 'IA livre, em qualquer sessão', dinamica: 'nota 1 a 10, curadoria diária', injecao: 'não injetada; recuperada por busca' },
];

export default function SpecMemoria() {
  return (
    <div className="md">
      <p className="muted small">conteúdo estático, verificado no código em 29/09/2026 — como o Claude "lembra", o que o Orion injeta hoje e o que falta fechar</p>

      <h2>1. Como o Claude "lembra"</h2>
      <p>
        A API é <strong>stateless</strong>: ela não guarda nada entre turnos. A cada mensagem, o cliente (CLI/SDK)
        reenvia o contexto inteiro — system prompt, a conversa toda, os resultados de tools — e o modelo devolve
        só o delta. Quem guarda e remonta o histórico é sempre o cliente. "Memória", portanto, é só isto:
        o que o cliente decide colocar de volta no contexto a cada turno.
      </p>
      <DiagramaCiclo />
      <ul>
        <li>Janela de contexto de ~200k tokens. Quando enche, entra a <strong>compactação</strong>: o começo da conversa vira um resumo e o detalhe morre.</li>
        <li><strong>Cache de prompt</strong>: um prefixo idêntico ao do turno anterior custa ~10%. Não encurta a janela — só barateia. TTL de 5 minutos.</li>
        <li>Numa sessão padrão, o CLI/SDK injeta automaticamente: system prompt, <code>~/.claude/CLAUDE.md</code>, <code>CLAUDE.md</code> do projeto, <code>MEMORY.md</code> (só o índice — o corpo dos .md é lido sob demanda via tool Read, por decisão do modelo) e metadados de ambiente.</li>
      </ul>

      <h2>2. O que uma sessão do Orion recebe hoje</h2>
      <p>
        O <code>runner.ts</code> usa o Agent SDK (<code>query()</code>) com <code>settingSources: ['user','project']</code> —
        ou seja, a injeção padrão do Claude Code está <strong>ligada</strong>. Por cima, o Orion acrescenta o próprio append.
        Na prática, cada sessão parte deste empilhamento:
      </p>
      <div style={{ margin: '12px 0 16px' }}>
        {camadas.map((c, i) => (
          <div key={c.titulo} style={i === 0 ? { ...camadaEstilo, marginTop: 0 } : camadaEstilo}>
            <strong>{c.titulo}</strong> <span className="muted">— {c.detalhe}</span>
          </div>
        ))}
      </div>

      <h2>3. Os dois sistemas de memória em paralelo</h2>
      <p>
        Existem <strong>duas memórias que não conversam sozinhas</strong>: a memória de arquivos do próprio
        Claude Code (no disco, por pasta de projeto — as barras do caminho viram hífens no nome da pasta) e a
        tabela <code>memories</code> no Postgres do painel. A tabela é a fonte da verdade: é ela que o append,
        a tool <code>orion-memory</code> e o curador usam. A ponte com os arquivos é manual, por botão.
      </p>
      <DiagramaDoisSistemas />
      <table>
        <thead><tr><th></th><th>Lado A — arquivos</th><th>Lado B — Postgres</th></tr></thead>
        <tbody>
          <tr>
            <th>onde vive</th>
            <td><code>~/.claude/projects/&lt;cwd&gt;/memory/</code>, um diretório por projeto</td>
            <td>tabela <code>memories</code> no Postgres do painel</td>
          </tr>
          <tr>
            <th>formato</th>
            <td>.md com frontmatter <code>name</code>, <code>description</code>, <code>type</code> (user | project | reference | feedback)</td>
            <td><code>code</code>, <code>title</code>, <code>summary</code> (máx 144), <code>body_md</code>, <code>level</code> 0 a 4, <code>nota</code> 1 a 10 (só nível 4), <code>rewritable</code>, até 4 keywords, escopo universal/projeto/usuário, <code>embedding</code> vector(384)</td>
          </tr>
          <tr>
            <th>como chega ao Claude</th>
            <td>MEMORY.md (índice) injetado no prompt; o corpo de cada .md só quando o modelo decide ler via tool Read</td>
            <td>níveis 0 e 1 pelo CLAUDE.md nativo; nível 2 com corpo e nível 3 só índice no append (escopo universal + projeto + pessoa); corpo do nível 3 e todo o nível 4 pela tool <code>orion-memory</code></td>
          </tr>
          <tr>
            <th>rastreio</th>
            <td>nenhum</td>
            <td><code>last_accessed_at/session/reason</code> (painel e tool <code>buscar</code>), <code>last_analyzed_at</code>, <code>last_rewritten_at</code></td>
          </tr>
          <tr>
            <th>estado hoje</th>
            <td>poucas memórias por projeto; no Orion, 3 .md + MEMORY.md</td>
            <td>27 memórias: 1 no nível 0, 3 no 1, 5 no 2, 15 no 3, 3 no 4; todas com embedding</td>
          </tr>
        </tbody>
      </table>
      <p>
        <strong>A ponte</strong> são os botões de importar/exportar por projeto (<code>server/routes/memories.ts</code>):
        importar lê os .md do disco e faz upsert por <code>code</code> na tabela (<code>type</code> user ou project vira regra nível 2, o resto vira micro-fato nível 4);
        exportar escreve os .md no disco e <strong>reescreve o MEMORY.md inteiro</strong> a partir da tabela.
      </p>

      <h2>4. Buracos conhecidos</h2>
      <table>
        <thead><tr><th>#</th><th>buraco</th><th>efeito prático</th><th>estado (29/09)</th></tr></thead>
        <tbody>
          {buracos.map((b, i) => (
            <tr key={i}><td>{i + 1}</td><td>{b.buraco}</td><td className="leigo">{b.efeito}</td><td>{b.estado}</td></tr>
          ))}
        </tbody>
      </table>

      <h2>5. Decisões fechadas (28/09/2026)</h2>
      <p>
        A arquitetura decidida é uma pirâmide de <strong>5 níveis</strong>. Quanto mais alto o nível,
        mais ele é injetado nas sessões, e menos gente (ou IA) pode escrever nele.
      </p>
      <table>
        <thead><tr><th>Nível</th><th>O que é</th><th>Quem escreve</th><th>Dinâmica</th><th>Injeção</th></tr></thead>
        <tbody>
          {niveis.map(n => (
            <tr key={n.nivel}>
              <td><strong>{n.nivel}</strong></td>
              <td>{n.oQueE}</td>
              <td>{n.quemEscreve}</td>
              <td>{n.dinamica}</td>
              <td>{n.injecao}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>A escada de escrita (lei)</h3>
      <p>
        Quanto mais alto o nível (mais injetado), menos IA pode escrever. Nível 0: só o Danilo.
        Nível 1: só script (fato mecânico, zero LLM; um fato alucinado sempre injetado envenenaria
        todas as sessões). Níveis 2 a 4: a IA escreve e o curador cuida.
      </p>

      <h3>Mecânica do nível 4 (MVP no estilo "Hermes agent", sem exagero)</h3>
      <ul>
        <li>Micro-memória nasce com <strong>nota 5</strong>, criada por qualquer sessão (captura proativa da constituição).</li>
        <li>Usada ou confirmada em sessão: +1. Sem uso por 30 dias: -1. Nota 0: deletada. Nota 10: o curador propõe promover a nível 3 (decisão permanente); no início, a promoção só acontece com aprovação do Danilo.</li>
        <li><strong>Curador</strong>: agente headless diário, só com as tools de memória. Funde duplicatas nível 4 direto (nota = maior das duas). Todo o resto vira proposta que o Danilo decide no painel: promoção, reescrita, deleção, conflito e reescopo. Nunca toca os níveis 0 e 1.</li>
        <li><strong>Recuperação</strong>: busca híbrida exposta às sessões como tool MCP <code>orion-memory</code> (<code>buscar</code> e <code>salvar</code>). Full-text do Postgres (<code>portuguese</code>) + busca vetorial com pgvector na mesma tabela, fundidas por reciprocal rank fusion (top 8). Os embeddings são locais (<code>multilingual-e5-small</code>, 384 dimensões, sem API externa). Sem a coluna ou sem o modelo, cai no full-text puro sem erro.</li>
        <li>Buscar um micro-fato sobe a nota em 1 (teto 10), no máximo uma vez por dia por memória. O decaimento (-1 após 30 dias sem uso) roda no ciclo do orion-inventory.</li>
        <li>A nota é <strong>exclusiva do nível 4</strong>: acima dele, a importância é o próprio nível. Um plano aprovado se decompõe: a lei sobe para os níveis 0/1/2, a decisão vira nível 3, migalhas úteis viram nível 4.</li>
      </ul>

      <h3>Já implantado (28 e 29/09/2026)</h3>
      <ul>
        <li><strong>Nível 0 no ar</strong>: <code>/home/danilo/.claude/CLAUDE.md</code>, espelhado na aba Memória como <code>constituicao-nivel-0</code>.</li>
        <li><strong>Nível 1 no ar</strong>: 3 arquivos em <code>~danilo/.claude/nivel1/</code> com <code>@import</code>, regenerados de hora em hora por <code>server/nivel1/generate.ts</code> dentro do ciclo do orion-inventory, espelhados como <code>nivel1-*</code>.</li>
        <li>Teste headless confirmou a injeção de ponta a ponta.</li>
        <li><strong>Migração do esquema e tool orion-memory (29/09/2026)</strong>: esquema da tabela <code>memories</code> migrado para <code>level</code>/<code>nota</code> (níveis 0 a 4), tool MCP <code>orion-memory</code> (<code>buscar</code>/<code>salvar</code>) em toda sessão, decaimento diário e UI por nível. Commits <code>2bd5af7</code> e <code>fb61ec8</code>.</li>
        <li><strong>Curador e perfis nível 2 por pessoa (29/09/2026)</strong>: <code>orion-curador.timer</code> diário (03:10 UTC), tools só do MCP <code>curadoria</code> (<code>listar</code>, <code>fundir</code>, <code>propor</code>), tabela <code>curadoria_propostas</code> e aprovação na aba Memória. Commit <code>7df91c0</code>.</li>
        <li><strong>mem21 (29/09/2026)</strong>: a tool salva no escopo da sessão (projeto por padrão; <code>universal</code> e <code>sobre_pessoa</code> são opt-in), busca híbrida com pgvector (container <code>orion-postgres</code> em <code>pgvector/pgvector:pg16-trixie</code>), proposta de reescopo na curadoria e erros visíveis na UI. Commit <code>5cfb02e</code>.</li>
      </ul>

      <h3>Escopo dentro de projeto grande (fechada 29/09/2026)</h3>
      <p>
        Projetos colossais (ex.: Brandspace, onde cada tool interna é um SaaS) não ganham níveis novos:
        profundidade vira pasta e keyword, não camada.
      </p>
      <ol>
        <li><strong>Spec e arquitetura de cada módulo</strong>: arquivos no repositório (<code>docs/</code> do módulo), versionados junto do código. Memória não guarda cópia de doc.</li>
        <li><strong>Regra que toda sessão do módulo precisa</strong>: <code>CLAUDE.md</code> aninhado na subpasta do módulo (o Claude Code carrega nativamente só quando se trabalha ali). O <code>CLAUDE.md</code> da raiz do projeto continua enxuto.</li>
        <li><strong>Decisão fechada de um módulo</strong>: memória nível 3 no grupo do projeto dono, com o nome do módulo no título e nas keywords (ex.: “[editor-ia] Export sempre server-side”).</li>
        <li><strong>Migalhas do módulo</strong>: nível 4 com keyword do módulo.</li>
      </ol>
      <p>
        <strong>Regra de bolso</strong>: vive com o código, repo; obriga toda sessão, <code>CLAUDE.md</code>; decisão, nível 3; migalha, nível 4.
      </p>

      <h2>6. A definir</h2>
      <p>
        Nada aberto depois das decisões de 28 e 29/09. O nível 2 e o curador foram fechados na construção (seção 5).
        A sincronização com a memória do Mac foi descartada: o Mac deixa de ser usado, e a memória vive só na c3.
      </p>
    </div>
  );
}
