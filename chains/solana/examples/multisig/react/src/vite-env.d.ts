/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_MULTISIG_PROGRAM_ID: string;
  readonly VITE_DWALLET_PROGRAM_ID: string;
  readonly VITE_RPC_URL: string;
}
interface ImportMeta { readonly env: ImportMetaEnv; }
