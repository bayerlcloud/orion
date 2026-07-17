/**
 * Blueprints — templates PT-BR de automação para Orion.
 * Cada blueprint tem slots {VARIAVEL} que devem ser preenchidos antes de criar o job.
 */

export const BLUEPRINTS = [
  {
    id: 'resumo-diario',
    name: 'Resumo diário de tarefas',
    description: 'Todo dia num horário fixo, faz um resumo das principais atividades e pendências.',
    category: 'produtividade',
    schedule: '0 8 * * 1-5',
    scheduleLabel: 'Dias úteis às 8h',
    slots: [
      { key: 'AREA_FOCO', label: 'Área de foco', example: 'desenvolvimento de software' },
      { key: 'CONTEXTO', label: 'Contexto adicional (opcional)', example: 'projetos Orion e Brandspace' },
    ],
    taskPrompt: `Bom dia! Faça um resumo executivo das minhas principais pendências e prioridades de hoje na área de {AREA_FOCO}. {CONTEXTO ? "Contexto: {CONTEXTO}." : ""}

Liste:
1. As 3 tarefas mais urgentes
2. O que pode ser adiado
3. Uma sugestão de foco para maximizar produtividade hoje

Seja direto e conciso — formato WhatsApp.`,
  },

  {
    id: 'monitoramento-mercado',
    name: 'Monitoramento de mercado',
    description: 'Analisa tendências e novidades do seu setor regularmente.',
    category: 'inteligência',
    schedule: '0 7 * * 1',
    scheduleLabel: 'Segundas às 7h',
    slots: [
      { key: 'SETOR', label: 'Setor / mercado', example: 'SaaS para agências de marketing' },
      { key: 'CONCORRENTES', label: 'Concorrentes a observar (opcional)', example: 'RD Station, Resultados Digitais' },
    ],
    taskPrompt: `Analise o mercado de {SETOR} e traga um briefing semanal com:

1. Principais tendências desta semana
2. Oportunidades emergentes
3. Ameaças ou riscos relevantes
{CONCORRENTES ? "4. Movimento de concorrentes: {CONCORRENTES}" : ""}

Use linguagem direta e prática. Formato WhatsApp, máximo 300 palavras.`,
  },

  {
    id: 'check-saude',
    name: 'Check de saúde diário',
    description: 'Lembra e incentiva hábitos de saúde ao longo do dia.',
    category: 'bem-estar',
    schedule: '0 12 * * *',
    scheduleLabel: 'Diariamente ao meio-dia',
    slots: [
      { key: 'METAS', label: 'Metas de saúde', example: 'beber 2L de água, caminhar 30 min, meditar' },
    ],
    taskPrompt: `É hora do check de saúde! Envie uma mensagem motivacional e prática me lembrando de: {METAS}.

Inclua:
- Um dado ou fato interessante sobre um dos hábitos
- Dica rápida de como encaixar na rotina
- Emojis para deixar mais leve 😄

Máximo 100 palavras.`,
  },

  {
    id: 'relatorio-vendas',
    name: 'Relatório de métricas de negócio',
    description: 'Analisa e comenta métricas de vendas ou performance regularmente.',
    category: 'negócio',
    schedule: '0 9 * * 1',
    scheduleLabel: 'Segundas às 9h',
    slots: [
      { key: 'METRICAS', label: 'Métricas a acompanhar', example: 'MRR, churn, novos clientes, NPS' },
      { key: 'PRODUTO', label: 'Nome do produto/serviço', example: 'Brandspace' },
    ],
    taskPrompt: `Prepare um comentário executivo sobre as métricas de {PRODUTO}: {METRICAS}.

Estrutura:
1. Headline: o número mais importante desta semana
2. O que está indo bem
3. O que precisa de atenção
4. Uma ação concreta a tomar

Formato executivo, direto, sem rodeios. Adapte ao contexto de SaaS B2B brasileiro.`,
  },

  {
    id: 'lembrete-contato',
    name: 'Lembrete de manutenção de relacionamentos',
    description: 'Lembra de manter contato com clientes, parceiros ou pessoas importantes.',
    category: 'relacionamento',
    schedule: '0 10 * * 3',
    scheduleLabel: 'Quartas às 10h',
    slots: [
      { key: 'TIPO_CONTATO', label: 'Tipo de contato', example: 'clientes ativos, parceiros estratégicos' },
      { key: 'OBJETIVO', label: 'Objetivo do contato', example: 'check-in de satisfação e upsell' },
    ],
    taskPrompt: `É dia de manter relacionamentos! Crie uma mensagem modelo para entrar em contato com {TIPO_CONTATO}.

Objetivo: {OBJETIVO}.

Entregue:
1. Uma mensagem WhatsApp de check-in (máx. 3 linhas, calorosa mas profissional)
2. 2 tópicos de conversa relevantes para o momento atual do mercado
3. Uma pergunta aberta para descobrir oportunidades

Tom: brasileiro, próximo, sem forçar.`,
  },

  {
    id: 'aprendizado-diario',
    name: 'Micro-aprendizado diário',
    description: 'Entrega um conceito ou insight de aprendizado todo dia.',
    category: 'desenvolvimento',
    schedule: '0 6 * * 1-5',
    scheduleLabel: 'Dias úteis às 6h',
    slots: [
      { key: 'AREA_APRENDIZADO', label: 'Área de aprendizado', example: 'marketing digital, empreendedorismo, tecnologia' },
      { key: 'NIVEL', label: 'Nível desejado', example: 'avançado, focado em aplicação prática' },
    ],
    taskPrompt: `Bom dia! Compartilhe um micro-aprendizado de hoje sobre {AREA_APRENDIZADO} ({NIVEL}).

Formato:
🧠 **Conceito:** [nome do conceito em 1 linha]
📖 **O que é:** [explicação em 2-3 frases]
💡 **Como aplicar:** [ação concreta para hoje ou esta semana]
🔗 **Para saber mais:** [termo para pesquisar]

Escolha algo pouco óbvio, que realmente agregue valor.`,
  },

  {
    id: 'revisao-semanal',
    name: 'Revisão semanal e planejamento',
    description: 'Revisão estruturada da semana e planejamento da próxima.',
    category: 'produtividade',
    schedule: '0 17 * * 5',
    scheduleLabel: 'Sextas às 17h',
    slots: [
      { key: 'PROJETOS_ATIVOS', label: 'Projetos ativos a revisar', example: 'Brandspace, FisioExpert, Orion' },
      { key: 'METAS_SEMANA', label: 'Metas semanais principais', example: 'lançar feature X, fechar 2 vendas' },
    ],
    taskPrompt: `É hora da revisão semanal! Me ajude a estruturar o encerramento desta semana e o planejamento da próxima.

Projetos: {PROJETOS_ATIVOS}
Metas desta semana: {METAS_SEMANA}

Perguntas de reflexão:
1. O que avancei esta semana? (liste 3 conquistas)
2. O que ficou pendente e por quê?
3. Qual é a meta #1 da próxima semana?
4. O que posso delegar ou eliminar?

Seja honesto e direto. Formato de lista, máx. 200 palavras.`,
  },

  {
    id: 'monitoramento-script',
    name: 'Monitoramento via script + análise',
    description: 'Executa um script de coleta de dados e pede ao Orion que analise os resultados.',
    category: 'técnico',
    schedule: '0 * * * *',
    scheduleLabel: 'A cada hora (configurar)',
    noAgent: false,
    slots: [
      { key: 'SCRIPT_PATH', label: 'Caminho do script (relativo a scripts/)', example: 'check-service.sh' },
      { key: 'O_QUE_ANALISAR', label: 'O que o Orion deve analisar nos dados', example: 'alertas de erro ou degradação de performance' },
    ],
    script: '{SCRIPT_PATH}',
    taskPrompt: `Analise os dados coletados pelo script de monitoramento e identifique: {O_QUE_ANALISAR}.

Se tudo estiver normal, responda exatamente: [SILENT]
Se houver algo relevante, envie um alerta claro com:
- O que foi detectado
- Severidade (baixa/média/alta)
- Ação recomendada

Seja objetivo. Sem verbose desnecessário.`,
  },
]

export function getBlueprintById(id) {
  return BLUEPRINTS.find(b => b.id === id) ?? null
}

export function fillBlueprint(blueprint, slotValues) {
  let prompt = blueprint.taskPrompt
  let scriptPath = blueprint.script ?? null

  for (const [key, value] of Object.entries(slotValues)) {
    prompt = prompt.replaceAll(`{${key}}`, value)
    if (scriptPath) scriptPath = scriptPath.replaceAll(`{${key}}`, value)
  }

  // remove slots não preenchidos (opcionais)
  prompt = prompt.replace(/\{[A-Z_]+\}/g, '')
  // limpar expressões ternárias não processadas (simplificado)
  prompt = prompt.replace(/\{[^}]+ \? "[^"]*" : "[^"]*"\}/g, '')

  return { prompt: prompt.trim(), scriptPath }
}
