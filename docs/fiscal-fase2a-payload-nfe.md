# Fase Fiscal 2A — Fontes e decisões (cadastro Focus + payload NF-e MEI)

Documento de rastreabilidade das decisões tomadas nesta fase, com fonte de cada uma. Nenhum comportamento fiscal foi inventado sem fonte — onde a fonte não fechava a questão, isso está marcado abaixo e no relatório final da fase (seção G).

## 1. Cadastro de empresa na Focus (`regime_tributario`)

Confirmado (2 páginas independentes e consistentes): `POST /v2/empresas` (criar), `PUT /v2/empresas/{id}` (atualizar, `id` = identificador Focus, nunca CNPJ), `GET /v2/empresas?cnpj=` (buscar, usado pra decidir criar vs. atualizar). Campo `regime_tributario`: 1=Simples Nacional, 2=excesso de sublimite, 3=Regime Normal, **4=Simples Nacional-MEI**.

Certificado A1: `arquivo_certificado_base64` + `senha_certificado`, enviados no mesmo `POST`/`PUT` de empresa — confirmado como o fluxo oficial (doc + blog Focus "Como vincular o certificado digital modelo A1..."). Nunca persistido no ERP.

Fontes: doc.focusnfe.com.br/reference/criar_empresa, /atualizar_empresa, /listar_empresas; focusnfe.com.br/blog/como-vincular-o-certificado-digital-modelo-a1-a-empresa-cadastrada/

## 2. `regime_tributario_emitente` na emissão (`POST /v2/nfe`)

A referência interativa (`doc.focusnfe.com.br/reference/emitir_nfe`) só mostrou 1/2/3 em algumas buscas. A documentação de campos completa (`campos.focusnfe.com.br/nfe/NotaFiscalXML.html`) lista explicitamente o valor **4 — Simples Nacional-MEI** pra este mesmo campo, e o descreve como opcional ("usa o cadastro da empresa se omitido").

**Decisão adotada:** enviar `regime_tributario_emitente` = `company_fiscal_settings.crt` sempre, explicitamente (nunca omitir, nunca hardcoded como 1). Justificativa: (a) a fonte mais completa confirma que 4 é um valor válido; (b) desde a Nota Técnica 2024.001 da SEFAZ, CRT=4 é obrigatório pra emitentes MEI (não é opcional do ponto de vista fiscal); (c) espelhar `crt` diretamente, sem reinterpretar, é o que torna a transição MEI→ME (`crt: 4→1`) automática sem mudança de código.

**Bloqueador residual:** a inconsistência entre as duas páginas da própria Focus não foi resolvida com uma fonte primária única — ver relatório da fase, seção G, pergunta sugerida pro suporte Focus.

## 3. CSOSN para CRT=4 (MEI)

Nota Técnica 2024.001 (SEFAZ), vigente em homologação desde 01/06–01/07/2024 e produção desde 01/04/2025, restringe CSOSN pra emitente CRT=4 a **{102, 300, 400, 900}** (rejeição SEFAZ 782 fora dessa lista). **102** ("tributada pelo Simples Nacional sem permissão de crédito") é o código correto pra revenda simples de mercadoria — nosso único cenário tributário implementado.

Fontes: focusnfe.com.br/blog/nota-tecnica-2024-001-nfe-nfce-e-crt-4-regras-de-validacao/; ajuda.treeunfe.com.br, ajuda.webmaniabr.com (rejeição 782); nfe.fazenda.gov.br NT 2024.001.

## 4. CFOP — achado crítico pra CRT=4

A mesma NT 2024.001 restringe CFOP, quando CSOSN=102, a **{5102, 6102}** pra emitente CRT=4 (rejeição SEFAZ 337) — **mesmo em venda interestadual a consumidor final não contribuinte**, onde a regra geral (não-MEI) usaria 6108. `resolveCfop()` implementa essa distinção explicitamente por CRT — ver `src/lib/fiscal/taxRules.ts`.

**Isto é uma armadilha real**: um CFOP "normalmente correto" (6108) causaria rejeição SEFAZ 337 se usado por um emitente MEI. Confirmado por 5+ fontes independentes (Focus + TreeUNFe + Omie + CIGAM + TecnoSpeed), mas sem verificação direta contra o PDF primário da NT 2024.001 (bloqueado por redirect) — listado como bloqueador residual (seção G do relatório).

