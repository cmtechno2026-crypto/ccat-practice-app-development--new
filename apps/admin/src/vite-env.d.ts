/// <reference types="vite/client" />

interface ImportMetaEnv { readonly VITE_GATEWAY_URL?: string }
interface ImportMeta { readonly env: ImportMetaEnv }

interface Window { __CCAT_GATEWAY__?: string }
