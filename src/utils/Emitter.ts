export type Listener = (event: { detail?: any }) => void;

export class Emitter {
    private map = new Map<string, Set<Listener>>();

    on(event: string, fn: Listener) {
        if (!this.map.has(event)) this.map.set(event, new Set());
        this.map.get(event)!.add(fn);
        return () => this.off(event, fn);
    }

    off(event: string, fn: Listener) {
        this.map.get(event)?.delete(fn);
    }

    protected emit(event: string, detail?: any) {
        const evt = { detail };
        this.map.get(event)?.forEach((fn) => fn(evt));
    }
}
