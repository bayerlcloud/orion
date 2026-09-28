// Aba estática "Arquitetura de Memória" da página Spec.
// Conteúdo verificado em 28/09/2026 — descreve o estado real do código (runner.ts,
// header.ts, routes/memories.ts) e da memória de arquivos do Claude Code na c3.

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
      <text x="24" y="127" style={tTexto}>· hoje no Orion: 2 memórias + MEMORY.md</text>
      <text x="24" y="144" style={tTexto}>· por pasta de projeto (cwd)</text>
      {/* lado B */}
      <rect x="450" y="10" width="340" height="175" rx="6" style={caixa} />
      <text x="464" y="34" style={tTitulo}>Lado B — tabela memories</text>
      <text x="464" y="52" style={tMono}>Postgres do painel</text>
      <text x="464" y="76" style={tTexto}>· code, title, summary (144), body_md</text>
      <text x="464" y="93" style={tTexto}>· importância: Deus (7) → Rascunho (1)</text>
      <text x="464" y="110" style={tTexto}>· escopo, keywords, rewritable, rastreio</text>
      <text x="464" y="127" style={tTexto}>· hoje: 3 memórias (1 Deus, 2 Aprend. 3)</text>
      <text x="464" y="144" style={tTexto}>· editada pela UI do painel</text>
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
      <text x="780" y="243" textAnchor="end" style={tTexto}>memoriasPara():</text>
      <text x="780" y="259" textAnchor="end" style={tTexto}>só título + resumo, LIMIT 20</text>
    </svg>
  );
}

// Pilha do que uma sessão recebe (na ordem em que entra no contexto)
const camadas: { titulo: string; detalhe: string }[] = [
  { titulo: 'System prompt do Claude Code', detalhe: 'preset claude_code do Agent SDK' },
  { titulo: 'Append do Orion', detalhe: 'buildSystemAppend (server/claude/header.ts): projeto, pasta, criador, aviso de painel multi-pessoa, pt-BR, regras do projeto e até 20 memórias do painel (só título + resumo, por importância)' },
  { titulo: '~/.claude/CLAUDE.md do danilo', detalhe: 'vazio hoje' },
  { titulo: 'CLAUDE.md do projeto + MEMORY.md (índice)', detalhe: "injeção padrão do SDK ligada: settingSources: ['user','project'] no runner.ts" },
  { titulo: 'Histórico da sessão', detalhe: 'retomável via sessionId/resume; arquivos em /home/danilo/.claude/projects/-srv-orion/ — mesmo formato do CLI, compartilhado com plugin/CLI' },
  { titulo: 'Mensagem nova', detalhe: 'prefixada com [Nome] de quem mandou' },
];

const camadaEstilo: React.CSSProperties = {
  border: '1px solid var(--line)', background: 'var(--bg2)', padding: '7px 12px', marginTop: -1, maxWidth: 640,
};

const buracos: { buraco: string; efeito: string }[] = [
  {
    buraco: 'O corpo (body_md) nunca chega ao Claude: a injeção manda só o resumo de 144 caracteres e não há tool nem rota para ele buscar o corpo.',
    efeito: 'Ele só lê o corpo de uma memória se alguém exportar para o disco antes.',
  },
  {
    buraco: 'Export destrutivo no índice: reescreve o MEMORY.md inteiro a partir da tabela.',
    efeito: 'Memória criada pelo Claude nos arquivos e nunca importada some do índice no próximo export.',
  },
  {
    buraco: 'Rastreio de acesso (last_accessed_at/session/reason) só funciona pelo painel.',
    efeito: 'A IA não tem como registrar "acessei X por causa de Y"; o rastreio não reflete o uso real.',
  },
  {
    buraco: '/analyzed e rewritable são stubs.',
    efeito: 'O ciclo "IA analisa e reescreve memórias" está desenhado no schema, mas não construído.',
  },
  {
    buraco: 'Import atribui memória type: user a quem clicou no botão.',
    efeito: 'O dono registrado pode não ser o dono real da memória.',
  },
  {
    buraco: 'Memória de arquivos é por pasta de projeto (cwd).',
    efeito: 'O fisioexpert tem a dele (vazia) e nada da memória do Mac do Bayerl foi levado para a c3.',
  },
];

const aDefinir = [
  'Fonte canônica única: tabela × arquivos × híbrido.',
  'Como o Claude lê o corpo das memórias (tool? rota? export automático?).',
  'Como o Claude registra acesso e aprendizado (fechar o ciclo de rastreio).',
  'Sincronização com a memória do Mac do Bayerl.',
  'Memória por projeto × memória global.',
];

export default function SpecMemoria() {
  return (
    <div className="md">
      <p className="muted small">conteúdo estático, verificado no código em 28/09/2026 — como o Claude "lembra", o que o Orion injeta hoje e o que falta fechar</p>

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
        Hoje existem <strong>duas memórias que não conversam sozinhas</strong>: a memória de arquivos do próprio
        Claude Code (no disco, por pasta de projeto — as barras do caminho viram hífens no nome da pasta) e a
        tabela <code>memories</code> no Postgres do painel. A ponte entre elas é manual, por botão.
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
            <td><code>code</code>, <code>title</code>, <code>summary</code> (máx 144), <code>body_md</code>, 7 níveis de importância (Deus=7 → Aprendizagem 5..1 → Rascunho=1), <code>rewritable</code>, até 4 keywords, escopo universal/projeto/usuário</td>
          </tr>
          <tr>
            <th>como chega ao Claude</th>
            <td>MEMORY.md (índice) injetado no prompt; o corpo de cada .md só quando o modelo decide ler via tool Read</td>
            <td><code>memoriasPara()</code>: universais + do projeto + do usuário criador, LIMIT 20, ordenadas por importância — <strong>só título + resumo</strong> no system append</td>
          </tr>
          <tr>
            <th>rastreio</th>
            <td>nenhum</td>
            <td><code>last_accessed_at/session/reason</code>, <code>last_analyzed_at</code>, <code>last_rewritten_at</code> (via painel)</td>
          </tr>
          <tr>
            <th>estado hoje</th>
            <td>2 memórias no projeto Orion (danilo-role, orion-project) + MEMORY.md</td>
            <td>3 memórias: 1 Deus (orion-central-unico-painel) + 2 Aprendizagem 3 importadas dos .md</td>
          </tr>
        </tbody>
      </table>
      <p>
        <strong>A ponte</strong> são os botões de importar/exportar por projeto (<code>server/routes/memories.ts</code>):
        importar lê os .md do disco e faz upsert por <code>code</code> na tabela (tudo entra como Aprendizagem 3);
        exportar escreve os .md no disco e <strong>reescreve o MEMORY.md inteiro</strong> a partir da tabela.
      </p>

      <h2>4. Buracos conhecidos</h2>
      <table>
        <thead><tr><th>#</th><th>buraco</th><th>efeito prático</th></tr></thead>
        <tbody>
          {buracos.map((b, i) => (
            <tr key={i}><td>{i + 1}</td><td>{b.buraco}</td><td className="leigo">{b.efeito}</td></tr>
          ))}
        </tbody>
      </table>

      <h2>5. A definir</h2>
      <p>
        Bifurcações que serão decididas em conversa, uma por vez. Esta seção vai sendo preenchida
        conforme as decisões forem fechadas.
      </p>
      <ul>
        {aDefinir.map(d => <li key={d}>{d}</li>)}
      </ul>
    </div>
  );
}
