-- SOMENTE LEITURA — estado fiscal da venda 1243 (sem dados pessoais).
select id, document_type, environment, status, provider_ref, number, series,
       left(access_key, 6) || '…' as access_key_prefix, authorization_protocol is not null as tem_protocolo,
       status_sefaz, status_message, submission_error_code, submission_error_message,
       submission_started_at, submission_lease_until, issued_at, authorized_at,
       xml_path is not null as tem_xml, danfe_path is not null as tem_danfe
from fiscal_documents where sale_id = 1243 order by id;

select fdi.* from fiscal_document_items fdi
join fiscal_documents fd on fd.id = fdi.fiscal_document_id
where fd.sale_id = 1243 and fd.document_type = 'nfe';
