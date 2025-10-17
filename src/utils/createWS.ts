export async function createWS(url: string, nodeOptions?: { protocols?: string | string[]; [k: string]: unknown }): Promise<WebSocket> {
    if (typeof globalThis !== "undefined" && (globalThis as any).WebSocket) {
        const Sock = (globalThis as any).WebSocket as typeof WebSocket;
        return nodeOptions?.protocols != null ? new Sock(url, nodeOptions.protocols as any) : new Sock(url);
    }

    let WSLike: any;
    try {
        const mod = await import("isomorphic-ws");
        WSLike = (mod as any).default ?? mod;
    } catch {
        const mod = await import("ws");
        WSLike = (mod as any).default ?? mod;
    }

    if (!(globalThis as any).WebSocket) {
        (globalThis as any).WebSocket = WSLike;
    }

    return nodeOptions?.protocols != null ? new WSLike(url, nodeOptions.protocols, nodeOptions) : new WSLike(url, undefined, nodeOptions);
}
