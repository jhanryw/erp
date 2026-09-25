# Mercado Livre — Fase 2: anúncios (Marketplace Hub / channel_listings)

Status: **implementado e testado localmente**. A homologação no usuário TEST
do Mercado Livre (roteiro na seção 10) **ainda precisa ser executada** por
quem tem as credenciais do DevCenter. Nada foi publicado em conta real.

Fora de escopo (não implementado): pedidos, webhooks de pedidos, baixa de
estoque vinda do ML, Mercado Envios, fiscal, devoluções, reclamações,
Ads, `channel_orders`, envios, mensagens.

---

## 1. Migration

`supabase/migrations/202609251000_channel_listings.sql` — 100% aditiva.

**Tabela `channel_listings`** (genérica, não é específica do ML), 1 linha = 1 variação vendável × 1 conta de canal:

| Grupo | Colunas |
|---|---|
| Vínculo | `company_id`, `integration_id` → `company_integrations`, `provider`, `product_id`, `product_variation_id`, `seller_sku` |
| IDs externos | `external_listing_id` (ML item_id), `external_variant_id` (variation_id, legado), `external_product_id` (user_product_id), `external_group_id` (family_id), `external_ids jsonb` (extensível), `external_category_id`, `permalink` |
| Estado | `local_status` (draft/publishing/active/paused/error/closed) **separado** de `external_status` + `external_sub_status[]` |
| Preço/qtd | `channel_price` (NULL = herda o Qarvon), `last_sent_price`, `synced_quantity`, `last_synced_at`, `last_error` |
| Idempotência | `publish_attempt_id`, `publish_lease_until` |
| Outros | `metadata jsonb` (categoria, tipo de anúncio, atributos, descrição, family_name, modelo) — nunca segredo |

- Único parcial: 1 vínculo vivo por `(integration_id, product_variation_id)`; o mesmo anúncio externo não é vinculado duas vezes.
- Trigger `fn_channel_listings_validate`: integração, produto e variação têm de ser **da mesma empresa** (e integração do mesmo provider).
- RPCs (`SECURITY DEFINER`, só `service_role`): `rpc_begin_channel_listing_publish`, `rpc_complete_channel_listing_publish`, `rpc_fail_channel_listing_publish`.
- RLS ligado, deny-by-default; `anon`/`authenticated` sem acesso.

Aplicar no Supabase **manualmente** (SQL Editor), depois da migration da Fase 1 (`202609241000`).

## 2. Interface genérica e adaptador

- `src/lib/channels/types.ts` — `ChannelAdapter` (`publishListing`, `fetchListing`, `updateListing`, `updatePrice`, `updateQuantity`, `pauseListing`, `activateListing`, `findListingsBySellerSku`), `ChannelListingDraft`, `ChannelListingSnapshot`, `resolveLocalStatus`.
- `src/lib/integrations/mercadolivre/adapter.ts` — `createMercadoLivreAdapter`. Todas as chamadas passam por `mercadoLivreRequest` (token/refresh/erros da Fase 1).
- `src/services/channels/listings.service.ts` — serviço **genérico** (publicar, sincronizar, pausar, reativar, reconciliar, overview p/ UI). Não conhece kit nem `stock_balances`.
- `src/services/channels/mercadolivreChannel.ts` — única ponte serviço genérico ↔ ML (conta, site/moeda, modelo UP/legado, formulário de categoria).

| Operação | Chamada ML |
|---|---|
| validar | `POST /items/validate` (mesmo corpo; 204 = ok; 400 com `cause[]` → erros bloqueiam, warnings não) |
| publicar | `POST /items` (+ `POST /items/{id}/description`, + `GET /user-products/{id}` p/ family_id) |
| buscar | `GET /items/{id}` |
| preço | `PUT /items/{id} {price}` |
| quantidade | `PUT /items/{id} {available_quantity}` (absoluta) |
| pausar / reativar | `PUT /items/{id} {status: paused/active}` |
| reconciliar | `GET /users/{seller}/items/search?seller_sku=` |
| categoria | `GET /sites/{site}/domain_discovery/search`, `GET /categories/{id}`, `GET /categories/{id}/attributes`, `POST /categories/{id}/attributes/conditional` |

## 3. Endpoints (mínimo papel: gerente; empresa sempre da sessão)

