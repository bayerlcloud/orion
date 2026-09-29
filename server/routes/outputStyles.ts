/**
 * Rotas do catálogo de output styles (ver server/tools/outputStyles.ts pra investigação e decisão
 * de arquitetura, e web/src/claude/OutputStyles.tsx pra UI do assistente). A troca de estilo POR
 * SESSÃO fica em server/routes/claude.ts (POST /api/claude/sessions/:id/output-style), junto das
 * irmãs de modo/modelo/esforço — precisa do runner, que só existe no escopo de lá.
 *
 * Criar estilo: QUALQUER usuário autenticado (a UI real deixa qualquer um construir estilo; o
 * catálogo registra `criado-por`). Substituir um estilo existente: só o admin ou o próprio criador
 * — é a parte destrutiva de mudar o catálogo compartilhado.
 */
import type { FastifyInstance } from 'fastify';
import {
  ESTILOS_DIR, gravarEstilo, lerEstilos, montarMd, slugDeNome, validarDescricao, validarInstrucoes, validarNome,
} from '../tools/outputStyles.js';

export async function outputStylesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'não autenticado' });
  });

  /** Estilos disponíveis: embutidos do CLI + customs do catálogo. */
  app.get('/api/claude/output-styles', async () => {
    return { styles: await lerEstilos(), catalogo_dir: ESTILOS_DIR };
  });

  /**
   * Cria (ou substitui) um estilo custom — o "Build a custom style" real. O nome digitado vira o
   * arquivo (`slugDeNome`); o corpo é frontmatter + instruções (ver montarMd). `substituir: true`
   * pula a checagem de "já existe" — só admin ou o criador registrado do estilo.
   */
  app.post<{ Body: { nome?: string; descricao?: string; instrucoes?: string; manter_instrucoes_codigo?: boolean; substituir?: boolean } }>('/api/claude/output-styles', async (req, reply) => {
    const b = req.body ?? {};
    const nome = (b.nome ?? '').trim();
    const descricao = (b.descricao ?? '').trim();
    const instrucoes = (b.instrucoes ?? '').trim();
    const substituir = b.substituir === true;
    const existentes = await lerEstilos();
    const slug = slugDeNome(nome);
    const jaExiste = existentes.find(e => e.nome === slug);
    const erro = (substituir && jaExiste ? null : validarNome(nome, existentes.map(e => e.nome)))
      ?? validarDescricao(descricao) ?? validarInstrucoes(instrucoes);
    if (erro) return reply.code(400).send({ error: erro });
    if (jaExiste) {
      if (jaExiste.builtin) return reply.code(400).send({ error: `${nome} já é o nome de um estilo. Escolha outro.` });
      if (!substituir) return reply.code(409).send({ error: `Já existe um arquivo de estilo chamado ${slug}.`, slug });
      if (req.user!.role !== 'owner' && jaExiste.criado_por !== req.user!.email) {
        return reply.code(403).send({ error: 'só o admin ou quem criou o estilo pode substituí-lo' });
      }
    }
    const md = montarMd({ nome, descricao, instrucoes, manterInstrucoesCodigo: b.manter_instrucoes_codigo !== false }, req.user!.email);
    try {
      await gravarEstilo(slug, md);
    } catch (e) {
      return reply.code(500).send({ error: `Não deu para salvar o estilo. ${(e as Error).message}` });
    }
    app.log.info(`output style ${jaExiste ? 'substituído' : 'criado'} por ${req.user!.email}: ${slug}`);
    return reply.code(201).send({ ok: true, slug });
  });
}
