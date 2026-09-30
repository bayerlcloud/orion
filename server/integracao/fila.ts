/**
 * Fila de integração automática (spec 2026-09-30-preview-design, Parte 2): um job por vez por
 * projeto, projetos diferentes em paralelo. Em memória: um reinício do Orion perde o que estava na
 * fila, mas o commit já está na branch e sobe no fim do próximo turno da sessão.
 */
export class FilaIntegracao {
  private cauda = new Map<number, Promise<void>>();
  private contagem = new Map<number, number>();

  enfileirar(projetoId: number, job: () => Promise<void>): Promise<void> {
    this.contagem.set(projetoId, this.tamanho(projetoId) + 1);
    const anterior = this.cauda.get(projetoId) ?? Promise.resolve();
    const atual = anterior.then(job).finally(() => {
      const n = this.tamanho(projetoId) - 1;
      if (n > 0) this.contagem.set(projetoId, n);
      else { this.contagem.delete(projetoId); if (this.cauda.get(projetoId) === seguro) this.cauda.delete(projetoId); }
    });
    // A cauda nunca rejeita: erro de um job não trava os próximos. Quem enfileirou recebe o erro.
    const seguro = atual.catch(() => {});
    this.cauda.set(projetoId, seguro);
    return atual;
  }

  tamanho(projetoId: number): number {
    return this.contagem.get(projetoId) ?? 0;
  }
}
