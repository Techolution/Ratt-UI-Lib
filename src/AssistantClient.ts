import type { AssistantEvents, AssistantOptions, StartMicOptions } from "./types";
import { AssistantEvent, TARGET_SAMPLES } from "./types";
import { floatTo16BitPCM } from "./audio/floatTo16BitPCM";
import { ensureAudioContextAndWorklets } from "./audio/WorkletLoader";

/* ---------- helpers ---------- */
async function createWS(url: string): Promise<WebSocket> {
    if (typeof WebSocket !== "undefined") return new WebSocket(url);
    const mod = await import("isomorphic-ws");
    const WS = (mod.default ?? mod) as unknown as typeof WebSocket;
    // @ts-expect-error cross-env ctor typing variance
    return new WS(url) as WebSocket;
}

function appendWords(push: (full: string, delta?: string) => void, previous: string, next: string) {
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

/* ---------- class ---------- */
export class AssistantClient extends EventTarget {
    private opts: Required<AssistantOptions>;

    // ws
    private ws: WebSocket | null = null;
    private cleanedUp = false;
    private reconnectTimer: number | null = null;
    private static ACTIVE_WS: WebSocket | null = null;
    private static CONNECT_PROMISE: Promise<WebSocket> | null = null;

    // heartbeat
    private heartbeatInterval: number | null = null;
    private missedPongs = 0;

    // audio
    private audioCtx: AudioContext | null = null;
    private recNode: AudioWorkletNode | null = null;
    private vadNode: AudioWorkletNode | null = null;
    private mediaStream: MediaStream | null = null;
    private workletsLoaded = false;

    // sender
    private sendInterval: number | null = null;
    private rolling = new Float32Array(0);
    private isRecording = false;

    // public-ish mirrors
    private _wsReady = false;
    private _micOpen = false;
    private _micConnecting = false;
    private _amplitude = 0;
    private _transcription = "";

    // refs
    private isMsgSended = false;
    private userText = "";

    // per-instance bound handlers
    private boundOnOpen?: (e: Event) => void;
    private boundOnError?: (e: Event) => void;
    private boundOnClose?: (e: CloseEvent) => void;
    private boundOnMessage?: (e: MessageEvent) => void;

    constructor(options: AssistantOptions) {
        super();

        // normalize options (no undefined anywhere after this)
        this.opts = {
            url: options.url,
            onSend: options.onSend ?? (() => {}),
            rattAgentDetails: options.rattAgentDetails ?? {},
            requestId: options.requestId,
            showToast: options.showToast ?? (() => {}),
            pingIntervalMs: options.pingIntervalMs ?? 5000,
            maxMissedPongs: options.maxMissedPongs ?? 2,
            workletBasePath: options.workletBasePath ?? "/",
            // injectable providers so lib works in any env (system audio, etc.)
            mediaStreamProvider:
                options.mediaStreamProvider ??
                (async () =>
                    navigator.mediaDevices.getUserMedia({
                        audio: {
                            channelCount: { ideal: 1 },
                            sampleRate: { ideal: 16000 },
                            sampleSize: { ideal: 16 },
                            autoGainControl: { ideal: true },
                            noiseSuppression: { ideal: true },
                            echoCancellation: { ideal: true },
                        },
                        video: false,
                    })),
            audioContextFactory: options.audioContextFactory ?? (() => new AudioContext()),
            workletLoader: options.workletLoader ?? ((base) => ensureAudioContextAndWorklets(base)),
        };

        // adopt existing socket (StrictMode-safe)
        if (AssistantClient.ACTIVE_WS?.readyState === WebSocket.OPEN) {
            this.ws = AssistantClient.ACTIVE_WS;
            this.attachSocketHandlers(this.ws);
            this._wsReady = true;
            queueMicrotask(() => this.emit(AssistantEvent.READY));
        }
    }

    /* ---------- public getters ---------- */
    get wsReady() {
        return this._wsReady || this.ws?.readyState === WebSocket.OPEN;
    }
    get micOpen() {
        return this._micOpen;
    }
    get micConnecting() {
        return this._micConnecting;
    }
    get amplitude() {
        return this._amplitude;
    }
    get transcription() {
        return this._transcription;
    }

    /* ---------- connection ---------- */
    async connect(): Promise<void> {
        // reuse ACTIVE or CONNECTING
        if (AssistantClient.ACTIVE_WS) {
            this.ws = AssistantClient.ACTIVE_WS;
            this.attachSocketHandlers(this.ws);

            if (this.ws.readyState === WebSocket.OPEN) {
                this._wsReady = true;
                this.emit(AssistantEvent.READY);
                return;
            }
            if (this.ws.readyState === WebSocket.CONNECTING) {
                await this.waitForOpen(this.ws);
                this._wsReady = true;
                this.emit(AssistantEvent.READY);
                return;
            }
        }

        // await a single-flight connect
        if (AssistantClient.CONNECT_PROMISE) {
            this.ws = await AssistantClient.CONNECT_PROMISE;
            this.attachSocketHandlers(this.ws);
            if (this.ws.readyState !== WebSocket.OPEN) await this.waitForOpen(this.ws);
            this._wsReady = true;
            this.emit(AssistantEvent.READY);
            return;
        }

        this.clearReconnect();
        this.cleanedUp = false;

        // single-flight connect: resolves after OPEN
        AssistantClient.CONNECT_PROMISE = (async () => {
            const socket = await createWS(this.opts.url);
            AssistantClient.ACTIVE_WS = socket;
            this.ws = socket;
            this.attachSocketHandlers(socket);

            await this.waitForOpen(socket);
            this._wsReady = true;
            this.emit(AssistantEvent.READY);
            try {
                await this.preloadWorklets();
            } catch (e) {
                this.emit(AssistantEvent.ERROR, { error: e });
            }
            return socket;
        })();

        try {
            this.ws = await AssistantClient.CONNECT_PROMISE;
        } finally {
            AssistantClient.CONNECT_PROMISE = null;
        }
    }

    /** close the ratt agent (teardown mic etc). Does not forcibly close WS. */
    disconnect() {
        this.cleanedUp = true;
        this.clearReconnect();
        this.clientDisconnect();
    }

    teardown() {
        this.localTeardown();
    }

    /* ---------- session ---------- */
    async startSession(): Promise<void> {
        if (this.ws?.readyState === WebSocket.CONNECTING) return;

        // ensure worklets loaded
        if (!this.workletsLoaded) {
            try {
                await this.preloadWorklets();
            } catch (error) {
                this.emit(AssistantEvent.ERROR, { error });
                this.opts.showToast("error", "Audio Error", "Failed to initialize audio modules. Please reload the page.");
                return;
            }
        }

        // toggle off if mid-connect
        if (this._micConnecting) {
            this.ws?.send(JSON.stringify({ disconnect: true }));
            this._micConnecting = false;
            this.isMsgSended = false;
            this.emit(AssistantEvent.MIC_CONNECTING, { connecting: false });
            this.stopRecording();
            return;
        }

        if (!this._micOpen) {
            this._micConnecting = true;
            this.emit(AssistantEvent.MIC_CONNECTING, { connecting: true });

            try {
                // ask early for mic (or custom provider may throw)
                const test = await this.opts.mediaStreamProvider();
                test.getTracks().forEach((t) => t.stop());

                if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                    await this.connect();
                }

                this.isMsgSended = true;
                const newReqId = `requestId-${(crypto.randomUUID?.() ?? Date.now()).toString()}`;
                this.opts.requestId.current = newReqId;

                const details = { ...this.opts.rattAgentDetails, requestId: newReqId };

                this.userText = "";
                this._transcription = "";
                this.emit(AssistantEvent.TRANSCRIPTION, { text: "" });
                this.ws?.send(JSON.stringify(details));
            } catch (err: any) {
                this.isMsgSended = false;
                if (err?.name === "NotAllowedError") {
                    this.opts.showToast("error", "Mic Disabled", "Microphone access is blocked. Please enable it in your browser settings.");
                } else {
                    this.opts.showToast("error", "Error", "Something failed, Please try again.");
                }
                this._micConnecting = false;
                this.emit(AssistantEvent.MIC_CONNECTING, { connecting: false });
            }
        } else {
            // currently open -> toggle off
            this.disconnect();
        }
    }

    handleSend() {
        const current = (this._transcription || "").trim() || (this.userText || "").trim();
        if (!current) return;
        if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
        }
        this.opts.onSend?.();
    }

    async stopAudio() {
        this.isMsgSended = false;
        this.disconnect();
    }

    // optional helpers
    async startMic(_opts: StartMicOptions = {}) {
        await this.startRecording();
    }
    stopMic() {
        this.stopRecording();
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ disconnect: true }));
        }
    }

    /* ---------- DOM-style listener ---------- */
    on(event: AssistantEvents, handler: (e: any) => void) {
        this.addEventListener(event, handler as EventListener);
        return () => this.removeEventListener(event, handler as EventListener);
    }

    /* ---------- WS handlers ---------- */
    private handleWSMessage = (evt: MessageEvent) => {
        let parsed: any | undefined = undefined;
        if (typeof evt.data === "string") {
            try {
                parsed = JSON.parse(evt.data as string);
            } catch {
                // still emit raw below; just no parsed
            }
        }
        this.emit(AssistantEvent.SOCKET_MESSAGE, { raw: evt, parsed });

        const data = parsed;
        if (!data) return;

        if (data?.heartbeat === true) {
            this.missedPongs = 0;
            return;
        }

        if (data?.error) {
            this.localTeardown();
            this.opts.showToast("error", "Error", "Something failed , Please try again.");
            this.emit(AssistantEvent.ERROR, { error: data.error });
            return;
        }

        if (data?.start_audio) {
            if (this.isMsgSended) {
                this._micConnecting = false;
                this.emit(AssistantEvent.MIC_CONNECTING, { connecting: false });
                this.startRecording().catch(() => {});
                this._micOpen = true;
                this.emit(AssistantEvent.MIC_OPEN, { open: true });
            }
            return;
        }

        if (data?.streaming_data?.previous_transcription !== undefined && data?.streaming_data?.new_transcription && this.isMsgSended) {
            appendWords(
                (full, delta) => {
                    this._transcription = full;
                    this.userText = full;
                    this.emit(AssistantEvent.TRANSCRIPTION, { text: full, delta });
                },
                data.streaming_data.previous_transcription,
                data.streaming_data.new_transcription
            );
            return;
        }

        if (data?.transcription && this.isMsgSended) {
            this._transcription = data.transcription;
            this.userText = data.transcription;
            this.emit(AssistantEvent.TRANSCRIPTION, { text: this._transcription });
        }

        if (data?.stop_audio) {
            this.setAmplitude(0);
            this.stopRecording();
        }

        if (data?.disconnect) {
            this.localTeardown();
            this.handleSend();
        }
    };

    private attachSocketHandlers(socket: WebSocket) {
        if (this.boundOnOpen || this.boundOnMessage || this.boundOnError || this.boundOnClose) return;

        this.boundOnOpen = () => {
            this.startHeartbeat();
            this._wsReady = true;
            this.emit(AssistantEvent.READY);
            this.preloadWorklets().catch((e) => this.emit(AssistantEvent.ERROR, { error: e }));
        };
        this.boundOnError = (e) => {
            this.emit(AssistantEvent.ERROR, { error: e });
        };
        this.boundOnClose = () => {
            this._wsReady = false;
            this.stopHeartbeat();
            if (AssistantClient.ACTIVE_WS === socket) AssistantClient.ACTIVE_WS = null;
            if (!this.cleanedUp) {
                this.localTeardown();
                this.reconnectTimer = window.setTimeout(() => {
                    this.connect().catch(() => {});
                }, 2000);
            }
        };
        this.boundOnMessage = this.handleWSMessage;

        socket.addEventListener("open", this.boundOnOpen);
        socket.addEventListener("error", this.boundOnError);
        socket.addEventListener("close", this.boundOnClose);
        socket.addEventListener("message", this.boundOnMessage);

        if (typeof window !== "undefined") {
            window.addEventListener("beforeunload", this.clientDisconnect);
        }
    }

    private detachSocketHandlers() {
        const socket = this.ws;
        if (!socket) return;
        if (this.boundOnOpen) socket.removeEventListener("open", this.boundOnOpen);
        if (this.boundOnError) socket.removeEventListener("error", this.boundOnError);
        if (this.boundOnClose) socket.removeEventListener("close", this.boundOnClose);
        if (this.boundOnMessage) socket.removeEventListener("message", this.boundOnMessage);
        this.boundOnOpen = this.boundOnError = this.boundOnClose = this.boundOnMessage = undefined;

        if (typeof window !== "undefined") {
            window.removeEventListener("beforeunload", this.clientDisconnect);
        }
    }

    /* ---------- audio ---------- */
    private async startRecording() {
        try {
            const stream = await this.opts.mediaStreamProvider();
            this.mediaStream = stream;

            this.audioCtx = await this.opts.workletLoader(this.opts.workletBasePath);
            if (this.audioCtx.state === "suspended") await this.audioCtx.resume();

            this.recNode = new AudioWorkletNode(this.audioCtx, "recorder-worklet");
            this.vadNode = new AudioWorkletNode(this.audioCtx, "vad-worklet");

            this.recNode.port.onmessage = (event) => {
                const chunk = event.data as Float32Array;
                const combined = new Float32Array(this.rolling.length + chunk.length);
                combined.set(this.rolling);
                combined.set(chunk, this.rolling.length);
                this.rolling = combined;
            };

            this.vadNode.port.onmessage = (event) => {
                const { energy } = event.data;
                this.setAmplitude(energy);
            };

            const src = this.audioCtx.createMediaStreamSource(stream);
            src.connect(this.recNode);
            src.connect(this.vadNode);
            this.recNode.connect(this.audioCtx.destination);
            this.vadNode.connect(this.audioCtx.destination);

            this.isRecording = true;

            this.sendInterval = window.setInterval(() => {
                if (!this.isRecording || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
                if (this.rolling.length >= TARGET_SAMPLES) {
                    const chunk = this.rolling.slice(0, TARGET_SAMPLES);
                    const pcm = floatTo16BitPCM(chunk);
                    this.ws.send(pcm.buffer);
                    this.rolling = this.rolling.slice(TARGET_SAMPLES);
                }
            }, 1000);
        } catch (err) {
            console.error("Microphone access error:", err);
            this.stopRecording();
        }
    }

    private stopRecording() {
        this.recNode?.disconnect();
        this.vadNode?.disconnect();
        if (this.audioCtx && this.audioCtx.state !== "closed") this.audioCtx.suspend();
        this.mediaStream?.getTracks().forEach((t) => t.stop());
        if (this.sendInterval) {
            clearInterval(this.sendInterval);
            this.sendInterval = null;
        }
        this.isRecording = false;
        this._micOpen = false;
        this.emit(AssistantEvent.MIC_OPEN, { open: false });
    }

    /* ---------- heartbeat ---------- */
    private startHeartbeat() {
        this.stopHeartbeat();
        this.missedPongs = 0;
        this.heartbeatInterval = window.setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ heartbeat: true }));
                this.missedPongs++;
                if (this.missedPongs >= this.opts.maxMissedPongs) {
                    this.ws?.close();
                }
            }
        }, this.opts.pingIntervalMs);
    }

    private stopHeartbeat() {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
        this.missedPongs = 0;
    }

    /* ---------- teardown & helpers ---------- */
    public closeSocket() {
        this.cleanedUp = true;
        try {
            this.ws?.close();
        } catch {}
        if (AssistantClient.ACTIVE_WS === this.ws) AssistantClient.ACTIVE_WS = null;
        this.detachSocketHandlers();
        this.ws = null;
    }

    private clientDisconnect = () => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ disconnect: true }));
        }
        this.localTeardown();
    };

    private localTeardown() {
        this.isMsgSended = false;
        this.isRecording = false;
        this._micConnecting = false;
        this.emit(AssistantEvent.MIC_CONNECTING, { connecting: false });
        this.stopRecording();
        this._amplitude = 0;
        this.emit(AssistantEvent.AMPLITUDE, { value: 0 });

        if (this.sendInterval) {
            clearInterval(this.sendInterval);
            this.sendInterval = null;
        }

        if (typeof window !== "undefined") {
            window.removeEventListener("beforeunload", this.clientDisconnect);
        }
    }

    private clearReconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    private setAmplitude(v: number) {
        this._amplitude = v;
        this.emit(AssistantEvent.AMPLITUDE, { value: v });
    }

    private emit(type: AssistantEvents, detail?: any) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    private async preloadWorklets() {
        if (typeof window !== "undefined" && !this.workletsLoaded) {
            this.audioCtx = await this.opts.workletLoader(this.opts.workletBasePath);
            this.workletsLoaded = true;
        }
    }

    private waitForOpen(ws: WebSocket): Promise<void> {
        if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
            const onOpen = () => {
                cleanup();
                resolve();
            };
            const onError = (e: any) => {
                cleanup();
                reject(e);
            };
            const cleanup = () => {
                ws.removeEventListener("open", onOpen);
                ws.removeEventListener("error", onError);
            };
            ws.addEventListener("open", onOpen);
            ws.addEventListener("error", onError);
        });
    }
}
