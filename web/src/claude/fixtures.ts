import type { SdkMessage, SessionSummary } from './types';

const now = Date.now();
const m = (min: number) => now - min * 60_000;

export const SESSIONS: SessionSummary[] = [
  { id: 's-forms', title: '[Brandspace] Forms', status: 'running', updatedAt: now, project: 'brandspace' },
  { id: 's-v2', title: 'Subdomínio v2.bayerl.cloud', status: 'idle', updatedAt: m(2), project: 'infra' },
  { id: 's-deploy', title: '[Orion] Deploy da Central', status: 'waiting', updatedAt: m(1), project: 'orion' },
  { id: 's-fisio', title: 'Fisioexpert profissional creation error', status: 'unread', updatedAt: m(10), project: 'fisioexpert' },
  { id: 's-dash', title: 'Dashboard acesso usuário contato', status: 'idle', updatedAt: m(7 * 60), project: 'brandspace' },
  { id: 's-tm', title: '[Trackingmachine] Otimizar', status: 'idle', updatedAt: m(7 * 60), project: 'trackingmachine' },
  { id: 's-esc', title: '[Brandspace] Escritório', status: 'idle', updatedAt: m(24 * 60), project: 'brandspace' },
  { id: 's-fd', title: '[Fisioexpert] Dashboard', status: 'idle', updatedAt: m(2 * 24 * 60), project: 'fisioexpert' },
  { id: 's-rel', title: 'Fisioexpert automações relatórios', status: 'failed', updatedAt: m(2 * 24 * 60), project: 'fisioexpert' },
  { id: 's-ralab', title: '[RALab-Gustavo] Dev', status: 'idle', updatedAt: m(2 * 24 * 60), project: 'ralab' },
];

const v2: SdkMessage[] = [
  { type: 'system', subtype: 'init', model: 'claude-fable-5-1', cwd: '/srv/work/infra/t-41' },
  { type: 'user', message: { content: 'cria um subdominio v2.bayerl.cloud e aponta para 217.76.55.249 por favor' } },
  { type: 'assistant', message: { content: [
    { type: 'thinking', thinking: 'O pedido é um registro A no domínio bayerl.cloud. A zona está na Hostinger, então o caminho é o MCP hostinger com dns_upsert. Depois confirmo a resolução por fora.' },
    { type: 'text', text: 'Vou criar o registro A `v2.bayerl.cloud → 217.76.55.249` via MCP hostinger.' },
    { type: 'tool_use', id: 't1', name: 'mcp__hostinger__dns_upsert', input: { domain: 'bayerl.cloud', name: 'v2', type: 'A', value: '217.76.55.249', ttl: 300 } },
  ] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '✅ Criado: v2.bayerl.cloud (A) → 217.76.55.249  TTL=300s\nPropagação: até 300s para TTL existente expirar nos resolvers.' }] } },
  { type: 'assistant', message: { content: [
    { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'dig +short v2.bayerl.cloud @1.1.1.1; dig +short v2.bayerl.cloud @8.8.8.8', description: 'Verify DNS resolution of v2.bayerl.cloud on public resolvers' } },
  ] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'Exit code 127\n/bin/bash: line 1: dig: command not found\n/bin/bash: line 1: dig: command not found' }] } },
  { type: 'assistant', message: { content: [
    { type: 'tool_use', id: 't3', name: 'Bash', input: { command: `getent hosts v2.bayerl.cloud || python3 -c "import socket;print(socket.gethostbyname('v2.bayerl.cloud'))"`, description: 'Verify DNS resolution of v2.bayerl.cloud without dig' } },
  ] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: '217.76.55.249   v2.bayerl.cloud' }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Feito. Registro A criado e já resolvendo.\n\n| Nome | Tipo | Valor | TTL |\n|---|---|---|---|\n| v2.bayerl.cloud | A | 217.76.55.249 | 300 |\n\nConfirmei a resolução daqui do container e já aponta pro IP certo. O TTL está em 300 (temporário). Se esse IP virar produção estável, subo pra 14400.\n\nEsse IP não é nenhuma das 3 VPSs conhecidas (Contabo 86.48.28.10, Contabo 2 212.47.70.170, Hostinger 72.61.135.82). Se for uma máquina nova que vai entrar na stack, me diz o que ela é que eu registro no CLAUDE.md.' }] } },
  { type: 'result', subtype: 'success', duration_ms: 18_400, num_turns: 4 },
];

const deploy: SdkMessage[] = [
  { type: 'system', subtype: 'init', model: 'claude-fable-5-1', cwd: '/srv/work/orion/t-7' },
  { type: 'user', message: { content: 'sobe a nova versão da central na c3' } },
  { type: 'assistant', message: { content: [
    { type: 'thinking', thinking: 'Build primeiro, reiniciar o serviço depois. Reiniciar é ação com efeito no servidor, então vai pedir permissão.' },
    { type: 'text', text: 'Vou compilar e, se o build passar, reiniciar o serviço `orion-central`.' },
    { type: 'tool_use', id: 'd1', name: 'Bash', input: { command: 'cd /srv/orion && npm run build', description: 'Build the Central' } },
  ] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'd1', content: '✓ 36 modules transformed.\n../dist/web/index.html   0.39 kB\n../dist/web/assets/index.js   209.29 kB\n✓ built in 499ms' }] } },
];

export const CONVERSATIONS: Record<string, SdkMessage[]> = { 's-v2': v2, 's-deploy': deploy };

/** Pedido de permissão pendente na sessão de deploy (na vida real vem do canUseTool do SDK). */
export const PENDING_PERMISSION = {
  sessionId: 's-deploy',
  toolUseId: 'd2',
  name: 'Bash',
  label: 'Bash',
  description: 'Restart the Central service',
  inputText: 'systemctl restart orion-central',
};

export const USAGE = [
  { label: 'Sessão (5h)', pct: 32, note: 'Renova em 16m' },
  { label: 'Semanal (7 dias)', pct: 53, note: 'Renova em 4h' },
  { label: 'Limite Fable', pct: 29, note: 'Renova em 4h' },
];
