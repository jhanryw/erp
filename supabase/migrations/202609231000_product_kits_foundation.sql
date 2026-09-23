-- =============================================================================
-- 202609231000_product_kits_foundation.sql
--
-- KITS / PRODUTOS COMPOSTOS — fundação de schema (Fase C).
--
-- Modelo:
--   - Kit continua sendo um produto do catálogo (`products`), distinguido
--     por `products.product_kind` ('standard' | 'kit'). NÃO é uma tabela
--     paralela. `product_kind` é IMUTÁVEL depois da criação (trocar
--     standard↔kit com saldo/vendas existentes geraria estado ambíguo).
--   - A composição vive no nível da VARIAÇÃO vendável:
--     `product_kit_components(kit_product_variation_id →
--      component_product_variation_id × quantity)`.
--   - Kit NÃO possui saldo físico: nenhuma linha de `stock_balances` pode
--     existir para uma variação de kit (trigger `trg_block_kit_stock_balances`
--     — cobre entrada, ajuste, transferência, inventário, inicialização,
--     cancelamento, devolução, troca e qualquer RPC futura, sem depender de
--     cada rota lembrar da regra).
--   - Disponibilidade do kit é DERIVADA dos componentes
--     (`fn_variation_sellable_quantity`) — nunca persistida como estoque.
--   - Venda de kit mantém o item COMERCIAL em `sale_items` (o SKU do kit) e
--     registra o consumo físico em `sale_item_components` (snapshot imutável
--     da composição + custo + local de origem de cada unidade consumida).
--   - Fila de domínio `stock_availability_changes` + cache derivado
--     `variation_availability` preparam o core para o Marketplace Hub
--     (estoque de componente mudou → kits afetados → nova quantidade
--     vendável). A fonte de verdade continua sendo `stock_balances`.
--
-- 100% aditiva/backward-safe:
--   - `product_kind` entra com DEFAULT 'standard' (ADD COLUMN com default
--     constante = só metadado no PG ≥ 11, sem rewrite). Todo produto
--     existente vira 'standard' e continua exatamente como antes.
--   - CHECK novo em `products` usa NOT VALID + VALIDATE separado (mesmo
--     padrão de 202608311200_wholesale_retail_schema_foundation.sql).
--   - Nenhuma tabela existente é recriada; nenhum dado é apagado.
-- =============================================================================


-- ─── 1. products.product_kind ────────────────────────────────────────────────

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS product_kind TEXT NOT NULL DEFAULT 'standard';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'products_product_kind_valid'
      AND conrelid = 'public.products'::regclass
  ) THEN
    ALTER TABLE public.products
      ADD CONSTRAINT products_product_kind_valid
      CHECK (product_kind IN ('standard', 'kit')) NOT VALID;
  END IF;
END $$;

ALTER TABLE public.products VALIDATE CONSTRAINT products_product_kind_valid;

COMMENT ON COLUMN public.products.product_kind IS
  'standard = produto físico (tem saldo em stock_balances). kit = produto composto: sem saldo próprio, disponibilidade derivada de product_kit_components, venda baixa os componentes. Imutável após a criação (trg_products_product_kind_immutable).';

CREATE INDEX IF NOT EXISTS idx_products_company_kit
  ON public.products (company_id)
  WHERE product_kind = 'kit';

CREATE OR REPLACE FUNCTION public.fn_products_product_kind_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.product_kind IS DISTINCT FROM OLD.product_kind THEN
    RAISE EXCEPTION 'O tipo do produto (padrão/kit) não pode ser alterado depois da criação (produto #%).', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_products_product_kind_immutable ON public.products;
CREATE TRIGGER trg_products_product_kind_immutable
  BEFORE UPDATE OF product_kind ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.fn_products_product_kind_immutable();


