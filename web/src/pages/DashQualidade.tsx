import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatTokens } from '../claude/mapper';

// Espelha server/dash/qualidade.ts (QualidadeResposta).
type Linha = { nome: string; sessoes: number; turnos: number; tokens_in: number; tokens_out: number; compactacoes: number; cortados: number; publicacoes: number; erros: number };
type Dados = { dias: 7 | 30; por_projeto: Linha[]; por_pessoa: Linha[]; total: Linha };

function Tabela({ titulo, rotulo, linhas, total }: { titulo: string; rotulo: string; linhas: Linha[]; total: Linha }) {
  return (
    <div className="dash-bloco">
      <h3><span>{titulo}</span></h3>
      <table className="dash-table">
        <thead>
          <tr>
            <th>{rotulo}</th><th className="num">sessões</th><th className="num">turnos</th><th className="num">tokens ent.</th><th className="num">tokens saída</th>
            <th className="num" title="compactações de contexto">compact.</th><th className="num" title="turnos cortados por restart do servidor">cortados</th>
            <th className="num">publicações</th><th className="num">erros</th>
          </tr>
        </thead>
        <tbody>
          {[...linhas, total].map(r => (
            <tr key={r.nome} className={r === total ? 'failed' : undefined}>
              <td>{r.nome}</td><td className="num">{r.sessoes}</td><td className="num">{r.turnos}</td>
              <td className="num">{formatTokens(r.tokens_in)}</td><td className="num">{formatTokens(r.tokens_out)}</td>
              <td className="num">{r.compactacoes}</td><td className="num">{r.cortados}</td><td className="num">{r.publicacoes}</td><td className="num">{r.erros}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function DashQualidade() {
  const [dias, setDias] = useState<7 | 30>(7);
  const [d, setD] = useState<Dados | null>(null);
  const [erro, setErro] = useState('');
  useEffect(() => {
    let vivo = true;
    api<Dados>(`/api/dash/qualidade?dias=${dias}`).then(r => { if (vivo) { setD(r); setErro(''); } }).catch(e => { if (vivo) setErro(String(e?.message ?? e)); });
    return () => { vivo = false; };
  }, [dias]);
  return (
    <section>
      <h2>
        <span>Custo e qualidade</span>
        <span className="muted"> sessões tocadas nos últimos{' '}
          <select value={dias} onChange={e => setDias(Number(e.target.value) as 7 | 30)}><option value={7}>7 dias</option><option value={30}>30 dias</option></select>
        </span>
      </h2>
      {erro && <div className="vazio">não foi possível carregar: {erro}</div>}
      {!d && !erro && <div className="vazio">carregando</div>}
      {d && (
        <div className="dash-two">
          <Tabela titulo="por projeto" rotulo="projeto" linhas={d.por_projeto} total={d.total} />
          <Tabela titulo="por pessoa" rotulo="pessoa" linhas={d.por_pessoa} total={d.total} />
        </div>
      )}
    </section>
  );
}
