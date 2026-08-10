# Plano de Remediação — Policies RLS Abertas

**Tipo:** proposta de correção, **não implementada**. Baseado inteiramente em dados já coletados na rodada anterior de validação ([`fiscal-database-validation-results.md`](fiscal-database-validation-results.md) §3), portanto **não precisou de nova consulta ao banco** — mas incorpora uma descoberta nova feita nesta rodada por leitura direta do código-fonte (ver §0). Nenhum `DROP POLICY`, `ALTER POLICY`, `CREATE POLICY` ou qualquer migration foi executado.

---

## §0 — Descoberta nova desta rodada: o frontend acessa algumas tabelas diretamente

Até esta rodada, toda a auditoria presumiu (corretamente, para o backend) que "a aplicação usa exclusivamente `service_role`". **Isso precisa ser corrigido: o frontend também usa um client Supabase de navegador (`src/lib/supabase/client.ts`, `createBrowserClient` com `NEXT_PUBLIC_SUPABASE_ANON_KEY`), que roda como o papel `authenticated`, não `service_role`.**

Busca feita agora: `grep -rl "from '@/lib/supabase/client'" src/` encontrou 11 arquivos usando esse client; dentro deles, as únicas tabelas/views consultadas diretamente (`.from(...)`) são:

**`customers`, `products`, `product_variations`, `suppliers`, `stock_locations`, `vw_stock_live`** (a última é uma view sobre `stock`).

Arquivos confirmados: `src/app/(dashboard)/vendas/nova/page.tsx` (PDV — consulta/cria `customers`), `src/app/(dashboard)/estoque/entrada/lote/page.tsx`, `.../entrada/matriz/page.tsx`, `.../entrada/page.tsx`, `.../ajuste/page.tsx` (todas consultam `products`/`suppliers`/`stock_locations`/`product_variations`), `src/app/(dashboard)/estoque/localizacoes/page.tsx` (`stock_locations`), `src/app/(dashboard)/estoque/inventario/page.tsx` (`vw_stock_live`), e `src/app/(dashboard)/debug/page.tsx` (`suppliers`, incluindo um teste de `INSERT`+`DELETE` direto do navegador — página protegida por gate de UI `hasMinRole(userRole, 'gerente')`, mas esse gate é só client-side e não impede uma chamada direta à API do Supabase por fora da página).

**Consequência prática:** para essas 5 tabelas + 1 view, a política RLS **não é uma segunda camada de defesa teórica — é a única proteção real que está em uso agora**, porque a aplicação já depende de RLS para essas consultas específicas (o filtro de empresa não é reforçado em nenhum outro lugar para essas chamadas, já que elas vão direto do navegador para o Supabase, sem passar por nenhuma rota de API Next.js que poderia adicionar um `.eq('company_id', ...)`). **Hoje isso não causa nenhum vazamento visível porque só existe 1 empresa no sistema** — mas confirma que corrigir essas policies deixa de ser só "defesa em profundidade teórica" e passa a ser **a correção de um mecanismo de isolamento que a aplicação já usa de verdade**.

Para as outras ~10 tabelas com policy aberta (`sale_items`, `sales`, `cashback_transactions`, `categories`, `collections`, `finance_entries`, `marketing_costs`, `stock`, `stock_lots`, `users`, `audit_log`), nenhum acesso direto do frontend foi encontrado — só `service_role` (backend) as acessa hoje, o que mantém o risco como latente/dormente para essas.

---

## §1 — Inventário completo das policies abertas

Legenda de "Acesso atual da app": **Frontend direto** = navegador usa `authenticated` (client de `src/lib/supabase/client.ts`) para esta tabela; **Só backend** = só API routes via `service_role` (`src/lib/supabase/admin.ts`) tocam esta tabela hoje.

