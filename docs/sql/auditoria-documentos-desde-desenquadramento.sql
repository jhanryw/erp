-- SOMENTE LEITURA — NF-e/NFC-e desde 01/09/2026 emitidas com CRT 4 / CFOP de MEI. NADA é alterado.
-- NF-e: o CRT vai no payload (regime_tributario_emitente). NFC-e: não envia regime (vale o cadastro da
-- Focus no momento da emissão) — crt_enviado fica nulo; avaliar pela data vs. alteração do painel.
select fd.id, fd.sale_id, fd.document_type, fd.environment, fd.status, fd.number,
       coalesce(fd.authorized_at, fd.issued_at, fd.created_at) as data_ref,
       fd.request_payload->>'regime_tributario_emitente' as crt_enviado,
       (select string_agg(distinct fdi.cfop, ',') from public.fiscal_document_items fdi where fdi.fiscal_document_id = fd.id) as cfops
from public.fiscal_documents fd
where fd.company_id = 1
  and coalesce(fd.authorized_at, fd.issued_at, fd.created_at) >= timestamptz '2026-09-01 00:00:00-03'
order by data_ref;

-- Recorte: NF-e AUTORIZADAS com CRT 4 desde o desenquadramento.
select fd.id, fd.sale_id, fd.number, fd.authorized_at
from public.fiscal_documents fd
where fd.company_id = 1 and fd.document_type = 'nfe' and fd.status = 'authorized'
  and fd.authorized_at >= timestamptz '2026-09-01 00:00:00-03'
  and fd.request_payload->>'regime_tributario_emitente' = '4';
