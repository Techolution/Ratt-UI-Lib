import { AssistantOptions } from "./types";
import { AssistantClient as Base } from "./AssistantClient";

export class AssistantClient extends Base {
    constructor(options: AssistantOptions) {
        super({
            ...options,
            // RN must use external audio capture (pushPCM16 / pushFloat32)
            externalAudio: options.externalAudio ?? true,
            // Prevent accidental web-audio usage on RN
            mediaStreamProvider:
                options.mediaStreamProvider ??
                (async () => {
                    throw new Error("[ratt-lib] React Native does not support AudioWorklet/getUserMedia. " + "Record audio natively and call pushPCM16().");
                }),
            audioContextFactory: options.audioContextFactory ?? (() => null as any),
            workletLoader: options.workletLoader ?? (async () => null as any),
        });
    }
}
