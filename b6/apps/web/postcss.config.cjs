const path = require('path');

// Explicit config path: Tailwind otherwise looks for its config in the launch directory.
module.exports = {
  plugins: {
    tailwindcss: { config: path.join(__dirname, 'tailwind.config.js') },
    autoprefixer: {},
  },
};
