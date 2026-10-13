/** @type {import('tailwindcss').Config} */
export default {
  // relative: resolve from this file, not from whatever directory the dev server was launched in
  content: { relative: true, files: ['./index.html', './src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'] },
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Dark Questate: obsidian grounds, champagne-gold accent.
        ink: { DEFAULT: '#0a0b0d', deep: '#060708' },
        panel: { DEFAULT: '#111316', raised: '#16191d', hover: '#1b1f24' },
        line: { DEFAULT: '#23272e', soft: '#1a1d22', strong: '#323843' },
        gold: { DEFAULT: '#c9a45c', light: '#dcbf85', pale: '#efe3c6', deep: '#9c7a3c' },
        bone: { DEFAULT: '#f3f1ec', dim: '#b9b6ad', mute: '#7c7a73' },
      },
      fontFamily: {
        display: ['"Iowan Old Style"', '"Palatino Linotype"', 'Palatino', '"Book Antiqua"', 'Georgia', 'ui-serif', 'serif'],
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Cascadia Mono"', 'Consolas', 'Menlo', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        lift: '0 18px 40px -24px rgba(0, 0, 0, 0.8)',
      },
    },
  },
  plugins: [],
};
