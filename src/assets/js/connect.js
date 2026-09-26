import { MicVAD } from '@ricky0123/vad-web'
import { CONFIG } from './config.js'

const SAMPLE_RATE = 16000
const WAV_HEADER_BYTES = 44
const PCM_SCALE_NEG = 0x8000
const PCM_SCALE_POS = 0x7fff

export class Connect extends EventTarget {
    constructor() {
        super()
        this.config = CONFIG
        this.ws = null
        this.reconnectTimeout = null
    }

    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return

        this.ws = new WebSocket(this.config.wsUrl)

        this.ws.onopen = () => {
            this.emit('status-change', { status: 'Connected', isError: false })
            this.sendAction('get_state')
        }

        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data)
                if (data.type === 'ping') return this.send({ type: 'pong' })

                this.dispatchEvent(new CustomEvent('message', { detail: data }))
            } catch (e) {
                console.error('Parse error', e)
            }
        }

        this.ws.onclose = () => {
            this.emit('status-change', {
                status: 'Disconnected',
                isError: true,
            })
            this.reconnect()
        }

        this.ws.onerror = () =>
            this.emit('status-change', { status: 'Error', isError: true })
    }

    emit(type, detail) {
        this.dispatchEvent(new CustomEvent(type, { detail }))
    }

    send(data) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data))
        }
    }

    // sends a command action to the avatar over the socket
    sendAction(action, params = {}) {
        this.send({ action, ...params })
    }

    reconnect() {
        clearTimeout(this.reconnectTimeout)
        this.reconnectTimeout = setTimeout(
            () => this.connect(),
            CONFIG.reconnectTimer
        )
    }
}

// wraps the float32 utterance the vad hands back into a 16khz mono pcm16 wav blob
function float32ToWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(WAV_HEADER_BYTES + samples.length * 2)
    const view = new DataView(buffer)
    const writeStr = (offset, str) => {
        for (let i = 0; i < str.length; i++) {
            view.setUint8(offset + i, str.charCodeAt(i))
        }
    }

    writeStr(0, 'RIFF')
    view.setUint32(4, 36 + samples.length * 2, true)
    writeStr(8, 'WAVE')
    writeStr(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * 2, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    writeStr(36, 'data')
    view.setUint32(40, samples.length * 2, true)

    let offset = WAV_HEADER_BYTES
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]))
        view.setInt16(
            offset,
            s < 0 ? s * PCM_SCALE_NEG : s * PCM_SCALE_POS,
            true
        )
        offset += 2
    }

    return new Blob([view], { type: 'audio/wav' })
}

// listens nonstop with silero vad and hands back a wav blob each utterance
export class ContinuousListener {
    constructor() {
        this.isListening = false
        this.vad = null
        this.onSpeechStart = null
        this.onSpeechEnd = null
        this.onAudioReady = null
        this.onError = null
    }

    async start() {
        if (this.isListening) return true
        try {
            this.vad = await MicVAD.new({
                model: 'v5',
                baseAssetPath: '/',
                onnxWASMBasePath: '/',
                redemptionFrames: 12,
                minSpeechFrames: 5,
                preSpeechPadFrames: 3,
                onSpeechStart: () => this.onSpeechStart?.(),
                onSpeechEnd: async (audio) => {
                    await this.onAudioReady?.(float32ToWav(audio, SAMPLE_RATE))
                    this.onSpeechEnd?.()
                },
            })
            this.vad.start()
            this.isListening = true
            return true
        } catch (e) {
            this.onError?.(e)
            return false
        }
    }

    stop() {
        this.isListening = false
        if (this.vad) {
            this.vad.destroy()
            this.vad = null
        }
    }
}
