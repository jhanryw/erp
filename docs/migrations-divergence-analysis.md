# Análise de Divergência entre as Duas Árvores de Migration

**Tipo:** análise técnica isolada, read-only. Nenhum arquivo foi movido, apagado, renomeado ou alterado. Todas as citações abaixo foram reconferidas diretamente nesta sessão (não apenas herdadas do relatório anterior).

---

## 1. Caminho de cada árvore

| Árvore | Caminho | Conteúdo |
|---|---|---|
| **A — ativa** | `supabase/migrations/` | 110 arquivos `.sql`, nomeados por data (`YYYYMMDD_descrição.sql` ou `YYYYMMDDHHMM_descrição.sql`), mais um arquivo sem prefixo de data (`00_add_dynamic_sku_colors_and_sizes.sql`, o mais antigo alfabeticamente no diretório). Intervalo confirmado: do arquivo mais antigo datado até `202607302700_fix_markup_pct_overflow_and_import_error_detail.sql` (30/07/2026). |
| **B — legada/consolidada** | `src/lib/db/migrations/` | Um único arquivo `000_schema_completo.sql` (149.055 bytes) + subdiretório `archive/` com 37 itens numerados `001_...` a `036_...` (mais um item, `033_fix_stock_consistency_and_add_lot_sync_trigger`, **sem extensão `.sql`** — nome de arquivo incompleto/malformado, ao lado de um `033_fix_timezone_sale_date.sql` distinto e corretamente nomeado; ambos coexistem no mesmo diretório com o mesmo número de sequência, o que já é, por si só, um indício de descuido de organização nesta árvore). |

---

## 2. Qual é executada atualmente

**Não é possível confirmar com 100% de certeza apenas pelos arquivos** — não existe `supabase/config.toml` em lugar nenhum do repositório (`find . -iname config.toml` não retorna nada), que é o arquivo que normalmente declarita explicitamente qual diretório de migrations o CLI do Supabase usa.

**Evidência indireta forte, porém, aponta para a Árvore A (`supabase/migrations/`) como a única mantida ativamente e a mais próxima do banco real:**
- `package.json:12` — `"supabase:types": "supabase gen types typescript --local > src/types/database.types.ts"` — usa a convenção padrão do CLI do Supabase, que por padrão lê de `supabase/migrations/` quando nenhum `config.toml` sobrescreve isso.
- A Árvore A tem commits regulares e recentes (último em 31/07/2026, arquivo `202607302700...`), enquanto a Árvore B teve seu único commit relevante em 30/07/2026 (criação do arquivo consolidado) e não recebeu nenhuma atualização desde então correspondente às migrations mais recentes da Árvore A.
- A própria Árvore B se autodeclara não-migration, mas "referência": o cabeçalho de `000_schema_completo.sql` (linhas 1-15) diz textualmente: *"Para instâncias NOVAS: executar este arquivo completo. Para instâncias existentes: o dado já está no banco, só as migrations de correção individuais precisam rodar."* — ou seja, o próprio arquivo admite que, para a instância real e já existente da Santtorini, ele **nunca foi (e não deveria ser) executado por completo** — ele é um retrato hipotético de "como seria começar do zero", não o histórico real aplicado.

**Conclusão:** a Árvore A é a fonte de verdade operacional (é o que realmente roda contra o banco real, incrementalmente). A Árvore B é material de referência/documentação que um desenvolvedor específico manteve para tentar ter uma visão consolidada do schema — não é, e nunca foi pretendida como, o histórico real de mudanças aplicadas ao banco de produção.

---

## 3. Qual contém informações incorretas

**A Árvore B (`src/lib/db/migrations/000_schema_completo.sql`) contém informações comprovadamente incorretas, por admissão datada do próprio autor do projeto.** Não é uma suspeita da auditoria — é uma citação direta do histórico de commits.

## 4. Como isso foi comprovado

Citação exata, `supabase/migrations/202607302600_pim_product_sku_identity.sql:12-18` (comentário de cabeçalho da própria migration):

> *"CORREÇÃO FUNDAMENTAL NESTA VERSÃO (diagnóstico real do banco, não do arquivo consolidado): products.sku NUNCA teve UNIQUE. Existem apenas idx_products_sku e idx_products_company_sku — ambos índices NÃO únicos. src/lib/db/migrations/000_schema_completo.sql (que eu tinha usado como referência) está errado nisso — mais uma vez desatualizado em relação ao schema real (mesma classe de problema já encontrada com rpc_stock_initialize e a tabela stock/stock_balances)."*

