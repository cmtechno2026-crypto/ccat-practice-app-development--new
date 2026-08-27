import { CcatClient, type TokenStore, type TokenPair } from '@ccat/api-client';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';

// Base URL comes from Expo config `extra.gatewayUrl` (app.json) or an env override.
// For a physical device use your machine's LAN IP, not localhost.
const baseUrl: string =
  (Constants.expoConfig?.extra as { gatewayUrl?: string } | undefined)?.gatewayUrl ??
  'http://localhost:8080';

// SecureStore-backed token storage (encrypted at rest, §11/§36.1 spirit for local tokens).
const secureStore: TokenStore = {
  async getAccess() { return SecureStore.getItemAsync('ccat_access'); },
  async getRefresh() { return SecureStore.getItemAsync('ccat_refresh'); },
  async set(t: TokenPair) {
    await SecureStore.setItemAsync('ccat_access', t.access_token);
    await SecureStore.setItemAsync('ccat_refresh', t.refresh_token);
  },
  async clear() {
    await SecureStore.deleteItemAsync('ccat_access');
    await SecureStore.deleteItemAsync('ccat_refresh');
  },
};

export const client = new CcatClient({ baseUrl, tokens: secureStore });

// A stable per-install device identifier (Blueprint single-device model, §5). A real build
// derives this from a hardware/installation id + attestation; here it is a persisted UUID.
export async function getDeviceHash(): Promise<string> {
  let id = await SecureStore.getItemAsync('ccat_device');
  if (!id) {
    id = `dev_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    await SecureStore.setItemAsync('ccat_device', id);
  }
  return id;
}
