import type { AssistantEvents, AssistantOptions, StartMicOptions } from "./types";
import { AssistantEvent, TARGET_SAMPLES } from "./types";
import { floatTo16BitPCM } from "./audio/floatTo16BitPCM";
import { ensureAudioContextAndWorklets } from "./audio/WorkletLoader";
import { createWS } from "./utils/createWS";
import { appendWords } from "./utils/appendWords";

/* ---------- class ---------- */
export class AssistantClient extends EventTarget {
    private opts: Required<AssistantOptions>;

    // ws
    private ws: WebSocket | null = null;
    private cleanedUp = false;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private static ACTIVE_WS: WebSocket | null = null;
    private static CONNECT_PROMISE: Promise<WebSocket> | null = null;

    // heartbeat
    private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    private missedPongs = 0;

    // audio
    private audioCtx: AudioContext | null = null;
    private recNode: AudioWorkletNode | null = null;
    private vadNode: AudioWorkletNode | null = null;
    private mediaStream: MediaStream | null = null;
    private workletsLoaded = false;

    // sender
    private sendInterval: ReturnType<typeof setInterval> | null = null;
    private rolling = new Float32Array(0);
    private rollingPCM16 = new Int16Array(0);
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

    // which socket our bound handlers are currently attached to
    private handlerSocket: WebSocket | null = null;
    // prebuffering / gating
    private canSendAudio = false; // becomes true after server start_audio

    constructor(options: AssistantOptions) {
        super();
        const isNode = typeof window === "undefined" || typeof (globalThis as any).document === "undefined";
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
                (async () => {
                    // If someone tries to use it in Node by accident, just throw a clear error
                    if (isNode) throw new Error("mediaStreamProvider not available in Node. Use externalAudio + pushPCM16().");
                    return navigator.mediaDevices.getUserMedia({
                        audio: {
                            channelCount: { ideal: 1 },
                            sampleRate: { ideal: 16000 },
                            sampleSize: { ideal: 16 },
                            autoGainControl: { ideal: true },
                            noiseSuppression: { ideal: true },
                            echoCancellation: { ideal: true },
                        },
                        video: false,
                    });
                }),
            audioContextFactory:
                options.audioContextFactory ??
                // In Node return null; in browser return a real AudioContext when used
                (() => (isNode ? (null as any) : new AudioContext())),
            workletLoader:
                options.workletLoader ??
                (async (base: string) => {
                    if (isNode) return null as any;
                    return ensureAudioContextAndWorklets(base);
                }),
            externalAudio: isNode ? options.externalAudio ?? true : options.externalAudio ?? false,
            externalAmplitudeRms: options.externalAmplitudeRms ?? true,
            pcmChunkSize: options.pcmChunkSize ?? TARGET_SAMPLES,
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

    /** Start capturing mic immediately, buffer locally, do NOT send yet. */
    public async beginPrebuffering(): Promise<void> {
        if (this.isRecording) return; // already recording (idempotent)
        if (!this.workletsLoaded && !this.opts.externalAudio) await this.preloadWorklets();

        this.canSendAudio = false; // gate closed
        await this.startRecording(); // start capture, but do NOT create sender yet
    }

    /** Stop prebuffering and clear any buffered audio. */
    public stopPrebuffering(): void {
        this.canSendAudio = false;
        this.rolling = new Float32Array(0); // drop buffered audio
        this.stopRecording();
    }

    /** Push 16kHz 16-bit mono PCM (LE). Works in any env. */
    public pushPCM16(chunk: Buffer | Int16Array) {
        const view = chunk instanceof Int16Array ? chunk : new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2);
        // concat into rollingPCM16
        const merged = new Int16Array(this.rollingPCM16.length + view.length);
        merged.set(this.rollingPCM16);
        merged.set(view, this.rollingPCM16.length);
        this.rollingPCM16 = merged;
        // optional amplitude from PCM16 (RMS)
        if (this.opts.externalAmplitudeRms) {
            let sum = 0;
            const len = Math.min(view.length, 1024);
            for (let i = 0; i < len; i++) {
                const s = view[i] / 32768; // back to [-1,1]
                sum += s * s;
            }
            const rms = Math.sqrt(sum / Math.max(1, len));
            this.setAmplitude(rms);
        }
        // try flush if gate open
        this.flushBufferedAudio();
    }