| Método | Rota | Uso |
|---|---|---|
| GET | `/api/integrations/mercadolivre/categories/search?q=` | preditor de categoria |
| GET | `/api/integrations/mercadolivre/categories/{id}?product_id=` | detalhe + atributos (comuns × por variação) + sugestões |
| GET | `/api/channels/listings?product_id=` | "Canais de venda" do produto |
| POST | `/api/channels/listings` | publicar variações selecionadas |
| POST | `/api/channels/listings/{id}/sync` | sincronizar quantidade + preço |
| POST | `/api/channels/listings/{id}/pause` | pausar |
| POST | `/api/channels/listings/{id}/activate` | reativar |
| POST | `/api/channels/listings/{id}/reconcile` | reconciliar por SKU |

## 4. UI

Detalhe do produto → **Canais de venda** (`src/components/channels/channel-listings-panel.tsx`, visível para gerente+):

- conta conectada (nickname, site, selo TEST); aviso se a conta não for TEST;
- por variação: SKU, preço Qarvon, disponível, status local + status/sub_status do ML, ID externo, quantidade enviada, preço enviado, última sincronização, erro/aviso;
- ações: **Sincronizar**, **Pausar/Reativar**, **Abrir no ML**; **Reconciliar** quando não há ID externo;
- **Publicar no Mercado Livre**: categoria (sugerida pelo nome do produto) → nome da família, tipo de anúncio, descrição → atributos da categoria (obrigatórios/condicionais marcados, sugestões pré-preenchidas) → variações (seleção, preço do canal opcional, atributos por variação) → prévia (conta, categoria, quantidade de variações) → publicar; resultado por variação.

## 5. Categoria e atributos

- Categoria: preditor (`domain_discovery`); a escolhida precisa ser folha com `listing_allowed`.
- Atributos **100% dinâmicos** por categoria (nada fixo de lingerie). Cache em memória com TTL de 1h.
- Filtros: `read_only`, `fixed`/`inferred` e `SELLER_SKU` saem do formulário.
- Obrigatórios = `required` + `new_required` + **condicionais** resolvidos no servidor via `/attributes/conditional`. `GTIN` pode ser substituído por `EMPTY_GTIN_REASON`.
- Por variação: `allow_variations` / `variation_attribute` / hierarquia `CHILD_PK` (ex.: COLOR, SIZE).
- Sugestões por semântica: `BRAND` ← marca, `MODEL` ← modelo, `COLOR`/`MAIN_COLOR` ← cor, `SIZE` ← tamanho (casando `value_id` quando a lista tem o valor). O usuário confere tudo.
- Validado **antes** de chamar o ML: preço > 0, imagens válidas, obrigatórios preenchidos.
- Depois da reserva (lease) e **antes** do `POST /items`: `POST /items/validate` com o corpo final. `cause` do tipo `error` → `validation_failed`, vínculo em `error` com a mensagem do ML, **nenhum `POST /items`**. Só `warning` → publica e grava o aviso em `last_error` (`aviso: …`). Falha de transporte/autenticação na validação (5xx, 401, timeout) → `channel_error`, também sem `POST /items` (não se presume válido).

## 6. User Products

- Modelo detectado **ao vivo** pela tag `user_product_seller` em `/users/me`.
- UP: envia `family_name` (sem `title`, sem array `variations`). Legado: envia `title` (truncado em `max_title_length`).
- Em **ambos** o Qarvon publica 1 item por variação vendável (mesmo grão de `channel_listings`); a migração de modelo não muda o vínculo.
- Persistidos: `item_id` → `external_listing_id`, `user_product_id` → `external_product_id`, `family_id` → `external_group_id`, e todos também em `external_ids`.

## 7. Quantidade, preço e status

- Quantidade = `getVariationAvailability(..., 'online_priority')` (camada central). **Sempre absoluta**, nunca negativa.
- Qarvon desativado (produto/variação/habilitação manual) → não publica; na sincronização envia 0; reativação bloqueada.
- Preço = `channel_price ?? price_override ?? base_price`. Sincroniza só se mudou. Se o ML ignorar o preço (automação de preços), fica **aviso** em `last_error` e `last_sent_price` não é atualizado.
- Qtd 0 → ML `paused/out_of_stock` e o ML reativa sozinho ao repor; local continua `active`.
- Pausa manual → ML `paused_by_seller`; **nunca** reativada por sincronização (só pelo botão Reativar).

## 8. Kits

Kit é uma variação vendável como qualquer outra: SKU do kit em `SELLER_SKU`, preço do kit, quantidade derivada pela camada central (menor múltiplo dos componentes). Nenhum componente, SKU de componente ou composição é enviado ao ML. O serviço de anúncios não tem `if kit`.

## 9. Idempotência e reconciliação

