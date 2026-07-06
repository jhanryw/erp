-- Documentar tipo/modelo/ano em products (colunas já existentes em produção
-- sem migration rastreável) e formalizar NOT NULL em tipo/modelo, alinhando
-- o banco com a regra que o código já impõe em 100% dos caminhos de escrita
-- (POST /api/produtos e POST /api/produtos/import).
--
-- Auditoria (2026-07-06): ano já é NOT NULL em produção; tipo e modelo são
-- nullable hoje, mas 0 de 370 produtos têm valor nulo ou vazio.
--
-- Não toca em SKU, estoque, vendas ou Nuvemshop. Não cria tabela nova.
-- Não altera comportamento funcional: apenas formaliza no banco uma regra
-- que a aplicação já impõe em todo caminho de escrita existente.

-- 1. Documental — idempotente, sem efeito sobre tipagem/nullability das
--    colunas que já existem (é o caso das três).
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS tipo   TEXT,
  ADD COLUMN IF NOT EXISTS modelo TEXT,
  ADD COLUMN IF NOT EXISTS ano    TEXT NOT NULL;

COMMENT ON COLUMN public.products.tipo IS
  'Retroativo: coluna já existia em produção sem migration rastreável até 2026-07-06. Obrigatória em todo caminho de escrita (POST /api/produtos, POST /api/produtos/import). Ver auditoria PIM Fase 1.';
COMMENT ON COLUMN public.products.modelo IS
  'Retroativo: coluna já existia em produção sem migration rastreável até 2026-07-06. Obrigatória em todo caminho de escrita (POST /api/produtos, POST /api/produtos/import). Ver auditoria PIM Fase 1.';
COMMENT ON COLUMN public.products.ano IS
  'Retroativo: coluna já existia em produção sem migration rastreável até 2026-07-06 (já era NOT NULL). Obrigatória em todo caminho de escrita. Ver auditoria PIM Fase 1.';

-- 2. Formaliza a invariante já garantida pela aplicação: auditoria de
--    2026-07-06 confirmou 0 produtos (de 370) com tipo/modelo nulo ou vazio.
ALTER TABLE public.products
  ALTER COLUMN tipo   SET NOT NULL,
  ALTER COLUMN modelo SET NOT NULL;
