import { useEffect, useRef, useState } from 'react';
import { claudeApi, type CatalogPlugin, type MarketplaceInfo, type McpServerInfo } from './api';
import { Check, Sync, X } from './icons';

/**
 * "Aba Claude" — marketplace de plugins + servidores MCP (PARIDADE-marketplace.md). Porta o diálogo
 * "Manage Plugins" da extensão real (webview v2.1.283: overlay+dialog com abas "Plugins" e
 * "Marketplaces", formulário addMarketplaceForm com placeholder "GitHub repo, URL, or path…",
 * empty state "No marketplaces configured. Add one above to discover plugins.", ações com
 * aria-label "Refresh marketplace"/"Remove marketplace", aviso de confiança do scopeSelector) e a
 * lista de servidores MCP (mcpServerList/mcpServerItem/serverDetail com "← Back to list") — TRÊS
 * abas num painel só, mesmo precedente do SkillsHooksPanel (dois diálogos reais viraram um painel
 * com abas, documentado lá).
 *
 * Diferenças deliberadas (ver PARIDADE-marketplace.md): plugins instalados vivem no CATÁLOGO do
 * Orion e o liga/desliga é POR PESSOA (skill_prefs, chave plugin:<nome>) em vez do settings.json
 * do usuário; instalar/adicionar/remover/atualizar marketplace é só do admin (isOwner) porque muda
 * o catálogo compartilhado; e não há "Restart Claude" — cada sessão nova já nasce com a composição
 * recalculada.
 */
export type MarketplaceProps = { open: boolean; onClose: () => void; isOwner: boolean };

type Tab = 'plugins' | 'marketplaces' | 'mcp';

function PluginRow({ p, isOwner, saving, onToggle }: { p: CatalogPlugin; isOwner: boolean; saving: boolean; onToggle: (escopo: 'eu' | 'todos', ligada: boolean) => void }) {
  const partes = [
    p.versao ? `v${p.versao}` : null,
    p.skills ? `${p.skills} skill${p.skills > 1 ? 's' : ''}` : null,
    p.commands ? `${p.commands} command${p.commands > 1 ? 's' : ''}` : null,
    p.agents ? `${p.agents} agent${p.agents > 1 ? 's' : ''}` : null,
    p.hooks ? 'hooks' : null,
  ].filter(Boolean);
  return (
    <div className="cc-skill-row">
      <span className={`cc-mkt-dot ${p.efetiva ? 'is-on' : 'is-off'}`} title={p.efetiva ? 'Habilitado pra você' : 'Desabilitado pra você'} />
      <div className="cc-skill-main">
        <div className="cc-skill-name">{p.nome}</div>
        {p.descricao && <div className="cc-skill-desc" title={p.descricao}>{p.descricao}</div>}
        <div className="cc-mkt-meta">{partes.join(' · ')}{p.autor ? ` · de ${p.autor}` : ''}</div>
      </div>
      {isOwner && (
        <button type="button" className={`cc-skill-toggle ${p.ligada_todos === false ? 'is-off' : 'is-on'}`} disabled={saving}
          title="Padrão pra todo mundo (só o admin muda); a escolha de cada pessoa vale por cima"
          onClick={() => onToggle('todos', p.ligada_todos === false)}>
          Todos: {p.ligada_todos === false ? 'off' : 'on'}
        </button>
      )}
      <button type="button" className={`cc-skill-toggle ${p.efetiva ? 'is-on' : 'is-off'}`} disabled={saving}
        title={p.efetiva ? 'Clique para desabilitar pra você' : 'Clique para habilitar pra você'}
        onClick={() => onToggle('eu', !p.efetiva)}>
        {saving ? 'Salvando…' : p.efetiva ? 'Habilitado' : 'Desabilitado'}
      </button>
    </div>
  );
}

