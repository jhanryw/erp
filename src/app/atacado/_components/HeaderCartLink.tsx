'use client'

import Link from 'next/link'
import { ShoppingCart } from 'lucide-react'
import { useCart } from '../_lib/CartContext'
import { useWholesaleBasePath } from '../_lib/WholesaleBasePathContext'
import { wholesaleHref } from '@/lib/wholesale/site-host'

export function HeaderCartLink() {
  const { totalItems } = useCart()
  const basePath = useWholesaleBasePath()
  return (
    <Link href={wholesaleHref(basePath, '/carrinho')} className="relative flex items-center gap-1.5 text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors">
      <ShoppingCart className="w-5 h-5" />
      <span className="hidden sm:inline">Carrinho</span>
      {totalItems > 0 && (
        <span className="absolute -top-2 -right-2 sm:static sm:ml-1 inline-flex items-center justify-center text-[10px] font-bold bg-brand text-white rounded-full min-w-[18px] h-[18px] px-1">
          {totalItems}
        </span>
      )}
    </Link>
  )
}
