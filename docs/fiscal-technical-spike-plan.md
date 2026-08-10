# Spike Técnico — Prova Isolada de Integração Direta SEFAZ/SVRS

**Tipo:** plano de spike técnico, **não implementado**. Objetivo do spike: provar, em código isolado (fora das rotas do PDV, sem tocar em `sales`/`rpc_create_sale`/nenhuma tabela de produção), que a cadeia completa certificado → mTLS → XML → validação → assinatura → transmissão → interpretação de resposta funciona em homologação, antes de integrar ao domínio de vendas.

**Isolamento do spike:** roda como um script/rota de teste separada (ex.: `scripts/fiscal-spike/` ou uma rota `/api/debug/fiscal-spike` protegida por `admin` + `CRON_SECRET`-like guard, nunca exposta em produção), nunca chamado pelo fluxo real de venda. Usa dados sintéticos de teste (CNPJ de homologação fornecido pela SEFAZ/RN, se existir um padrão documentado — a confirmar; senão, dados fictícios claramente marcados). Consome exclusivamente os endpoints de **homologação** listados em `svrs-services-endpoints.md` — nunca produção.

---

## Passo 1 — Carregar certificado A1 por secret de runtime

| | |
|---|---|
| **Arquivo** | `scripts/fiscal-spike/01-load-certificate.ts` |
| **Dependências** | `node-forge` (>=1.4.0, obrigatório por causa dos CVEs corrigidos — ver `fiscal-crypto-security-plan.md`) |
| **Secrets** | `CERTIFICATE_PFX_BASE64` (conteúdo do .pfx em base64, nunca o arquivo em disco versionado), `CERTIFICATE_PASSWORD` (senha do PFX, secret separado — nunca concatenado com o PFX) |
| **Riscos** | Vazamento do secret em log de erro se a lib lançar exceção contendo o buffer; secret em variável de ambiente pode aparecer em `process.env` dumps de ferramentas de observabilidade mal configuradas |
| **Testes** | Unitário: carregar um PFX de teste (gerado localmente, autoassinado, nunca um certificado real) e confirmar que a chave privada e o certificado são extraídos sem erro; teste negativo: senha errada deve falhar com erro claro, sem vazar a senha na mensagem |
| **Rollback** | Nenhum — script standalone, não toca infraestrutura persistente |

## Passo 2 — Validar certificado, CNPJ e validade

| | |
|---|---|
| **Arquivo** | `scripts/fiscal-spike/02-validate-certificate.ts` |
| **Dependências** | `node-forge` (leitura de campos do X.509: `notBefore`/`notAfter`, `subject` para extrair CNPJ do OID específico do padrão ICP-Brasil e-CNPJ) |
| **Secrets** | Nenhum novo — reusa o certificado carregado no Passo 1 |
| **Riscos** | Formato do CNPJ dentro do certificado ICP-Brasil segue um padrão específico (dentro do campo `subject`, OID de "Responsável" + CNPJ concatenados) — erro comum é extrair o campo errado; validade expirada não deveria travar o spike (é ambiente de teste), mas deve ser logada com clareza |
| **Testes** | Confirmar que `notAfter` é lido corretamente e comparado contra a data atual; confirmar extração do CNPJ contra um valor conhecido do certificado de teste |
| **Rollback** | Nenhum |

## Passo 3 — Estabelecer mTLS

| | |
|---|---|
| **Arquivo** | `scripts/fiscal-spike/03-mtls-handshake.ts` |
| **Dependências** | Nativo (`https`/`tls` do Node 20) — nenhuma lib terceira necessária (confirmado em `fiscal-crypto-security-plan.md`) |
| **Secrets** | Certificado + chave (já extraídos do Passo 1) |
| **Riscos** | Cadeia intermediária ausente causa falha de handshake — precisa concatenar leaf + AC intermediária; formato PEM vs. o que `node-forge` exporta precisa ser conferido byte a byte |
| **Testes** | Handshake TLS puro contra `https://nfe-homologacao.svrs.rs.gov.br` (sem enviar SOAP ainda) — sucesso = conexão TLS estabelecida, sem erro de certificado |
| **Rollback** | Nenhum |

## Passo 4 — Consultar `NfeStatusServico` em homologação

