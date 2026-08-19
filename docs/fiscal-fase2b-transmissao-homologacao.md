# Fase Fiscal 2B — Pré-emissão Focus NFe em homologação

Documento de rastreabilidade das decisões desta fase, com fonte de cada uma.

## A. IBS/CBS — reconfirmado por leitura direta do HTML bruto

A Fase 2A tinha usado `WebFetch` (que resume conteúdo via um modelo de IA) pra pesquisar os campos IBS/CBS — risco real de paráfrase nos nomes de campo. Nesta fase, refeito via `curl` direto em `campos.focusnfe.com.br/nfe/NotaFiscalXML.html`, com grep no JSON bruto da própria página (sem intermediário de IA). Confirmado, com `required`/`tag` originais:

| Campo Focus | required | tag XML | Escopo |
|---|---|---|---|
| `ibs_cbs_situacao_tributaria` | **true** | CST | item |
| `ibs_cbs_classificacao_tributaria` | **true** | cClassTrib | item |
| `ibs_cbs_base_calculo` | false | vBC | item |
| `ibs_uf_aliquota` | false | pIBSUF | item |
| `ibs_uf_valor` | false | vIBSUF | item |
| `ibs_mun_aliquota` | false | pIBSMun | item |
| `ibs_mun_valor` | false | vIBSMun | item |
| `ibs_valor_total` | false | vIBS | item (nome reaproveitado do total do documento — confirmado por posição no HTML) |
| `cbs_aliquota` | false | pCBS | item |
| `cbs_valor` | false | vCBS | item |
| `ibs_uf_valor_total` / `ibs_mun_valor_total` / `cbs_valor_total` | false | vIBSUF/vIBSMun/vCBS | documento (não enviados por este ERP — mesma decisão de não computar totais de documento, Focus computa a partir dos itens) |

Todos os valores calculados são enviados explicitamente como `0` (nunca omitidos) — mesmo padrão confirmado pra PIS/COFINS pelos XMLs reais.

**Ano-teste 2026**: confirmado por anúncio oficial conjunto CGIBS + Receita Federal (cgibs.gov.br) — declarar com alíquota real, mas dispensado de recolher (valor final zero), condicionado a cumprir a obrigação acessória.

## B. Resposta de emissão/consulta — confirmado por exemplo real

Via `curl` em `doc.focusnfe.com.br/reference/consultar_nfe` (raw HTML, não resumo de IA):

```json
{
  "cnpj_emitente": "...", "ref": "...", "status": "autorizado",
  "status_sefaz": "100", "mensagem_sefaz": "Autorizado o uso da NF-e",
  "chave_nfe": "...", "numero": "22", "serie": "1",
  "caminho_xml_nota_fiscal": "/arquivos/.../XMLs/....xml",
  "caminho_danfe": "/arquivos/.../DANFEs/....pdf",
  "caminho_danfe_etiqueta": "...",
  "protocolo_nota_fiscal": {
    "numero_protocolo": "151260029467289", "status": "100",
    "motivo": "Autorizado o uso da NF-e", "data_recebimento": "...", "chave_nfe": "..."
  }
}
```

**Correção importante**: o protocolo (`nProt` do XML) fica em `protocolo_nota_fiscal.numero_protocolo` (objeto aninhado) — **não** um campo `protocolo` plano, como uma leitura rápida da doc poderia sugerir.

`POST /nfe` confirmado: `ref` é **query parameter obrigatório** (`?ref=...`), nunca no corpo — `{"name":"ref","in":"query","required":true}`.

## C. Transmission service — idempotência

`submitNfeHomologacao(saleId, companyId)` — ver comentário completo em [`src/services/fiscal/submitNfeHomologacao.ts`](../src/services/fiscal/submitNfeHomologacao.ts). Resumo: `provider_ref = qarvon-{company_id}-{sale_id}-nfe` (determinístico), uma linha `fiscal_documents` por (empresa, venda), nunca duas. `authorized`/`cancelled` = terminal, nunca reemite. `pending` = consulta antes de qualquer coisa. Timeout/rede = `pending` com resultado desconhecido, não `submission_error` (que é reservado pra erro síncrono confirmado da Focus).

## D. Fechamento — bloqueadores encerrados por decisão do responsável pelo produto

Após esta fase, os seguintes itens (antes listados como "bloqueador residual — confirmar com Focus support") foram considerados FECHADOS, sem necessidade de confirmação externa adicional:

1. `regime_tributario_emitente=4` pra emitente MEI — confirmado.
2. Nomes de campo IBS/CBS (tabela da seção A) — confirmados.
3. Código IBGE do destinatário — **mantido como preferência forte** (`resolveMunicipioIbge`, `buildNfePayload` continua exigindo o valor resolvido). Documentado, mas não implementado como fallback: é plausível que a Focus consiga resolver o código internamente a partir de `municipio_destinatario`+`uf_destinatario` — ver comentário em `src/lib/integrations/focus/nfePayload.types.ts`, campo `codigo_municipio_destinatario`. Este ERP continua exigindo a resolução local.

**A partir daqui, o motor fiscal (`src/lib/fiscal/`, `src/services/fiscal/buildNfePayload.ts`, `buildFiscalSnapshot.ts`, `submitNfeHomologacao.ts`, `nfePayload.types.ts`) está CONGELADO** — nenhuma mudança de regra tributária, nome de campo ou payload foi feita nesta rodada de fechamento, só documentação. Itens ainda genuinamente pendentes (não fechados por decisão, permanecem reais):

- CFOP 6102 pra CRT=4 sem verificação direta do PDF primário da NT 2024.001 (Fase 2A, item 4).
- PIS/COFINS CST 49 / IPI CST 53 como convenção contábil, não regra SEFAZ — confirmação com contador ainda recomendada antes de uma emissão que valha fiscalmente.
- Se `ibs_uf_valor`/`ibs_mun_valor`/`ibs_valor_total`/`cbs_valor` calculados devem vir do cliente ou são computados pela Focus.
- `customers` sem suporte a CNPJ/PJ (lacuna de schema, fora de escopo).