-- ─── 2. product_kit_components ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.product_kit_components (
  id                             BIGSERIAL    PRIMARY KEY,
  company_id                     INT          NOT NULL REFERENCES public.companies(id),
  kit_product_variation_id       INT          NOT NULL REFERENCES public.product_variations(id) ON DELETE CASCADE,
  -- RESTRICT: apagar uma variação usada como componente deixaria kits
  -- sem composição — precisa ser removida do(s) kit(s) antes.
  component_product_variation_id INT          NOT NULL REFERENCES public.product_variations(id) ON DELETE RESTRICT,
  quantity                       INT          NOT NULL,
  created_at                     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by                     UUID,

  CONSTRAINT product_kit_components_quantity_positive CHECK (quantity > 0),
  CONSTRAINT product_kit_components_not_self CHECK (kit_product_variation_id <> component_product_variation_id),
  -- Componente duplicado no mesmo kit é impossível — a RPC de composição
  -- consolida (soma) duplicatas de forma determinística antes de gravar.
  CONSTRAINT uq_product_kit_components_kit_component UNIQUE (kit_product_variation_id, component_product_variation_id)
);

-- "Quais kits usam esta variação?" — consulta quente (recalculo de
-- disponibilidade a cada mudança de estoque de componente).
CREATE INDEX IF NOT EXISTS idx_product_kit_components_component
  ON public.product_kit_components (component_product_variation_id);
CREATE INDEX IF NOT EXISTS idx_product_kit_components_company
  ON public.product_kit_components (company_id);

COMMENT ON TABLE public.product_kit_components IS
  'Composição de uma variação de kit: N unidades de variações standard da MESMA empresa. Kit dentro de kit é proibido (V1). Validada por trg_product_kit_components_validate e, no commit, por trg_kit_variation_requires_components.';

DROP TRIGGER IF EXISTS trg_product_kit_components_touch_updated_at ON public.product_kit_components;
CREATE TRIGGER trg_product_kit_components_touch_updated_at
  BEFORE UPDATE ON public.product_kit_components
  FOR EACH ROW EXECUTE FUNCTION public.company_integrations_touch_updated_at();

-- Validação estrutural — defesa no banco, independente de qual caminho
-- (RPC, script, service_role) grave a composição.
CREATE OR REPLACE FUNCTION public.fn_product_kit_components_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_kit_kind       text;
  v_kit_company    int;
  v_comp_kind      text;
  v_comp_company   int;
BEGIN
  SELECT p.product_kind, p.company_id INTO v_kit_kind, v_kit_company
  FROM public.product_variations pv
  JOIN public.products p ON p.id = pv.product_id
  WHERE pv.id = NEW.kit_product_variation_id;

  SELECT p.product_kind, p.company_id INTO v_comp_kind, v_comp_company
  FROM public.product_variations pv
  JOIN public.products p ON p.id = pv.product_id
  WHERE pv.id = NEW.component_product_variation_id;

  IF v_kit_kind IS DISTINCT FROM 'kit' THEN
    RAISE EXCEPTION 'Variação #% não é de um produto do tipo kit.', NEW.kit_product_variation_id
      USING ERRCODE = 'P0001';
  END IF;
  IF v_comp_kind IS NULL THEN
    RAISE EXCEPTION 'Componente #% não encontrado.', NEW.component_product_variation_id
      USING ERRCODE = 'P0001';
  END IF;
  IF v_comp_kind = 'kit' THEN
    RAISE EXCEPTION 'Kit dentro de kit não é permitido (componente #% é um kit).', NEW.component_product_variation_id
      USING ERRCODE = 'P0001';
  END IF;
  IF v_kit_company IS DISTINCT FROM NEW.company_id
     OR v_comp_company IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'Kit e componente precisam pertencer à mesma empresa.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_product_kit_components_validate ON public.product_kit_components;
CREATE TRIGGER trg_product_kit_components_validate
  BEFORE INSERT OR UPDATE ON public.product_kit_components
  FOR EACH ROW EXECUTE FUNCTION public.fn_product_kit_components_validate();

