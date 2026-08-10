# Guia de Execução — `fiscal-audit-readonly.sql`

**Objetivo deste guia:** permitir que você (ou quem tiver acesso de leitura ao Supabase da Santtorini) execute [`fiscal-audit-readonly.sql`](fiscal-audit-readonly.sql) em blocos pequenos e entendidos, em vez de rodar o arquivo inteiro de uma vez sem contexto. Nada foi executado por mim — este documento só explica o que cada bloco faz.

**Confirmação de segurança, revisada linha a linha:** todas as instruções do arquivo `fiscal-audit-readonly.sql` são `SELECT` puro, contra tabelas de aplicação (`public.sales`, `public.products`, etc.) ou contra catálogo do sistema (`information_schema.*`, `pg_catalog`/`pg_class`/`pg_constraint`/`pg_indexes`/`pg_policies`/`pg_proc`/`pg_matviews`). **Não existe nenhum `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE` ou `CREATE` em nenhuma linha do arquivo.** Reconferido nesta revisão antes de escrever este guia.

**Recomendação de execução:** use, se possível, uma conexão/usuário com permissão apenas de leitura (não a `service_role` key, que tem acesso total). Se só houver acesso via `service_role` ou via SQL Editor do painel Supabase com privilégio total, isso não é um problema de segurança para estas consultas específicas (elas não escrevem nada), mas é uma boa prática geral não usar credencial de escrita total para tarefas de leitura quando existir alternativa.

**Sobre carga no banco:** a Santtorini opera em escala pequena (~200 vendas/mês, single-tenant). Nenhuma consulta abaixo faz `JOIN` pesado, varredura de tabela grande sem filtro, nem operação recursiva. A avaliação de carga por bloco abaixo é conservadora mesmo assim, mas na prática todos os blocos devem rodar em menos de 1 segundo cada num banco desse porte.

---

## Ordem sugerida de execução

Não existe dependência técnica entre os blocos — todos podem rodar isoladamente e em qualquer ordem. A ordem abaixo é sugerida por prioridade de decisão: primeiro o que valida o achado mais crítico do relatório (Bloco 1), depois o que valida achados estruturais (Blocos 2-4), depois o inventário geral de conferência (Blocos 5-8), útil mas não urgente.

| Ordem | Bloco | Prioridade |
|---|---|---|
| 1 | Bloco 1 — `products_total` | Alta — fecha o achado mais crítico do relatório |
| 2 | Bloco 3 — RLS/policies | Alta — fecha um risco de segurança (M5/M6 do registro de riscos) |
| 3 | Bloco 2 — Unicidade de SKU | Média — confirma um risco já documentado, não muda decisão imediata |
| 4 | Bloco 4 — Schema de tabelas sem CREATE TABLE rastreado | Média — insumo para a Fase 1, não urgente agora |
| 5 | Bloco 6 — Tabelas Nuvemshop | Baixa — mesma finalidade do Bloco 4, escopo menor |
| 6 | Bloco 7 — Auth/RBAC | Baixa — confirmação de contexto, sem achado de risco pendente |
| 7 | Bloco 8 — Audit logs | Baixa — só dimensiona volume, sem decisão pendente |
| 8 | Bloco 5 — Inventário geral | Baixa — cobertura ampla de "item 24" da auditoria original, útil como registro de referência, não resolve um achado específico |

---

## Bloco 1 — Regressão de `sales.products_total` (consultas 1.1 a 1.3)

**O que consulta:** quantas vendas têm `products_total` nulo, separadas por antes/depois de 14/06/2026 (1.1); a mesma contagem detalhada por dia nos últimos 90 dias (1.2); uma amostra de 20 linhas afetadas para inspeção manual (1.3).

**Por que é necessária:** é o achado mais crítico do relatório principal — a leitura de código provou que a coluna parou de ser preenchida a partir de uma migration específica, mas só uma consulta no banco real confirma o *escopo* exato (quantas vendas, desde quando, se há exceções).

