'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import * as xlsx from 'xlsx'
import Papa from 'papaparse'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ArrowLeft, Upload, FileType, Check, AlertTriangle, AlertCircle, RefreshCw, CheckCircle2, XCircle } from 'lucide-react'
import { formatCurrency } from '@/lib/utils/currency'

import { parseImportRows, type ImportRow, type ParsedProduct, type ErrorWarning, type DbData } from '@/lib/utils/import-parser'

export default function ImportarProdutosPage() {
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement>(null)
  
  const [file, setFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)
  const [dbData, setDbData] = useState<DbData | null>(null)
  const [rawRows, setRawRows] = useState<any[]>([])
  
  const [parsedProducts, setParsedProducts] = useState<ParsedProduct[]>([])
  const [issues, setIssues] = useState<ErrorWarning[]>([])
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<{
    imported: number
    errors: string[]
    skipped: number
  } | null>(null)

  // Carregar dados de referência
  useEffect(() => {
    async function loadDbData() {
      try {
        const [catsRes, suppRes, varsRes] = await Promise.all([
          fetch('/api/categorias'),
          fetch('/api/fornecedores'),
          fetch('/api/variacoes')
        ])
        const cats = await catsRes.json()
        const supps = await suppRes.json()
        const vars = await varsRes.json()
        
        const types = vars.types || []
        const colorType = types.find((t: any) => t.slug === 'cor')
        const sizeType = types.find((t: any) => t.slug === 'tamanho')

        setDbData({
          categories: cats.categories ?? [],
          suppliers: supps.suppliers ?? [],
          colors: colorType?.variation_values ?? [],
          sizes: sizeType?.variation_values ?? [],
        })
      } catch (err) {
        toast.error('Erro ao carregar dados do sistema')
      }
    }
    loadDbData()
  }, [])

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setFile(file)
    setParsedProducts([])
    setIssues([])
    setRawRows([])
    
    const isCsv = file.name.toLowerCase().endsWith('.csv')
    const reader = new FileReader()
    reader.onload = (event) => {
      const result = event.target?.result
      if (typeof result !== 'string' && !(result instanceof ArrayBuffer)) return

      if (isCsv) {
        Papa.parse(file, {
          header: true,
          skipEmptyLines: true,
          complete: (results) => {
            setRawRows(results.data as any[])
          }
        })
      } else {
        const wb = xlsx.read(result, { type: 'buffer' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        const data = xlsx.utils.sheet_to_json(ws)
        setRawRows(data as any[])
      }
    }
    
    if (isCsv) {
      reader.readAsText(file) // papaparse usa string/file
    } else {
      reader.readAsArrayBuffer(file) // xlsx precisa de buffer
    }
  }

  function validateAndParse() {
    if (!dbData || rawRows.length === 0) return

    setLoading(true)
    const { parsedProducts: newParsed, issues: newIssues } = parseImportRows(rawRows, dbData)
    setParsedProducts(newParsed)
    setIssues(newIssues)
    setLoading(false)
  }

  useEffect(() => {
    if (rawRows.length > 0 && dbData) {
      validateAndParse()
    }
  }, [rawRows, dbData])

  async function handleImport() {
    // Separa produtos com dados completos dos que têm erro crítico de pré-validação
    // (category_id=0 ou base_price=0 causariam erro 422 no servidor)
    const sendable  = parsedProducts.filter(p => p.category_id > 0 && p.base_price > 0 && p.variants.length > 0)
    const skipped   = parsedProducts.length - sendable.length

    if (sendable.length === 0) {
      toast.error('Nenhum produto com dados válidos para importar. Verifique os erros abaixo.')
      return
    }

    setImporting(true)
    setImportResult(null)

    try {
      const res = await fetch('/api/produtos/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sendable),
      })

      const json = await res.json()
      const imported: number = json.imported ?? 0
      const errors: string[] = json.errors ?? []

      setImportResult({ imported, errors, skipped })

      if (imported > 0 && errors.length === 0 && skipped === 0) {
        toast.success(`${imported} produto${imported !== 1 ? 's' : ''} importado${imported !== 1 ? 's' : ''} com sucesso!`)
        router.push('/produtos')
        router.refresh()
      } else if (imported > 0) {
        toast.warning(`${imported} importado${imported !== 1 ? 's' : ''}${skipped > 0 ? `, ${skipped} ignorado${skipped !== 1 ? 's' : ''}` : ''}${errors.length > 0 ? `, ${errors.length} com falha` : ''} — veja detalhes abaixo`)
      } else {
        toast.error('Nenhum produto foi importado — veja os erros abaixo')
      }
    } catch {
      toast.error('Falha inesperada ao importar')
    } finally {
      setImporting(false)
    }
  }

  const errors = issues.filter(i => i.type === 'error')
  const warnings = issues.filter(i => i.type === 'warning')

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/produtos">
          <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Importar Produtos</h2>
          <p className="text-sm text-text-muted">Importação em lote de produtos via CSV ou XLSX</p>
        </div>
      </div>

      <Card className="p-6">
        <div className="flex flex-col items-center justify-center p-8 border-2 border-dashed border-border rounded-lg bg-bg-overlay/50">
           <FileType className="w-10 h-10 text-text-muted mb-4" />
           <p className="font-medium text-text-primary mb-2">Selecione ou arraste seu arquivo</p>
           <p className="text-sm text-text-muted text-center mb-6 max-w-md">
             Faça download do <a href="/template-importacao.csv" className="text-brand hover:underline">template em CSV</a> para garantir
             que as colunas estejam corretas. O arquivo deve conter colunas: nome_produto, tipo, modelo, ano, categoria, cor, tamanho, preco, custo, estoque_inicial.
           </p>

           <input 
             type="file" 
             ref={fileInputRef} 
             className="hidden" 
             accept=".csv, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel" 
             onChange={handleFileSelect} 
           />
           <Button onClick={() => fileInputRef.current?.click()} variant="outline">
             <Upload className="w-4 h-4 mr-2" />
             {file ? file.name : 'Selecionar arquivo'}
           </Button>
        </div>
      </Card>

      {file && (
        <Card className="p-6 space-y-6">
          <h3 className="text-lg font-medium border-b border-border pb-2">Resumo da Avaliação</h3>
          
          <div className="grid grid-cols-3 gap-4">
            <div className="p-4 bg-bg-overlay border border-border rounded-lg text-center">
              <p className="text-3xl font-semibold mb-1">{parsedProducts.length}</p>
              <p className="text-xs text-text-muted uppercase tracking-wider">Produtos Válidos</p>
            </div>
            <div className="p-4 bg-bg-overlay border border-border rounded-lg text-center flex flex-col items-center justify-center">
              <p className="text-3xl font-semibold mb-1 text-error">{errors.length}</p>
              <p className="text-xs text-error/80 uppercase tracking-wider flex items-center gap-1"><AlertCircle className="w-3 h-3"/> Erros Críticos</p>
            </div>
            <div className="p-4 bg-bg-overlay border border-border rounded-lg text-center flex flex-col items-center justify-center">
              <p className="text-3xl font-semibold mb-1 text-warning">{warnings.length}</p>
              <p className="text-xs text-warning/80 uppercase tracking-wider flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Avisos</p>
            </div>
          </div>

          {(issues.length > 0) && (
            <div className="mt-6 space-y-4">
              <h4 className="font-medium">Detalhamento de Problemas:</h4>

              {/* Resumo agrupado por mensagem */}
              {(() => {
                // Agrupa erros/avisos pela mensagem (sem o valor específico), conta linhas afetadas
                const grouped = new Map<string, { type: 'error' | 'warning'; rows: number[]; sample: string }>()
                issues.forEach(issue => {
                  // Extrai a "chave" removendo o valor entre aspas para agrupar mensagens similares
                  const key = issue.message.replace(/'[^']*'/g, "'…'")
                  if (!grouped.has(key)) {
                    grouped.set(key, { type: issue.type, rows: [], sample: issue.message })
                  }
                  grouped.get(key)!.rows.push(issue.row)
                })

                return (
                  <div className="space-y-2">
                    {Array.from(grouped.entries()).map(([key, { type, rows, sample }]) => (
                      <div key={key} className={`p-3 rounded-md text-sm border flex items-start gap-3 ${
                        type === 'error'
                          ? 'bg-error/10 border-error/20'
                          : 'bg-warning/10 border-warning/20'
                      }`}>
                        {type === 'error'
                          ? <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-error" />
                          : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-warning" />}
                        <div className="min-w-0 flex-1">
                          <p className={`font-medium ${type === 'error' ? 'text-error' : 'text-warning-foreground'}`}>
                            {sample}
                          </p>
                          <p className="text-xs text-text-muted mt-0.5">
                            {rows.length === 1
                              ? `Linha ${rows[0]}`
                              : `${rows.length} linhas afetadas — primeiras: ${rows.slice(0, 5).join(', ')}${rows.length > 5 ? '…' : ''}`}
                          </p>
                        </div>
                        {rows.length > 1 && (
                          <span className={`shrink-0 text-xs font-semibold px-2 py-0.5 rounded-full ${
                            type === 'error' ? 'bg-error/20 text-error' : 'bg-warning/20 text-warning-foreground'
                          }`}>
                            ×{rows.length}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )
              })()}
            </div>
          )}

          <div className="flex items-center justify-between pt-4 border-t border-border">
            <div className="text-sm text-text-muted">
              {(() => {
                const sendable = parsedProducts.filter(p => p.category_id > 0 && p.base_price > 0 && p.variants.length > 0)
                const skipped  = parsedProducts.length - sendable.length
                if (sendable.length === 0) return <span className="text-error">Nenhum produto válido para importar</span>
                if (skipped > 0) return <span><strong>{sendable.length}</strong> prontos para importar · <span className="text-error">{skipped} serão ignorados por erros</span></span>
                return <span><strong>{sendable.length}</strong> produto{sendable.length !== 1 ? 's' : ''} prontos para importar</span>
              })()}
            </div>
            <Button
              onClick={handleImport}
              disabled={loading || importing || parsedProducts.filter(p => p.category_id > 0 && p.base_price > 0 && p.variants.length > 0).length === 0}
            >
              {importing ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Check className="w-4 h-4 mr-2" />}
              Importar válidos
            </Button>
          </div>
        </Card>
      )}

      {/* Resultado do import */}
      {importResult && (
        <Card className="p-6 space-y-4">
          <h3 className="text-lg font-medium border-b border-border pb-2">Resultado da Importação</h3>

          <div className="grid grid-cols-3 gap-4">
            <div className="flex items-center gap-3 p-4 rounded-lg bg-success/10 border border-success/20">
              <CheckCircle2 className="w-6 h-6 text-success shrink-0" />
              <div>
                <p className="text-2xl font-semibold text-success">{importResult.imported}</p>
                <p className="text-xs text-success/80 uppercase tracking-wide">Importado{importResult.imported !== 1 ? 's' : ''}</p>
              </div>
            </div>
            <div className="flex items-center gap-3 p-4 rounded-lg bg-error/10 border border-error/20">
              <XCircle className="w-6 h-6 text-error shrink-0" />
              <div>
                <p className="text-2xl font-semibold text-error">{importResult.errors.length}</p>
                <p className="text-xs text-error/80 uppercase tracking-wide">Falha{importResult.errors.length !== 1 ? 's' : ''} no servidor</p>
              </div>
            </div>
            <div className="flex items-center gap-3 p-4 rounded-lg bg-bg-overlay border border-border">
              <AlertCircle className="w-6 h-6 text-text-muted shrink-0" />
              <div>
                <p className="text-2xl font-semibold text-text-muted">{importResult.skipped}</p>
                <p className="text-xs text-text-muted uppercase tracking-wide">Ignorado{importResult.skipped !== 1 ? 's' : ''} (erro no CSV)</p>
              </div>
            </div>
          </div>

          {importResult.errors.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-text-primary">Produtos que falharam:</p>
              <div className="max-h-72 overflow-y-auto space-y-2 pr-1">
                {importResult.errors.map((err, i) => {
                  // Formato da API: "Produto Nome: razão" — separa nome do motivo
                  const colonIdx = err.indexOf(':')
                  const label  = colonIdx > 0 ? err.slice(0, colonIdx).trim() : `Produto ${i + 1}`
                  const reason = colonIdx > 0 ? err.slice(colonIdx + 1).trim() : err
                  return (
                    <div key={i} className="flex items-start gap-3 p-3 rounded-md bg-error/8 border border-error/20 text-sm">
                      <XCircle className="w-4 h-4 text-error mt-0.5 shrink-0" />
                      <div className="min-w-0">
                        <p className="font-medium text-error truncate">{label}</p>
                        <p className="text-text-muted text-xs mt-0.5">{reason}</p>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-border">
            {importResult.imported > 0 && (
              <Button variant="outline" onClick={() => { router.push('/produtos'); router.refresh() }}>
                Ver produtos importados
              </Button>
            )}
            {importResult.errors.length > 0 && (
              <Button variant="ghost" onClick={() => setImportResult(null)}>
                Fechar e corrigir arquivo
              </Button>
            )}
          </div>
        </Card>
      )}

    </div>
  )
}
