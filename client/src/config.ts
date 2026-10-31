// Dev: Vite on :5173 talks to the game server on :2567. Prod: the server serves this bundle, same origin.
export const SERVER = import.meta.env.VITE_SERVER_URL || (import.meta.env.DEV ? `http://${location.hostname}:2567` : location.origin);