**Carga no banco:** baixa. É uma agregação simples sobre `public.sales`, que numa operação de ~200 vendas/mês tem no máximo alguns milhares de linhas. Sem `JOIN`.

**O que copiar de volta:** o resultado das três consultas — principalmente a 1.1 (visão geral) e, se os números confirmarem a suspeita, uma ou duas linhas de exemplo da 1.3 para eu conferir se os outros campos (`subtotal`, `discount_amount`) estão consistentes com a fórmula de reconstrução descrita em [`products-total-regression-analysis.md`](products-total-regression-analysis.md).

**Risco de alteração:** nenhum. `SELECT` puro.

---

## Bloco 2 — Unicidade real de `products.sku` / `product_variations.sku_variation` (consultas 2.1 a 2.3)

**O que consulta:** as constraints `UNIQUE`/`PRIMARY KEY` realmente existentes nas duas tabelas (2.1); todos os índices das duas tabelas, para comparar com os nomes `idx_products_sku`/`idx_products_company_sku` citados como não-únicos na migration `202607302600_pim_product_sku_identity.sql` (2.2); evidência direta de SKUs duplicados hoje, se existirem (2.3).

**Por que é necessária:** o próprio time já documentou, numa migration datada, que `products.sku` nunca teve `UNIQUE` (contrariando o que o arquivo `000_schema_completo.sql` afirma) e que a unicidade de `product_variations.sku_variation` nunca foi verificada. Isso é relevante para o módulo fiscal porque um SKU ambíguo pode levar a mapear o item errado de NCM/CFOP na hora de montar um documento fiscal.

**Carga no banco:** baixa a média. As consultas 2.1/2.2 são metadados de catálogo (instantâneas). A consulta 2.3 faz `GROUP BY` com `HAVING count(*) > 1` sobre `products`/`product_variations` — para o volume de catálogo típico de uma loja desse porte (algumas centenas a poucos milhares de produtos/variações), é uma operação rápida.

**O que copiar de volta:** o resultado de 2.1 (definição exata das constraints) é o mais importante — ele fecha a dúvida de uma vez. Se 2.3 retornar linhas, copie a contagem total de grupos duplicados (não precisa colar a lista inteira se for longa).

**Risco de alteração:** nenhum. `SELECT` puro.

---

## Bloco 3 — RLS e policies ativas (consultas 3.1 a 3.2)

**O que consulta:** se `companies`, `products`, `product_variations`, `sales`, `sale_items`, `sale_payments`, `customers`, `returns`, `return_items`, `exchanges`, `exchange_items`, `cashback_transactions`, `pedidos`, `pedidos_itens` têm RLS habilitado (3.1); todas as policies ativas nessas tabelas, inclusive possíveis policies antigas e permissivas que nunca foram removidas (3.2).

**Por que é necessária:** a leitura de código encontrou (a) `companies` sem nenhuma `ENABLE ROW LEVEL SECURITY` em nenhuma migration, (b) `sale_items` e `product_variations` com RLS habilitado mas sem nenhuma `CREATE POLICY` correspondente na seção consolidada de RLS, e (c) uma policy antiga (`archive/001_rls_and_audit.sql`, `USING (true)` — sem filtro de empresa) que nunca foi explicitamente removida em nenhum arquivo. Como o Postgres combina policies permissivas com `OR`, se essa policy antiga ainda estiver ativa no banco real, ela sozinha libera acesso irrestrito para qualquer cliente autenticado (não-`service_role`), tornando as policies novas por `company_id` redundantes. Isso é mitigado hoje porque a aplicação usa exclusivamente `service_role` (que ignora RLS), mas é uma lacuna real de defesa em profundidade a ser corrigida antes de dar a qualquer integração futura (inclusive um eventual provedor fiscal, se algum dia precisar de acesso direto) uma credencial `authenticated` em vez de `service_role`.

**Carga no banco:** desprezível — é consulta de catálogo (`pg_policies`, `pg_class`), sem tocar dado de aplicação.