| Tabela | Policy aberta | Papel | Comando | `USING` | `WITH CHECK` | Permissiva/Restritiva | Outras policies na mesma tabela | Impacto do `OR` | Acesso atual da app |
|---|---|---|---|---|---|---|---|---|---|
| `users` | `authenticated_full_access` | `authenticated` | `ALL` | `true` | `true` | Permissiva | **Nenhuma outra** | Sem nenhuma outra policy para combinar — é a única regra, portanto é o próprio comportamento efetivo: acesso total | Só backend |
| `finance_entries` | `authenticated_full_access` | `authenticated` | `ALL` | `true` | `true` | Permissiva | `finance_entries_company` (SELECT, company+role), `finance_entries_select` (SELECT, só role, **sem filtro de empresa**), `finance_entries_insert`/`_update`/`_delete` (role admin/gerente, sem filtro de empresa) | A policy aberta por si só já anula tudo; mas note que **mesmo sem ela**, `finance_entries_select` não filtra por empresa — só por papel | Só backend |
| `sale_items` | `authenticated_full_access` | `authenticated` | `ALL` | `true` | `true` | Permissiva | `sale_items_insert` (`true`), `sale_items_select` (`true`) | Nenhuma das 3 policies desta tabela filtra por empresa — **mesmo removendo a aberta, as outras duas continuam abertas** | Só backend |
| `sales` | `authenticated_full_access` | `authenticated` | `ALL` | `true` | `true` | Permissiva | `sales_company` (SELECT, company-scoped — **a única boa**), `sales_delete` (admin), `sales_insert` (`true`), `sales_select` (`true`), `sales_update` (admin/gerente) | `sales_select`/`sales_insert` continuam abertos mesmo sem a policy `ALL` | Só backend |
| `cashback_transactions` | `authenticated_full_access` | `authenticated` | `ALL` | `true` | `true` | Permissiva | **Nenhuma outra** | Única regra — acesso total efetivo | Só backend |
| `categories` | `authenticated_full_access` | `authenticated` | `ALL` | `true` | `true` | Permissiva | **Nenhuma outra** | Única regra — acesso total efetivo | Frontend indireto (via `products`, que referencia `category_id`, mas a tabela `categories` em si não foi encontrada em `.from('categories')` no client de navegador) |
| `collections` | `authenticated_full_access` | `authenticated` | `ALL` | `true` | `true` | Permissiva | **Nenhuma outra** | Única regra — acesso total efetivo | Só backend |
| `marketing_costs` | `authenticated_full_access` | `authenticated` | `ALL` | `true` | `true` | Permissiva | `marketing_costs_select`/`marketing_costs_write` (role-scoped, **sem filtro de empresa**) | Mesmo padrão de `finance_entries` — falta filtro de empresa mesmo nas policies "boas" | Só backend |
| `stock` | `authenticated_full_access` | `authenticated` | `ALL` | `true` | `true` | Permissiva | `stock_all_write` (role-scoped, sem empresa), `stock_company` (SELECT, company-scoped — boa), `stock_select` (`true`) | `stock_select` continua aberto mesmo sem a policy `ALL` | **Indireto via `vw_stock_live`**, view usada pelo frontend |
| `stock_lots` | `authenticated_full_access` | `authenticated` | `ALL` | `true` | `true` | Permissiva | `stock_lots_insert` (role-scoped, sem empresa), `stock_lots_select` (`true`) | `stock_lots_select` continua aberto mesmo sem a policy `ALL` | Só backend |
| `products` | `authenticated_full_access` | `authenticated` | `ALL` | `true` | `true` | Permissiva | `products_company` (SELECT, company-scoped — boa), `products_delete` (admin), `products_insert` (admin/gerente), `products_select` (`true`), `products_update` (admin/gerente) | `products_select` continua aberto mesmo sem a policy `ALL` | **Frontend direto** |
| `product_variations` | `authenticated_full_access` | `authenticated` | `ALL` | `true` | `true` | Permissiva | `product_variations_delete` (admin), `product_variations_insert` (admin/gerente), `product_variations_select` (`true`), `product_variations_update` (admin/gerente) | **Nenhuma policy desta tabela filtra por empresa, nem mesmo em SELECT** — é a mais exposta entre as tabelas com pelo menos alguma policy própria | **Frontend direto** |
| `suppliers` | `authenticated_full_access` | `authenticated` | `ALL` | `true` | `true` | Permissiva | `suppliers_select` (`true`), `suppliers_write` (role-scoped, sem empresa) | Nenhuma policy filtra por empresa | **Frontend direto** |
| `customers` | `authenticated_full_access` | `authenticated` | `ALL` | `true` | `true` | Permissiva | `customers_company` (ALL, company-scoped — boa), `customers_delete` (admin/gerente), `customers_insert` (`true`), `customers_select` (`true`), `customers_update` (`true`) | `customers_select`/`_insert`/`_update` continuam abertos mesmo sem a policy `ALL` | **Frontend direto** |
| `audit_log` (singular) | `authenticated_full_access` | `authenticated` | `ALL` | `true` | `true` | Permissiva | **Nenhuma outra** | Única regra — acesso total efetivo. Tabela órfã (não usada pelo código atual, ver `fiscal-audit-delta-after-sql.md`) | Nenhum uso confirmado |