| | |
|---|---|
| **Arquivo** | `scripts/fiscal-spike/04-status-servico.ts` |
| **Dependências** | `easy-soap-request` (ou `soap`, a decidir — ver `fiscal-crypto-security-plan.md`) + `fast-xml-parser` para ler a resposta |
| **Secrets** | Nenhum novo |
| **Riscos** | Este é o primeiro passo que efetivamente sai para a rede da SEFAZ — confirmar que está apontando para homologação (`nfe-homologacao.svrs.rs.gov.br`), nunca produção, com uma checagem explícita no código (ex.: assert no início do script) |
| **Testes** | Chamada real a `NfeStatusServico` de homologação (é seguro — é só consulta de disponibilidade, não gera obrigação fiscal); sucesso = `cStat=107` ("Serviço em Operação") ou equivalente documentado no MOC |
| **Rollback** | Nenhum — é só leitura contra o serviço da SEFAZ |

## Passo 5 — Montar XML mínimo

| | |
|---|---|
| **Arquivo** | `scripts/fiscal-spike/05-build-minimal-xml.ts` |
| **Dependências** | `xmlbuilder2` |
| **Secrets** | Nenhum |
| **Riscos** | Montar um XML "mínimo" de NFC-e ainda exige preencher corretamente dezenas de campos obrigatórios do leiaute (emitente, destinatário quando aplicável, item, totais, transporte, pagamento) — o risco aqui não é técnico (a lib funciona), é de **fidelidade ao leiaute** (Anexo I do MOC 7.0, layout PL_010e conforme `fiscal-xsd-versioning-plan.md`). Usar dados fictícios de CNPJ/produto claramente marcados como teste |
| **Testes** | Nenhuma chamada de rede neste passo — só geração de string XML; teste unitário: XML gerado é bem formado (parseável de volta) |
| **Rollback** | Nenhum |

## Passo 6 — Validar XML no XSD oficial

| | |
|---|---|
| **Arquivo** | `scripts/fiscal-spike/06-validate-xsd.ts` |
| **Dependências** | `xmllint-wasm` (opção recomendada — ver `fiscal-crypto-security-plan.md` para a lacuna de validação XSD em Node) |
| **Secrets** | Nenhum |
| **Riscos** | Os XSDs têm `xsd:import`/`xsd:include` entre si — `xmllint-wasm` não resolve isso automaticamente via rede, exige carregar todos os arquivos XSD relacionados manualmente (baixados do Portal Nacional, versão PL_010e, nunca de terceiro) |
| **Testes** | XML do Passo 5 deve validar sem erro contra o XSD oficial; teste negativo proposital (remover um campo obrigatório) deve falhar a validação, confirmando que o validador realmente pega erros |
| **Rollback** | Nenhum |

## Passo 7 — Assinar com XMLDSig

| | |
|---|---|
| **Arquivo** | `scripts/fiscal-spike/07-sign-xml.ts` |
| **Dependências** | `xml-crypto` ou `xmldsigjs` (escolher uma após comparação — ver `fiscal-crypto-security-plan.md`) |
| **Secrets** | Chave privada extraída no Passo 1 |
| **Riscos** | A NF-e exige assinatura **enveloped** com canonicalização **exc-c14n** de uma tag específica (não o documento inteiro) — erro de `Reference URI`/transform é a causa mais comum de rejeição por assinatura inválida; testar contra os requisitos exatos do Anexo I do MOC antes de considerar concluído |
| **Testes** | Assinar o XML do Passo 6 e confirmar que a tag `<Signature>` aparece corretamente formada, no local certo do documento |
| **Rollback** | Nenhum |

## Passo 8 — Verificar localmente a assinatura

| | |
|---|---|
| **Arquivo** | `scripts/fiscal-spike/08-verify-signature-locally.ts` |
| **Dependências** | Mesma lib do Passo 7 (verificação é o inverso da assinatura) |
| **Secrets** | Certificado público (não a chave privada — verificação só precisa da parte pública) |
| **Riscos** | Verificar localmente antes de transmitir evita gastar uma tentativa de transmissão (e possivelmente consumir numeração) com uma assinatura já sabidamente inválida |
| **Testes** | A assinatura do Passo 7 deve verificar como válida; teste negativo: alterar 1 byte do XML assinado deve fazer a verificação falhar |
| **Rollback** | Nenhum |

## Passo 9 — Transmitir em homologação

