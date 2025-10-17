// Cross-env WebSocket factory (browser or Node)
export async function createWS(url: string): Promise<WebSocket> {
    if (typeof WebSocket !== "undefined") return new WebSocket(url);
    const mod = await import("isomorphic-ws");
    const WS = (mod.default ?? mod) as unknown as typeof WebSocket;
    // @ts-expect-error cross-env ctor typing variance
    return new WS(url) as WebSocket;
}
