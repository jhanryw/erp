import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: ['class'],
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Brand (theme-invariant)
        brand: {
          DEFAULT: '#A71818',
          dark: '#8B1313',
          light: '#C41E1E',
        },
        accent: {
          DEFAULT: '#F4A8A9',
          muted: '#E8888A',
        },
        // Background tiers — resolved via CSS variables
        bg: {
          root:     'var(--bg-root)',
          base:     'var(--bg-base)',
          elevated: 'var(--bg-elevated)',
          overlay:  'var(--bg-overlay)',
          hover:    'var(--bg-hover)',
          active:   'var(--bg-active)',
        },
        // Borders
        border: {
          DEFAULT: 'var(--border)',
          strong:  'var(--border-strong)',
          subtle:  'var(--border-subtle)',
        },
        // Text
        text: {
          primary:  'var(--text-primary)',
          secondary:'var(--text-secondary)',
          muted:    'var(--text-muted)',
          disabled: 'var(--text-disabled)',
        },
        // shadcn/ui aliases → nossos tokens (evita texto invisível)
        muted: {
          DEFAULT:    'var(--bg-overlay)',
          foreground: 'var(--text-muted)',
        },
        // Semantic (theme-invariant)
        success: '#22C55E',
        warning: '#F59E0B',
        error:   '#EF4444',
        info:    '#3B82F6',
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'monospace'],
      },
      borderRadius: {
        lg: '0.625rem',
        xl: '0.875rem',
        '2xl': '1.125rem',
      },
      boxShadow: {
        card: '0 1px 3px 0 rgb(0 0 0 / 0.4), 0 1px 2px -1px rgb(0 0 0 / 0.4)',
        elevated: '0 4px 6px -1px rgb(0 0 0 / 0.5), 0 2px 4px -2px rgb(0 0 0 / 0.5)',
        modal: '0 20px 25px -5px rgb(0 0 0 / 0.6), 0 8px 10px -6px rgb(0 0 0 / 0.6)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-right': {
          from: { transform: 'translateX(100%)' },
          to: { transform: 'translateX(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.2s ease-out',
        'slide-in-right': 'slide-in-right 0.3s ease-out',
        shimmer: 'shimmer 1.5s infinite linear',
      },
    },
  },
  plugins: [],
}

export default config
