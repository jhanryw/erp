-- NÃO EXECUTADO. Atualiza SOMENTE razao_social (e, opcionalmente, nome_fantasia) da empresa 1.
-- Fonte: Consulta de Optantes da Receita Federal — "SANTTORINI LINGERIE LTDA", mesmo CNPJ (final 0001-17).
-- Preserva CNPJ, IE, endereço, CRT. NÃO toca em fiscal_documents (documentos emitidos guardam o próprio snapshot).
-- Cada passo é um statement simples (sem bloco DO), seguro para o SQL Editor do Supabase.
-- O hash abaixo cobre os campos que NÃO podem mudar: tem de ser IDÊNTICO no ANTES e no DEPOIS.

-- ── 1) ANTES ────────────────────────────────────────────────────────────────
select razao_social, nome_fantasia, crt,
       md5(concat_ws('|', cnpj, inscricao_estadual, logradouro, numero_endereco, complemento,
                          bairro, municipio, municipio_ibge, uf, cep)) as hash_campos_preservados,
       (select count(*) from public.fiscal_documents where company_id = 1) as qtd_documentos_fiscais
from public.company_fiscal_settings where company_id = 1;

-- ── 2) UPDATE da razão social (compare-and-set: só altera se ainda for o valor antigo) ──
update public.company_fiscal_settings
   set razao_social = 'SANTTORINI LINGERIE LTDA'
 where company_id = 1
   and razao_social = '61.523.225 YASMIM PEREIRA ARAUJO LUCAS FREIRE';

-- ── 3) OPCIONAL: nome fantasia (só se hoje for nulo). Remova este statement se não quiser. ──
update public.company_fiscal_settings
   set nome_fantasia = 'Santtorini Lingerie'
 where company_id = 1 and nome_fantasia is null;

-- ── 4) DEPOIS (conferir: hash e qtd_documentos_fiscais iguais ao ANTES; razao_social nova) ──
select razao_social, nome_fantasia, crt,
       md5(concat_ws('|', cnpj, inscricao_estadual, logradouro, numero_endereco, complemento,
                          bairro, municipio, municipio_ibge, uf, cep)) as hash_campos_preservados,
       (select count(*) from public.fiscal_documents where company_id = 1) as qtd_documentos_fiscais
from public.company_fiscal_settings where company_id = 1;
