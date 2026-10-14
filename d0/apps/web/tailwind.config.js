/** @type {import('tailwindcss').Config} */
export default {
  // relative: resolve from this file, not from whatever directory the dev server was launched in
  content: { relative: true, files: ['./index.html', './src/**/*.{ts,tsx}'] },
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // DarkOrder: obsidian grounds, ember-crimson accent. The `gold` key name is kept from the
        // suite's shared UI primitives; here every shade of it is crimson.
        ink: { DEFAULT: '#0b0a0c', deep: '#070608' },
        panel: { DEFAULT: '#131116', raised: '#181519', hover: '#1e1a1f' },
        line: { DEFAULT: '#272228', soft: '#1c181e', strong: '#3a323b' },
        gold: { DEFAULT: '#dc2626', light: '#ef4444', pale: '#fecaca', deep: '#991b1b' },
        bone: { DEFAULT: '#f3f0ec', dim: '#bab5ae', mute: '#7d7871' },
      },
      fontFamily: {
        display: ['"Iowan Old Style"', '"Palatino Linotype"', 'Palatino', '"Book Antiqua"', 'Georgia', 'ui-serif', 'serif'],
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Cascadia Mono"', 'Consolas', 'Menlo', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        lift: '0 18px 40px -24px rgba(0, 0, 0, 0.8)',
        ember: '0 0 28px -10px rgba(220, 38, 38, 0.45)',
      },
    },
  },
  plugins: [],
};
