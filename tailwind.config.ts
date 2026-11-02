import type { Config } from 'tailwindcss';
export default {
  content: ['./index.html', './src/web/**/*.{ts,tsx}'],
  theme: { extend: { colors: {
    background: 'var(--background)', foreground: 'var(--foreground)',
    primary: 'var(--primary)', border: 'var(--border)', muted: 'var(--muted)',
  } } },
  plugins: [],
} satisfies Config;
