/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_QUESTATE_LOCAL?: string;
  readonly VITE_LOCAL_RPC?: string;
  readonly VITE_LOCAL_DEED?: string;
  readonly VITE_LOCAL_BROKERAGE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
