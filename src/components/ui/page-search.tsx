'use client'

import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { useCallback, useRef, useTransition } from 'react'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'

interface PageSearchProps {
  defaultValue?: string
  placeholder?: string
}

export function PageSearch({ defaultValue, placeholder = 'Buscar...' }: PageSearchProps) {
  const router      = useRouter()
  const pathname    = usePathname()
  const searchParams = useSearchParams()
  const [, startTransition] = useTransition()
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value.trim()
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        const params = new URLSearchParams(searchParams.toString())
        if (value) {
          params.set('q', value)
          params.delete('page') // volta pra página 1 ao buscar
        } else {
          params.delete('q')
          params.delete('page')
        }
        startTransition(() => {
          router.replace(`${pathname}?${params.toString()}`)
        })
      }, 300)
    },
    [router, pathname, searchParams],
  )

  return (
    <div className="relative max-w-sm w-full">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
      <Input
        type="search"
        placeholder={placeholder}
        defaultValue={defaultValue}
        onChange={handleChange}
        className="pl-9"
      />
    </div>
  )
}
