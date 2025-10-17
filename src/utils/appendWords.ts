export function appendWords(push: (full: string, delta?: string) => void, previous: string, next: string) {
    let current = previous || "";
    push(current);
    const words = (next || "").trim().split(/\s+/);
    let i = 0;
    const tick = () => {
        if (i >= words.length) return;
        const w = words[i++];
        current = current ? `${current} ${w}` : w;
        push(current, w);
        setTimeout(tick, 100);
    };
    tick();
}
