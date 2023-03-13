import ThresholdKey from "@tkey/core";
import { TorusServiceProvider } from "@tkey/service-provider-torus";
import { TorusStorageLayer } from "@tkey/storage-layer-torus";
import { WebStorageModule } from "@tkey/web-storage";

// Configuration of Service Provider

const torusSp = new TorusServiceProvider({
  useTSS: true,
  customAuthArgs: {
    baseUrl: `${window.location.origin}`,
    redirectPathName: "auth",
    enableLogging: true,
    uxMode: "redirect",
  },
});

const storageLayer = new TorusStorageLayer({
  hostUrl: "https://sapphire-dev-2-1.authnetwork.dev/metadata",
  enableLogging: true,
});

// Configuration of Modules
const webStorageModule = new WebStorageModule();

// Instantiation of tKey
export const tKey = new ThresholdKey({
  enableLogging: true,
  modules: {
    webStorage: webStorageModule,
  },
  serviceProvider: torusSp,
  storageLayer,
  manualSync: true,
});