**O que copiar de volta:** o resultado completo de 3.2 (a lista de policies costuma ser curta, poucas dezenas de linhas) — preciso ver o texto de `qual`/`with_check` de cada uma para confirmar se alguma ainda é `USING (true)` sem filtro.

**Risco de alteração:** nenhum. `SELECT` puro.

---

## Bloco 4 — Schema real de tabelas sem `CREATE TABLE` rastreado em nenhuma migration (consultas da Seção 4, incluindo 4.1 e 4.2)

**O que consulta:** colunas (com tipo, nulidade, default) de `companies`, `products`, `product_variations`, `customers`, `sales`, `sale_items`, `sale_payments`, `pedidos`, `pedidos_itens`, `produto_map`, `returns`, `return_items`, `exchanges`, `exchange_items`, `cashback_transactions`, `stock_lots`, `stock_balances`, `audit_logs`, `users`, `authorization_tokens`; suas foreign keys (4.1); e os `CHECK constraints` das tabelas mais relevantes a fiscal (4.2).

**Por que é necessária:** como detalhado em [`migrations-divergence-analysis.md`](migrations-divergence-analysis.md), o `CREATE TABLE` original de `companies`/`products`/`customers`/`pedidos`/`pedidos_itens` não existe em nenhuma das duas árvores de migration rastreadas em git — essas tabelas foram criadas antes do histórico de migrations começar a ser versionado, ou por execução manual não commitada. Isso significa que a estrutura de colunas dessas tabelas hoje só pode ser confirmada lendo o banco real, não os arquivos.

**Carga no banco:** desprezível — é toda consulta de metadado (`information_schema.columns`, `information_schema.table_constraints`, `pg_constraint`), independente do volume de dados nas tabelas.

**O que copiar de volta:** o resultado completo — é a base para desenhar com segurança as extensões fiscais propostas em `fiscal-architecture-proposal.md` (ex.: confirmar se `companies` realmente não tem nenhuma coluna fiscal escondida que não apareceu em nenhuma migration, e se `customers` realmente não tem nenhum campo de endereço além dos já identificados).

**Risco de alteração:** nenhum. `SELECT` puro.

---

## Bloco 5 — Inventário geral do schema (consultas 5.1 a 5.10)

**O que consulta:** lista de schemas (5.1); todas as tabelas do `public` com contagem aproximada de linhas via `pg_class.reltuples` (5.2 — é uma estimativa do planejador, não um `COUNT(*)` real, portanto instantânea); todos os enums e seus valores (5.3); todas as views e materialized views (5.4); todas as functions/procedures customizadas do schema `public` (5.5); todos os triggers (5.6); todos os índices (5.7); todas as foreign keys do schema inteiro, não só das tabelas-chave (5.8); todas as policies do schema inteiro (5.9); e todas as tabelas com RLS habilitado/desabilitado (5.10).

**Por que é necessária:** é o inventário completo pedido no item 24 do escopo original da auditoria — cobertura de referência geral, não vinculada a um achado específico pendente de confirmação. Útil para ter um retrato completo do banco arquivado junto com o relatório, e para detectar qualquer coisa que a leitura de arquivos não tenha capturado (ex.: uma function ou trigger criada manualmente via SQL Editor, sem migration correspondente).

**Carga no banco:** desprezível a baixa. Todas são consultas de catálogo. A única que toca `pg_class.reltuples` (5.2) é uma estimativa estatística já mantida pelo Postgres, não uma varredura de tabela.

**O que copiar de volta:** este bloco é o mais longo — não precisa colar tudo linha por linha se o volume for grande. Um resumo (quantas tabelas, quantas views, quantas functions, quantos enums) já ajuda; posso pedir o detalhe de uma seção específica depois, se algo chamar atenção.

**Risco de alteração:** nenhum. `SELECT` puro.

---

## Bloco 6 — Tabelas Nuvemshop sem `CREATE TABLE` rastreado (consulta 6 e 6.1)

