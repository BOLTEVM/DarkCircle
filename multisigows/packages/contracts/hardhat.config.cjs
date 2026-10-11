require("@nomicfoundation/hardhat-toolbox");
require("@typechain/hardhat");

/** @type import('hardhat/config').HardhatUserConfig */
// Everything targets "paris": no PUSH0/MCOPY/TLOAD/TSTORE, so the bytecode does
// not depend on how far Quai's EVM has advanced. scripts/check-opcodes.js enforces this.
const V2_COMPILER = {
  version: "0.8.24",
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "paris",
  },
};

module.exports = {
  solidity: {
    compilers: [V2_COMPILER],
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  networks: {
    hardhat: {
      // scripts/local-quai-node.mjs runs the node as Orchard (15000) so the web app can use it.
      chainId: Number(process.env.HARDHAT_CHAIN_ID || 31337),
      // Pinned below Osaka: its per-transaction gas cap (EIP-7825, 2^24) has no Quai
      // equivalent, and it breaks gas estimation for calls with storage refunds.
      hardfork: "cancun",
    },
    // No Quai networks here on purpose: Hardhat cannot build Quai transactions, and deploy
    // keys never come from env vars. Deploy with scripts/deploy-v2.mjs (encrypted keystore).
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
  mocha: {
    timeout: 40000,
    recursive: true,
    spec: "test/**/*.test.{ts,js}",
  },
};
