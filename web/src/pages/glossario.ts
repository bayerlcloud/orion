/** Glossário leigo, em português, para a aba Instalado. Puro: recebe um nome e devolve "o que é e para que serve". */

type Entrada = { teste: RegExp; texto: string };

const BINARIOS: Entrada[] = [
  { teste: /^node$/, texto: 'Motor que roda programas escritos em JavaScript fora do navegador. É o que executa a Central do Orion.' },
  { teste: /^npm$/, texto: 'Instalador de pacotes do Node. Baixa as bibliotecas que os programas precisam.' },
  { teste: /^npx$/, texto: 'Atalho do npm para rodar uma ferramenta sem instalar de vez.' },
  { teste: /^pnpm$/, texto: 'Alternativa ao npm, mais rápida e econômica em disco.' },
  { teste: /^yarn$/, texto: 'Outra alternativa ao npm para instalar bibliotecas.' },
  { teste: /^bun$/, texto: 'Motor de JavaScript mais novo e rápido, parecido com o Node. Aqui serve para rodar o kanna.' },
  { teste: /^deno$/, texto: 'Outro motor de JavaScript, focado em segurança.' },
  { teste: /^python3?$/, texto: 'Linguagem de programação muito usada em automação e dados. Vem com o Ubuntu.' },
  { teste: /^pip3?$/, texto: 'Instalador de pacotes do Python.' },
  { teste: /^docker$/, texto: 'Roda programas em "caixinhas" isoladas, os containers. O Postgres do Orion roda em uma.' },
  { teste: /^docker-compose$/, texto: 'Sobe vários containers de uma vez a partir de um arquivo de configuração.' },
  { teste: /^caddy$/, texto: 'Porta de entrada do site: recebe as visitas em https, cuida do certificado sozinho e repassa para a Central.' },
  { teste: /^nginx$/, texto: 'Servidor web e porta de entrada, mesmo papel do Caddy.' },
  { teste: /^git$/, texto: 'Guarda o histórico de cada mudança no código e permite várias pessoas trabalharem sem se atropelar.' },
  { teste: /^gh$/, texto: 'Ferramenta de linha de comando do GitHub, para abrir PRs e issues.' },
  { teste: /^claude$/, texto: 'O Claude Code em si: o programa da Anthropic que lê e escreve código, roda comandos e conversa. A aba Claude usa ele por baixo.' },
  { teste: /^kanna$/, texto: 'Interface web de outra pessoa, código aberto, para conversar com o Claude Code. Instalada como apoio enquanto a Central cresce.' },
  { teste: /^psql$/, texto: 'Terminal do Postgres, para consultar o banco na mão.' },
  { teste: /^redis-server$/, texto: 'Banco em memória, usado para filas e cache.' },
  { teste: /^pm2$/, texto: 'Mantém programas Node rodando e reinicia se caírem. Muito usado na c1.' },
  { teste: /^go$/, texto: 'Linguagem de programação do Google.' },
  { teste: /^(rustc|cargo)$/, texto: 'Linguagem Rust e seu instalador de pacotes.' },
  { teste: /^java$/, texto: 'Linguagem Java.' },
  { teste: /^ffmpeg$/, texto: 'Converte e edita áudio e vídeo por linha de comando.' },
  { teste: /^jq$/, texto: 'Lê e filtra arquivos JSON no terminal. Usado por scripts de manutenção.' },
  { teste: /^curl$/, texto: 'Faz requisições a sites e APIs pelo terminal. É o "abrir uma URL" sem navegador.' },
  { teste: /^rsync$/, texto: 'Copia arquivos entre máquinas enviando só o que mudou. É como o código chega na c3.' },
  { teste: /^ufw$/, texto: 'Firewall simples do Ubuntu. Aqui deixa passar só SSH, http e https.' },
  { teste: /^fail2ban(-client)?$/, texto: 'Vigia tentativas de login erradas e bloqueia o IP de quem insiste.' },
  { teste: /^ss$/, texto: 'Mostra quais portas e conexões de rede estão abertas.' },
];

const PACOTES: Entrada[] = [
  { teste: /^@anthropic-ai\/claude-code$/, texto: 'O Claude Code instalado para toda a máquina. É o programa por trás do comando claude.' },
  { teste: /^@anthropic-ai\/claude-agent-sdk$/, texto: 'Biblioteca oficial para programas chamarem o Claude Code por dentro. A Central usa ela.' },
  { teste: /^kanna-code$/, texto: 'O pacote do kanna, a interface web de apoio.' },
  { teste: /^corepack$/, texto: 'Vem junto com o Node; gerencia versões do pnpm e do yarn.' },
  { teste: /^npm$/, texto: 'O próprio instalador de pacotes do Node.' },
  { teste: /^typescript$/, texto: 'JavaScript com tipos, que pega erros antes de rodar. A Central é escrita nele.' },
  { teste: /^pm2$/, texto: 'Mantém programas Node rodando e reinicia se caírem.' },
];