1. `begin` cria/assume a linha em `publishing` com lease (`attempt_id`) **antes** de chamar o ML. Resultados: `claimed`, `already_published`, `in_progress` (lease vivo), `needs_reconciliation` (lease vencido em `publishing`).
2. Sucesso → `complete` (só o dono do attempt; fencing). Erro → `fail` (`error`, linha reaproveitada na próxima tentativa).
3. Queda entre o ML criar o item e o salvamento → a próxima tentativa **não republica**: busca por `seller_sku`. 1 resultado → vincula; 0 → libera nova publicação; >1 → não escolhe sozinho (lista candidatos em `last_error`/`metadata`).

**Trava de homologação:** `publishListings` só cria anúncios em usuário **TEST** do ML (tag `test_user` ao vivo). Conta real → `403 real_account_blocked`, a menos que `CHANNEL_LISTINGS_ALLOW_REAL_ACCOUNTS=true`. **Não ligar essa flag antes da homologação aprovada.**

## 10. Roteiro de homologação (usuário TEST do vendedor, sem compra)

Pré-requisitos: migrations `202609241000` e `202609251000` aplicadas em ambiente de **homologação**; app ML do DevCenter; usuário TEST vendedor criado (`POST /users/test_user`, ver runbook da Fase 1) e conectado em Configurações → Mercado Livre (selo **TEST**). Se o TEST user precisar do modelo User Products, solicitar a habilitação ao ML (formulário), senão ele publica no modelo legado. Imagens em JPG/PNG no bucket público.

**Teste A — produto normal**
1. Criar produto "TESTE ML Sutiã" com 2 variações (ex.: Preto M, Preto G), saldo 5 e 0, imagens JPG.
2. Canais de venda → Publicar → categoria sugerida → preencher obrigatórios (BRAND, MODEL, SIZE, GTIN ou EMPTY_GTIN_REASON) → publicar as 2.
3. Conferir: 2 itens no ML; `SELLER_SKU` = SKU da variação; qtd 5 (ativo) e 0 (paused/out_of_stock); preço = Qarvon; IDs e status na tela; link "Abrir" funciona.
4. Mudar saldo para 3 → Sincronizar → ML mostra 3. Mudar preço → Sincronizar → preço novo (ou aviso de automação).
5. Pausar → ML `paused_by_seller`; Sincronizar com estoque → continua pausado; Reativar → ativo.
6. Publicar de novo a mesma variação → "já publicada", sem item novo.

**Teste B — kit**
1. Criar kit "TESTE ML Kit 3 calcinhas" (componente com saldo 7, qtd 3 no kit → disponível 2).
2. Publicar → item com `SELLER_SKU` = SKU do kit, preço do kit, qtd 2; nenhum dado de componente no anúncio.
3. Ajustar saldo do componente para 3 → Sincronizar → qtd 1. Zerar → qtd 0 (out_of_stock).
4. Desativar o kit no Qarvon → Sincronizar envia 0; Reativar bloqueado.

Registrar para cada passo: ID do item, user_product_id/family_id, status/sub_status, prints. **Não comprar.** Ao final, pausar os itens de teste.

## 11. Testes

- `src/lib/integrations/mercadolivre/listings.test.ts` (22): payload UP×legado, SELLER_SKU, imagens, parse, sugestões, status, catálogo (atributos, condicionais, GTIN, cache), adapter contra ML simulado.
- `src/services/channels/listings.service.test.ts` (32): validação prévia (válido, categoria inválida, obrigatório, imagem, warning não bloqueia, erro+warning, 5xx na validação, kit), produto normal, kit, preço do canal, duplicidade, concorrência, erro, queda + reconciliação, ambíguo, desativado, imagens, obrigatórios, multi-tenant, needs_reauth, trava de conta real, refresh de token, sync, qtd zero, pausa manual, automação de preço, erro no sync.
- `src/app/api/channels/routes.test.ts` (5): 401/403, empresa da sessão, validação, mapeamento de erros, sem tokens.
- `supabase/tests/channel_listings.test.sql` (35 checagens): begin/complete/fail, fencing, needs_reconciliation, unicidade, trigger multi-tenant, CHECKs, RLS, grants.
- Double: `src/lib/integrations/mercadolivre/fakeMlMarket.testutil.ts`.

## 12. Limitações conhecidas da API / desta fase

