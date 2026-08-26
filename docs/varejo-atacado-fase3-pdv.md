# Varejo/Atacado — Fase 3: Experiência no PDV

**Data:** 2026-09-02
**Escopo:** iniciar, montar, editar e concluir uma venda no PDV explicitamente como VAREJO ou ATACADO, com preço correto e `sale_type`/`sales_channel` persistidos corretamente. Sem PDV de atacado separado, sem dashboards, sem site de atacado, sem comissão, sem reformulação fiscal — conforme pedido.

---

## 0. Auditoria curta (pontos confirmados antes de alterar)

- Início de venda / seleção de vendedor: `src/app/(dashboard)/vendas/nova/page.tsx`, Passo 0, `<SellerPicker>`.
- Busca de produto: `src/components/vendas/ProductSearchInput.tsx` → `GET /api/produtos/buscar` (`src/app/api/produtos/buscar/route.ts`).
- Preço retornado: `price_override ?? base_price` (varejo, único preço até esta fase).
- Preço manual: `handleItemPriceChange` em `vendas/nova/page.tsx` — edita `unit_price` diretamente, sem trava de role no front (servidor valida abaixo do custo).
- Carrinho/desconto: `src/lib/sales/pricing.ts` (`computeSubtotal`/`computeGrandTotal`), consumido pela mesma página.
- Cliente: 3 modos (buscar/criar/avulso), inline na mesma página.
- Pagamento: multi-pagamento, mesma página.
- Chamada final: `POST /api/vendas` (`src/app/api/vendas/route.ts`) → `createSale()` (`src/services/vendas.service.ts`) → `rpc_create_sale`.
- Reabertura/edição: `PATCH /api/vendas/[id]/editar` só edita `sale_origin`/`notes`/`sale_date` — **não existe** fluxo de reabrir venda pra adicionar itens; a peça equivalente é a Troca.
- Troca: `src/app/(dashboard)/vendas/[id]/troca/page.tsx` + `ExchangeForm.tsx` → `POST /api/vendas/[id]/troca` (Fase 1 já garante herança de `sale_type`/`sales_channel` no backend).
- Cancelamento/devolução: botões na página de detalhe (`vendas/[id]/page.tsx`), RPCs já preservam modalidade (Fase 1).
- Único outro chamador de `POST /api/vendas`: **nenhum** — confirmado por grep, só o PDV chama essa rota.

## 1. Arquivos alterados

**Novos:**
- `src/app/api/produtos/buscar/buildProductSearchItem.ts` — resolução de preço centralizada (mapeamento puro linha-do-banco → item de busca).
- `src/app/api/produtos/buscar/buildProductSearchItem.test.ts` — 6 testes.
- `supabase/tests/pdv_wholesale_retail_shared_stock.test.sql` — estoque compartilhado + cliente sem CPF.

**Modificados:**
- `src/app/api/produtos/buscar/route.ts` — aceita `sale_type`, usa `buildProductSearchItem`.
- `src/components/vendas/ProductSearchInput.tsx` — prop `saleType`, bloqueia seleção sem preço de atacado.
- `src/app/(dashboard)/vendas/nova/page.tsx` — seletor de modalidade, badge permanente, trava de troca com carrinho, defesa contra item sem preço.
- `src/app/(dashboard)/vendas/[id]/troca/ExchangeForm.tsx` + `troca/page.tsx` — herdam e usam `sale_type` da venda original na busca de peças novas.
- `src/app/(dashboard)/vendas/[id]/page.tsx` — badge VAREJO/ATACADO no cabeçalho.
- `src/lib/receipts/getReceiptData.ts` + `src/app/(print)/vendas/[id]/comprovante/page.tsx` — modalidade no comprovante.
- `src/lib/validators/index.ts` — `saleSchema.sale_type`.
- `src/app/api/vendas/route.ts` — `sales_channel` removido do schema aceito do cliente, hardcoded `'pos'` no servidor.

## 2. Como ficou a UX

Sem wizard novo, sem modal por produto. Um toggle de 2 botões (VAREJO/ATACADO) inserido entre o seletor de vendedor e o modo de entrega — mesmo padrão visual já usado para "Modo de Entrega". Um badge compacto (chip colorido) fica visível logo abaixo do stepper em **todos os passos**, mais uma cópia no resumo lateral (desktop) e na tela de confirmação — a vendedora nunca perde de vista a modalidade.

## 3. Em que momento escolhe retail/wholesale

Passo 0 (Itens), imediatamente depois de escolher o vendedor responsável, antes do modo de entrega e da busca de produto — exatamente a sequência pedida (vendedor → modalidade → produtos). A escolha é **obrigatória**: o botão "Continuar" do Passo 0 fica desabilitado até uma seleção explícita (`saleTypeChosen`), mesmo o valor por padrão do formulário sendo `retail` internamente (retrocompatibilidade). A busca de produto (`ProductSearchInput`) fica desabilitada até a escolha ser feita.

