import { describe, it, expect } from "vitest";
import { avaliarSinais, passouCooldown, COOLDOWN_MS, type Sinais } from "../server/dash/c3Alerta.js";

const ok: Sinais = { rssGb: 1, swapPct: 10, sessaoMb: { id: "a", v: 5 }, compactacoes: { id: "a", v: 2 }, turnosCortados: 0, quedas: 0 };

describe("avaliarSinais", () => {
  it("nada acima do limiar, nada alerta; nulos são ignorados", () => {
    expect(avaliarSinais(ok)).toEqual([]);
    expect(avaliarSinais({ rssGb: null, swapPct: null, sessaoMb: null, compactacoes: null, turnosCortados: null, quedas: null })).toEqual([]);
  });
  it("limiar é estrito (igual não alerta)", () => {
    expect(avaliarSinais({ ...ok, rssGb: 2.5, swapPct: 60, turnosCortados: 5 })).toEqual([]);
  });
  it("cada sinal acima gera um alerta com número e limiar", () => {
    const a = avaliarSinais({ rssGb: 3, swapPct: 80, sessaoMb: { id: "abcdef123", v: 102 }, compactacoes: { id: "zzzzzzzz1", v: 11 }, turnosCortados: 42, quedas: 18 });
    expect(a.map((x) => x.chave)).toEqual(["rss", "swap", "sessao_grande", "compactacoes", "turnos_cortados", "quedas"]);
    expect(a[0].texto).toContain("3.0 GB");
    expect(a[0].texto).toContain("2.5");
    expect(a[2].texto).toContain("abcdef12");
    expect(a[4].texto).toContain("42");
  });
});

describe("passouCooldown", () => {
  it("sem registro ou registro inválido libera", () => {
    expect(passouCooldown(null, 1000)).toBe(true);
    expect(passouCooldown(NaN, 1000)).toBe(true);
  });
  it("bloqueia antes de 6 h e libera a partir de 6 h", () => {
    expect(passouCooldown(0, COOLDOWN_MS - 1)).toBe(false);
    expect(passouCooldown(0, COOLDOWN_MS)).toBe(true);
  });
});