Isso é uma tripla confirmação, na própria linguagem do time:
1. **Erro #1 (esta migration):** `products.sku` — `000_schema_completo.sql:482` declara `sku TEXT NOT NULL UNIQUE`, mas a constraint `UNIQUE` real nunca existiu no banco (só índices não-únicos).
2. **Erro #2 (citado como precedente, "mesma classe de problema"):** algo relacionado a `rpc_stock_initialize` e à tabela `stock`/`stock_balances` — não investigado em detalhe nesta análise (fora do escopo desta rodada), mas citado pelo próprio autor como um erro anterior já detectado no mesmo arquivo consolidado. Rastreável via `grep -rln "rpc_stock_initialize" supabase/migrations/*.sql`, que aponta para `20260517_reconcile_stock_movements.sql` e `20260610_multi_estoque.sql` como candidatos a conter o contexto original desse achado — não lidos em profundidade nesta análise, citados aqui apenas como ponteiro para investigação futura, se necessário.
3. **Item explicitamente não verificado, mas sinalizado como suspeito pelo próprio autor:** a mesma migration, linhas 42-47, admite: *"ACHADO AINDA EM ABERTO: não confirmei (nem foi pedido) se product_variations.sku_variation realmente tem UNIQUE — o mesmo arquivo consolidado afirma que sim, mas dado que ele já errou duas vezes nesta sessão sobre unicidade/schema real (...), recomendo validar isso também antes de confiar cegamente."*

**Achado adicional desta análise, não citado pelo próprio time, mas comprovado por grep direto:** `000_schema_completo.sql` **não contém nenhuma menção à tabela `pedidos`** — `grep -n "pedidos" src/lib/db/migrations/000_schema_completo.sql` retorna zero ocorrências —, apesar de `pedidos`/`pedidos_itens` serem tabelas ativamente usadas, alteradas e centrais ao fluxo de importação de pedidos da Nuvemshop (`supabase/migrations/20260521_webhook_idempotency.sql`, `20260515_nuvemshop_sale_link.sql`, `20260618_fix_pedidos_itens_webhook_columns.sql` todas fazem `ALTER TABLE public.pedidos`/`public.pedidos_itens`). Ou seja, o arquivo "consolidado" não é apenas impreciso em alguns detalhes — ele está **incompleto**, faltando tabelas inteiras que fazem parte do sistema real.

---

## 5. Quais migrations existem em uma árvore e não na outra

- **Todas as 37 entradas de `src/lib/db/migrations/archive/*` (numeradas `001` a `036`, mais o item malformado `033_fix_stock_consistency_and_add_lot_sync_trigger`) não têm arquivo correspondente na Árvore A.** Elas representam o histórico pré-consolidação — supostamente resumido em `000_schema_completo.sql`, mas, como demonstrado, esse resumo é comprovadamente incompleto e parcialmente incorreto.
- **Todas as 110 migrations de `supabase/migrations/*` não têm arquivo correspondente na Árvore B.** A Árvore B parou de crescer migration-a-migration; só o arquivo único `000_schema_completo.sql` recebe atualizações esporádicas tentando "alcançar" o estado da Árvore A, sem sucesso total (conforme os erros já documentados).
- **Nenhuma das duas árvores contém o `CREATE TABLE` original de `companies`, `products`, `customers`, `pedidos` ou `pedidos_itens`** — confirmado por `grep -rln "CREATE TABLE.*public\.\(companies\|products\|customers\)\b" supabase/migrations/*.sql`, que retorna **zero arquivos**. A única cópia de `CREATE TABLE public.companies` encontrada em todo o repositório está em `src/lib/db/migrations/archive/005_multi_tenant.sql:26` (e sua réplica em `000_schema_completo.sql:101`) — mas essa migration cria `companies` no contexto de uma retrofitagem de multi-tenancy sobre um schema que já existia antes dela (o próprio nome do arquivo, "005", indica que 4 migrations já rodaram antes, e mesmo essas 4 primeiras não contêm o `CREATE TABLE` original de `products`/`customers`). **Conclusão: o schema-base original do sistema (antes de qualquer migration rastreada em git, em qualquer árvore) nunca foi versionado — foi aplicado por execução manual direta no banco, num momento anterior ao início do histórico de migrations em ambas as árvores.**

---

## 6. Qual árvore representa melhor o banco real

**Nenhuma das duas sozinha.** A resposta correta é composta:
- Para qualquer mudança de schema **a partir de meados de maio de 2026 em diante** (quando a Árvore A começa e é mantida continuamente), `supabase/migrations/*.sql` é a fonte mais confiável — é a árvore realmente aplicada incrementalmente.
- Para a **estrutura-base anterior a isso**, nem A nem B têm o registro fiel — B tem uma tentativa de reconstrução que já foi pega errada em pelo menos 2 pontos específicos pelo próprio autor, e não inclui tabelas inteiras (`pedidos`/`pedidos_itens`). A é uma árvore de mudanças incrementais, então por definição também não contém o estado inicial.
- **A única forma de saber com certeza o schema real hoje é ler o banco diretamente** — não há atalho documental confiável. Isso é o motivo de existirem as consultas de leitura da Seção 4 e Seção 5 em `fiscal-audit-readonly.sql`, e por isso a recomendação, já registrada no relatório principal e reafirmada aqui, de rodar `pg_dump --schema-only` (ou as consultas de `information_schema`/`pg_catalog` já preparadas) antes de desenhar qualquer migration fiscal definitiva.

---

## 7. Como impedir que uma migration errada seja aplicada futuramente

Nenhuma destas ações foi executada — são recomendações para decisão e execução futuras, sob autorização separada:

1. **Nunca usar `src/lib/db/migrations/000_schema_completo.sql` como referência ao escrever uma nova migration em `supabase/migrations/`.** Isso já causou pelo menos dois erros documentados (Seção 4). A prática mais segura é sempre consultar o banco real (via as consultas somente-leitura já preparadas) antes de assumir qualquer constraint, tipo de coluna ou default.
2. **Se uma referência consolidada de schema for necessária no dia a dia**, ela deve ser **gerada automaticamente** (via `pg_dump --schema-only` ou `supabase gen types`) e nunca mantida manualmente como um arquivo "vivo" que alguém edita à mão — é exatamente a manutenção manual de `000_schema_completo.sql` que permitiu que ele divergisse do banco real sem ninguém perceber por meses.
3. **Marcar explicitamente a Árvore B como não-autoritativa**, por exemplo com um `README.md` dentro de `src/lib/db/migrations/` avisando "este diretório não reflete o schema real desde `dd/mm/aaaa` — consulte `supabase/migrations/` e o banco real" — isso é uma alteração de conteúdo (criação de arquivo), portanto **não foi feita nesta auditoria**, apenas recomendada para autorização futura.
4. **Formalizar, ainda que informalmente por enquanto (sem ferramenta de CI), a regra de que toda nova migration em `supabase/migrations/` deve ser criada a partir da versão mais recente da função/tabela que está sendo alterada**, não de uma cópia local desatualizada — isso endereça diretamente a causa raiz identificada em `products-total-regression-analysis.md` (a reescrita de `rpc_create_sale` que causou a regressão partiu de uma versão-base anterior à mudança fiscal do dia anterior).
5. **Considerar, como melhoria de processo futura (fora do escopo desta auditoria), introduzir verificação automatizada** — por exemplo, um teste que compare a lista de colunas de um `INSERT INTO sales` recém-escrito contra a lista da versão anterior da mesma função, alertando se uma coluna sumiu sem justificativa explícita no diff. Isso depende de existir CI/CD, que hoje não existe (`fiscal-risk-register.md`, achado B1) — mencionado aqui só como direção, não como proposta a implementar agora.

---

## 8. O histórico precisa ser consolidado?

**Sim, eventualmente — mas não da forma como foi tentado até agora (edição manual de um arquivo único).** A tentativa atual de consolidação (`000_schema_completo.sql`) já provou ser uma fonte de erro em vez de uma proteção contra erro, precisamente porque é mantida manualmente e trata "eu lembro que é assim" como equivalente a "eu conferi no banco que é assim". Uma consolidação útil precisa ser **derivada do banco real**, não escrita de memória.

---

## 9. Estratégia de consolidação sem alterar o banco nesta fase

Proposta, não executada:

1. **Gerar um snapshot real e objetivo do schema**, via `pg_dump --schema-only` (ferramenta padrão do Postgres, não altera nada — só lê e exporta a definição) ou, alternativamente, via as consultas de `information_schema`/`pg_catalog` já preparadas em `fiscal-audit-readonly.sql` (Seções 4 e 5), que cobrem tabelas, colunas, constraints, índices, triggers, functions, views e enums.
2. **Salvar esse snapshot como um arquivo novo e claramente rotulado como gerado/read-only** — por exemplo `docs/schema-snapshot-2026-08-04.sql` — com um cabeçalho explícito indicando que foi gerado automaticamente a partir do banco real nesta data, e que **não deve ser editado à mão**. Esse arquivo seria complementar, não substituiria `supabase/migrations/*` como histórico de mudanças.
3. **Comparar esse snapshot com `000_schema_completo.sql`** para produzir uma lista objetiva e completa de divergências (não só as 3 já conhecidas) — isso responderia de vez à pergunta "o que mais está errado no arquivo consolidado" sem precisar descobrir um erro de cada vez, como aconteceu até agora.
4. **Decidir separadamente, com autorização própria, o que fazer com `src/lib/db/migrations/`** — as opções incluem: (a) deixar como está, mas com aviso explícito de que não é autoritativo; (b) arquivar formalmente (mover para algo como `docs/legacy-schema-reference/`, com aviso); (c) apagar, se for consenso que não tem mais valor nem como referência histórica. **Nenhuma dessas ações foi tomada — nenhum arquivo foi movido, apagado ou renomeado nesta análise, conforme instruído.**
5. Essa consolidação, uma vez feita, deveria ser tratada como um artefato **descartável e regenerável** — se o schema real mudar de novo, gera-se um novo snapshot, nunca se edita o antigo à mão. Isso elimina estruturalmente a classe de problema encontrada nesta análise.

**Nenhuma das ações acima foi executada nesta auditoria.** Este documento é a análise e a proposta; a execução (inclusive rodar o `pg_dump` ou as consultas do Bloco 4/5) depende da sua autorização, e mesmo assim continua sendo uma ação de leitura, não de escrita — a decisão sobre o que fazer com os arquivos das duas árvores (mover/arquivar/apagar) é uma etapa separada e posterior, explicitamente fora do escopo desta rodada.