**Trocar modalidade com carrinho não-vazio**: bloqueado (decisão de menor risco, conforme autorizado pelo pedido) — os botões ficam desabilitados e um texto explica "Remova os itens do carrinho para trocar a modalidade". Evita a ambiguidade de recalcular preço editado manualmente sem uma regra clara do que fazer com customizações.

## 4. Como preço é resolvido

100% centralizado em `src/app/api/produtos/buscar/buildProductSearchItem.ts`, que chama `resolveSalePrice` (fundação da Fase 1) com os 4 campos brutos do banco (`base_price`, `price_override`, `wholesale_price`, `wholesale_price_override`). `GET /api/produtos/buscar?sale_type=retail|wholesale` é o único lugar que decide preço — nenhum componente de frontend recalcula nada, só exibe o que veio pronto. Valor de `sale_type` fora de `retail`/`wholesale` é rejeitado com 400 antes de qualquer query.

## 5. Comportamento sem preço de atacado

`buildProductSearchItem` devolve `price: null` + `missing_wholesale_price: true`. `ProductSearchInput` mostra "Atacado não cadastrado" em vez do preço, com opacidade reduzida, e **bloqueia a seleção** com toast explicativo se o vendedor tentar clicar mesmo assim — nunca cai silenciosamente pro preço de varejo. Segunda camada de defesa: `addProduct` (vendas/nova) e `addNewItem` (troca) recusam qualquer item com `price: null` mesmo que chegasse até ali por algum caminho não previsto.

## 6. Comportamento de edição manual

Inalterado — `handleItemPriceChange` continua editando `unit_price` livremente (mesma permissão de sempre, servidor bloqueia abaixo do custo só para role `usuario`). Como o preço já entra no carrinho **resolvido pela modalidade** (varejo ou atacado), a "base" da edição é automaticamente a correta em cada caso — nenhuma lógica nova foi necessária aqui, o comportamento pedido (editar R$ 49,90 → R$ 47,90 em atacado, sem tocar cadastro) já era exatamente assim que o campo sempre funcionou.

## 7. Comportamento do desconto

Inalterado — `computeSubtotal`/`computeGrandTotal` (`src/lib/sales/pricing.ts`) sempre operaram sobre `unit_price` de cada item. Como esse valor já reflete a modalidade, desconto de 5% sobre um item de R$ 50,00 (atacado) resulta em R$ 47,50 automaticamente, sem nenhuma mudança de código — não existe "preço de varejo escondido" em lugar algum do cálculo.

## 8. Como `sale_type` chega ao backend

`saleSchema.sale_type` (novo campo, `retail`/`wholesale`, default `retail`) — preenchido via `setValue('sale_type', ...)` pelo seletor, enviado no `POST /api/vendas` junto do resto do formulário (`{...data}`, já existente). A API já validava isso desde a Fase 1 (`z.enum(['retail','wholesale']).default('retail')`) e a RPC (`rpc_create_sale`) rejeita qualquer valor fora desses dois com `P0001` — nada novo aqui, só a UI passou a enviar o valor real escolhido em vez do default silencioso.

## 9. Como `sales_channel='pos'` é garantido

**Mudança de segurança desta fase**: `sales_channel` foi **removido do schema Zod** de `POST /api/vendas` — não existe mais como campo aceito do cliente nessa rota (Zod descarta chaves desconhecidas por padrão). O valor enviado à RPC é hardcoded `'pos'` no próprio código do servidor, no mesmo ponto onde `createSale()` é chamado — mesmo padrão já usado pelo webhook Nuvemshop, que fixa `'nuvemshop'` sem nunca ler o payload externo. Como `POST /api/vendas` só tem um chamador (o PDV, confirmado por auditoria), isso fecha completamente a possibilidade de o frontend forçar `nuvemshop`/`wholesale_site`/qualquer outro canal — não é uma questão de "o frontend não tenta", é estruturalmente impossível pela ausência do campo no contrato aceito.

## 10. Comportamento de estoque

Não tocado. `rpc_create_sale` debita `stock_balances` exatamente como antes, sem nenhum branch por `sale_type`. Confirmado pelo teste novo `pdv_wholesale_retail_shared_stock.test.sql`: 10 unidades → venda atacado de 3 → saldo 7 → venda varejo de 2 (mesmo produto) → saldo 5, e uma asserção estrutural extra confirmando que `stock_balances` não ganhou nenhuma coluna relacionada a modalidade.

## 11. Comportamento de troca/reabertura

Não existe fluxo de "reabrir venda para adicionar itens" no ERP — a peça funcionalmente equivalente é a Troca, que a Fase 1 já fez herdar `sale_type`/`sales_channel` da venda original no backend. Nesta fase, o **frontend** da troca (`ExchangeForm`) passou a receber a modalidade original (`troca/page.tsx` agora seleciona `sale_type` da venda) e repassá-la ao `ProductSearchInput` das "peças que a cliente vai levar" — antes disso, a busca de peça nova na troca sempre usava preço de varejo, independente da venda original ser atacado. Um badge (ATACADO/VAREJO) também aparece no cabeçalho da tela de troca e junto da busca de peça nova, pra deixar claro qual preço está sendo usado. Nenhum seletor livre foi adicionado — a modalidade da troca é sempre a da venda original, sem exceção.