-- "Um kit precisa possuir pelo menos um componente" — verificado no COMMIT
-- (constraint trigger DEFERRED), para permitir substituir a composição
-- inteira dentro de uma transação (DELETE + INSERT) sem falso positivo.
CREATE OR REPLACE FUNCTION public.fn_kit_variation_requires_components()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_kit_pvid int;
BEGIN
  IF TG_TABLE_NAME = 'product_variations' THEN
    v_kit_pvid := NEW.id;
  ELSE
    v_kit_pvid := OLD.kit_product_variation_id;
  END IF;

  -- Variação não existe mais (kit/produto apagado) → nada a exigir.
  IF NOT EXISTS (
    SELECT 1
    FROM public.product_variations pv
    JOIN public.products p ON p.id = pv.product_id
    WHERE pv.id = v_kit_pvid AND p.product_kind = 'kit'
  ) THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.product_kit_components WHERE kit_product_variation_id = v_kit_pvid
  ) THEN
    RAISE EXCEPTION 'Variação de kit #% precisa ter pelo menos um componente.', v_kit_pvid
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_kit_variation_requires_components ON public.product_variations;
CREATE CONSTRAINT TRIGGER trg_kit_variation_requires_components
  AFTER INSERT ON public.product_variations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_kit_variation_requires_components();

DROP TRIGGER IF EXISTS trg_kit_components_keep_at_least_one ON public.product_kit_components;
CREATE CONSTRAINT TRIGGER trg_kit_components_keep_at_least_one
  AFTER DELETE OR UPDATE OF kit_product_variation_id ON public.product_kit_components
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_kit_variation_requires_components();


-- ─── 3. Kit nunca tem saldo físico ───────────────────────────────────────────
-- Único ponto que garante a regra para TODA origem de escrita em
-- stock_balances (entrada, ajuste, transferência simples/em lote,
-- inventário, inicialização, cancelamento, devolução, troca, RPCs futuras).

CREATE OR REPLACE FUNCTION public.fn_block_kit_stock_balances()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.product_variations pv
    JOIN public.products p ON p.id = pv.product_id
    WHERE pv.id = NEW.product_variation_id
      AND p.product_kind = 'kit'
  ) THEN
    RAISE EXCEPTION 'Kit não possui estoque próprio (variação #%). Movimente o estoque dos componentes.', NEW.product_variation_id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_block_kit_stock_balances ON public.stock_balances;
CREATE TRIGGER trg_block_kit_stock_balances
  BEFORE INSERT OR UPDATE ON public.stock_balances
  FOR EACH ROW EXECUTE FUNCTION public.fn_block_kit_stock_balances();


-- ─── 4. sale_item_components — snapshot do consumo físico da venda ──────────
-- Grão: (item da venda, componente, local de estoque). Uma linha por local
-- de onde o componente foi efetivamente debitado — em main_store sempre 1
-- local; em online_priority pode haver cascata por prioridade. Isso permite
-- reverter um cancelamento EXATAMENTE para o local de origem.
--   quantity_per_kit × kit_quantity = total_quantity (composição congelada)
--   quantity = parte de total_quantity debitada deste local
-- A composição usada na venda nunca muda, mesmo que o kit seja editado.

CREATE TABLE IF NOT EXISTS public.sale_item_components (
  id                             BIGSERIAL     PRIMARY KEY,
  company_id                     INT           NOT NULL REFERENCES public.companies(id),
  sale_id                        INT           NOT NULL REFERENCES public.sales(id) ON DELETE CASCADE,
  sale_item_id                   INT           NOT NULL REFERENCES public.sale_items(id) ON DELETE CASCADE,
  kit_product_variation_id       INT           NOT NULL REFERENCES public.product_variations(id),
  component_product_variation_id INT           NOT NULL REFERENCES public.product_variations(id),
  stock_location_id              INT           NOT NULL REFERENCES public.stock_locations(id),
  quantity_per_kit               INT           NOT NULL,
  kit_quantity                   INT           NOT NULL,
  total_quantity                 INT           NOT NULL,
  quantity                       INT           NOT NULL,
  unit_cost                      NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at                     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT sale_item_components_qty_per_kit_positive CHECK (quantity_per_kit > 0),
  CONSTRAINT sale_item_components_kit_qty_positive     CHECK (kit_quantity > 0),
  CONSTRAINT sale_item_components_total_consistent     CHECK (total_quantity = quantity_per_kit * kit_quantity),
  CONSTRAINT sale_item_components_quantity_valid       CHECK (quantity > 0 AND quantity <= total_quantity),
  CONSTRAINT uq_sale_item_components_item_comp_loc UNIQUE (sale_item_id, component_product_variation_id, stock_location_id)
);

