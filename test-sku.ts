import { generateSKU, generateParentSKU } from './src/lib/sku/sku-map'

try {
  console.log("=== TESTE SKU ===")
  console.log("Teste 1: conjunto renda sem bojo preto M 2026")
  console.log("Esperado: 1403010226")
  console.log("Retornado:", generateSKU({ tipo: 'conjunto_calcinha_sutia', modelo: 'renda_sem_bojo', cor: 'preto', tamanho: 'm', ano: '2026' }))
} catch (e: any) { console.error("ERRO Teste 1:", e.message) }

try {
  console.log("Teste 2: calcinha sem costura bege M 2026")
  console.log("Esperado: 0204110226")
  console.log("Retornado:", generateSKU({ tipo: 'calcinha', modelo: 'sem_costura', cor: 'bege', tamanho: 'm', ano: '2026' }))
} catch (e: any) { console.error("ERRO Teste 2:", e.message) }

try {
  console.log("Teste 3: pijama americano rosa M 2026")
  console.log("Esperado: 1101050226")
  // Aqui o usuário disse TT=11, o modelo seria o que gera 01. Vamos testar:
  console.log("Retornado:", generateSKU({ tipo: 'pijama_americano', modelo: 'padrao', cor: 'rosa', tamanho: 'm', ano: '2026' }))
} catch (e: any) { console.error("ERRO Teste 3:", e.message) }

try {
  console.log("=== TESTE PAI ===")
  console.log(generateParentSKU('conjunto_calcinha_sutia', 'renda_sem_bojo', '2026'))
} catch (e: any) { console.error("ERRO Parent:", e.message) }
