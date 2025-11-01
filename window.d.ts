import type { ContextBridgeApi } from "./src/preload";

declare global {
    interface Window {
        electronApi: ContextBridgeApi
    }
}