function PluginsTab({ isOwner }: { isOwner: boolean }) {
  const [plugins, setPlugins] = useState<CatalogPlugin[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [busca, setBusca] = useState('');
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    claudeApi.marketplacePlugins()
      .then(r => { if (vivo) setPlugins(r.plugins); })
      .catch((e: Error) => { if (vivo) setErro(e.message || 'falha ao carregar plugins'); });
    return () => { vivo = false; };
  }, []);

  async function toggle(p: CatalogPlugin, escopo: 'eu' | 'todos', ligada: boolean) {
    setSaving(p.nome);
    try {
      const r = await claudeApi.setPluginEnabled(p.nome, escopo, ligada);
      setPlugins(ps => ps && ps.map(x => x.nome === p.nome ? { ...x, ligada_todos: r.todos, ligada_eu: r.eu, efetiva: r.efetiva } : x));
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'falha ao salvar');
    } finally { setSaving(null); }
  }

  if (erro) return <div className="cc-banner">{erro}</div>;
  if (!plugins) return <div className="cc-skillshooks-empty">Carregando plugins…</div>;
  const filtro = busca.trim().toLowerCase();
  const lista = filtro ? plugins.filter(p => `${p.nome} ${p.descricao}`.toLowerCase().includes(filtro)) : plugins;
  return (
    <>
      <div className="cc-search cc-mkt-search">
        <input placeholder="Buscar plugin…" value={busca} onChange={e => setBusca(e.target.value)} />
      </div>
      {lista.length === 0 && (
        <div className="cc-skillshooks-empty">
          <p>{plugins.length === 0 ? 'Nenhum plugin no catálogo ainda.' : 'Nenhum plugin bate com a busca.'}</p>
          {plugins.length === 0 && <p className="cc-muted">Adicione um marketplace na aba ao lado e instale um plugin de lá{isOwner ? '' : ' (só o admin instala)'}.</p>}
        </div>
      )}
      {lista.map(p => <PluginRow key={p.nome} p={p} isOwner={isOwner} saving={saving === p.nome} onToggle={(escopo, ligada) => void toggle(p, escopo, ligada)} />)}
      <div className="cc-mkt-foot">O liga/desliga vale só pra VOCÊ (composição por pessoa); o padrão "Todos" é do admin. Skills individuais de cada plugin continuam na aba Tools.</div>
    </>
  );
}