**Nota importante que atravessa a tabela inteira:** mesmo removendo `authenticated_full_access` de cada tabela, **8 delas continuariam com pelo menos uma policy própria igualmente aberta** (`sale_items`, `sales_select`/`_insert`, `products_select`, `product_variations` inteira, `suppliers_select`, `stock_select`, `stock_lots_select`, `customers_select`/`_insert`/`_update`). A correção não pode ser "só remover a policy chamada `authenticated_full_access`" — precisa também revisar essas policies "próprias" que já nasceram sem filtro de empresa.

**Tabelas com RLS totalmente desabilitado** (categoria diferente — nem chegou a ter policy, correta ou não): `companies`, `pedidos`, `pedidos_itens`, `returns`, `return_items`, mais ~35 outras já listadas em `fiscal-database-validation-results.md` §3. Fora do foco principal deste plano (que trata de policies abertas), mas citadas na Seção 7 (tabelas que exigem atenção especial) porque a técnica de correção é diferente (habilitar RLS do zero, não só trocar policy).

---

## §2 — Correção proposta por tabela

Princípio geral: **nunca remover uma policy sem antes confirmar que uma policy substituta company-scoped já existe ou é criada na mesma migration** — para não trocar "aberto para todo mundo" por "fechado para todo mundo" e quebrar a aplicação.

| Tabela | Ação proposta |
|---|---|
| `users` | `DROP POLICY authenticated_full_access`. **Não existe nenhuma policy substituta hoje** — precisa criar do zero: SELECT/UPDATE company-scoped (provavelmente só leitura do próprio registro + leitura de colegas da mesma empresa para telas de gestão de usuário; escrita restrita a `admin`) |
| `finance_entries` | `DROP POLICY authenticated_full_access`. Corrigir `finance_entries_select` para incluir `company_id = current_company_id()` além do papel |
| `sale_items` | `DROP POLICY authenticated_full_access`, `sale_items_insert`, `sale_items_select`. Criar policies novas com filtro por empresa (via `EXISTS (SELECT 1 FROM sales WHERE sales.id = sale_items.sale_id AND sales.company_id = current_company_id())`, já que `sale_items` não tem `company_id` própria) |
| `sales` | `DROP POLICY authenticated_full_access`, `sales_select`, `sales_insert`. Manter `sales_company`, `sales_delete`, `sales_update`; adicionar INSERT company-scoped |
| `cashback_transactions` | `DROP POLICY authenticated_full_access`. Criar policies novas — tabela já tem `company_id` própria (confirmado no schema), então é direto: `company_id = current_company_id()` |
| `categories` | `DROP POLICY authenticated_full_access`. **Atenção:** `categories` não tem `company_id` no schema já lido — confirmar antes se categorias são globais (compartilhadas entre empresas) ou por empresa antes de desenhar a policy substituta; se globais, uma policy `SELECT true` para `authenticated` pode ser aceitável, mas write deveria continuar restrito por papel |
| `collections` | Mesmo tratamento de `categories` — confirmar se é catálogo global ou por empresa antes de desenhar a substituta |
| `marketing_costs` | `DROP POLICY authenticated_full_access`. Corrigir `marketing_costs_select`/`_write` para incluir `company_id` |
| `stock` | `DROP POLICY authenticated_full_access`, `stock_select`. Corrigir `stock_all_write` para incluir `company_id`. Manter `stock_company` |
| `stock_lots` | `DROP POLICY authenticated_full_access`, `stock_lots_select`. Corrigir `stock_lots_insert` para incluir `company_id`. Criar SELECT company-scoped |
| `products` | `DROP POLICY authenticated_full_access`, `products_select`. Manter `products_company`, `products_delete`, `products_insert`, `products_update` |
| `product_variations` | `DROP POLICY authenticated_full_access`, `product_variations_select`. **Criar do zero** uma policy company-scoped (via `EXISTS (SELECT 1 FROM products WHERE products.id = product_variations.product_id AND products.company_id = current_company_id())`, já que a tabela não tem `company_id` própria) — hoje não existe nenhuma policy company-scoped nesta tabela |
| `suppliers` | `DROP POLICY authenticated_full_access`, `suppliers_select`. Corrigir `suppliers_write` para incluir `company_id`. Criar SELECT company-scoped (confirmar antes se fornecedores são por empresa — schema já mostrou só 1 fornecedor cadastrado no total, pode ser um catálogo pretendido como compartilhado, precisa confirmação de negócio antes de restringir) |
| `customers` | `DROP POLICY authenticated_full_access`, `customers_select`, `customers_insert`, `customers_update`. Manter `customers_company` (já cobre `ALL`), `customers_delete` |
| `audit_log` (singular) | `DROP POLICY authenticated_full_access`. Como a tabela parece órfã (não usada pelo código atual — ver `fiscal-audit-delta-after-sql.md`), a correção mais simples é **não criar nenhuma policy nova**, deixando RLS habilitado sem nenhuma policy (equivalente a negar tudo para `authenticated`, só `service_role` acessa) — mas confirmar antes que nada depende dela |