**O que consulta:** colunas de `pedidos`, `pedidos_itens`, `produto_map`, `nuvemshop_sync_logs`; e se existe alguma constraint `UNIQUE` real em `pedidos` (a leitura de código só encontrou um índice não-único, `idx_pedidos_external_source_lock`, protegendo a chave natural `external_id`+`source` — se de fato não houver `UNIQUE`, há uma janela teórica de corrida em que dois webhooks quase simultâneos para o mesmo pedido novo poderiam inserir duas linhas antes que o lock de processamento entre em ação).

**Por que é necessária:** mesma motivação do Bloco 4, com foco específico nas tabelas de staging de pedido Nuvemshop, que a auditoria já sinalizou como candidatas a fonte de inconsistência de idempotência.

**Carga no banco:** desprezível — metadado de catálogo.

**O que copiar de volta:** o resultado de 6.1 é o mais importante (confirma ou refuta a lacuna de `UNIQUE`).

**Risco de alteração:** nenhum. `SELECT` puro.

---

## Bloco 7 — Autenticação / usuários / RBAC (consultas 7.1 a 7.3)

**O que consulta:** estrutura da tabela `users` (7.1); contagem de usuários por `role`, sem expor nenhum dado pessoal — só o rótulo do papel e a contagem (7.2); e a lista de empresas cadastradas (`companies`, só `id`/`name`/`slug`/`plan`/`active`/`created_at`) para confirmar em dados reais a suposição de que a Santtorini opera como single-tenant de fato (7.3).

**Por que é necessária:** validar contra dado real duas suposições da auditoria de código: que o RBAC de 3 papéis (`admin`/`gerente`/`usuario`) está mesmo em uso (não só declarado no código) e que existe de fato só uma empresa ativa hoje.

**Carga no banco:** desprezível — `users` e `companies` são tabelas pequenas por natureza.

**O que copiar de volta:** os dois resultados completos (são poucas linhas).

**Risco de alteração:** nenhum. `SELECT` puro. **Nota de privacidade:** a consulta 7.2 foi desenhada deliberadamente para não trazer nome, e-mail ou qualquer dado pessoal de usuário — só contagem por papel. Não modifique a consulta para trazer colunas adicionais de `users` sem necessidade.

---

## Bloco 8 — Logs e auditoria (consultas 8.1 a 8.2)

**O que consulta:** estrutura da tabela `audit_logs` (8.1); volume de eventos por mês, últimos 24 meses (8.2) — para avaliar, na prática, se a política de retenção de 24 meses hoje sugerida em `TECHNICAL_NOTES.md` já está gerando volume relevante, e se essa tabela é candidata viável a reaproveitar como trilha de auditoria fiscal sem virar gargalo.

**Por que é necessária:** insumo de dimensionamento para a decisão (ainda não tomada) de reaproveitar `audit_logs` para eventos fiscais em vez de criar uma tabela nova (`fiscal-architecture-proposal.md`, seção 2, item "Auditoria").

**Carga no banco:** baixa. `GROUP BY date_trunc('month', ts)` sobre `audit_logs` é uma agregação simples; mesmo que o volume já seja de dezenas de milhares de linhas, é uma operação de segundos, não de minutos, num banco desse porte.

**O que copiar de volta:** o resultado completo de 8.2 (24 linhas no máximo).

**Risco de alteração:** nenhum. `SELECT` puro.

---

## Depois de rodar

Quando tiver os resultados (de todos os blocos ou só dos prioritários), me envie o retorno — posso então:
- Fechar definitivamente os achados marcados **[LIVE]** em [`fiscal-risk-register.md`](fiscal-risk-register.md), atualizando sua classificação de risco com base no dado real.
- Ajustar [`products-total-regression-analysis.md`](products-total-regression-analysis.md) se o escopo real (Bloco 1) divergir da estimativa feita sem acesso ao banco.
- Ainda sem propor nenhuma correção de código — isso continua dependendo da sua autorização expressa, como reforçado em todos os documentos desta auditoria.