function MarketplacesTab({ isOwner }: { isOwner: boolean }) {
  const [mkts, setMkts] = useState<MarketplaceInfo[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [fonte, setFonte] = useState('');
  const [adicionando, setAdicionando] = useState(false);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [confirmarInstalar, setConfirmarInstalar] = useState<{ plugin: string; marketplace: string } | null>(null);

  async function recarregar() {
    try { setMkts((await claudeApi.marketplaces()).marketplaces); }
    catch (e) { setErro(e instanceof Error ? e.message : 'falha ao carregar marketplaces'); }
  }
  useEffect(() => { void recarregar(); }, []);

  async function adicionar() {
    if (!fonte.trim() || adicionando) return;
    setAdicionando(true); setErro(null); setAviso(null);
    try { await claudeApi.addMarketplace(fonte.trim()); setFonte(''); await recarregar(); }
    catch (e) { setErro(e instanceof Error ? e.message : 'falha ao adicionar'); }
    finally { setAdicionando(false); }
  }
  async function atualizar(nome: string) {
    setOcupado(nome); setErro(null); setAviso(null);
    try { await claudeApi.refreshMarketplace(nome); setAviso(`Marketplace ${nome} atualizado da fonte.`); await recarregar(); }
    catch (e) { setErro(e instanceof Error ? e.message : 'falha ao atualizar'); }
    finally { setOcupado(null); }
  }
  async function remover(nome: string) {
    setOcupado(nome); setErro(null); setAviso(null);
    try { await claudeApi.removeMarketplace(nome); await recarregar(); }
    catch (e) { setErro(e instanceof Error ? e.message : 'falha ao remover'); }
    finally { setOcupado(null); }
  }
  async function instalar(plugin: string, marketplace: string) {
    setConfirmarInstalar(null);
    setOcupado(`${plugin}@${marketplace}`); setErro(null); setAviso(null);
    try {
      await claudeApi.installPlugin(plugin, marketplace);
      setAviso(`${plugin} instalado no catálogo. Habilite/desabilite por pessoa na aba Plugins.`);
      await recarregar();
    } catch (e) { setErro(e instanceof Error ? e.message : 'falha ao instalar'); }
    finally { setOcupado(null); }
  }

  if (erro && !mkts) return <div className="cc-banner">{erro}</div>;
  if (!mkts) return <div className="cc-skillshooks-empty">Carregando marketplaces…</div>;
  return (
    <>
      {erro && <div className="cc-banner">{erro}</div>}
      {aviso && <div className="cc-mkt-ok">{aviso}</div>}
      {isOwner && (
        <div className="cc-mkt-addform">
          <input placeholder="Repo do GitHub (dono/repo) ou URL git https…" value={fonte}
            onChange={e => setFonte(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void adicionar(); }} />
          <button type="button" className="cc-btn cc-btn-primary" disabled={!fonte.trim() || adicionando} onClick={() => void adicionar()}>
            {adicionando ? 'Adicionando…' : 'Adicionar'}
          </button>
        </div>
      )}
      {mkts.length === 0 && (
        <div className="cc-skillshooks-empty">Nenhum marketplace configurado. {isOwner ? 'Adicione um acima para descobrir plugins.' : 'Peça pro admin adicionar um.'}</div>
      )}
      {mkts.map(m => (
        <div key={m.nome} className="cc-mkt-marketplace">
          <div className="cc-skill-row">
            <div className="cc-skill-main">
              <div className="cc-skill-name">
                {m.nome}
                {m.oficial && <span className="cc-mkt-official" title="Marketplace oficial do Claude Code"><Check size={12} /></span>}
              </div>
              {m.descricao && <div className="cc-skill-desc">{m.descricao}</div>}
              <div className="cc-mkt-meta">
                Fonte: {m.fonte_url ? <a href={m.fonte_url} target="_blank" rel="noopener noreferrer">{m.fonte}</a> : m.fonte}
                {m.atualizado ? ` · atualizado ${new Date(m.atualizado).toLocaleDateString('pt-BR')}` : ''}
              </div>
            </div>
            {isOwner && (
              <span className="cc-mkt-actions">
                <button type="button" className="cc-icon" aria-label="Atualizar marketplace" title="Atualizar marketplace da fonte" disabled={ocupado !== null} onClick={() => void atualizar(m.nome)}><Sync size={14} /></button>
                <button type="button" className="cc-icon" aria-label={ocupado === m.nome ? 'Removendo…' : 'Remover marketplace'} title="Remover marketplace" disabled={ocupado !== null} onClick={() => void remover(m.nome)}><X size={14} /></button>
              </span>
            )}
          </div>
          {m.plugins.length > 0 && (
            <div className="cc-mkt-available">
              <div className="cc-mkt-section">Disponíveis</div>
              {m.plugins.map(p => (
                <div key={p.name} className="cc-mkt-avail-row">
                  <div className="cc-skill-main">
                    <div className="cc-mkt-avail-name">{p.name}{p.category ? <span className="cc-mkt-cat">{p.category}</span> : null}</div>
                    {p.description && <div className="cc-skill-desc" title={p.description}>{p.description}</div>}
                  </div>
                  {p.instalado
                    ? <span className="cc-mkt-installed">no catálogo</span>
                    : isOwner && (
                      <button type="button" className="cc-btn" disabled={ocupado !== null} onClick={() => setConfirmarInstalar({ plugin: p.name, marketplace: m.nome })}>
                        {ocupado === `${p.name}@${m.nome}` ? 'Instalando…' : 'Instalar'}
                      </button>
                    )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      {/* Confirmação com o aviso de confiança do scopeSelector real, traduzido — a instalação roda
          `claude plugin install` no servidor, então a aprovação explícita fica AQUI (só admin). */}
      {confirmarInstalar && (
        <div className="cc-permrules-overlay-inner" onClick={e => { if (e.target === e.currentTarget) setConfirmarInstalar(null); }}>
          <div className="cc-permrules-confirm">
            <div className="cc-permrules-confirm-title">Instalar {confirmarInstalar.plugin} no catálogo?</div>
            <div className="cc-permrules-confirm-rule">
              Confie no plugin antes de instalar, atualizar ou usar. A Anthropic não controla que servidores MCP, arquivos ou outros
              programas fazem parte de um plugin, e não garante que funcionem como prometido nem que não mudem depois.
              Se o marketplace declarar um comando de instalação, o Claude Code recusa e o erro aparece aqui (nunca aceitamos comando automático).
            </div>
            <div className="cc-permrules-confirm-actions">
              <button type="button" className="cc-btn" onClick={() => setConfirmarInstalar(null)}>Cancelar</button>
              <button type="button" className="cc-btn cc-btn-primary" onClick={() => void instalar(confirmarInstalar.plugin, confirmarInstalar.marketplace)}>Instalar</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function McpTab() {
  const [servers, setServers] = useState<McpServerInfo[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [detalhe, setDetalhe] = useState<McpServerInfo | null>(null);

  useEffect(() => {
    let vivo = true;
    claudeApi.mcpServers()
      .then(r => { if (vivo) setServers(r.servers); })
      .catch((e: Error) => { if (vivo) setErro(e.message || 'falha ao carregar servidores'); });
    return () => { vivo = false; };
  }, []);

  if (erro) return <div className="cc-banner">{erro}</div>;
  if (!servers) return <div className="cc-skillshooks-empty">Carregando servidores…</div>;
  if (detalhe) {
    return (
      <div className="cc-mkt-serverdetail">
        <button type="button" className="cc-mkt-back" onClick={() => setDetalhe(null)}>← Voltar pra lista</button>
        <div className="cc-skill-name">{detalhe.nome}</div>
        <div className="cc-mkt-detail-grid">
          <span className="cc-mkt-detail-lbl">Tipo</span><span className="cc-mono">{detalhe.tipo}</span>
          <span className="cc-mkt-detail-lbl">Detalhe</span><span className="cc-mono">{detalhe.detalhe}</span>
          <span className="cc-mkt-detail-lbl">Origem</span><span>{detalhe.origem}</span>
          <span className="cc-mkt-detail-lbl">Escopo</span><span>{detalhe.escopo}</span>
        </div>
        <div className="cc-mkt-foot">Configurado pelo servidor do Orion em toda sessão (tokens nunca aparecem aqui). O estado vivo (conectado/falhou) existe só dentro de cada sessão.</div>
      </div>
    );
  }
  if (servers.length === 0) return <div className="cc-skillshooks-empty">Nenhum servidor MCP configurado.</div>;
  return (
    <>
      {servers.map(s => (
        <button type="button" key={s.nome} className="cc-skill-row cc-mkt-server" onClick={() => setDetalhe(s)}>
          <span className="cc-mkt-dot is-on" />
          <div className="cc-skill-main">
            <div className="cc-skill-name">{s.nome}</div>
            <div className="cc-skill-desc">{s.origem}</div>
          </div>
          <span className="cc-hook-badge is-source">{s.tipo}</span>
        </button>
      ))}
      <div className="cc-mkt-foot">Servidores MCP injetados em toda sessão pelo Orion: Hostinger (token em Configurações), um GitHub e um Cloudflare por conta da aba Tools e a memória do painel.</div>
    </>
  );
}

export default function Marketplace({ open, onClose, isOwner }: MarketplaceProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [tab, setTab] = useState<Tab>('plugins');

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      onClose();
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="cc-agentmap-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cc-agentmap cc-skillshooks" role="dialog" aria-label="Gerenciar plugins" tabIndex={-1}>
        <div className="cc-agentmap-head">
          <div className="cc-agentmap-headtext">
            <div className="cc-agentmap-title">Gerenciar plugins</div>
            <div className="cc-agentmap-subtitle">Catálogo compartilhado da c3, ligado por pessoa · marketplaces e servidores MCP</div>
          </div>
          <button ref={closeRef} type="button" className="cc-icon" onClick={onClose} title="Fechar (Esc)"><X size={14} /></button>
        </div>
        <div className="cc-skillshooks-tabs">
          <button type="button" className={`cc-skillshooks-tab ${tab === 'plugins' ? 'is-active' : ''}`} onClick={() => setTab('plugins')}>Plugins</button>
          <button type="button" className={`cc-skillshooks-tab ${tab === 'marketplaces' ? 'is-active' : ''}`} onClick={() => setTab('marketplaces')}>Marketplaces</button>
          <button type="button" className={`cc-skillshooks-tab ${tab === 'mcp' ? 'is-active' : ''}`} onClick={() => setTab('mcp')}>Servidores MCP</button>
        </div>
        <div className="cc-agentmap-body cc-skillshooks-body">
          {tab === 'plugins' ? <PluginsTab isOwner={isOwner} /> : tab === 'marketplaces' ? <MarketplacesTab isOwner={isOwner} /> : <McpTab />}
        </div>
      </div>
    </div>
  );
}
