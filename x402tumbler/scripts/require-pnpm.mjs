// Runs as `preinstall`. This project is managed with pnpm; installing it with npm or yarn would create a
// second lockfile and a different, flat node_modules layout that hides undeclared dependencies.
const agent = process.env.npm_config_user_agent || "";
if (!agent.startsWith("pnpm/")) {
  console.error("\nThis project uses pnpm. Install it with `corepack enable` (or `npm i -g pnpm`), then run `pnpm install`.\n");
  process.exit(1);
}
