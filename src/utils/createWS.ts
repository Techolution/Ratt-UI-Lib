// Cross-env WebSocket factory (browser or Node)
// This version includes detailed console diagnostics for debugging.

export async function createWS(url: string, nodeOptions?: { protocols?: string | string[]; [k: string]: unknown }): Promise<WebSocket> {
    console.log("[createWS] called with URL:", url);
    console.log("[createWS] called with URL:", url);

    try {
        console.log("[createWS] typeof globalThis:", typeof globalThis);
    } catch {
        console.log("[createWS] typeof globalThis: <unavailable>");
    }

    try {
        console.log("[createWS] typeof window:", typeof window);
    } catch {
        console.log("[createWS] typeof window: <unavailable>");
    }

    try {
        console.log("[createWS] typeof document:", typeof document);
    } catch {
        console.log("[createWS] typeof document: <unavailable>");
    }

    try {
        console.log("[createWS] typeof process:", typeof process);
        console.log("[createWS] process.release:", typeof process !== "undefined" ? (process as any)?.release?.name : "<no process>");
    } catch {
        console.log("[createWS] typeof process: <unavailable>");
    }

    try {
        console.log("[createWS] globalThis.WebSocket exists:", !!(globalThis as any)?.WebSocket);
    } catch {
        console.log("[createWS] globalThis.WebSocket exists: <cannot check>");
    }

    // Detect real browser vs Node/Electron host
    const isBrowser = typeof window !== "undefined" && typeof window.WebSocket !== "undefined" && typeof document !== "undefined";

    console.log("[createWS] Detected environment:", isBrowser ? "browser" : "node/electron");

    // ✅ Browser: use native WebSocket
    if (isBrowser) {
        console.log("[createWS] Using native browser WebSocket");
        const Sock = window.WebSocket;
        const ws = nodeOptions?.protocols ? new Sock(url, nodeOptions.protocols as any) : new Sock(url);

        attachDebugHandlers(ws, "browser");
        return ws;
    }

    // 🧩 Node / Electron extension host: load ws or isomorphic-ws
    let WSLike: any;
    try {
        const mod = await import("isomorphic-ws");
        WSLike = (mod as any).default ?? mod;
        console.log("[createWS] Using isomorphic-ws");
    } catch (err) {
        console.warn("[createWS] isomorphic-ws import failed, falling back to ws:", err);
        const mod = await import("ws");
        WSLike = (mod as any).default ?? mod;
        console.log("[createWS] Using ws fallback");
    }

    // Set global WebSocket if not already defined
    if (!(globalThis as any).WebSocket) {
        (globalThis as any).WebSocket = WSLike;
        console.log("[createWS] Assigned WSLike to globalThis.WebSocket");
    } else {
        console.log("[createWS] globalThis.WebSocket already exists, not overwriting");
    }

    // Construct the WebSocket
    const ws: WebSocket = nodeOptions?.protocols != null ? new WSLike(url, nodeOptions.protocols, nodeOptions) : new WSLike(url, undefined, nodeOptions);

    attachDebugHandlers(ws, "node");
    return ws;
}

// Utility to add connection debug handlers
function attachDebugHandlers(ws: WebSocket, env: string) {
    (ws as any).onopen = () => console.log(`[createWS] [${env}] ✅ connected`);
    (ws as any).onerror = (err: any) => console.error(`[createWS] [${env}] ❌ error:`, err);
    (ws as any).onclose = (evt: any) => console.warn(`[createWS] [${env}] ⚠️ closed code=${evt.code ?? "?"} reason=${evt.reason ?? ""}`);

    // For ws (Node) style
    (ws as any).once?.("open", () => console.log(`[createWS] [${env}] ✅ open (node once)`));
    (ws as any).once?.("error", (e: any) => console.error(`[createWS] [${env}] ❌ error (node once):`, e));
    (ws as any).once?.("close", (c: any) => console.warn(`[createWS] [${env}] ⚠️ close (node once):`, c));
}
