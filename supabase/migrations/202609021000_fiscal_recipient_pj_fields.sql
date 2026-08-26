-- =============================================================================
-- 202609021000_fiscal_recipient_pj_fields.sql
--
-- Fase Fiscal 6 (PDV — comprovante/NFC-e/NF-e na venda) — fundação mínima de
-- schema pra dois gaps reais encontrados na auditoria curta desta fase:
--
--   1. `sale_recipients` só suportava o caminho "venda com entrega" — todas
--      as colunas de endereço (cep/logradouro/numero/bairro/municipio/uf) e
--      `nome` eram NOT NULL, e a linha só era criada pelo RPC de venda
--      quando `p_delivery_recipient` vinha preenchido (que a rota
--      `POST /api/vendas` só passa quando `delivery_mode='delivery'`).
--      Requisito 9 do pedido: "uma venda de balcão/retirada com NF-e
--      também precisa conseguir ter destinatário fiscal" — e requisito 6:
--      NFC-e pode ter só um CPF, sem nenhum endereço. Nenhuma das duas
--      hipóteses cabia no NOT NULL existente.
--
--      Correção: DROP NOT NULL nessas 7 colunas — nunca removidas, nunca
--      viram opcionais "por acaso": o significado da tabela passa a ser
--      "snapshot do destinatário fiscal desta venda, com o que se sabe
--      dele no momento" — pode ser só um CPF (NFC-e de balcão), só um
--      endereço completo sem documento, ou tudo (NF-e completa). Quem
--      decide o que é OBRIGATÓRIO pra emitir continua sendo
--      `validateNfeReadiness`/`validateNfceReadiness` (camada de aplicação,
--      nunca o schema) — mesma filosofia já usada em toda a fundação
--      fiscal anterior. As CHECK constraints de formato (uf/cep/
--      municipio_ibge) continuam intocadas — em Postgres, CHECK nunca
--      rejeita NULL, só valores presentes e mal formados.
--
--   2. Nenhuma coluna existia pra Inscrição Estadual / indicador de
--      IE do destinatário — `loadSaleFiscalContext.ts` sempre devolvia
--      `inscricaoEstadual: null` (comentário explícito: "customers não tem
--      essa coluna"), e `buildNfePayload.ts` inferia o indicador (1/2/9)
--      só pela PRESENÇA de IE — heurística que o pedido desta fase (seção
--      14) explicitamente pediu pra não depender sozinha quando um
--      indicador real puder ser capturado. `sale_recipients` ganha as duas
--      colunas; a heurística antiga de `buildNfePayload.ts` continua como
--      FALLBACK pra qualquer linha antiga/legada sem o indicador explícito
--      (nenhuma regressão pros dados já existentes).
--
-- Nenhuma tabela nova. Nenhuma alteração no RPC de venda (`rpc_create_sale`)
-- — decisão deliberada: reescrever uma função de ~600 linhas só pra
-- adicionar 2 colunas opcionais a um INSERT já existente era um risco
-- desproporcional ao ganho; o preenchimento de `inscricao_estadual`/
-- `indicador_ie` (e a criação do snapshot pra vendas SEM entrega) passa a
-- acontecer via um upsert de aplicação dedicado
-- (`src/services/fiscal/upsertSaleRecipient.ts`), sempre DEPOIS da venda já
-- ter sido criada com sucesso — mesmo padrão de não-atomicidade já aceito
-- neste arquivo pra `shipments` ("erro no shipment é não-fatal": a venda já
-- foi criada). Documentado no relatório desta fase.
-- =============================================================================

ALTER TABLE public.sale_recipients
  ALTER COLUMN nome       DROP NOT NULL,
  ALTER COLUMN cep        DROP NOT NULL,
  ALTER COLUMN logradouro DROP NOT NULL,
  ALTER COLUMN numero     DROP NOT NULL,
  ALTER COLUMN bairro     DROP NOT NULL,
  ALTER COLUMN municipio  DROP NOT NULL,
  ALTER COLUMN uf         DROP NOT NULL;

ALTER TABLE public.sale_recipients
  ADD COLUMN IF NOT EXISTS inscricao_estadual TEXT,
  ADD COLUMN IF NOT EXISTS indicador_ie        SMALLINT
    CONSTRAINT sale_recipients_indicador_ie_valid CHECK (indicador_ie IN (1, 2, 9));

COMMENT ON COLUMN public.sale_recipients.inscricao_estadual IS 'IE do destinatário PJ — opcional. Usado por buildNfePayload (inscricao_estadual_destinatario) quando presente.';
COMMENT ON COLUMN public.sale_recipients.indicador_ie IS 'indIEDest explícito — 1=contribuinte ICMS, 2=contribuinte isento, 9=não contribuinte. Capturado no momento em que o operador informa os dados fiscais (nunca inferido do schema aqui). NULL = sem indicador explícito, buildNfePayload cai na heurística legada (CNPJ+IE→1, CNPJ sem IE→2, sem CNPJ→9).';
COMMENT ON TABLE public.sale_recipients IS
  'Snapshot IMUTÁVEL (por upsert controlado da aplicação, nunca editado livremente) do destinatário fiscal de uma venda — pode ser parcial (ex.: só CPF, pra NFC-e de balcão) ou completo (NF-e). Nunca é a única fonte pra decidir o que é obrigatório: isso é sempre validateNfeReadiness/validateNfceReadiness. Não customer_addresses/shipments.address_id.';

-- =============================================================================
-- Smoke tests
-- =============================================================================

SELECT column_name, is_nullable FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'sale_recipients'
  AND column_name IN ('nome', 'cep', 'logradouro', 'numero', 'bairro', 'municipio', 'uf');
-- Esperado: 7 linhas, todas is_nullable = 'YES'

SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'sale_recipients'
  AND column_name IN ('inscricao_estadual', 'indicador_ie');
-- Esperado: 2 linhas

-- =============================================================================
-- ROLLBACK
-- =============================================================================
/*
ALTER TABLE public.sale_recipients
  DROP COLUMN IF EXISTS inscricao_estadual,
  DROP COLUMN IF EXISTS indicador_ie;

-- Reverter DROP NOT NULL exigiria garantir que nenhuma linha existente
-- tenha NULL nessas colunas antes do ALTER COLUMN ... SET NOT NULL —
-- não incluído automaticamente aqui de propósito (pode falhar contra dados
-- reais criados sob o novo comportamento, ex. uma linha só-CPF de NFC-e).
*/
