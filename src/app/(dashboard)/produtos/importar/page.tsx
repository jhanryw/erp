'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import * as xlsx from 'xlsx'
import Papa from 'papaparse'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ArrowLeft, Upload, FileType, Check, AlertTriangle, AlertCircle, RefreshCw } from 'lucide-react'
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
    const hasErrors = issues.some(i => i.type === 'error')
    if (hasErrors) {
      toast.error('Corrija os erros antes de importar')
      return
    }

    setImporting(true)
    
    try {
      const res = await fetch('/api/produtos/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(parsedProducts)
      })

      const json = await res.json()
      
      if (!res.ok) {
        toast.error('Falha na importação', { description: json.error || json.message })
        if (json.errors && json.errors.length > 0) {
           setIssues([{ row: 0, message: json.errors[0], type: 'error' }])
        }
      } else {
        toast.success(json.message)
        router.push('/produtos')
        router.refresh()
      }
    } catch (err) {
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
               <div className="max-h-60 overflow-y-auto space-y-2 pr-2">
                 {issues.map((issue, idx) => (
                   <div key={idx} className={`p-3 rounded-md text-sm border flex items-start gap-3 ${issue.type === 'error' ? 'bg-error/10 border-error/20 text-error' : 'bg-warning/10 border-warning/20 text-warning-foreground'}`}>
                      {issue.type === 'error' ? <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />}
                      <div>
                        <strong>Linha {issue.row}:</strong> {issue.message}
                      </div>
                   </div>
                 ))}
               </div>
            </div>
          )}

          <div className="flex justify-end pt-4 border-t border-border">
            <Button onClick={handleImport} disabled={loading || importing || errors.length > 0} className={errors.length > 0 ? "opacity-50" : ""}>
               {importing ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Check className="w-4 h-4 mr-2" />}
               Confirmar Importação
            </Button>
          </div>
        </Card>
      )}

    </div>
  )
}
