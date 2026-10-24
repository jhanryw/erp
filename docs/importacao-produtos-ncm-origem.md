# Importação de produtos — NCM, origem fiscal e CST

## Cabeçalhos
Os cabeçalhos são comparados sem diferenciar maiúsculas, acentos, espaços ou pontuação
(`NCM`, `Origem Fiscal`, `Nome Produto`, `Preço`, `SKU` funcionam).

| Campo | Cabeçalhos aceitos |
|---|---|
| NCM | `ncm`, `codigo_ncm` |
| Origem fiscal (0–8) | `origem_fiscal`, `origem_da_mercadoria`, `origem_mercadoria`, `origem_icms`, `icms_origem`, `orig` |
| CST | `cst`, `cst_csosn` |
| Fabricação (própria/terceiro) | `origem` com texto (`propria`/`terceiro`) |

## Regras
- **NCM**: sempre texto de 8 dígitos. Pontuação é removida (`6109.10.00` → `61091000`). Célula
  *numérica* de 7 dígitos (zero perdido pelo Excel) recebe o zero; texto com 7 dígitos é rejeitado.
  Nunca há NCM padrão.
- **Origem fiscal**: inteiro 0–8; `0` é válido. Vazio = ausente.
- **Ambiguidade da coluna `origem`**: valor numérico 0–8 é lido como origem fiscal e gera **aviso**
  (não bloqueia). Se `origem_fiscal` também estiver preenchida, ela tem prioridade e a `origem` numérica é ignorada.
- **Produto com variações**: dados fiscais são do produto; o primeiro valor informado vale e valores
  divergentes entre linhas do mesmo produto são erro.
- **Atualização por SKU** (coluna `sku` preenchida): só campos preenchidos entram; célula vazia nunca apaga.
- **CST**: guardado como texto; um CST numérico do Excel (`60`) não tem o zero restaurado (`060`).

## Produtos já cadastrados sem NCM/origem
Consulta somente leitura: `docs/queries/produtos-sem-ncm-ou-origem.sql`. A correção deve vir da planilha
original (reimportação por SKU) ou de revisão manual; não há preenchimento automático.