- Vendedores **multi-origem** (estoque por depósito) usam `PUT /user-products/{id}/stock/type/seller_warehouse` com `x-version` — não implementado; o `PUT /items` de quantidade falha para eles.
- Automação de preços do ML pode ignorar o preço enviado (tratado como aviso).
- Usuário TEST pode não ter a tag `user_product_seller` sem pedido ao ML.
- ML aceita só JPG/JPEG/PNG (500–1920 px); webp e URLs assinadas são recusadas antes do envio.
- Máx. 30 itens por User Product (família).
- Sincronização é **manual** nesta fase (sem job/evento de estoque para canais).
- `updateListing` (título/imagens/atributos) existe no adaptador, mas não tem botão na UI.
- Produto sem campo de descrição/GTIN no Qarvon: informados no formulário e guardados em `metadata`.

## 13. Retry após falha (estado republicável)

| Onde falhou | Nada criado no ML? | Estado local | Ação na UI |
|---|---|---|---|
| validação local / `POST /items/validate` (erro ou 5xx) | sim | `draft` | **Publicar novamente** |
| `POST /items` recusado (400/401/403/404) | sim | `draft` | **Publicar novamente** |
| `POST /items` sem resposta (timeout/5xx/rede) | incerto | `error` | **Reconciliar** (e publicar reconcilia antes, nunca duplica) |
| reconciliação sem anúncio com o SKU | sim | `draft` (ids externos limpos) | **Publicar novamente** |

- A linha nunca é apagada (idempotência); a nova tentativa reaproveita a mesma linha.
- `metadata.last_attempt` + `metadata.attempts[]` (últimas 10) guardam etapa, erro, preço e quantidade da tentativa — histórico, nunca bloqueia.
- A UI mostra o erro como **"Tentativa anterior (data)"** e, se preço/quantidade mudaram desde então, avisa que ele pode não se aplicar mais. "Publicar novamente" pré-preenche categoria/atributos da tentativa anterior.

## 14. Tabela de medidas (SIZE_GRID_ID) — dinâmica

Doc ML "Guia de tamanhos" (primeiros passos / gerenciar / validações):

1. A categoria usa tabela quando tem atributo `value_type: grid_id` (SIZE_GRID_ID) e `grid_row_id` (SIZE_GRID_ROW_ID) — detectado pelos tipos, sem lista de categorias; esses atributos saem do formulário digitável.
2. Filtros da busca = atributos `grid_template_required`/`grid_filter` da ficha técnica do domínio (`GET /domains/{domain_id}/technical_specs`), com os valores preenchidos (ex.: GENDER, BRAND).
3. `POST /catalog/charts/search` {domain_id sem prefixo do site, site_id, seller_id, attributes} → tabelas BRAND/STANDARD/SPECIFIC da conta.
4. `GET /catalog/charts/{id}` → linhas; cada variação é casada pela igualdade de tamanho (SIZE/atributo principal), com escolha manual quando não há correspondência única.
5. Publicação: SIZE_GRID_ID no nível do item e SIZE_GRID_ROW_ID por variação; o `/items/validate` confere (erros `missing/invalid.fashion_grid.*` bloqueiam; SIZE diferente da linha é warning).
6. `domain_not_active` na busca = domínio não usa tabela → não bloqueia. Nenhuma tabela encontrada → criar a tabela da conta no ML (criação via API `POST /catalog/charts` não implementada nesta fase).

Endpoints: `POST /api/integrations/mercadolivre/size-charts/search`, `GET /api/integrations/mercadolivre/size-charts/{chartId}` (gerente+, empresa da sessão).

### 14.1 Criação de tabela SPECIFIC no fluxo de publicação

Quando a busca não retorna tabelas: **Nenhuma tabela encontrada → [Criar tabela de medidas]**.

1. `domain_id` vem do preditor de categoria (guardado no vínculo para retry).
2. Filtros obrigatórios da ficha do domínio (`grid_template_required`, ex.: gênero) → `POST /domains/{domain_id}/technical_specs?section=grids` devolve a ficha da TABELA.
3. Formulário montado da ficha: campos gerais (`grid_filter`/`grid_template_required`, sem `read_only`), atributo principal (`main_attribute_candidate`), tipo de medida (tags `BODY_MEASURE`/`CLOTHING_MEASURE`, quando existirem) e colunas das linhas (`required` do tipo escolhido; listas como seleção; `number_unit` com a unidade padrão da ficha).
4. Linhas iniciais = tamanhos das variações selecionadas (ex.: P, M, G, GG), editáveis.
5. `POST /catalog/charts` (nome ≤ 60 só letras/números/espaços; domínio sem prefixo; gerais fora das linhas). Corpo montado e validado **no servidor** a partir da ficha recém-consultada.
6. Após criar: nova busca, seleção automática da tabela criada e casamento de cada variação com seu `SIZE_GRID_ROW_ID`.
7. Publicar: `/items/validate` com `SIZE_GRID_ID` + `SIZE_GRID_ROW_ID` e, só se aprovado, `POST /items`.

