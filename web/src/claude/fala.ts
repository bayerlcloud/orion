// Funções puras do Ouvir (sem React): o teste roda em worktree sem node_modules.

/** Markdown vira texto falável: bloco de código não é lido, links ficam só com o rótulo, símbolos somem. */
export function paraFala(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' (bloco de código) ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*\|?[-:| ]+\|[-:| ]*$/gm, '')
    .replace(/[|*_#>~]/g, ' ')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Pedaços curtos: o Chrome corta falas longas (~15 s) e trocar a velocidade recomeça só o pedaço atual. */
export function pedacos(texto: string): string[] {
  const out: string[] = [];
  for (const par of texto.split(/\n+/)) {
    for (const frase of par.match(/[^.!?;:]+[.!?;:]*/g) ?? []) {
      const f = frase.trim();
      if (!f) continue;
      const last = out[out.length - 1];
      if (last && last.length + f.length < 200 && !/[.!?]$/.test(last)) out[out.length - 1] = `${last} ${f}`;
      else out.push(f);
    }
  }
  return out;
}