    /** Convenience: push Float32 samples ([-1,1]) and convert to PCM16. */
    public pushFloat32(chunk: Float32Array) {
        // convert without allocating twice
        const pcm = new Int16Array(chunk.length);
        for (let i = 0; i < chunk.length; i++) {
            const s = Math.max(-1, Math.min(1, chunk[i]));
            pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        this.pushPCM16(pcm);
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
        if (!this.workletsLoaded && !this.opts.externalAudio) {
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
                if (!this.opts.externalAudio) {
                    const test = await this.opts.mediaStreamProvider();
                    test.getTracks().forEach((t) => t.stop());
                }
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
                    this.emit(AssistantEvent.ERROR, { error: "Microphone access is blocked. Please enable it in your browser settings." });
                    this.opts.showToast("error", "Mic Disabled", "Microphone access is blocked. Please enable it in your browser settings.");
                } else {
                    this.emit(AssistantEvent.ERROR, { err });
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
            this.canSendAudio = true;
            this._micConnecting = false;
            this.emit(AssistantEvent.MIC_CONNECTING, { connecting: false });
            this._micOpen = true;
            this.emit(AssistantEvent.MIC_OPEN, { open: true });
            if (!this.isRecording && this.isMsgSended) {
                this.startRecording().catch(() => {});
            }
            this.flushBufferedAudio();
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
        // already attached to THIS socket
        if (this.handlerSocket === socket) return;

        // attached to a different socket? detach first
        if (this.handlerSocket && this.handlerSocket !== socket) {
            this.detachSocketHandlers();
        }

        // define bound handlers if not yet created
        if (!this.boundOnOpen) {
            this.boundOnOpen = () => {
                this.startHeartbeat();
                this._wsReady = true;
                this.emit(AssistantEvent.READY);
            };
        }

        if (!this.boundOnError) {
            this.boundOnError = (e) => {
                this.emit(AssistantEvent.ERROR, { error: e });
            };
        }
        if (!this.boundOnClose) {
            this.boundOnClose = (event) => {
                console.warn("[WebSocket] closed", event);
                this._wsReady = false;
                this.stopHeartbeat();
                if (AssistantClient.ACTIVE_WS === socket) AssistantClient.ACTIVE_WS = null;
                if (!this.cleanedUp) {
                    // detach from this socket to avoid zombie handlers
                    this.detachSocketHandlers();
                    this.localTeardown();
                    this.reconnectTimer = setTimeout(() => {
                        this.connect().catch(() => {});
                    }, 2000);
                } else {
                    // we were explicitly torn down; ensure handlers are gone
                    this.detachSocketHandlers();
                }
            };
        }
        if (!this.boundOnMessage) {
            this.boundOnMessage = this.handleWSMessage;
        }

        // attach
        socket.addEventListener("open", this.boundOnOpen!);
        socket.addEventListener("error", this.boundOnError!);
        socket.addEventListener("close", this.boundOnClose!);
        socket.addEventListener("message", this.boundOnMessage!);

        if (typeof window !== "undefined") {
            window.addEventListener("beforeunload", this.clientDisconnect);
        }

        this.handlerSocket = socket;
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
        if (this.opts.externalAudio) {
            // external capture: we don't create AudioContext / worklets
            this.isRecording = true;
            if (this.sendInterval) {
                clearInterval(this.sendInterval);
                this.sendInterval = null;
            }
            this.ensureSender();
            return;
        }
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

            if (this.sendInterval) {
                clearInterval(this.sendInterval);
                this.sendInterval = null;
            }
            this.ensureSender();
        } catch (err) {
            console.error("Microphone access error:", err);
            this.stopRecording();
        }
    }

    private stopRecording() {
        if (!this.opts.externalAudio) {
            this.recNode?.disconnect();
            this.vadNode?.disconnect();
            if (this.audioCtx && this.audioCtx.state !== "closed") this.audioCtx.suspend();
            this.mediaStream?.getTracks().forEach((t) => t.stop());
        }
        if (this.sendInterval) {
            clearInterval(this.sendInterval);
            this.sendInterval = null;
        }
        this.isRecording = false;
        this._micOpen = false;
        this.emit(AssistantEvent.MIC_OPEN, { open: false });
        this.canSendAudio = false;
    }

    private ensureSender() {
        if (this.sendInterval) return;
        this.sendInterval = setInterval(() => {
            if (!this.isRecording || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            if (!this.canSendAudio) return; // gate closed until start_audio
            // 1) External PCM16 path
            const pcmChunkSize = this.opts.pcmChunkSize; // typically 16000 samples
            if (this.rollingPCM16.length >= pcmChunkSize) {
                const slice = this.rollingPCM16.slice(0, pcmChunkSize);
                this.ws.send(Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength));
                this.rollingPCM16 = this.rollingPCM16.slice(pcmChunkSize);
                return; // send one chunk per tick to keep cadence
            }
            // 2) Browser Float32 path (convert -> send)
            if (this.rolling.length >= TARGET_SAMPLES) {
                const chunk = this.rolling.slice(0, TARGET_SAMPLES);
                const pcm = floatTo16BitPCM(chunk);
                this.ws.send(pcm.buffer);
                this.rolling = this.rolling.slice(TARGET_SAMPLES);
                return;
            }
        }, 1000);
    }

    private flushBufferedAudio() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (!this.canSendAudio) return;

        const pcmChunkSize = this.opts.pcmChunkSize;
        // Flush PCM16 first
        while (this.rollingPCM16.length >= pcmChunkSize) {
            const slice = this.rollingPCM16.slice(0, pcmChunkSize);
            this.ws.send(Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength));
            this.rollingPCM16 = this.rollingPCM16.slice(pcmChunkSize);
        }
        // Then flush float32 buffer if any (browser)
        while (this.rolling.length >= TARGET_SAMPLES) {
            const chunk = this.rolling.slice(0, TARGET_SAMPLES);
            const pcm = floatTo16BitPCM(chunk);
            this.ws.send(pcm.buffer);
            this.rolling = this.rolling.slice(TARGET_SAMPLES);
        }
    }
    /* ---------- heartbeat ---------- */
    private startHeartbeat() {
        this.stopHeartbeat();
        this.missedPongs = 0;
        this.heartbeatInterval = setInterval(() => {
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
        if (typeof window !== "undefined" && !this.workletsLoaded && !this.opts.externalAudio) {
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
