# Fase Fiscal 6 — Comprovante / NFC-e / NF-e no fechamento do PDV

Relatório de entrega. Continuação de `docs/varejo-atacado-fase3-pdv.md`, sobre a fundação fiscal já existente (Fase Fiscal 1-5C: `resolveFiscalDocumentType`, `loadSaleFiscalContext`, `validateFiscalReadiness`, `buildNfePayload`/`buildNfcePayload`, `fiscal_documents` com claim/lease, `sale_recipients`).

## 0. Achado mais importante da auditoria curta

O motor fiscal (NF-e/NFC-e via Focus, homologação) já estava **muito mais maduro** do que o pedido presumia: payload builders, validação de readiness, claim/lease/idempotência, resolução automática de tipo de documento e uma tela de emissão manual pós-venda já existiam. O que **não existia** era exatamente o que foi pedido: (a) nenhuma decisão fiscal no fechamento do PDV — tudo era pós-venda manual; (b) NF-e/NFC-e eram só `-homologacao` — não existe (e não foi criado) nenhum caminho de produção; (c) `sale_recipients` só era gravado para vendas com entrega, então balcão/retirada nunca tinha destinatário fiscal possível; (d) não havia coluna nenhuma para IE/indicador de contribuinte; (e) cancelamento de venda não coordenava com documento fiscal autorizado.

## 1. Arquitetura fiscal final

Três dimensões continuam **independentes**, como já eram: `sale_type` (comercial), `sales_channel` (canal operacional) e documento fiscal (`fiscal_documents`, fonte de verdade separada de `sales`). Nada mudou nisso — só passou a ser possível **escolher explicitamente** o documento no fechamento, além do fluxo manual pós-venda que já existia (agora reforçado). `resolveFiscalDocumentType` deixou de ser a ÚNICA fonte da decisão — virou **elegibilidade**: NFC-e só pode ser emitida quando ele resolve para `'nfce'` (mesma regra de sempre); NF-e nunca teve esse bloqueio (mais genérica) e continua sem ele.

## 2. Arquivos alterados/criados

**Migration:** [202609021000_fiscal_recipient_pj_fields.sql](supabase/migrations/202609021000_fiscal_recipient_pj_fields.sql) — `sale_recipients` ganha `inscricao_estadual`/`indicador_ie`; `nome`/endereço deixam de ser `NOT NULL` (uma linha pode ser só um CPF, para NFC-e de balcão). **Nenhuma mudança em `rpc_create_sale`** — decisão deliberada (função de ~600 linhas, risco desproporcional a 2 colunas opcionais).

**Novos:**
- [src/lib/utils/cnpj.ts](src/lib/utils/cnpj.ts) + teste — validação de dígito verificador (não existia).
- [src/services/fiscal/upsertSaleRecipient.ts](src/services/fiscal/upsertSaleRecipient.ts) + teste — único ponto que escreve `sale_recipients` fora da RPC.
- [src/services/fiscal/buildFiscalRecipientInput.ts](src/services/fiscal/buildFiscalRecipientInput.ts) + teste — mescla destinatário fiscal com destinatário de entrega, sem perder dado.
- [src/app/api/fiscal/recipient/route.ts](src/app/api/fiscal/recipient/route.ts) — GET/POST para "completar dados fiscais".
- [src/components/vendas/FiscalRecipientFields.tsx](src/components/vendas/FiscalRecipientFields.tsx) — formulário reutilizável (PDV + tela da venda).
- [supabase/tests/fiscal_recipient_pj_fields.test.sql](supabase/tests/fiscal_recipient_pj_fields.test.sql).

**Modificados:** [types.ts](src/services/fiscal/types.ts), [loadSaleFiscalContext.ts](src/services/fiscal/loadSaleFiscalContext.ts), [buildNfePayload.ts](src/services/fiscal/buildNfePayload.ts) (+testes de todos os 3), [src/app/api/vendas/route.ts](src/app/api/vendas/route.ts) (emissão no fechamento), [cancelar/route.ts](src/app/api/vendas/[id]/cancelar/route.ts) e [devolucao/route.ts](src/app/api/vendas/[id]/devolucao/route.ts) (bloqueio com doc autorizado), [vendas/nova/page.tsx](src/app/(dashboard)/vendas/nova/page.tsx) (seletor no fechamento), [vendas/[id]/page.tsx](src/app/(dashboard)/vendas/[id]/page.tsx) + [documento-fiscal-card.tsx](src/app/(dashboard)/vendas/[id]/_components/documento-fiscal-card.tsx) (card reescrito), [validators/index.ts](src/lib/validators/index.ts).

## 3. Modelo de destinatário

`sale_recipients` continua sendo a fonte única do snapshot fiscal — agora **parcial por natureza**: pode ter só CPF (NFC-e de balcão), ou nome+endereço completo sem documento, ou tudo (NF-e PJ). O que é **obrigatório para emitir** continua sendo decidido só por `validateNfeReadiness`/`validateNfceReadiness`, nunca pelo schema.

## 4. CPF/CNPJ

Auditado: `customers` continua só CPF (decisão de Fase 1, não revista). `sale_recipients.cnpj` já existia desde a Fase 5C mas nunca era gravado para venda sem entrega — agora é, via `upsertSaleRecipient`. Novo `validateCNPJ` (dígito verificador) usado antes de persistir, em `/api/vendas` e em `/api/fiscal/recipient`.

## 5. IE / indicador

