import { useEffect, useMemo, useRef, useState } from 'react';
import { claudeApi, type OutputStyleInfo } from './api';
import { X } from './icons';

/**
 * "Aba Claude" — assistente "Build a custom style" dos output styles (PARIDADE-marketplace.md).
 * Porta o wizard real (webview v2.1.283, componente QW0 + tabela de strings r6): 4 etapas na MESMA
 * ordem (`ne=["name","description","instructions","save"]`), com os mesmos textos em pt-BR:
 * "Step X of Y" → "Etapa X de 4"; help do nome "Shows in the Output styles menu and becomes the
 * file name" → "Aparece no menu de estilos de saída e vira o nome do arquivo"; placeholder
 * "Diagrams first" mantido; validações de nome/descrição/instruções idênticas (server/tools/
 * outputStyles.ts valida de novo no servidor); checkbox "Include the coding instructions"
 * (keep-coding-instructions, chave REAL do frontmatter do CLI); "Switch to this style now" →
 * "Trocar para este estilo agora".
 *
 * Diferença deliberada: o "Save to Project/User" real virou UM destino só, o catálogo compartilhado
 * do Orion (/srv/claude/catalog/output-styles/<slug>.md, com criado-por registrado) — documentado
 * em PARIDADE-marketplace.md. O menu de ESCOLHA de estilo fica no Composer (seletor "Estilo",
 * strings "Select an output style"/"No output styles available" traduzidas lá).
 */
export type BuildStyleProps = {
  open: boolean;
  onClose: () => void;
  /** Slugs/nomes já existentes (embutidos + catálogo) — pra validação ao vivo do nome. */
  existing: OutputStyleInfo[];
  /** Chamado depois de salvar; `switchNow` = o usuário pediu "Trocar para este estilo agora". */
  onSaved: (slug: string, switchNow: boolean) => void;
  /** Há uma sessão de verdade aberta? Sem ela, o "Trocar agora" não tem onde aplicar e fica de fora. */
  canSwitchNow: boolean;
};