CREATE INDEX IF NOT EXISTS idx_sale_item_components_sale      ON public.sale_item_components (sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_item_components_component ON public.sale_item_components (component_product_variation_id);
CREATE INDEX IF NOT EXISTS idx_sale_item_components_company   ON public.sale_item_components (company_id);

COMMENT ON TABLE public.sale_item_components IS
  'Snapshot imutável do consumo físico de itens de kit numa venda: composição (quantity_per_kit), custo do componente no momento da venda e local de origem de cada unidade. Fonte usada por cancelamento/devolução/troca para devolver os componentes — nunca a composição atual do kit.';


-- ─── 5. Disponibilidade vendável — função central ───────────────────────────
-- Mesma regra de locais que rpc_create_sale usa para BAIXAR:
--   main_store      → só o Estoque Loja (fn_main_store_id) — PDV.
--   online_priority → soma dos locais ATIVOS da empresa — venda online/canais.
-- Futuro: "quais locais abastecem o canal X" entra como um novo modo aqui,
-- num único lugar, sem tocar em quem consome a função.

CREATE OR REPLACE FUNCTION public.fn_physical_available_quantity(
  p_company_id   int,
  p_variation_id int,
  p_stock_mode   text
)
RETURNS int
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT GREATEST(0, COALESCE((
    CASE p_stock_mode
      WHEN 'main_store' THEN (
        SELECT SUM(sb.quantity)
        FROM stock_balances sb
        WHERE sb.product_variation_id = p_variation_id
          AND sb.stock_location_id = public.fn_main_store_id(p_company_id)
      )
      ELSE (
        SELECT SUM(sb.quantity)
        FROM stock_balances sb
        JOIN stock_locations sl ON sl.id = sb.stock_location_id
        WHERE sb.product_variation_id = p_variation_id
          AND sl.company_id = p_company_id
          AND sl.active = true
      )
    END
  ), 0))::int;
$$;

CREATE OR REPLACE FUNCTION public.fn_variation_sellable_quantity(
  p_company_id   int,
  p_variation_id int,
  p_stock_mode   text
)
RETURNS int
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_kind    text;
  v_company int;
  v_result  int;
BEGIN
  IF p_stock_mode NOT IN ('main_store', 'online_priority') THEN
    RAISE EXCEPTION 'p_stock_mode inválido: %.', p_stock_mode USING ERRCODE = 'P0001';
  END IF;

  SELECT p.product_kind, p.company_id INTO v_kind, v_company
  FROM product_variations pv JOIN products p ON p.id = pv.product_id
  WHERE pv.id = p_variation_id;

  -- Variação inexistente ou de outra empresa → nada vendável (nunca vaza
  -- saldo de outro tenant).
  IF v_company IS NULL OR v_company IS DISTINCT FROM p_company_id THEN
    RETURN 0;
  END IF;

  IF v_kind <> 'kit' THEN
    RETURN public.fn_physical_available_quantity(p_company_id, p_variation_id, p_stock_mode);
  END IF;

  -- Kit: MIN(floor(disponível do componente / quantidade por kit)).
  -- Sem componentes → 0 (nunca vendável).
  SELECT MIN(public.fn_physical_available_quantity(p_company_id, kc.component_product_variation_id, p_stock_mode) / kc.quantity)
  INTO v_result
  FROM product_kit_components kc
  WHERE kc.kit_product_variation_id = p_variation_id;

  RETURN COALESCE(v_result, 0);
END;
$$;

-- Leitura em lote para a aplicação (service_role). Só devolve variações da
-- empresa informada — company_id sempre vem da SESSÃO no servidor.
CREATE OR REPLACE FUNCTION public.rpc_get_variation_availability(
  p_company_id    int,
  p_variation_ids int[],
  p_stock_mode    text DEFAULT 'online_priority'
)
RETURNS TABLE (
  product_variation_id int,
  product_id           int,
  product_kind         text,
  manual_enabled       boolean,
  sellable_quantity    int,
  inventory_available  boolean,
  is_sellable          boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    pv.id,
    p.id,
    p.product_kind,
    (pv.active AND p.active),
    q.qty,
    q.qty > 0,
    (pv.active AND p.active AND q.qty > 0)
  FROM product_variations pv
  JOIN products p ON p.id = pv.product_id
  CROSS JOIN LATERAL (
    SELECT public.fn_variation_sellable_quantity(p_company_id, pv.id, p_stock_mode) AS qty
  ) q
  WHERE pv.id = ANY(p_variation_ids)
    AND p.company_id = p_company_id;
$$;

REVOKE ALL ON FUNCTION public.fn_physical_available_quantity(int, int, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_variation_sellable_quantity(int, int, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_get_variation_availability(int, int[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_physical_available_quantity(int, int, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_variation_sellable_quantity(int, int, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_get_variation_availability(int, int[], text) TO service_role;


-- ─── 6. Fila de domínio: mudanças de disponibilidade ─────────────────────────
-- Toda alteração de saldo físico (qualquer origem) grava, NA MESMA
-- TRANSAÇÃO, uma linha para a variação e para cada kit que a usa. Coalescida
-- por (variação, transação): N movimentos da mesma variação numa venda
-- geram 1 evento. Sem FK para product_variations de propósito: apagar uma
-- variação (cascade para stock_balances) não pode falhar por causa da fila.
--
-- Por que não integration_outbox (ainda): o outbox é consumido hoje pelo
-- fan-out do Chatwoot em lotes FIFO; um inventário de milhares de
-- variações empurraria os eventos sale.* para trás. Esta fila tem consumidor
-- próprio (rpc_process_stock_availability_changes) e, quando existir
-- Marketplace Hub, é o ponto onde nascem as deliveries por canal.

CREATE TABLE IF NOT EXISTS public.stock_availability_changes (
  id                          BIGSERIAL    PRIMARY KEY,
  company_id                  INT          NOT NULL,
  product_variation_id        INT          NOT NULL,
  reason                      TEXT         NOT NULL,
  source_product_variation_id INT,
  txid                        BIGINT       NOT NULL DEFAULT txid_current(),
  status                      TEXT         NOT NULL DEFAULT 'pending',
  attempts                    INT          NOT NULL DEFAULT 0,
  locked_at                   TIMESTAMPTZ,
  locked_by                   TEXT,
  processed_at                TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT stock_availability_changes_reason_valid
    CHECK (reason IN ('stock', 'kit_composition', 'catalog_status')),
  CONSTRAINT stock_availability_changes_status_valid
    CHECK (status IN ('pending', 'processing', 'processed'))
);

-- Parcial (só 'pending'): coalesce N mudanças da mesma variação numa
-- transação, mas nunca descarta uma mudança nova porque um evento antigo
-- do mesmo txid já foi processado.
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_availability_changes_variation_tx
  ON public.stock_availability_changes (product_variation_id, txid)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_stock_availability_changes_open
  ON public.stock_availability_changes (status, created_at)
  WHERE status IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS idx_stock_availability_changes_company
  ON public.stock_availability_changes (company_id, created_at DESC);

-- Enfileira a variação física + todos os kits que dependem dela.
CREATE OR REPLACE FUNCTION public.fn_enqueue_availability_change(
  p_company_id   int,
  p_variation_id int,
  p_reason       text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_company_id IS NULL OR p_variation_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO stock_availability_changes (company_id, product_variation_id, reason, source_product_variation_id)
  VALUES (p_company_id, p_variation_id, p_reason, p_variation_id)
  ON CONFLICT (product_variation_id, txid) WHERE status = 'pending' DO NOTHING;

  INSERT INTO stock_availability_changes (company_id, product_variation_id, reason, source_product_variation_id)
  SELECT kc.company_id, kc.kit_product_variation_id, p_reason, p_variation_id
  FROM product_kit_components kc
  WHERE kc.component_product_variation_id = p_variation_id
    AND kc.company_id = p_company_id
  ON CONFLICT (product_variation_id, txid) WHERE status = 'pending' DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_enqueue_availability_change(int, int, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_stock_balances_enqueue_availability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pvid    int;
  v_loc     int;
  v_company int;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.quantity IS NOT DISTINCT FROM OLD.quantity
     AND NEW.stock_location_id IS NOT DISTINCT FROM OLD.stock_location_id THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_pvid := OLD.product_variation_id;
    v_loc  := OLD.stock_location_id;
  ELSE
    v_pvid := NEW.product_variation_id;
    v_loc  := NEW.stock_location_id;
  END IF;

  SELECT company_id INTO v_company FROM stock_locations WHERE id = v_loc;
  PERFORM public.fn_enqueue_availability_change(v_company, v_pvid, 'stock');
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_stock_balances_enqueue_availability ON public.stock_balances;
CREATE TRIGGER trg_stock_balances_enqueue_availability
  AFTER INSERT OR UPDATE OR DELETE ON public.stock_balances
  FOR EACH ROW EXECUTE FUNCTION public.fn_stock_balances_enqueue_availability();

CREATE OR REPLACE FUNCTION public.fn_kit_components_enqueue_availability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    INSERT INTO stock_availability_changes (company_id, product_variation_id, reason)
    VALUES (OLD.company_id, OLD.kit_product_variation_id, 'kit_composition')
    ON CONFLICT (product_variation_id, txid) WHERE status = 'pending' DO NOTHING;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    INSERT INTO stock_availability_changes (company_id, product_variation_id, reason)
    VALUES (NEW.company_id, NEW.kit_product_variation_id, 'kit_composition')
    ON CONFLICT (product_variation_id, txid) WHERE status = 'pending' DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_kit_components_enqueue_availability ON public.product_kit_components;
CREATE TRIGGER trg_kit_components_enqueue_availability
  AFTER INSERT OR UPDATE OR DELETE ON public.product_kit_components
  FOR EACH ROW EXECUTE FUNCTION public.fn_kit_components_enqueue_availability();

-- Ativação MANUAL (products.active / product_variations.active) também muda
-- o que é vendável — enfileira para o cache/canais saberem. Nunca o
-- contrário: nenhuma rotina de disponibilidade escreve em `active`.
CREATE OR REPLACE FUNCTION public.fn_variation_active_enqueue_availability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company int;
BEGIN
  IF NEW.active IS NOT DISTINCT FROM OLD.active THEN
    RETURN NULL;
  END IF;
  SELECT company_id INTO v_company FROM products WHERE id = NEW.product_id;
  INSERT INTO stock_availability_changes (company_id, product_variation_id, reason)
  VALUES (v_company, NEW.id, 'catalog_status')
  ON CONFLICT (product_variation_id, txid) WHERE status = 'pending' DO NOTHING;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_variation_active_enqueue_availability ON public.product_variations;
CREATE TRIGGER trg_variation_active_enqueue_availability
  AFTER UPDATE OF active ON public.product_variations
  FOR EACH ROW EXECUTE FUNCTION public.fn_variation_active_enqueue_availability();

CREATE OR REPLACE FUNCTION public.fn_product_active_enqueue_availability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.active IS NOT DISTINCT FROM OLD.active THEN
    RETURN NULL;
  END IF;
  INSERT INTO stock_availability_changes (company_id, product_variation_id, reason)
  SELECT NEW.company_id, pv.id, 'catalog_status'
  FROM product_variations pv
  WHERE pv.product_id = NEW.id
  ON CONFLICT (product_variation_id, txid) WHERE status = 'pending' DO NOTHING;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_product_active_enqueue_availability ON public.products;
CREATE TRIGGER trg_product_active_enqueue_availability
  AFTER UPDATE OF active ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.fn_product_active_enqueue_availability();


-- ─── 7. Cache derivado: variation_availability ───────────────────────────────
-- NÃO é estoque. É a "última disponibilidade publicada" por variação,
-- mantida pelo consumidor da fila. Serve para: (a) detectar transições
-- (vendável ↔ indisponível) e (b) futuramente o Marketplace Hub saber o que
-- mudou desde o último envio a um canal. Nenhuma venda lê esta tabela —
-- rpc_create_sale sempre decide com stock_balances sob lock.

CREATE TABLE IF NOT EXISTS public.variation_availability (
  product_variation_id   INT          PRIMARY KEY REFERENCES public.product_variations(id) ON DELETE CASCADE,
  company_id             INT          NOT NULL REFERENCES public.companies(id),
  product_kind           TEXT         NOT NULL,
  manual_enabled         BOOLEAN      NOT NULL,
  online_quantity        INT          NOT NULL,
  main_store_quantity    INT          NOT NULL,
  inventory_available    BOOLEAN      NOT NULL,
  is_sellable            BOOLEAN      NOT NULL,
  computed_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  changed_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  sellable_changed_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_variation_availability_company
  ON public.variation_availability (company_id, is_sellable);

COMMENT ON TABLE public.variation_availability IS
  'Cache DERIVADO (não é estoque): última disponibilidade vendável calculada por variação (standard ou kit). Fonte de verdade: stock_balances + product_kit_components. Mantido por rpc_process_stock_availability_changes. online_quantity usa a mesma regra de locais de rpc_create_sale online_priority.';

-- Consumidor da fila: reivindica (SKIP LOCKED), recalcula ao vivo,
-- atualiza o cache, marca processado. Idempotente (baseado em estado,
-- nunca em delta). Linhas presas em 'processing' há mais de 5 minutos
-- (worker morreu) voltam a ser reivindicáveis.
CREATE OR REPLACE FUNCTION public.rpc_process_stock_availability_changes(
  p_limit     int  DEFAULT 200,
  p_worker_id text DEFAULT 'unknown'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed      int := 0;
  v_variations   int := 0;
  v_changed      int := 0;
  v_became_on    int := 0;
  v_became_off   int := 0;
  v_row          record;
  v_prev         record;
  v_online       int;
  v_main         int;
  v_manual       boolean;
  v_sellable     boolean;
  v_ids          bigint[];
  v_companies    int[];
  v_pvids        int[];
BEGIN
  WITH claimed AS (
    UPDATE stock_availability_changes
    SET status = 'processing', locked_at = NOW(), locked_by = p_worker_id, attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM stock_availability_changes
      WHERE status = 'pending'
         OR (status = 'processing' AND locked_at < NOW() - INTERVAL '5 minutes')
      ORDER BY created_at, id
      LIMIT GREATEST(p_limit, 1)
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, company_id, product_variation_id
  )
  SELECT COALESCE(array_agg(id), '{}'), COALESCE(array_agg(company_id), '{}'), COALESCE(array_agg(product_variation_id), '{}')
  INTO v_ids, v_companies, v_pvids
  FROM claimed;

  v_claimed := COALESCE(array_length(v_ids, 1), 0);

  FOR v_row IN
    SELECT DISTINCT u.company_id, u.product_variation_id
    FROM unnest(v_companies, v_pvids) AS u(company_id, product_variation_id)
    ORDER BY u.product_variation_id
  LOOP
    SELECT p.product_kind, (pv.active AND p.active) AS manual, p.company_id AS real_company
    INTO v_prev
    FROM product_variations pv JOIN products p ON p.id = pv.product_id
    WHERE pv.id = v_row.product_variation_id;

    -- Variação apagada, ou evento com empresa divergente → só descarta.
    IF NOT FOUND OR v_prev.real_company IS DISTINCT FROM v_row.company_id THEN
      CONTINUE;
    END IF;

    v_variations := v_variations + 1;
    v_manual   := v_prev.manual;
    v_online   := public.fn_variation_sellable_quantity(v_row.company_id, v_row.product_variation_id, 'online_priority');
    v_main     := public.fn_variation_sellable_quantity(v_row.company_id, v_row.product_variation_id, 'main_store');
    v_sellable := v_manual AND v_online > 0;

    SELECT is_sellable, online_quantity, main_store_quantity, manual_enabled
    INTO v_prev
    FROM variation_availability
    WHERE product_variation_id = v_row.product_variation_id;

    IF NOT FOUND THEN
      INSERT INTO variation_availability (
        product_variation_id, company_id, product_kind, manual_enabled,
        online_quantity, main_store_quantity, inventory_available, is_sellable
      )
      SELECT v_row.product_variation_id, v_row.company_id, p.product_kind, v_manual,
             v_online, v_main, v_online > 0, v_sellable
      FROM product_variations pv JOIN products p ON p.id = pv.product_id
      WHERE pv.id = v_row.product_variation_id;
      v_changed := v_changed + 1;
      IF v_sellable THEN v_became_on := v_became_on + 1; END IF;
    ELSIF v_prev.online_quantity IS DISTINCT FROM v_online
       OR v_prev.main_store_quantity IS DISTINCT FROM v_main
       OR v_prev.manual_enabled IS DISTINCT FROM v_manual THEN
      UPDATE variation_availability
      SET manual_enabled      = v_manual,
          online_quantity     = v_online,
          main_store_quantity = v_main,
          inventory_available = v_online > 0,
          is_sellable         = v_sellable,
          computed_at         = NOW(),
          changed_at          = NOW(),
          sellable_changed_at = CASE WHEN v_prev.is_sellable IS DISTINCT FROM v_sellable THEN NOW() ELSE sellable_changed_at END
      WHERE product_variation_id = v_row.product_variation_id;
      v_changed := v_changed + 1;
      IF v_prev.is_sellable AND NOT v_sellable THEN v_became_off := v_became_off + 1; END IF;
      IF NOT v_prev.is_sellable AND v_sellable THEN v_became_on := v_became_on + 1; END IF;
    ELSE
      UPDATE variation_availability SET computed_at = NOW()
      WHERE product_variation_id = v_row.product_variation_id;
    END IF;
  END LOOP;

  UPDATE stock_availability_changes
  SET status = 'processed', processed_at = NOW(), locked_at = NULL, locked_by = NULL
  WHERE id = ANY(v_ids);

  -- Retenção: a fila não é histórico (o histórico é stock_movements). Apaga
  -- processados com mais de 7 dias, em lote limitado por execução.
  DELETE FROM stock_availability_changes
  WHERE id IN (
    SELECT id FROM stock_availability_changes
    WHERE status = 'processed' AND processed_at < NOW() - INTERVAL '7 days'
    ORDER BY id
    LIMIT 5000
  );

  RETURN jsonb_build_object(
    'claimed',          v_claimed,
    'variations',       v_variations,
    'changed',          v_changed,
    'became_sellable',  v_became_on,
    'became_unavailable', v_became_off
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_process_stock_availability_changes(int, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_process_stock_availability_changes(int, text) TO service_role;


-- ─── 8. RLS — deny-by-default (mesmo padrão das tabelas de integração) ──────

ALTER TABLE public.product_kit_components     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sale_item_components       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_availability_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.variation_availability     ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.product_kit_components     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.sale_item_components       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.stock_availability_changes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.variation_availability     FROM PUBLIC, anon, authenticated;

GRANT ALL ON public.product_kit_components     TO service_role;
GRANT ALL ON public.sale_item_components       TO service_role;
GRANT ALL ON public.stock_availability_changes TO service_role;
GRANT ALL ON public.variation_availability     TO service_role;

GRANT USAGE, SELECT ON SEQUENCE public.product_kit_components_id_seq     TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.sale_item_components_id_seq       TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.stock_availability_changes_id_seq TO service_role;