Criar tabela é escrita externa: mesma trava da publicação (só usuário TEST do ML, salvo `CHANNEL_LISTINGS_ALLOW_REAL_ACCOUNTS=true`).
Endpoints: `POST /api/integrations/mercadolivre/size-charts/template`, `POST /api/integrations/mercadolivre/size-charts`.

## 15. 1 variação → N ofertas (202609260900)

Uma variação vendável (produto normal ou kit) pode ter N anúncios no MESMO
canal/integração — ex.: ML Clássico R$ 39,90 + ML Premium R$ 44,90 + oferta
`promo-4190`. Estoque pertence à variação (kit: disponibilidade derivada);
preço, status e condições comerciais pertencem a cada anúncio.

- `channel_listings.offer_key` — chave estável da oferta dentro da variação (idempotência). Padrão = `listing_type_id`; o usuário pode definir outra (slug) para duas ofertas do mesmo tipo.
- `channel_listings.listing_type_id` — condição comercial (antes só em `metadata`).
- Unicidade: `(integration_id, product_variation_id, offer_key)` entre vínculos vivos (antes: 1 por variação).
- `rpc_begin_channel_listing_publish(..., p_offer_key, p_listing_type_id)` reserva POR OFERTA.
- Reconciliação por SKU com N ofertas desempata pelo tipo de anúncio/categoria da oferta; nunca escolhe no chute.
- Overview/UI: `listings[]` por variação; cada oferta com status, preço efetivo, quantidade enviada e ações próprias; botão **Nova oferta**.
- Fan-out de estoque: todas as ofertas vivas da variação (e dos kits dependentes) recebem a mesma quantidade absoluta.
- Vínculos existentes preservados: `offer_key` preenchido com o tipo de anúncio da publicação (ou `default`).
- Política do ML: duas ofertas do MESMO tipo para o mesmo produto podem ser moderadas como duplicadas; Clássico × Premium é o uso previsto.

## 16. Fase 4 — gestão comercial por oferta

Sem migration: tudo sobre `channel_listings` (genérico) + adapter/metadata do ML.

| Recurso | Implementação |
|---|---|
| Preço por oferta | `POST /api/channels/listings/{id}/price {price}` → `updateListingPrice`: valida (> 0, 2 casas) → `PUT /items/{id}` → **só com o preço devolvido = pedido** grava `channel_price`/`last_sent_price`; senão `not_applied`/`failed` com erro. Não mexe em preço-base, outras ofertas, Nuvemshop ou PDV. |
| Histórico de preço | `channel_listings.metadata.price_history` (últimos 20): anterior, pedido, horário, resultado (`applied`/`not_applied`/`failed`), erro do canal, usuário. |
| Tipos de anúncio | `GET /api/integrations/mercadolivre/listing-types?category_id=` → `GET /users/{seller}/available_listing_types?category_id=` (nada fixo; cache 1 h). |
| Tarifa estimada | `GET /api/channels/listings/{id}/fee-estimate?price=` e `GET /api/integrations/mercadolivre/fee-estimate?category_id=&listing_type_id=&price=` → `GET /sites/{site}/listing_prices` (`sale_fee_amount`, `percentage_fee`, `fixed_fee`, `financing_add_on_fee`); líquido estimado = preço − tarifa (sem frete). **Só leitura; nunca entra no financeiro** (o financeiro usa a tarifa real do pedido). |
| Métricas por oferta | overview agrega `channel_order_items` × `channel_orders` importados (não cancelados) por `channel_listing_id`: unidades, pedidos, bruto, tarifa real (linha ou rateio), frete/custos rateados, líquido, ticket médio; vendas com oferta ambígua ficam à parte. |
| Estoque | continua da variação (camada central); todas as ofertas recebem a mesma quantidade; sem quantidade manual por oferta. |
| Segurança | toda escrita em anúncio (preço, sync, pausa, reativação, publicação, tabela de medidas) exige usuário TEST salvo `CHANNEL_LISTINGS_ALLOW_REAL_ACCOUNTS=true`. |

UI (Canais de venda): por variação "Estoque disponível no Qarvon"; por oferta
tipo, preço (próprio ou herdado), quantidade sincronizada, status, tarifa
estimada sob demanda, vendas reais, última alteração de preço e ações
**Editar preço · Sincronizar · Pausar/Reativar · Abrir**; "Nova oferta" com
tipos da API e tarifa estimada ao vivo.
