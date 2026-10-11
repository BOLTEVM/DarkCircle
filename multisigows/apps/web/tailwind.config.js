/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    '../../packages/ui/src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        background: '#0b0f17',
        surface: {
          DEFAULT: '#121926',
          raised: '#1a2333',
          card: '#161f2e',
          hover: '#1e293b',
        },
        border: {
          DEFAULT: '#222f3e',
          subtle: '#1a2433',
          active: '#10b981',
        },
        brand: {
          emerald: '#10b981',
          'emerald-light': '#34d399',
          'emerald-dark': '#059669',
        },
        quai: {
          red: '#ff3344',
          gold: '#f59e0b',
          blue: '#3b82f6',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'Cascadia Mono', 'Consolas', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
