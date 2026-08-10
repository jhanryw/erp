# Plano de Versionamento de Schema XSD — NF-e/NFC-e

**Tipo:** estratégia de acompanhamento, **não implementada**. Motivação: a pesquisa oficial (`svrs-services-endpoints.md` §4) confirmou que o layout está em revisão ativa (PL_010e, com a NT 2025.002 na v.1.51 datada de hoje) — qualquer estratégia que trate a versão do schema como fixa está condenada a ficar desatualizada. Este documento propõe como o ERP deve lidar com isso ao longo do tempo, não qual versão usar hoje (isso é responsabilidade de `svrs-services-endpoints.md`, que deve ser tratado como o registro vivo da versão vigente).

---

## Princípio central

**Nunca hardcodar a versão do schema/layout dentro do código de montagem de XML.** A versão usada deve ser um dado explícito, gravado junto com cada documento fiscal emitido — não uma constante compilada uma vez e esquecida.

## Onde a versão do schema vive

- **`fiscal_documents.schema_version`** (novo campo, a adicionar à proposta de `fiscal-architecture-proposal.md` §2 na próxima revisão autorizada do modelo de dados) — grava qual versão do layout (ex.: `"PL_010e"`) foi usada para montar aquele documento específico. Imutável após autorização, como o resto do snapshot fiscal.
- **Diretório versionado de XSDs locais**, proposto: `src/services/fiscal/gateway/svrs/xsd/<versao>/`, contendo cópia local dos arquivos XSD oficiais baixados do Portal Nacional (nunca de terceiro, nunca resolvidos via rede em tempo de execução — `xmllint-wasm` não resolve `xsd:import` remotamente, conforme já registrado em `fiscal-crypto-security-plan.md`). Cada subpasta corresponde a uma versão do layout suportada.
- **`fiscal-svrs-endpoints.md`** (este documento e `svrs-services-endpoints.md`) — atualizado manualmente quando uma nova versão for adotada, nunca a fonte de verdade em tempo de execução (isso é o diretório local de XSDs).

## Processo de atualização quando uma nova versão/Nota Técnica for publicada

1. **Detecção:** não há webhook oficial de "nova NT publicada" — proposta de processo manual/periódico: revisão mensal da listagem `Documentos > Notas Técnicas` e `Documentos > Esquemas XML` do Portal Nacional (`nfe.fazenda.gov.br`), comparando contra a última versão registrada em `svrs-services-endpoints.md`. Isso é um processo operacional, não um job automatizado — não propor automação de scraping do portal oficial sem avaliação separada de estabilidade/termos de uso.
2. **Avaliação de impacto:** ler a NT completa (não só o título), classificar como: (a) aditiva/compatível — novos campos opcionais, XSD antigo continua validando documentos antigos; (b) obrigatória com prazo — como o cronograma de Reforma Tributária já mapeado, com data-limite conhecida; (c) breaking — muda estrutura de campo existente, exige coordenação com a emissão de documentos já em andamento.
3. **Nova subpasta de XSD:** baixar os XSDs oficiais da nova versão para uma nova subpasta versionada (`xsd/PL_0XXx/`), sem apagar a versão anterior enquanto documentos antigos possam precisar ser reconsultados/reimpressos com a versão original.
4. **Testar em homologação** antes de qualquer emissão em produção usar a nova versão — reaproveitando a mesma separação de ambiente já desenhada.
5. **Cutover controlado:** o código de montagem de XML (`xmlBuilder.ts`) passa a apontar para a nova versão como padrão só depois de validado; documentos futuros gravam `schema_version` da nova versão, documentos passados mantêm o valor histórico gravado.

## Rastreabilidade de qual NT motivou qual mudança

Proposta: um arquivo `CHANGELOG` dentro de `src/services/fiscal/gateway/svrs/xsd/`, texto simples, uma linha por adoção de nova versão, citando a NT e a data — não uma tabela de banco (isso é metadado de código/infraestrutura, não dado de negócio a consultar em runtime).

## Relação com a Reforma Tributária (IBS/CBS)

Como já registrado em `svrs-services-endpoints.md` §10: a Santtorini (Simples Nacional) tem prazo até 01/01/2027, com leiaute específico do Simples Nacional só publicado em 01/09/2026. **Isso significa que o schema XSD usado nas Entregas D-H (NFC-e em homologação e produção controlada, ver `fiscal-direct-implementation-phases.md`) não precisa necessariamente incluir campos de IBS/CBS desde o primeiro dia** — mas o processo de atualização acima (revisão mensal, subpastas versionadas) deve estar rodando antes de setembro/2026, para que a adoção do leiaute do Simples Nacional, quando publicado, siga o processo formal em vez de ser um retrabalho não planejado.

## O que este documento não decide

Não fixa qual versão exata deve ser usada no código quando a implementação for autorizada — isso deve ser a versão vigente confirmada em `svrs-services-endpoints.md` **no momento da Entrega C/D**, não a versão registrada nesta data (04/08/2026), que pode já estar desatualizada quando a implementação começar. **Reconfirmar a versão vigente imediatamente antes de baixar os XSDs para a Entrega C** é uma ação explícita a incluir no critério de início dessa entrega.

**Nenhum arquivo XSD foi baixado, nenhuma pasta foi criada nesta etapa.**
