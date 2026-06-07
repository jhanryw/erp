-- Migration: 20260606_auto_freight_expense.sql
--
-- Objetivo: registrar automaticamente a despesa de frete (repasse 100% ao motoboy)
-- toda vez que uma venda com shipping_charged > 0 for criada.
--
-- Efeito nos relatórios:
--   Receita: inclui shipping_charged (frete cobrado do cliente) — inalterado
--   Despesa: freight_cost igual ao frete cobrado — NOVO
--   Resultado líquido do frete: R$0 (repasse integral ao motoboy)
--
-- Idempotente: DROP IF EXISTS garante re-execução segura.

-- ─── 1. Função do trigger ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION trg_fn_auto_freight_expense()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_company_id INT;
BEGIN
  -- Só age quando há frete cobrado
  IF NEW.shipping_charged IS NULL OR NEW.shipping_charged <= 0 THEN
    RETURN NEW;
  END IF;

  -- Busca company_id do vendedor
  SELECT company_id INTO v_company_id
  FROM users WHERE id = NEW.seller_id;

  -- Registra despesa de frete (repasse motoboy)
  INSERT INTO finance_entries (
    type,
    category,
    description,
    amount,
    reference_date,
    sale_id,
    created_by,
    company_id
  ) VALUES (
    'expense',
    'freight_cost',
    'Frete motoboy — ' || NEW.sale_number,
    NEW.shipping_charged,
    NEW.sale_date,
    NEW.id,
    NEW.seller_id,
    v_company_id
  );

  RETURN NEW;
END;
$$;

-- ─── 2. Trigger na tabela sales ───────────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_auto_freight_expense ON sales;

CREATE TRIGGER trg_auto_freight_expense
  AFTER INSERT ON sales
  FOR EACH ROW
  EXECUTE FUNCTION trg_fn_auto_freight_expense();

-- ─── 3. Backfill: vendas já existentes sem lançamento de frete ────────────────
-- Cria o lançamento de despesa para vendas passadas que tinham frete
-- mas não tinham o registro de saída.

INSERT INTO finance_entries (type, category, description, amount, reference_date, sale_id, created_by, company_id)
SELECT
  'expense',
  'freight_cost',
  'Frete motoboy — ' || s.sale_number,
  s.shipping_charged,
  s.sale_date,
  s.id,
  s.seller_id,
  u.company_id
FROM sales s
JOIN users u ON u.id = s.seller_id
WHERE s.shipping_charged > 0
  AND s.status NOT IN ('cancelled', 'returned')
  -- Garante que não existe lançamento de frete já vinculado a esta venda
  AND NOT EXISTS (
    SELECT 1 FROM finance_entries fe
    WHERE fe.sale_id   = s.id
      AND fe.category  = 'freight_cost'
      AND fe.type      = 'expense'
  );
