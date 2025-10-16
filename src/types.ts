export type ToastKind = "success" | "info" | "warn" | "error" | undefined;

export type AssistantEvents = "ready" | "mic-open" | "mic-connecting" | "transcription" | "amplitude" | "error" | "socket-message";

export const AssistantEvent = {
    READY: "ready",
    MIC_OPEN: "mic-open",
    MIC_CONNECTING: "mic-connecting",
    TRANSCRIPTION: "transcription",
    AMPLITUDE: "amplitude",
    ERROR: "error",
    SOCKET_MESSAGE: "socket-message",
} as const;

export type AssistantEventName = (typeof AssistantEvent)[keyof typeof AssistantEvent];

export type SocketMessageDetail = {
    raw: MessageEvent;
    parsed?: any;
};

export type MediaStreamProvider = () => Promise<MediaStream>;

/** Optional overrides for how audio is created/loaded */
export interface AudioPlumbingOverrides {
    /** Provide your own MediaStream (system audio, tab capture, etc.) */
    mediaStreamProvider?: MediaStreamProvider;
    /** Provide your own AudioContext (e.g., shared/reused one) */
    audioContextFactory?: () => Promise<AudioContext> | AudioContext;
    /** Provide your own worklet loader (skip the built-in ensureAudioContextAndWorklets) */
    workletLoader?: (basePath: string) => Promise<AudioContext>;
}

export type ExternalAudioOptions = {
    /** if true, do not use getUserMedia/AudioContext; caller will push chunks */
    externalAudio?: boolean;
    /** derive amplitude from pushed PCM and emit AMPLITUDE events (default: true) */
    externalAmplitudeRms?: boolean;
    /** target PCM chunking for send loop; defaults to TARGET_SAMPLES (16000) */
    pcmChunkSize?: number;
};

export interface AssistantOptions extends AudioPlumbingOverrides, ExternalAudioOptions {
    url: string;
    onSend?: () => void;
    rattAgentDetails?: Record<string, any>;
    requestId: { current: string };
    showToast?: (severity: ToastKind, summary: string, detail: string, life?: number) => void;
    pingIntervalMs?: number;
    maxMissedPongs?: number;
    workletBasePath?: string; // where recorder-worklet.js & vad-worklet.js are served
}

export interface StartMicOptions {
    requestId?: string;
    detailsOverride?: Record<string, any>;
}

export interface TranscriptionPayload {
    previous: string;
    next: string;
}

export const TARGET_SAMPLES = 16000;
