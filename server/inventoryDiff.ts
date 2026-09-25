// Compara dois snapshots do inventário e descreve, em português, o que apareceu, sumiu ou mudou.
// Função pura: sem I/O, tolerante a snapshots parciais ou antigos (campos ausentes contam como vazios).
import type { Inventory, Binario, PacoteGlobal, Unidade, Container, Porta, EventoApt } from './inventory.js';

export type Categoria = 'binario' | 'pacote' | 'servico' | 'container' | 'porta' | 'apt';
export type Tipo = 'adicionado' | 'removido' | 'alterado';
export type Change = { tipo: Tipo; categoria: Categoria; chave: string; rotulo: string; antes?: string; depois?: string };
export type InventoryDiff = { added: Change[]; removed: Change[]; changed: Change[] };

export function emptyDiff(): InventoryDiff {
  return { added: [], removed: [], changed: [] };
}

export function totalChanges(d: InventoryDiff): number {
  return d.added.length + d.removed.length + d.changed.length;
}

export function flattenDiff(d: InventoryDiff): Change[] {
  return [...d.added, ...d.changed, ...d.removed];
}

// "git version 2.43.0" → "2.43.0"; "v22.14.0" → "22.14.0"; "claude 2.1.283 (Claude Code)" → "2.1.283"
export function versaoCurta(v: string | undefined | null): string {
  const s = String(v ?? '').trim();
  const m = s.match(/\d+(?:\.\d+)+[\w.+-]*/);
  return m ? m[0] : s;
}

function lista<T>(x: unknown): T[] {
  return Array.isArray(x) ? (x as T[]) : [];
}

function indexar<T>(items: T[], chave: (t: T) => string): Map<string, T> {
  const m = new Map<string, T>();
  for (const it of items) {
    const k = chave(it);
    if (k && !m.has(k)) m.set(k, it);
  }
  return m;
}

type Regras<T> = {
  categoria: Categoria;
  chave: (t: T) => string;
  mudou?: (a: T, b: T) => boolean;
  adicionado: (t: T) => string;
  removido?: (t: T) => string;
  alterado?: (a: T, b: T) => { rotulo: string; antes: string; depois: string };
};

function comparar<T>(prev: T[], next: T[], r: Regras<T>, out: InventoryDiff): void {
  const antes = indexar(prev, r.chave);
  const depois = indexar(next, r.chave);
  for (const [k, item] of depois) {
    const velho = antes.get(k);
    if (!velho) {
      out.added.push({ tipo: 'adicionado', categoria: r.categoria, chave: k, rotulo: r.adicionado(item) });
    } else if (r.mudou && r.alterado && r.mudou(velho, item)) {
      const a = r.alterado(velho, item);
      out.changed.push({ tipo: 'alterado', categoria: r.categoria, chave: k, rotulo: a.rotulo, antes: a.antes, depois: a.depois });
    }
  }
  if (!r.removido) return;
  for (const [k, item] of antes) {
    if (!depois.has(k)) out.removed.push({ tipo: 'removido', categoria: r.categoria, chave: k, rotulo: r.removido(item) });
  }
}

export function diffInventory(prev: Partial<Inventory> | null | undefined, next: Partial<Inventory> | null | undefined): InventoryDiff {
  const out = emptyDiff();
  const p = prev ?? {};
  const n = next ?? {};

  comparar<Binario>(lista(p.binarios), lista(n.binarios), {
    categoria: 'binario',
    chave: b => b.nome,
    mudou: (a, b) => a.versao !== b.versao,
    adicionado: b => `${b.nome} ${versaoCurta(b.versao)} apareceu`,
    removido: b => `${b.nome} sumiu (era ${versaoCurta(b.versao)})`,
    alterado: (a, b) => ({ rotulo: `${b.nome}: ${versaoCurta(a.versao)} → ${versaoCurta(b.versao)}`, antes: a.versao, depois: b.versao }),
  }, out);

  comparar<PacoteGlobal>(lista(p.pacotes), lista(n.pacotes), {
    categoria: 'pacote',
    chave: x => `${x.gerenciador}:${x.nome}`,
    mudou: (a, b) => a.versao !== b.versao,
    adicionado: x => `${x.gerenciador}: ${x.nome} ${x.versao} instalado`,
    removido: x => `${x.gerenciador}: ${x.nome} removido (era ${x.versao})`,
    alterado: (a, b) => ({ rotulo: `${b.gerenciador}: ${b.nome} ${a.versao} → ${b.versao}`, antes: a.versao, depois: b.versao }),
  }, out);

  comparar<Unidade>(lista(p.servicos), lista(n.servicos), {
    categoria: 'servico',
    chave: u => u.unidade,
    mudou: (a, b) => a.estado !== b.estado,
    adicionado: u => `${u.unidade} apareceu (${u.estado})`,
    removido: u => `${u.unidade} sumiu (era ${u.estado})`,
    alterado: (a, b) => ({ rotulo: `${b.unidade}: ${a.estado} → ${b.estado}`, antes: a.estado, depois: b.estado }),
  }, out);

  comparar<Container>(lista(p.containers), lista(n.containers), {
    categoria: 'container',
    chave: c => c.nome,
    mudou: (a, b) => a.estado !== b.estado || a.imagem !== b.imagem,
    adicionado: c => `container ${c.nome} apareceu (${c.imagem}, ${c.estado})`,
    removido: c => `container ${c.nome} sumiu (era ${c.imagem})`,
    alterado: (a, b) => a.imagem !== b.imagem
      ? { rotulo: `container ${b.nome}: imagem ${a.imagem} → ${b.imagem}`, antes: a.imagem, depois: b.imagem }
      : { rotulo: `container ${b.nome}: ${a.estado} → ${b.estado}`, antes: a.estado, depois: b.estado },
  }, out);

  comparar<Porta>(lista(p.portas), lista(n.portas), {
    categoria: 'porta',
    chave: x => String(x.porta),
    mudou: (a, b) => a.processo !== b.processo,
    adicionado: x => `porta ${x.porta} aberta (${x.processo})`,
    removido: x => `porta ${x.porta} fechada (era ${x.processo})`,
    alterado: (a, b) => ({ rotulo: `porta ${b.porta}: ${a.processo} → ${b.processo}`, antes: a.processo, depois: b.processo }),
  }, out);

  // apt: só o que entrou de novo no log; o que saiu da janela de 7 dias não é "removido".
  comparar<EventoApt>(lista(p.apt), lista(n.apt), {
    categoria: 'apt',
    chave: e => `${e.quando} ${e.acao} ${e.pacote} ${e.versao}`,
    adicionado: e => e.acao === 'upgrade'
      ? `apt: ${e.pacote} atualizado para ${e.versao}`
      : `apt: ${e.pacote} ${e.versao} instalado`,
  }, out);

  return out;
}
