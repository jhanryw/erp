-- =============================================================================
-- 20260823_ibge_municipios_cache.sql
--
-- Fase Fiscal 2B — cache de código IBGE de município, resolvido
-- dinamicamente contra a API pública do IBGE (servicodados.ibge.gov.br),
-- nunca por lista hardcoded de cidades no código da aplicação.
--
-- Por quê: `customer_addresses` não tem coluna de código IBGE (confirmado
-- na Fase 2A) e o XML real de NF-e autorizado pela SEFAZ (referência
-- empírica desta fase) confirma que `cMun` (código IBGE do município do
-- destinatário) é obrigatório. Não existe fonte local desse dado — a
-- arquitetura escolhida é resolver contra a API pública do IBGE na
-- primeira vez que um (uf, nome de município) aparece, e cachear o
-- resultado aqui pra nunca repetir a chamada de rede pro mesmo município
-- (ver src/services/fiscal/resolveMunicipioIbge.ts).
--
-- RLS: mesmo padrão de dado de referência público, não sensível — ainda
-- assim segue o padrão deny-by-default já estabelecido pras tabelas
-- fiscais (só service_role acessa; nenhuma policy pra authenticated).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.ibge_municipios (
  codigo_ibge       CHAR(7)      PRIMARY KEY,
  uf                CHAR(2)      NOT NULL,
  nome              TEXT         NOT NULL,
  -- Normalizado (minúsculo, sem acento, sem espaço duplicado) — chave de
  -- busca real, já que o nome digitado/importado num endereço de cliente
  -- raramente bate byte-a-byte com o nome oficial do IBGE.
  nome_normalizado  TEXT         NOT NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ibge_municipios_uf_nome ON public.ibge_municipios (uf, nome_normalizado);

ALTER TABLE public.ibge_municipios ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ibge_municipios FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.ibge_municipios TO service_role;

-- =============================================================================
-- ROLLBACK
-- =============================================================================
/*
DROP TABLE IF EXISTS public.ibge_municipios;
*/