`sale_recipients.indicador_ie` (1/2/9) explícito, capturado no formulário. `buildNfePayload.resolveIndicadorIeDestinatario` agora aceita esse override e o usa **sempre que presente**, nunca inferindo por presença de IE quando há indicador real (era exatamente o gap apontado no pedido — a heurística antiga foi preservada só como fallback para dado legado, com teste cobrindo os 3 casos).

## 6. indFinal

Confirmado que já estava correto desde a fundação varejo/atacado (decidido a partir de `sale_recipients.cnpj`, nunca de `sale_type`) — nenhuma mudança necessária, só confirmação.

## 7. Fluxo comprovante

Inalterado — "Somente comprovante" (`fiscal_document_type: 'none'`, default) nunca chama nada fiscal. Comprovante não fiscal continua funcionando exatamente como antes.

## 8. Fluxo NFC-e

Seletor no fechamento → se elegível (`resolveFiscalDocumentType === 'nfce'`), emite via `submitNfceHomologacao` (infraestrutura existente, intocada) logo após a venda ser persistida. CPF é opcional. Se inelegível, a venda é criada normalmente e o operador é avisado — nunca vira NF-e automaticamente.

## 9. Fluxo NF-e

Sem gate de elegibilidade prévio (mesmo comportamento que a rota manual já tinha). Se faltar destinatário, a venda continua válida e a UI oferece "Completar dados fiscais" na tela da venda.

## 10. Emissão imediata

Implementada em `POST /api/vendas`, estritamente depois de `createSale` (venda+pagamento+estoque, atômico via RPC, inalterado) e do insert de `shipments` — nunca pode fazer a venda falhar (todo o bloco é `try/catch`, erro vira `fiscal.status: 'error'` na resposta, não uma exceção).

## 11. Emissão posterior

Tela da venda: card reescrito mostra as duas seções (NFC-e/NF-e) sempre, com status real já carregado do banco no primeiro render (sem exigir clique). "Completar dados fiscais" pré-carrega o que já existe (`GET /api/fiscal/recipient`), salva e tenta emitir de novo automaticamente.

## 12. Idempotência

100% reaproveitada — nenhum mecanismo novo. `submitNfeHomologacao`/`submitNfceHomologacao` (claim/lease/`already_authorized`) chamados diretamente pelo novo caminho de emissão-no-fechamento, exatamente como pela rota manual.

## 13. Cancelamento

**Gap real encontrado**: nenhuma coordenação existia entre cancelar/devolver uma venda e um documento fiscal autorizado. Corrigido com um bloqueio (409) em `/cancelar` e `/devolucao` quando existe `fiscal_documents.status = 'authorized'` — cancelamento fiscal automatizado (`DELETE /v2/nfe`) **não existe** neste ERP; documentado como gap para fase futura, nunca "resolvido" com uma gambiarra.

## 14. Integração Focus

Nenhuma mudança — mesmo cliente HTTP, mesmos payload builders, ambiente permanece **só homologação** (nenhuma rota de produção existe ou foi criada).

## 15. Impacto Nuvemshop

Nenhum — webhook (`sale_origin='website'`, `sales_channel='nuvemshop'`) não foi tocado, confirmado por grep. `resolveFiscalDocumentType` continua forçando NF-e para `website`.

## 16. Validações fiscais de produto

Inalteradas (`validateCommonFiscalReadiness` já bloqueia NCM/origem ausente com mensagem legível) — só confirmadas, não modificadas.

## 17. UX criada

Seletor de 3 botões (Comprovante/NFC-e/NF-e) no Passo 3 do PDV, com selo "sugerido" (não vinculante) vindo da mesma função pura do servidor. Formulário fiscal só aparece quando NFC-e/NF-e é escolhido — mínimo (CPF) para NFC-e, completo para NF-e, pré-preenchido a partir do endereço de entrega quando aplicável.

## 18. Testes

39 testes novos: `cnpj.test.ts` (5), `upsertSaleRecipient.test.ts` (7), `buildFiscalRecipientInput.test.ts` (5, incluindo o caso crítico de não perder endereço), `buildNfePayload.test.ts` (+3, indicador explícito), 1 SQL manual. Suíte completa: **913/913 passando**.

## 19-22. Suíte completa / typecheck / build / homologação real

`npx vitest run` 913/913. `npm run typecheck` limpo. `npm run build` limpo. **Nenhum teste chama a Focus real** — tudo mockado (mesmo padrão pré-existente); qualquer emissão de verdade exige ambiente de homologação real configurado (token Focus + `company_fiscal_settings`), que este sandbox não tem.

## 23. Migrations/comandos pendentes

Sem acesso a Postgres/Supabase CLI neste sandbox (confirmado, mesma limitação de todas as fases anteriores). Aplicar em ordem:
```bash
supabase db push
# ou, uma a uma, garantindo que 202609021000_fiscal_recipient_pj_fields.sql
# rode depois de todas as migrations fiscais anteriores (20260821...20260828)
psql "$DATABASE_URL" -f supabase/tests/fiscal_recipient_pj_fields.test.sql
```

## 24. Pendências para a próxima fase

Cancelamento fiscal automatizado (`DELETE /v2/nfe|nfce`); tela de cadastro do emitente (`company_fiscal_settings` só tem dashboard read-only, cadastro é manual no banco — gap pré-existente, não desta fase); ambiente de produção; DANFE construído/hospedado pelo ERP (hoje só linka o que a Focus retorna).

## 25. Observação operacional

O default de `delivery_mode` no PDV é `'delivery'`, não `'pickup'` (decisão de fase anterior, não alterada aqui) — para uma venda de balcão ser elegível a NFC-e, o operador precisa selecionar "📦 Retirada" explicitamente no Passo Cliente. Vale mencionar ao time operacional.