## 5. PIS/COFINS/IPI

Nenhuma regra de validação SEFAZ documentada restringe CST de PIS/COFINS/IPI por CRT (diferente de CSOSN/CFOP, que têm rejeições SEFAZ numeradas). É convenção contábil, não regra de schema:

- **PIS/COFINS CST 49** ("Outras operações de saída") — candidato mais citado pra Simples Nacional/MEI (tributo recolhido via DAS, sem destaque por operação).
- **IPI CST 53** ("Saída não tributada") + `ipi_codigo_enquadramento_legal=999` ("não aplicável", confirmado na doc de campos da Focus) — pra não-contribuinte de IPI (revendedor).

**Confirmação pendente com o contador da empresa antes da primeira emissão real** — ver relatório, seção G. É o único ponto desta fase onde a fonte é prática contábil, não regra de validação SEFAZ.

## 6. Campos do payload — nomes exatos confirmados

Ver `src/lib/integrations/focus/nfePayload.types.ts` pra lista completa com comentário de origem por campo. Fonte primária: `campos.focusnfe.com.br/nfe/NotaFiscalXML.html`.

**Não confirmado** (documentado como tal no código, nunca inventado):
- Se `icms_base_calculo`/`aliquota`/`valor` (e os equivalentes de PIS/COFINS/IPI) devem ser omitidos ou enviados zerados quando CSOSN=102/CST=49/CST=53. **Decisão adotada:** omitir — CSOSN 102/CST 49/CST 53 representam "sem destaque de valor tributário" no schema nacional da NFe (convenção bem estabelecida, não específica da Focus); calcular e enviar valor zerado pra um imposto que não incide seria o oposto do que a instrução da fase pediu ("não calcule imposto que não se aplica apenas para preencher campo").
- Se a Focus calcula `local_destino` automaticamente a partir das UFs, ou exige que o ERP envie. **Decisão adotada:** o ERP sempre calcula e envia explicitamente (`resolveLocalDestino`) — mais seguro que depender de um comportamento não confirmado.
- Código IBGE do município do destinatário: **não existe fonte no ERP hoje** (`customer_addresses` não tem essa coluna) — sinalizado como erro de validação sempre, não uma lacuna escondida.

## 7. Lacunas de schema confirmadas (não resolvidas nesta fase, por escopo)

- `customers` não modela CNPJ nem tipo de pessoa (PF/PJ) — só suporta destinatário pessoa física hoje.
- `customer_addresses` não tem código IBGE do município.
- `presenca_comprador`/`natureza_operacao` não têm fonte própria no schema (`sales.sale_origin` é canal de marketing, não indicador fiscal) — parâmetros explícitos do preview nesta fase, não inferidos.

## 8. Fechamento (pós-Fase 2B) — o que mudou desde este documento

Este documento é um registro histórico das decisões da Fase 2A — não reescrito retroativamente. Atualizações reais desde então:

- **Item 2 (`regime_tributario_emitente=4`)**: considerado CONFIRMADO por decisão do responsável pelo produto — removido da lista de bloqueadores. Nenhuma mudança de comportamento (já era isso que o código enviava).
- **Item 6, primeiro ponto (omitir vs. zerar PIS/COFINS/IBS-CBS)**: **REVERTIDO na Fase 2B** com evidência empírica real (2 XMLs autorizados pela SEFAZ) — PIS/COFINS/IBS/CBS são sempre enviados explicitamente como `0`, nunca omitidos. Ver `docs/fiscal-fase2b-transmissao-homologacao.md` e o comentário de topo de `src/lib/integrations/focus/nfePayload.types.ts`.
- **Item 6/7, código IBGE do destinatário**: resolvido arquiteturalmente na Fase 2B via `resolveMunicipioIbge` (cache + API pública do IBGE) — deixou de ser "sem fonte", mas continua sendo **exigido** (preferência forte, nunca relaxado) antes de montar o payload.
- **Nomes de campo IBS/CBS**: reconfirmados na Fase 2B por leitura direta do HTML bruto (não resumo de IA) e considerados CONFIRMADOS por decisão do responsável pelo produto.
- Itens 3-5 (CSOSN/CFOP pra CRT=4, PIS/COFINS/IPI convenção contábil) permanecem como estavam — não foram alterados nem fechados nesta rodada.