const ETAPAS = ['name', 'description', 'instructions', 'save'] as const;
const RE_PROIBIDOS = /[/\\:*?"<>|]/;

/** Mesmas regras do servidor (server/tools/outputStyles.ts), replicadas pro feedback ao vivo. */
function validarNomeLocal(nome: string, existentes: string[]): string | null {
  const n = nome.trim();
  if (!n) return 'Digite um nome';
  if (RE_PROIBIDOS.test(n) || n.includes('---')) return 'O nome não pode conter / \\ : * ? " < > | nem ---';
  const baixo = new Set(existentes.map(e => e.toLowerCase()));
  if (baixo.has(n.toLowerCase()) || baixo.has(slugLocal(n))) return `${n} já é o nome de um estilo. Escolha outro.`;
  return null;
}
function slugLocal(nome: string): string {
  return nome.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
}

export default function BuildStyleDialog({ open, onClose, existing, onSaved, canSwitchNow }: BuildStyleProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [etapa, setEtapa] = useState(0);
  const [nome, setNome] = useState('');
  const [descricao, setDescricao] = useState('');
  const [instrucoes, setInstrucoes] = useState('');
  const [manterCodigo, setManterCodigo] = useState(true);
  const [trocarAgora, setTrocarAgora] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [estado, setEstado] = useState<{ kind: 'idle' } | { kind: 'exists'; slug: string } | { kind: 'saved'; slug: string } | { kind: 'error'; msg: string }>({ kind: 'idle' });

  useEffect(() => {
    if (!open) return;
    setEtapa(0); setNome(''); setDescricao(''); setInstrucoes(''); setManterCodigo(true); setTrocarAgora(true); setEstado({ kind: 'idle' });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      onClose();
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  const nomesExistentes = useMemo(() => existing.map(e => e.nome), [existing]);
  const erroNome = nome ? validarNomeLocal(nome, nomesExistentes) : null;
  const erroDescricao = descricao.includes('---') ? 'A descrição não pode conter ---' : null;
  const passo = ETAPAS[etapa] ?? 'name';
  const podeAvancar = passo === 'name' ? !!nome.trim() && !erroNome
    : passo === 'description' ? !erroDescricao
    : passo === 'instructions' ? !!instrucoes.trim()
    : true;

  async function salvar(substituir = false) {
    if (salvando) return;
    setSalvando(true); setEstado({ kind: 'idle' });
    try {
      const r = await claudeApi.createOutputStyle({ nome: nome.trim(), descricao: descricao.trim(), instrucoes: instrucoes.trim(), manter_instrucoes_codigo: manterCodigo, substituir });
      setEstado({ kind: 'saved', slug: r.slug });
      onSaved(r.slug, canSwitchNow && trocarAgora);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'erro desconhecido';
      // 409 do servidor: "Já existe um arquivo de estilo chamado X." — vira a oferta de Substituir.
      if (msg.startsWith('Já existe um arquivo de estilo')) setEstado({ kind: 'exists', slug: slugLocal(nome) });
      else setEstado({ kind: 'error', msg });
    } finally { setSalvando(false); }
  }

  if (!open) return null;
  const salvo = estado.kind === 'saved';
  return (
    <div className="cc-agentmap-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cc-agentmap cc-style-dialog" role="dialog" aria-label="Construir um estilo personalizado" tabIndex={-1}>
        <div className="cc-agentmap-head">
          <div className="cc-agentmap-headtext">
            <div className="cc-agentmap-title">Construir um estilo personalizado</div>
            <div className="cc-agentmap-subtitle">Etapa {Math.min(etapa + 1, 4)} de 4</div>
          </div>
          <button ref={closeRef} type="button" className="cc-icon" onClick={onClose} title="Fechar (Esc)"><X size={14} /></button>
        </div>
        <div className="cc-agentmap-body cc-style-body">
          {passo === 'name' && (
            <div className="cc-style-field">
              <label htmlFor="style-nome">Nome</label>
              <input id="style-nome" autoFocus value={nome} placeholder="Diagrams first" onChange={e => setNome(e.target.value)} />
              <div className="cc-style-help">Aparece no menu de estilos de saída e vira o nome do arquivo{nome.trim() && !erroNome ? <span className="cc-mono"> ({slugLocal(nome)}.md)</span> : null}</div>
              {erroNome && <div className="cc-style-error">{erroNome}</div>}
            </div>
          )}
          {passo === 'description' && (
            <div className="cc-style-field">
              <label htmlFor="style-desc">Descrição</label>
              <input id="style-desc" autoFocus value={descricao} placeholder="Toda explicação começa com um diagrama" onChange={e => setDescricao(e.target.value)} />
              <div className="cc-style-help">Opcional. Uma linha sobre o que o estilo faz</div>
              {erroDescricao && <div className="cc-style-error">{erroDescricao}</div>}
            </div>
          )}
          {passo === 'instructions' && (
            <div className="cc-style-field">
              <label htmlFor="style-instr">Instruções</label>
              <textarea id="style-instr" autoFocus rows={6} value={instrucoes}
                placeholder="Ao explicar código, arquitetura ou fluxo de dados, comece com um diagrama e depois explique em prosa."
                onChange={e => setInstrucoes(e.target.value)} />
              <div className="cc-style-help">Entram no prompt de sistema do Claude sempre que este estilo está ativo</div>
              <label className="cc-style-check">
                <input type="checkbox" checked={manterCodigo} onChange={e => setManterCodigo(e.target.checked)} />
                Incluir as instruções de código
              </label>
              <div className="cc-style-help">Mantém as instruções padrão de programação junto do seu estilo. Desligue para estilos que não são sobre escrever código.</div>
            </div>
          )}
          {passo === 'save' && (
            <div className="cc-style-field">
              <label>Salvar em</label>
              <div className="cc-style-save-dest">
                <b>Catálogo compartilhado</b>
                <span className="cc-style-help">/srv/claude/catalog/output-styles/{slugLocal(nome) || '…'}.md: visível pra todo mundo no painel, com você como criador</span>
              </div>
              {canSwitchNow && !salvo && (
                <label className="cc-style-check">
                  <input type="checkbox" checked={trocarAgora} onChange={e => setTrocarAgora(e.target.checked)} />
                  Trocar para este estilo agora
                </label>
              )}
              {estado.kind === 'exists' && <div className="cc-style-error">Já existe um arquivo de estilo chamado {estado.slug}.</div>}
              {estado.kind === 'error' && <div className="cc-style-error">Não deu para salvar o estilo. {estado.msg}</div>}
              {salvo && <div className="cc-style-saved">Salvo. O estilo já aparece no menu de estilos de saída{canSwitchNow && trocarAgora ? ' e esta sessão trocou pra ele' : ''}.</div>}
            </div>
          )}
        </div>
        <div className="cc-style-actions">
          {etapa > 0 && !salvo && <button type="button" className="cc-btn" onClick={() => setEtapa(x => Math.max(0, x - 1))}>Voltar</button>}
          <span className="cc-spacer" />
          {passo !== 'save' && <button type="button" className="cc-btn cc-btn-primary" disabled={!podeAvancar} onClick={() => setEtapa(x => x + 1)}>Avançar</button>}
          {passo === 'save' && !salvo && estado.kind !== 'exists' && (
            <button type="button" className="cc-btn cc-btn-primary" disabled={salvando} onClick={() => void salvar(false)}>{salvando ? 'Salvando…' : 'Salvar'}</button>
          )}
          {passo === 'save' && !salvo && estado.kind === 'exists' && (
            <button type="button" className="cc-btn cc-btn-primary" disabled={salvando} onClick={() => void salvar(true)}>{salvando ? 'Salvando…' : 'Substituir'}</button>
          )}
          {salvo && <button type="button" className="cc-btn cc-btn-primary" onClick={onClose}>Concluído</button>}
        </div>
      </div>
    </div>
  );
}
