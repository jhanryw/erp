-- SOMENTE LEITURA — confirmar a recuperação da NF-e da venda 1243 no ERP.
select id, status, number, series,
       access_key, length(access_key) as tamanho_chave, access_key ~ '^[0-9]{44}$' as chave_so_digitos,
       authorization_protocol, status_sefaz, provider_ref,
       xml_path is not null as tem_xml, danfe_path is not null as tem_danfe,
       authorized_at, submission_started_at
from public.fiscal_documents where id = 32;

-- Deve haver exatamente 1 documento NF-e de produção para a venda (nenhum novo):
select count(*) as qtd_documentos_nfe_producao, count(*) filter (where status = 'authorized') as qtd_autorizados
from public.fiscal_documents where sale_id = 1243 and document_type = 'nfe' and environment = 'producao';