---

## §3 — Ordem de aplicação

1. **`categories`, `collections`, `audit_log`** — sem uso confirmado pelo frontend direto e sem dependência de outras tabelas; menor risco de quebrar algo, bom ponto de partida para validar o procedimento.
2. **`suppliers`, `stock_locations`*, `product_variations`, `products`** — usadas pelo frontend direto; corrigir em conjunto porque as telas de entrada de estoque (`estoque/entrada/*`) consultam todas simultaneamente — testar como grupo.
   *(`stock_locations` já está corretamente scoped hoje — só entra na ordem porque é consultada nas mesmas telas que as tabelas acima, útil testar o fluxo completo junto)*
3. **`customers`** — usada no PDV (`vendas/nova`), tela de maior criticidade operacional (não pode quebrar o fluxo de venda); corrigir depois de validar o procedimento nos itens 1-2.
4. **`sale_items`, `sales`** — não acessadas pelo frontend direto, mas centrais ao negócio; qualquer erro aqui afeta o backend inteiro (todas as rotas de `/api/vendas/*`).
5. **`cashback_transactions`, `stock`, `stock_lots`, `marketing_costs`, `finance_entries`** — só backend, criticidade financeira alta, corrigir com테스트 mais cuidadoso.
6. **`users`** — por último, deliberadamente: é a tabela mais sensível (contém `role`), qualquer erro na policy nova pode impedir login/leitura de perfil para todo o sistema. Só corrigir depois de já ter validado o padrão de policy nas 12 tabelas anteriores.

---

## §4 — Testes por perfil

Para cada tabela corrigida, testar com uma sessão real (não `service_role`) de cada papel:

| Perfil | O que testar |
|---|---|
| `admin` | Consegue ler/escrever tudo dentro da própria empresa; **não consegue** ler/escrever nada de outra empresa (mesmo sendo admin) |
| `gerente` | Mesmo teste, respeitando as restrições de comando já existentes (ex.: não pode `DELETE` em `products`, que é `admin`-only) |
| `usuario` (`seller` no banco) | Só as operações já previstas nas policies de papel mais baixo (ex.: `SELECT` em `products`/`customers`, sem `DELETE`) |
| **Sem sessão (anon)** | Confirmar que nenhuma das tabelas corrigidas concede qualquer acesso a `anon` — nenhuma policy lida menciona a role `anon`, mas vale testar explicitamente após a correção, não presumir |

---

## §5 — Teste de isolamento entre empresas

**Bloqueador prático:** hoje só existe 1 empresa real (`Santtorini`, `id=1`) — não é possível testar isolamento entre empresas sem criar uma segunda empresa de teste. Proposta (não executada): criar uma empresa de teste temporária (`companies` com `id` novo, ex. `999`, `slug='teste-isolamento'`) **em ambiente de homologação, se existir até lá** — ou, na ausência de homologação, com extremo cuidado em produção, usando dados sintéticos claramente identificáveis, e removendo a empresa de teste ao final. Teste: criar 1 usuário, 1 cliente, 1 produto na empresa de teste; autenticar como esse usuário; confirmar que a policy corrigida **não retorna nenhuma linha da empresa `Santtorini`** e vice-versa.

---

## §6 — Impacto potencial

