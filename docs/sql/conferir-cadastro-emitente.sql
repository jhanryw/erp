-- SOMENTE LEITURA — o que o ERP enviaria à Focus em POST /api/fiscal/empresa.
-- A sincronização SOBRESCREVE o cadastro da Focus com estes valores: compare com a
-- Receita Federal / painel da Focus ANTES de sincronizar. (CNPJ mascarado.)
select company_id,
       left(cnpj, 2) || '.***.***/' || right(cnpj, 6) as cnpj_mascarado,
       razao_social, nome_fantasia, inscricao_estadual, crt,
       municipio, uf, cep, municipio_ibge, bairro, logradouro, numero_endereco, complemento,
       email is not null as tem_email, telefone is not null as tem_telefone,
       updated_at
from public.company_fiscal_settings where company_id = 1;

-- Modelo (NÃO executar sem preencher): corrigir a razão social no ERP antes da sincronização.
-- update public.company_fiscal_settings set razao_social = '<RAZÃO SOCIAL CONFORME RECEITA>',
--        nome_fantasia = '<FANTASIA>' where company_id = 1;
