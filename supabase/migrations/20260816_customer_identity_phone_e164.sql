-- FASE 1 (Customer Identity) — fundação de identidade de telefone.
--
-- Decisão arquitetural (relatório da Fase 1, seção C): NÃO normalizar
-- `customers.phone` em E.164 no lugar (opção A). `phone` continua exatamente
-- como está hoje — valor de apresentação/legado, lido/exibido em dezenas de
-- pontos (formulários, PDV, relatórios, sincronização Nuvemshop) sem
-- nenhuma garantia de formato. Em vez disso (opção B): `phone_e164` nasce
-- como coluna aditiva, nullable, só a identidade canônica normalizada —
-- usada por matching/CRM/futuro Chatwoot, nunca por telas de exibição.
--
-- NÃO cria UNIQUE nesta migration — a auditoria da Fase 1 (dados reais)
-- ainda não foi feita (sandbox sem acesso ao banco de produção, ver
-- relatório). Sequência correta, conforme decisão explícita do usuário:
--   1. coluna nullable, sem constraint          (esta migration)
--   2. backfill (script em scripts/, dry-run por padrão, roda fora daqui)
--   3. validação dos resultados do backfill pelo usuário
--   4. só então uma migration futura adicionaria
--      UNIQUE (company_id, phone_e164) WHERE phone_e164 IS NOT NULL
--      — parcial e escopada por tenant, nunca global, e só depois de
--      resolver duplicidades encontradas (ver script de auditoria).
--
-- Índice não-único abaixo já entrega a maior parte do ganho de performance
-- de matching (lookup por company_id+phone_e164) sem esperar a resolução de
-- duplicidade.

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS phone_e164 TEXT;

COMMENT ON COLUMN public.customers.phone_e164 IS
  'Identidade canônica de telefone: DDI+DDD+número, só dígitos, sem "+" (ex.: 5584999999999) — MESMO formato de crm_channel_identities.value pra whatsapp/telegram (normalizeE164BR(), src/lib/utils/phone.ts), de propósito, pra permitir comparação direta sem conversão em matching. NULL quando customers.phone não pôde ser normalizado com segurança (formato ambíguo/inválido) — nunca inventar. Não é a coluna de exibição (customers.phone continua sendo isso); é a identidade usada por matching CRM (crm_person_customer_links) e por integrações futuras (Chatwoot/Meta).';

CREATE INDEX IF NOT EXISTS idx_customers_phone_e164
  ON public.customers (company_id, phone_e164)
  WHERE phone_e164 IS NOT NULL;