- **Maior risco:** quebrar uma consulta legítima que hoje depende implicitamente da policy aberta, sem que ninguém tenha percebido — especialmente nas 5 tabelas/view acessadas diretamente pelo frontend (§0). O PDV (`customers`) é a tela de maior impacto operacional se algo quebrar.
- **Risco médio:** telas de estoque (`estoque/entrada/*`, `estoque/ajuste`, `estoque/localizacoes`, `estoque/inventario`) pararem de listar produtos/fornecedores/locais se a policy nova for restritiva demais.
- **Risco baixo:** tabelas só-backend (`sales`, `sale_items`, `cashback_transactions`, `finance_entries` etc.) — como a aplicação usa `service_role` (que ignora RLS) para essas, corrigir a policy **não deveria ter nenhum efeito observável no funcionamento atual** — o risco aqui é teórico/de segurança, não operacional.

## §7 — Rollback

Para cada tabela, o rollback é sempre: recriar a policy removida com o texto exato capturado nesta análise (`fiscal-database-validation-results.md` §3, tabela completa em §1 acima). Como toda alteração proposta é `DROP POLICY` + `CREATE POLICY` (nunca `ALTER TABLE ... DISABLE ROW LEVEL SECURITY`), o rollback nunca precisa desabilitar RLS — só restaurar a policy antiga. Proposta de execução seletiva por tabela (não em lote) — se uma tabela quebrar algo em teste, reverter só ela, sem precisar desfazer as demais já validadas.

## §8 — Tabelas que exigem atenção especial

- **`users`:** contém `role` — qualquer policy mal desenhada pode causar escalação de privilégio (o problema que estamos corrigindo) ou, no sentido oposto, travar login para todo mundo. Testar exaustivamente antes de aplicar.
- **`product_variations`:** hoje não tem **nenhuma** policy company-scoped, mesmo entre as "próprias" — é a que precisa de mais trabalho de desenho, não só remoção da policy aberta.
- **`sale_items`:** não tem `company_id` própria — a policy substituta precisa de subquery contra `sales`, mais cara computacionalmente que um filtro direto; avaliar índice em `sale_items.sale_id` (já existe, é FK) antes de aplicar em produção com volume.
- **`categories`/`collections`/`suppliers`:** requerem uma decisão de negócio prévia (são catálogos globais ou por empresa?) antes de qualquer policy ser desenhada — não são só uma correção técnica direta como as demais.
- **Tabelas com RLS totalmente desabilitado** (`companies`, `pedidos`, `pedidos_itens`, `returns`, `return_items`, e as ~35 outras da lista completa): fora do escopo principal deste documento (que trata de policy aberta, não de RLS desabilitado), mas merecem um plano irmão futuro — a técnica é diferente (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY` + criar policies do zero, sem nada para remover antes).

## §9 — Quais acessos atuais podem quebrar

Concretamente, com base no §0: se as policies novas para `customers`/`products`/`product_variations`/`suppliers`/`stock` (via `vw_stock_live`) forem restritivas demais (ex.: exigirem papel específico onde hoje `true` permite qualquer `authenticated`), as seguintes telas param de funcionar para usuários de papel mais baixo: PDV (`vendas/nova`, criação/busca de cliente), todas as telas de entrada de estoque, ajuste de estoque, localizações de estoque, inventário. **Nenhuma delas deveria quebrar se a policy nova continuar permitindo `SELECT`/`INSERT` para qualquer `authenticated` da própria empresa** (que é exatamente o que as policies "próprias" já tentavam fazer, só sem o filtro de empresa) — o objetivo da correção é adicionar o filtro de empresa, não restringir por papel além do que já existe.

## §10 — Como testar em homologação antes de produção

**Pré-requisito já registrado como bloqueador em `fiscal-audit-report.md`: não existe ambiente de homologação de aplicação hoje.** Isso vale tanto para o módulo fiscal quanto para esta correção de RLS — ambos dependem da mesma lacuna de infraestrutura. Duas opções, nenhuma executada:
1. **Aguardar a criação do ambiente de homologação** (já recomendada independentemente do módulo fiscal) e testar lá primeiro — caminho mais seguro, mas depende de uma decisão de infraestrutura maior, fora do escopo deste documento.
2. **Testar em produção com extremo cuidado, fora do horário de operação do PDV**, tabela por tabela (seguindo a ordem do §3), com rollback pronto para cada uma, e com um usuário de teste dedicado (não uma conta real) para os testes de perfil do §4. Esta opção é mais arriscada e só deveria ser adotada se a criação de homologação não for viável no curto prazo — **decisão de negócio, não técnica, a ser tomada pela Santtorini antes de autorizar a execução deste plano**.

---

**Nenhuma parte deste plano foi executada.** Fica pronto para autorização separada, tabela por tabela ou em lote, conforme a ordem proposta no §3.
