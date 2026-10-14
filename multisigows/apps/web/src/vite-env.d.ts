/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_QUAI_NETWORK?: string;
  readonly VITE_QUAI_RPC_URL?: string;
  readonly VITE_DISABLE_MAINNET_VAULTS?: string;
  readonly VITE_TX_CONFIRMATIONS?: string;
  readonly VITE_V2_FACTORY_ADDRESS?: string;
  readonly VITE_QUAI_SECONDARY_RPC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