const UNIDADES: Entrada[] = [
  { teste: /^orion-central\.service$/, texto: 'A Central do Orion: o site orion.bayerl.cloud, a API e o motor das sessões do Claude. Roda como o usuário danilo.' },
  { teste: /^orion-inventory\.(service|timer)$/, texto: 'Coleta de hora em hora do que está instalado nesta máquina, que alimenta esta aba.' },
  { teste: /^kanna\.service$/, texto: 'O kanna, interface de apoio do Claude Code. Só sobe quando houver senha definida.' },
  { teste: /^caddy\.service$/, texto: 'Porta de entrada do site: https, certificados e repasse para a Central.' },
  { teste: /^docker\.service$/, texto: 'O Docker, que roda os containers.' },
  { teste: /^docker\.socket$/, texto: 'Canal pelo qual programas falam com o Docker.' },
  { teste: /^containerd\.service$/, texto: 'Peça interna do Docker que de fato executa os containers.' },
  { teste: /^ssh\.service$/, texto: 'Acesso remoto seguro ao servidor por terminal. Só por chave, senha desligada.' },
  { teste: /^ssh\.socket$/, texto: 'Escuta as conexões SSH e acorda o serviço.' },
  { teste: /^ufw\.service$/, texto: 'O firewall.' },
  { teste: /^fail2ban\.service$/, texto: 'Bloqueio automático de quem tenta senhas erradas.' },
  { teste: /^cron\.service$/, texto: 'Agenda tarefas por horário, o "despertador" do Linux.' },
  { teste: /^postgres/, texto: 'Banco de dados Postgres.' },
  { teste: /^nginx\.service$/, texto: 'Servidor web.' },
  { teste: /^redis/, texto: 'Banco em memória para filas e cache.' },
  { teste: /^(n8n|evolution|coolify)/, texto: 'Serviço da stack antiga (automação, WhatsApp ou deploy).' },
  { teste: /^apt-daily/, texto: 'Rotina do Ubuntu que baixa atualizações de segurança.' },
  { teste: /^snapd/, texto: 'Sistema de pacotes "snap" do Ubuntu. Aqui, sem uso.' },
];

const IMAGENS: Entrada[] = [
  { teste: /^postgres(:|$)/, texto: 'O banco de dados do Orion: usuários, sessões, eventos, arquivos do Drive e este inventário.' },
  { teste: /^redis/, texto: 'Banco em memória para filas e cache.' },
  { teste: /^caddy/, texto: 'Porta de entrada do site em container.' },
  { teste: /^n8n/, texto: 'Automação de fluxos, estilo Zapier.' },
  { teste: /evolution/, texto: 'API de WhatsApp.' },
  { teste: /supabase|kong/, texto: 'Peças do Supabase, banco com API pronta.' },
];

const PORTAS: Record<number, string> = {
  22: 'SSH: acesso remoto ao servidor por terminal.',
  53: 'DNS local: tradução de nomes de sites em endereços, só para a própria máquina.',
  80: 'http: entrada do site sem criptografia; o Caddy redireciona para https.',
  443: 'https: entrada do site com cadeado. É por aqui que você acessa orion.bayerl.cloud.',
  2019: 'Painel interno do Caddy, só acessível de dentro da máquina.',
  3000: 'A Central do Orion, só acessível de dentro; o Caddy repassa para cá.',
  3210: 'O kanna, só acessível de dentro; o Caddy repassa para cá.',
  5432: 'O Postgres, só acessível de dentro da máquina.',
  6379: 'Redis.',
  8080: 'Porta comum de aplicações web internas.',
};

const APT: Entrada[] = [
  { teste: /^linux-(image|headers|modules)/, texto: 'Núcleo do sistema (kernel) ou peças dele. Atualização de segurança do Ubuntu.' },
  { teste: /^(libc6|libssl|openssl|ca-certificates)/, texto: 'Bibliotecas básicas de sistema e certificados de segurança.' },
  { teste: /^nodejs$/, texto: 'O Node, instalado via apt.' },
  { teste: /^docker-ce|^containerd\.io|^docker-buildx|^docker-compose-plugin/, texto: 'Peças do Docker.' },
  { teste: /^caddy$/, texto: 'O Caddy.' },
  { teste: /^ufw$/, texto: 'O firewall.' },
  { teste: /^fail2ban$/, texto: 'Bloqueio de tentativas de login.' },
  { teste: /^unzip$/, texto: 'Descompacta arquivos .zip. Necessário para instalar o bun.' },
  { teste: /^(curl|jq|htop|git)$/, texto: 'Ferramentas de linha de comando para manutenção.' },
  { teste: /^python3/, texto: 'Python e suas bibliotecas.' },
  { teste: /^(snapd|cloud-init|systemd|udev|dbus|apparmor|sudo|bash|coreutils|util-linux)/, texto: 'Peça do próprio Ubuntu.' },
];

function acha(lista: Entrada[], nome: string): string | null {
  for (const e of lista) if (e.teste.test(nome)) return e.texto;
  return null;
}

export const SEM_DESCRICAO = 'Sem descrição ainda.';

export function explicaBinario(nome: string): string { return acha(BINARIOS, nome) ?? SEM_DESCRICAO; }
export function explicaPacote(nome: string): string { return acha(PACOTES, nome) ?? acha(BINARIOS, nome) ?? SEM_DESCRICAO; }
export function explicaUnidade(unidade: string): string { return acha(UNIDADES, unidade) ?? SEM_DESCRICAO; }
export function explicaContainer(nome: string, imagem: string): string {
  return acha(IMAGENS, imagem) ?? acha(IMAGENS, nome) ?? acha(UNIDADES, `${nome}.service`) ?? SEM_DESCRICAO;
}
export function explicaPorta(porta: number, processo?: string): string {
  if (PORTAS[porta]) return PORTAS[porta];
  if (processo && processo !== '—') { const b = acha(BINARIOS, processo); if (b) return b; }
  return SEM_DESCRICAO;
}
export function explicaApt(pacote: string): string { return acha(APT, pacote) ?? acha(BINARIOS, pacote) ?? SEM_DESCRICAO; }
