-- Vincula pedidos Nuvemshop às vendas criadas no ERP.
-- sale_id:    ID da venda gerada em `sales` após processamento do webhook
-- customer_id: ID do cliente encontrado/criado no ERP para este pedido

ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS sale_id     integer REFERENCES sales(id),
  ADD COLUMN IF NOT EXISTS customer_id integer REFERENCES customers(id);