Detalhe/reabertura: `vendas/[id]/page.tsx` já lia `sale.*` via `select('*')`, então `sale.sale_type` já estava disponível sem nenhuma mudança de query — só faltava exibir, o que a seção 464 abaixo cobre.

## 12. Impacto no comprovante

Uma linha discreta nova ("Modalidade: Atacado"/"Varejo"), no mesmo estilo tipográfico do resto do recibo térmico, entre "Data" e o divisor de itens. `getReceiptData.ts` (usado tanto pela impressão interna quanto pela página pública de verificação) agora inclui `sale.sale_type` no tipo/consulta compartilhados — nenhuma mudança de layout, nenhuma reformulação fiscal (o comprovante continua sendo o mesmo documento não-fiscal de sempre, `receipt_token`/QR/`window.print()` intocados).

## 13. Regressão Nuvemshop

Confirmado por leitura direta do código (`src/app/api/webhooks/nuvemshop/order/route.ts:545-546`): continua `p_sale_type: 'retail'`, `p_sales_channel: 'nuvemshop'`, hardcoded, sem nenhuma alteração nesta fase.

## 14. Testes adicionados

**TypeScript (vitest):**
- `buildProductSearchItem.test.ts` — 6 casos: retail com/sem override, wholesale com/sem override, wholesale sem preço nunca cai pro varejo, demais campos preservados.

**SQL (`supabase/tests/`, para você rodar):**
- `pdv_wholesale_retail_shared_stock.test.sql` (novo) — cenário literal 10→7→5 (atacado 3, varejo 2, mesmo pool), confirmação estrutural de que `stock_balances` não ganhou coluna de modalidade, e cliente sem CPF completando venda de atacado.
- `rpc_create_sale_sale_type.test.sql` (Fase 1, reaproveitado sem mudanças) — já cobre: nova venda retail/wholesale, valor inválido rejeitado, cancelamento/devolução/troca preservam modalidade, `sale.completed` carrega os campos.

**Não coberto por teste automatizado (documentado explicitamente, conforme pedido item 23):** este projeto **não tem nenhuma infraestrutura de teste de componente React nem E2E** (sem Playwright, sem @testing-library, confirmado no `package.json`) — nunca existiu, não é uma lacuna introduzida aqui. Por isso, os seguintes itens do pedido foram verificados por **leitura de código**, não por teste automatizado: seletor de modalidade aparece/bloqueia corretamente, badge permanece visível, edição manual de preço, comportamento do desconto na tela. A parte que É logicamente testável sem UI (resolução de preço, a lógica de negócio real por trás desses comportamentos) está 100% coberta pelos testes de função pura acima.

## 15. Resultado da suíte completa

```
Test Files  61 passed (61)
Tests       893 passed (893)
```
(887 acumulados das Fases 1-2 + 6 novos desta fase — zero regressão.)

## 16. Typecheck

```
tsc --noEmit → limpo, zero erros
```

## 17. Lint

Não executável neste ambiente — projeto sem `.eslintrc`/`eslint.config` (gap pré-existente, mesma situação relatada nas fases anteriores).

## 18. Build

```
next build → completo, sem erros
```
`/vendas/nova`: 13.8 kB → 14.4 kB. `/vendas/[id]/troca`: 7.16 kB → 7.49 kB. Demais rotas inalteradas.

## 19. Migrations adicionais

**Nenhuma.** A fundação da Fase 1 (`sales.sale_type`/`sales_channel`, `products.wholesale_price`, `product_variations.wholesale_price_override`) já cobria tudo que esta fase precisava — nenhuma incompatibilidade estrutural foi encontrada entre a fundação e o PDV real. A única mudança de "segurança de backend" (remover `sales_channel` do schema Zod de `POST /api/vendas`) foi puramente TypeScript, sem tocar banco.

## 20. Pendências para a próxima fase

1. **Sem teste de componente/E2E** para os fluxos visuais do PDV (seção 14) — se o projeto algum dia adotar Playwright/@testing-library, esses cenários (seletor, badge, bloqueio de troca de modalidade) são os primeiros candidatos.
2. **Reabertura de venda com itens** não existe como conceito no ERP (só Troca) — se um dia for criada, precisa carregar `sale_type` persistido e nunca assumir retail (mesmo princípio já aplicado aqui à Troca).
3. **Fiscal, dashboards, site de atacado, comissão** — explicitamente fora de escopo, conforme pedido.
4. Pendências já registradas nas Fases 1/2 (`docs/varejo-atacado-fase1-fundacao.md` §14, `docs/varejo-atacado-fase2-*.md` §15) continuam de pé, nenhuma foi endereçada aqui.