| | |
|---|---|
| **Arquivo** | `scripts/fiscal-spike/09-transmit-homologacao.ts` |
| **Dependências** | Cliente SOAP do Passo 4, endpoint `NFeAutorizacao` de homologação |
| **Secrets** | Certificado (para mTLS, já carregado) |
| **Riscos** | **Este é o único passo do spike com efeito colateral real** (mesmo em homologação, consome numeração de teste, gera um registro do lado da SEFAZ). Checagem explícita obrigatória no código: ambiente = homologação, endpoint contém `-homologacao`, antes de qualquer envio. Nunca rodar este passo automatizado/em CI sem revisão humana |
| **Testes** | Envio do XML assinado (Passos 5-8); sucesso mínimo = resposta HTTP 200 com envelope SOAP interpretável (mesmo que o `cStat` retorne rejeição por dado de teste inválido — o objetivo do spike é provar a cadeia técnica, não necessariamente obter autorização na primeira tentativa) |
| **Rollback** | Não aplicável (não é possível "desfazer" uma transmissão à SEFAZ) — por isso os passos 1-8 devem estar exaustivamente testados antes de chegar aqui |

## Passo 10 — Interpretar `cStat`, `xMotivo`, recibo, protocolo e chave

| | |
|---|---|
| **Arquivo** | `scripts/fiscal-spike/10-parse-response.ts` |
| **Dependências** | `fast-xml-parser` |
| **Secrets** | Nenhum |
| **Riscos** | Mapeamento incompleto de códigos `cStat` (a NF-e tem dezenas de códigos possíveis — sucesso, rejeição, processamento assíncrono via lote) — o spike só precisa reconhecer os códigos mínimos para os cenários testados, não todos; documentar explicitamente quais foram cobertos |
| **Testes** | Parsing correto da resposta do Passo 9 (sucesso ou rejeição, ambos os casos devem ser tratáveis sem exceção não capturada) |
| **Rollback** | Nenhum |

## Passo 11 — Armazenar request/response sanitizados

| | |
|---|---|
| **Arquivo** | `scripts/fiscal-spike/11-store-sanitized.ts` |
| **Dependências** | Reaproveitar o padrão de `src/services/media.service.ts` (Storage privado, ver `fiscal-architecture-proposal.md` §8) |
| **Secrets** | Nenhum novo — mas a sanitização precisa garantir que nenhum segredo (senha do certificado, chave privada) jamais entre no payload armazenado, mesmo que só o XML/resposta estejam sendo salvos (checagem: o XML/resposta da SEFAZ nunca contém a chave privada, só o certificado público embutido na assinatura — mas vale uma checagem defensiva mesmo assim) |
| **Testes** | Confirmar que o arquivo salvo no bucket de teste não contém nenhuma string correspondente à senha do certificado usada no spike |
| **Rollback** | Apagar o objeto de teste do bucket de homologação/spike ao final do teste — bucket dedicado ao spike, nunca o bucket de produção fiscal real |

## Passo 12 — Garantir idempotência

| | |
|---|---|
| **Arquivo** | `scripts/fiscal-spike/12-idempotency-check.ts` |
| **Dependências** | Nenhuma nova — lógica de aplicação |
| **Secrets** | Nenhum |
| **Riscos** | O spike deve provar que rodar o Passo 9 duas vezes com o mesmo XML/chave de acesso não gera duplicidade — na prática, isso significa consultar (`NfeConsultaProtocolo`, ainda não coberto pelo spike, mas o padrão deve ser demonstrado) antes de reenviar, nunca reenviar cegamente. Este passo é mais uma demonstração do *padrão* (consultar antes de reenviar) do que um teste de biblioteca |
| **Testes** | Simular um "reenvio" do mesmo documento e confirmar que o código consulta a situação antes de decidir se retransmite, em vez de transmitir de novo automaticamente |
| **Rollback** | Nenhum |

---

## Resumo de dependências do spike (consolidado)

`node-forge` (>=1.4.0), `easy-soap-request` ou `soap`, `fast-xml-parser`, `xmlbuilder2`, `xmllint-wasm`, `xml-crypto` ou `xmldsigjs`. Nenhuma delas é instalada nesta etapa — listadas aqui para referência de quando o spike for autorizado. Ver comparação completa em [`fiscal-crypto-security-plan.md`](fiscal-crypto-security-plan.md).

## Critério de conclusão do spike

O spike é considerado bem-sucedido quando o Passo 9 retorna uma resposta interpretável da SEFAZ/SVRS em homologação (mesmo que rejeitada por dado de teste), com toda a cadeia anterior (certificado → mTLS → XML → validação → assinatura → verificação) comprovadamente funcional e testada isoladamente. **Não é necessário obter autorização (`cStat=100`) para considerar o spike concluído** — o objetivo é provar a cadeia técnica, não emitir uma nota de teste válida.

**Nenhum passo foi implementado.** Este documento é o plano completo, aguardando autorização para a Entrega C (ver `fiscal-direct-implementation-phases.md`).
