require("@nomicfoundation/hardhat-toolbox");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    compilers: [
      {
        version: "0.8.24",
        settings: {
          optimizer: { enabled: true, runs: 200 },
          // Pinned so the bytecode does not depend on how far Quai's EVM has advanced
          // (Cyprus-1 accepts PUSH0/MCOPY today, but nothing here needs them).
          evmVersion: "paris",
        },
      },
    ],
  },
  networks: {
    hardhat: {
      chainId: 31337,
      // Below Osaka: its per-transaction gas cap (EIP-7825) has no Quai equivalent.
      hardfork: "cancun",
    },
    // No Quai networks here on purpose: Hardhat cannot build Quai transactions (no r/s/v,
    // zone-ground addresses, access lists). Deploy with scripts/deploy-quai.mjs, which signs
    // from an encrypted keystore only.
  },
  mocha: {
    timeout: 60000,
  },
};
