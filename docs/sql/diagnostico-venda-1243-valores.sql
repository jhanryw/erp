-- SOMENTE LEITURA — venda 1243: valores, pagamento, CRT e status fiscal. Sem CPF/telefone/endereço.
select s.id as venda, s.status, s.total, s.discount_amount, s.surcharge_amount, s.shipping_charged,
       (select coalesce(sum(total_amount),0) from fiscal_document_items fdi
         join fiscal_documents fd on fd.id = fdi.fiscal_document_id
        where fd.id = 32) as soma_itens_nfe_doc32
from sales s where s.id = 1243;

select method, net_amount, amount_tendered, change_amount from sale_payments where sale_id = 1243;

select crt, nfe_environment, nfe_enabled from company_fiscal_settings where company_id = 1;

select id, status, environment, provider_ref, number, access_key is not null as tem_chave,
       submission_error_code, left(submission_error_message, 300) as erro
from fiscal_documents where id = 32;
