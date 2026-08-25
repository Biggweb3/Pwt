/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#07090d',
          900: '#0a0e14',
          850: '#0d1219',
          800: '#101722',
          750: '#131b28',
          700: '#182233',
          600: '#22304a',
        },
        line: '#1c2636',
        accent: { DEFAULT: '#38bdf8', dim: '#0ea5e9' },
        gain: '#34d399',
        loss: '#f87171',
        warn: '#fbbf24',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: { '2xs': ['0.6875rem', { lineHeight: '0.875rem' }] },
    },
  },
  plugins: [],
};
