import type { Config } from 'tailwindcss';

/**
 * Design tokens are CSS variables (src/styles.css) so light/dark switch without rebuilding;
 * Tailwind maps semantic names onto them.
 */
const token = (name: string): string => `rgb(var(--c-${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter Variable"', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        bg: token('bg'),
        surface: token('surface'),
        muted: token('muted'),
        border: token('border'),
        fg: token('fg'),
        subtle: token('subtle'),
        primary: token('primary'),
        'primary-fg': token('primary-fg'),
        danger: token('danger'),
        warning: token('warning'),
        success: token('success'),
        info: token('info'),
      },
    },
  },
  plugins: [],
} satisfies Config;
