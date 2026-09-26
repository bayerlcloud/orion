# Referência: EXPLORER do VS Code

Levantamento feito no código-fonte do VS Code (MIT) para espelhar o comportamento na página
Arquivos. Nada foi copiado inteiro; onde um trecho pequeno foi adaptado há um comentário no código
apontando o arquivo de origem.

Fontes (branch `main`, https://github.com/microsoft/vscode):

- `src/vs/workbench/contrib/files/browser/views/explorerView.ts` — a view, opções da árvore, ações do título (refresh, collapse all)
- `src/vs/workbench/contrib/files/browser/views/explorerViewer.ts` — `ExplorerDelegate` (altura 22px), `FileSorter`, input de renomear, drag & drop
- `src/vs/workbench/contrib/files/browser/fileActions.ts` — labels, `validateFileName`, `incrementFileName`
- `src/vs/workbench/contrib/files/browser/fileActions.contribution.ts` — atalhos e ordem do menu de contexto
- `src/vs/workbench/contrib/files/browser/fileCommands.ts` — copy path / copy relative path / open to the side
- `src/vs/workbench/contrib/files/browser/files.contribution.ts` — settings (`explorer.sortOrder` etc.)
- `src/vs/workbench/contrib/files/browser/views/explorerDecorationsProvider.ts` — decorações do próprio explorer (symlink, excluído)
- `src/vs/workbench/browser/actions/listCommands.ts` — navegação por teclado da árvore
- `src/vs/base/browser/ui/list/listWidget.ts` (`TypeNavigationController`) e `src/vs/base/browser/ui/tree/abstractTree.ts` (find widget)
- `src/vs/base/common/comparers.ts` — `compareFileNamesDefault`
- `src/vs/workbench/services/decorations/browser/decorationsService.ts` — composição das decorações e o "bubble" das pastas
- `extensions/git/src/decorationProvider.ts` e `extensions/git/src/repository.ts` — letras, cores e `propagate`
- `extensions/git/package.json` — contribuição de cores `gitDecoration.*`
- `src/vs/workbench/contrib/search/browser/searchActionsFind.ts` — Find in Folder

## Layout

- Cabeçalho da side bar: "EXPLORER" + botão "..." (menu da view).
- Uma seção por raiz de workspace, título em caixa alta (ex.: "WORKSPACE"). Ao passar o mouse no título aparecem 4
  ícones: New File (`codicon-new-file`), New Folder (`codicon-new-folder`), Refresh Explorer, Collapse Folders in Explorer.
- Linha da árvore: `ExplorerDelegate.ITEM_HEIGHT = 22`. Indentação padrão `workbench.tree.indent = 8`, guias de
  indentação por `workbench.tree.renderIndentGuides` (`onHover`).
- Pastas colapsadas por padrão (`collapseByDefault`); `autoExpandSingleChildren`; clique simples abre o arquivo
  (`workbench.list.openMode = singleClick`), duplo clique fixa a aba (pinned). O chevron alterna sem abrir.
- Seções "OUTLINE" e "TIMELINE" ficam abaixo, colapsadas.

## Ações e atalhos (foco no explorer)

| Ação | Atalho (Win/Linux) | macOS | Fonte |
|---|---|---|---|
| New File... / New Folder... | — (ícones do título e menu) | — | fileActions.ts |
| Rename... | `F2` | `Enter` | fileActions.contribution.ts |
| Delete (para a lixeira) | `Delete` | `Cmd+Backspace` | idem |
| Delete Permanently | `Shift+Delete` | `Cmd+Alt+Backspace` | idem |
| Cut / Copy / Paste | `Ctrl+X` / `Ctrl+C` / `Ctrl+V` | `Cmd+X/C/V` | idem |
| Cancelar recorte | `Escape` | | idem |
| Abrir mantendo foco (preview) | `Space` | | idem |
| Copy Path | `Ctrl+Alt+C` (Win: `Shift+Alt+C`) | `Cmd+Alt+C` | fileCommands.ts |
| Copy Relative Path | `Ctrl+Shift+Alt+C` (Win: `Ctrl+K Ctrl+Shift+C`) | `Cmd+Shift+Alt+C` | fileCommands.ts |
| Open to the Side | `Ctrl+Enter` | `Ctrl+Enter` | fileCommands.ts |
| Reveal in Explorer View | (menu do editor) | | fileCommands.ts |
| Find in Folder... | `Shift+Alt+F` | | searchActionsFind.ts |
| Refresh Explorer | (ícone do título) | | explorerView.ts |
| Collapse Folders in Explorer | (ícone do título) / `Ctrl+Left` na lista (`list.collapseAll`) | `Cmd+Left` | listCommands.ts |

Ordem do menu de contexto (`MenuId.ExplorerContext`, grupos): `navigation` (New File, New Folder, Open to the Side,
Open With, Reveal in Finder/Explorer), `2_workspace`, `3_compare`, `4_search` (Find in Folder), `5_cutcopypaste`
(Cut, Copy, Paste), `5b_importexport`, `6_copypath` (Copy Path, Copy Relative Path), `7_modification` (Rename,
Delete). Na raiz não há Rename/Cut.

## Seleção, foco e teclado (`listCommands.ts`)

- `Up`/`Down` movem o foco (`list.focusUp/Down`); `Home`/`End` primeiro/último; `PageUp/PageDown`.
- `Shift+Up/Down` estende a seleção múltipla (`multipleSelectionSupport: true`); `Ctrl/Cmd+clique` alterna.
- `Enter` = `list.select`: abre o arquivo (pinned) ou alterna a pasta. No mac `Cmd+Down` é o secundário.
- `Space` = `list.toggleExpand` (em arquivo: abre em preview mantendo o foco).
- `Left` = `list.collapse`: se o nó está expandido, colapsa; se já está colapsado ou é folha, foca o pai.
- `Right` = `list.expand`: expande; se já expandido, foca o primeiro filho.
- `Ctrl/Cmd+Left` = colapsa tudo; `Escape` limpa a seleção (`list.clear`).
- Digitar letras dispara o *type navigation* (`TypeNavigationController`, modo `automatic`): o foco pula para o
  item cujo nome começa com o que foi digitado (prefixo, com buffer que zera após ~800 ms). `Ctrl+Alt+F` (ou `F3`)
  abre o find widget ("Type to search"; o toggle vira "Type to filter" = `TreeFindMode.Filter`).
- Renomear/novo item: um input inline na própria linha (`explorerViewer.ts`); seleção inicial = nome sem a extensão
  (`lastIndexOf('.')`, pastas selecionam tudo); `Enter` confirma, `Escape` cancela, perder o foco confirma.
  Validação (`validateFileName`): nome vazio, começa com barra, já existe na pasta, caracteres inválidos → erro;
  espaço no início/fim → aviso. Colar em cima de nome existente incrementa (`incrementFileName`: `nome copy.ext`,
  `nome copy 2.ext`).

## Ordenação (`FileSorter` + `explorer.sortOrder`)

- `explorer.sortOrder` padrão = `default`: pastas antes de arquivos, ambos ordenados por nome. Outros valores:
  `mixed`, `filesFirst`, `type`, `modified`, `foldersNestsFiles`. Raízes nunca são reordenadas.
- Comparador padrão `compareFileNamesDefault`: `Intl.Collator(undefined, { numeric: true })` (natural: `a2` < `a10`),
  insensível a caixa (misturado), desempate por tamanho da string. `explorer.sortOrderLexicographicOptions` pode
  agrupar maiúsculas (`upper`), minúsculas (`lower`) ou usar ordem unicode.

## Decorações do git

Letra (`Resource.getStatusLetter`) e cor (`Resource.getStatusColor`) por estado; cores do tema **claro** e
**escuro** (`extensions/git/package.json`). A página usa as do escuro (o Orion é escuro):

| Estado | Letra | Cor (dark) | Cor (light) | id da cor |
|---|---|---|---|---|
| Modified (working tree) / Type changed | `M` | `#E2C08D` | `#895503` | `gitDecoration.modifiedResourceForeground` |
| Index modified (staged) | `M` | `#E2C08D` | `#895503` | `gitDecoration.stageModifiedResourceForeground` |
| Added (index) / intent-to-add | `A` | `#81b88b` | `#587c0c` | `gitDecoration.addedResourceForeground` |
| Deleted (working tree) | `D` | `#c74e39` (+ tachado) | `#ad0707` | `gitDecoration.deletedResourceForeground` |
| Index deleted | `D` | `#c74e39` (+ tachado) | `#ad0707` | `gitDecoration.stageDeletedResourceForeground` |
| Renamed / Copied (index) | `R` / `C` | `#73C991` | `#007100` | `gitDecoration.renamedResourceForeground` |
| Untracked | `U` | `#73C991` | `#007100` | `gitDecoration.untrackedResourceForeground` |
| Ignored | `I` (só cor, sem letra no explorer) | `#8C8C8C` | `#8E8E90` | `gitDecoration.ignoredResourceForeground` |
| Conflito (both modified/added/deleted...) | `!` | `#e4676b` | `#ad0707` | `gitDecoration.conflictingResourceForeground` |
| Submodule | `S` | `#8db9e2` | `#1258a7` | `gitDecoration.submoduleResourceForeground` |

Na página (arquivos.css): modified `#e2c08d`, added/untracked/renamed `#73c991`, deleted `#c74e39`, conflito
`#f14c4c` (o vermelho de erro do tema escuro, pedido pelo projeto), ignored `#8c8c8c`.

Regras:
- A decoração é publicada para o caminho do recurso; em renomeação também para o caminho antigo; em exclusão para
  ambos os lados. Ordem de coleta: index → untracked → working tree → merge (o último vence para o mesmo caminho).
- `propagate` (= `bubble` no serviço de decorações) é `true` para todo estado **exceto** `DELETED` e `INDEX_DELETED`.
  Ignorado vem de outro provider (`GitIgnoreDecorationProvider`) só com cor, sem propagar.
- Pasta (`decorationsService.getDecoration(uri, includeChildren = true)`): junta a decoração própria com as dos
  descendentes que têm `bubble`. Se só vier de filhos, a pasta recebe o **bubble badge**: um círculo cheio
  (codicon ``, 14px, opacidade 0.4, `margin-right: 14px`) à direita, na cor da decoração de maior `weight`
  (empate = primeira encontrada), e o nome da pasta ganha a mesma cor. Se a pasta tem decoração própria (ex.: pasta
  nova = `U`), mostra a letra. Prioridade que o git usa para grupos: conflito (4) > ignorado (3) > modificado (2) >
  demais (1).
- Decorações do próprio explorer (`explorerDecorationsProvider.ts`): symlink = letra `⤷` (`⤷`), tipo
  desconhecido = `?`, excluído por `files.exclude` = cor `listDeemphasizedForeground`, raiz que não resolve = `!`.
- `explorer.decorations.colors` e `explorer.decorations.badges` (ambos `true`) ligam/desligam cor e letra.

## Drag & drop (`FileDragAndDrop`)

- Arrastar move; segurando `Ctrl` (Win/Linux) ou `Alt` (mac) copia. `explorer.confirmDragAndDrop = true` pergunta
  "Are you sure you want to move 'x' into 'y'?" (com "Do not ask me again"). Soltar na própria pasta é ignorado;
  soltar sobre um descendente é proibido; conflito de nome pergunta se substitui.

## O que a página Arquivos espelha

Altura de linha 22px, pastas antes de arquivos com ordenação natural sem distinguir caixa, chevrons, guias de
indentação, input inline de renomear/novo com seleção do nome sem extensão, teclado (setas, Enter, Left/Right com
foco no pai/filho, F2, Delete, Ctrl/Cmd+C = copiar caminho, digitar = pular para o item), menu de contexto na
ordem do VS Code, letras e cores do tema escuro, bubble em pasta com descendentes alterados (exceto exclusões),
confirmação ao mover por drag & drop, seções OUTLINE e TIMELINE (git log do arquivo).
