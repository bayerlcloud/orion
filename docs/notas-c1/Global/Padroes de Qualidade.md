# Padrões de Qualidade

Regras que valem para **todos** os projetos e sites.

## Frontend / Sites
- Todo site deve ter favicon configurado
- Meta title e description obrigatórios em toda página
- Responsividade mobile é requisito, não opcional

## Deploy
- Sempre verificar healthcheck antes de considerar deploy concluído
- Domínios novos via API Hostinger (wildcard *.bayerl.cloud cobre automaticamente)

## Código
- Sem console.log em produção
- Variáveis sensíveis sempre em .env, nunca hardcoded

## 🔴 Regra de Fila — Como o Claude trabalha com o Danilo

**Quando Danilo pede algo enquanto outra tarefa está em andamento:**
- NÃO para o que está fazendo
- Anota o novo pedido
- Termina a tarefa atual
- Executa o próximo pedido em seguida

Pode avisar em 1 linha ("anotado, termino X e já faço Y") mas nunca interrompe.
