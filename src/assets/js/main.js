import { PanelUI, StatusUI, IntegrationsUI, ChatUI, LogUI } from './ui.js'
import { MemoryUI, memoryUrl } from './memory.js'
import { Connect, ContinuousListener } from './connect.js'
import { CONFIG } from './config.js'
import { loadSettings, saveSettings, applySettings } from './settings.js'
import { confirmModal } from './modal.js'

const API = (path) => `${CONFIG.apiUrl}${path}`

const panel = new PanelUI()
const status = new StatusUI()
const integrations = new IntegrationsUI()
const chat = new ChatUI()
const logs = new LogUI()
const memory = new MemoryUI()
const connection = new Connect()
const continuousListener = new ContinuousListener()

let currentState = { expression: 'neutral', state: 'idle', isSpeaking: false }
let micVoiceActive = false

// green while local mic has voice, gated on the avatar being in listening state
function refreshMicSpeaking() {
    status.updateMicSpeaking(
        micVoiceActive && currentState.state === 'listening'
    )
}

// turns raw millisecond timings into a short human label
function fmtMs(ms) {
    if (ms == null) return '-'
    if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
    return `${Math.round(ms)}ms`
}

// friendly labels per error code, falls back to the server message
const ERROR_LABELS = {
    tts_auth: 'Voice auth failed. Check the TTS API key.',
    tts_unavailable: 'Voice service is unavailable.',
    llm_error: 'Language model request failed.',
    llm_rate_limited: 'Rate limited. Wait a minute or switch to Ollama.',
    stt_error: 'Could not transcribe audio.',
    memory_error: 'Memory service failed.',
}

// pulls a display string from a structured {code, message} payload
function errText(data) {
    if (!data) return 'Unknown error'
    return ERROR_LABELS[data.code] || data.message || 'Unknown error'
}

// true when a response carries a structured error
function isError(res, data) {
    return !res.ok || !!(data && data.code)
}

// finds the buttons inside a control group by its visible label
function getControlGroupButtons(label) {
    const groups = document.querySelectorAll('.control-group')
    for (const group of groups) {
        const groupLabel = group.querySelector('.control-group-label')
        if (groupLabel && groupLabel.textContent.trim() === label) {
            return group.querySelectorAll('.control-buttons button')
        }
    }
    return []
}

function handleMessage(msg) {
    logs.log(`< ${msg.type}: ${JSON.stringify(msg.data ?? {})}`, 'debug')
    switch (msg.type) {
        case 'state_update':
            handleStateUpdate(msg.data)
            break
        case 'expression':
            currentState.expression = msg.data.expression
            status.updateExpression(msg.data.expression)
            break
        case 'state':
            currentState.state = msg.data.state
            status.updateState(msg.data.state)
            refreshMicSpeaking()
            break
        case 'speak_start':
            currentState.isSpeaking = true
            status.updateSpeech(true)
            break
        case 'speak_stop':
            currentState.isSpeaking = false
            status.updateSpeech(false)
            break
        case 'content_mode':
            updateContentModeUI(msg.data.content_mode)
            break
        case 'transcription':
            handleTranscription(msg.data)
            break
        case 'chat_message':
            handleChatMessage(msg.data)
            break
        case 'wake_command':
            logs.log(`Wake command: ${msg.data.command}`, 'event')
            break
        case 'error':
            chat.removeProcessingMessage()
            chat.addMessage(errText(msg.data), 'system')
            logs.log(`Error [${msg.data?.code}]: ${errText(msg.data)}`, 'error')
            break
    }
}

function handleStateUpdate(data) {
    currentState.expression = data.expression || 'neutral'
    currentState.state = data.state || 'idle'
    currentState.isSpeaking = !!data.is_speaking
    status.updateExpression(currentState.expression)
    status.updateState(currentState.state)
    status.updateSpeech(currentState.isSpeaking)
    if (data.content_mode) updateContentModeUI(data.content_mode)
}

function handleTranscription(data) {
    if (!data.text?.trim()) return
    if (data.final) chat.removeInterimTranscription()
    else chat.showInterimTranscription(data.text)
}

function handleChatMessage(data) {
    chat.removeInterimTranscription()
    chat.removeProcessingMessage()
    if (data.response?.trim()) chat.addMessage(data.response, 'assistant')
}

async function sendChatMessage() {
    const message = chat.getInputValue()
    if (!message) return
    chat.addMessage(message, 'user')
    chat.setInputDisabled(true)
    chat.addMessage('Thinking...', 'system')
    try {
        const res = await fetch(API('/chat'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message }),
        })
        const data = await res.json()
        chat.removeProcessingMessage()
        if (isError(res, data)) {
            chat.addMessage(errText(data), 'system')
            logs.log(`Chat error [${data.code}]: ${errText(data)}`, 'error')
            return
        }
        chat.addMessage(data.response, 'assistant')
        memory.updateStatsDisplay()
        updatePerformanceStats()
    } catch (e) {
        chat.removeProcessingMessage()
        chat.addMessage(`Error: ${e.message}`, 'system')
        logs.log(`Chat error: ${e.message}`, 'error')
    } finally {
        chat.setInputDisabled(false)
        chat.focusInput()
    }
}

// reply comes back over the socket so we only show the user side here
async function sendStreamingVoice(blob) {
    logs.log(`Sending voice clip (${blob.size} bytes)`, 'debug')
    try {
        const formData = new FormData()
        formData.append('audio', blob, 'recording.wav')
        const res = await fetch(API('/chat/voice/stream'), {
            method: 'POST',
            body: formData,
        })
        const data = await res.json()
        logs.log(`Voice stream: ${JSON.stringify(data)}`, 'debug')
        if (isError(res, data)) {
            chat.addMessage(errText(data), 'system')
        } else if (data.queued) {
            chat.addMessage(`[queued] ${data.transcribed}`, 'user')
        } else if (data.transcribed?.trim()) {
            chat.addMessage(data.transcribed, 'user')
        }
    } catch (e) {
        chat.addMessage(`Error: ${e.message}`, 'system')
        logs.log(`Voice error: ${e.message}`, 'error')
    }
}

async function toggleMicrophoneListening() {
    if (continuousListener.isListening) {
        continuousListener.stop()
        micVoiceActive = false
        status.updateMicButton(false)
        connection.sendAction('set_state', { state: 'idle' })
        logs.log('Stopped listening', 'event')
        return
    }
    logs.log('Requesting microphone...', 'debug')
    if (await continuousListener.start()) {
        status.updateMicButton(true)
        logs.log('Listening - just talk', 'event')
    }
}

function setAvatarExpression(expression) {
    connection.sendAction('set_expression', { expression })
    status.updateExpression(expression)
    currentState.expression = expression
    logs.log(`Expression: ${expression}`, 'debug')
}

function setAvatarState(state) {
    connection.sendAction('set_state', { state })
    status.updateState(state)
    currentState.state = state
    logs.log(`State: ${state}`, 'debug')
}

// the palette belongs to whichever rig is loaded, so ask instead of assuming
async function loadColorButtons() {
    const holder = document.getElementById('color-buttons')
    if (!holder) return

    let textures = []

    try {
        const res = await fetch(API('/character'))
        if (res.ok) textures = (await res.json()).textures || []
    } catch {
        logs.log('Could not read the avatar character', 'debug')
    }

    holder.replaceChildren()

    for (const name of textures) {
        const btn = document.createElement('button')
        // the label is for reading, the value is what the avatar gets
        btn.textContent = name.charAt(0).toUpperCase() + name.slice(1)
        btn.dataset.texture = name
        btn.addEventListener('click', () => setAvatarTexture(name))
        holder.appendChild(btn)
    }
}

function setAvatarTexture(texture) {
    connection.sendAction('set_texture', { texture })
    logs.log(`Color: ${texture}`, 'debug')
}

async function setProfanityFilterEnabled(enabled) {
    const mode = enabled ? 'filtered' : 'unfiltered'
    try {
        const res = await fetch(API(`/content-mode/${mode}`), {
            method: 'POST',
        })
        const data = await res.json()
        if (isError(res, data)) {
            logs.log(
                `Content mode error [${data.code}]: ${errText(data)}`,
                'error'
            )
            return
        }
        updateContentModeUI(data.content_mode)
        logs.log(`Content mode: ${data.content_mode}`, 'event')
    } catch (e) {
        logs.log(`Content mode error: ${e.message}`, 'error')
    }
}

function updateContentModeUI(mode) {
    status.setProfanityFilter(mode === 'filtered')
}

async function clearConversationAndHistory() {
    const ok = await confirmModal(
        'Clear the conversation? This cannot be undone.',
        { confirmText: 'Erase', danger: true }
    )
    if (!ok) return
    try {
        await fetch(API('/chat/clear'), { method: 'POST' })
        chat.clear()
        memory.updateStatsDisplay()
        logs.log('Conversation cleared', 'event')
    } catch (e) {
        chat.addMessage(`Error: ${e.message}`, 'system')
        logs.log(`Clear error: ${e.message}`, 'error')
    }
}

async function eraseMemories() {
    const ok = await confirmModal(
        'Erase all long term memories? This cannot be undone.',
        { confirmText: 'Erase', danger: true }
    )
    if (!ok) return
    try {
        await fetch(await memoryUrl('/memories'), { method: 'DELETE' })
        memory.updateStatsDisplay()
        memory.renderSubTab()
        logs.log('Memories erased', 'event')
    } catch (e) {
        logs.log(`Erase error: ${e.message}`, 'error')
    }
}

async function restoreConversation() {
    try {
        const res = await fetch(
            await memoryUrl('/conversation/recent?limit=20')
        )
        const data = await res.json()
        const messages = data.messages || data.conversation || []
        if (messages.length) chat.restore(messages)
    } catch {
        /* ignore */
    }
}

async function updatePerformanceStats() {
    try {
        const data = await (await fetch(API('/performance'))).json()
        status.updatePerformance({
            last: fmtMs(data.last_total_ms),
            avg: fmtMs(data.avg_total_ms),
            llm: fmtMs(data.last_llm_ms),
            tts: fmtMs(data.last_tts_ms),
            firstAudio: fmtMs(data.last_first_audio_ms),
        })
    } catch {
        /* ignore */
    }
    updateContextUsage()
}

async function updateContextUsage() {
    try {
        const data = await (await fetch(API('/usage'))).json()
        status.updateContextUsage(data)
    } catch {
        /* ignore */
    }
}

async function refreshSoundEffects() {
    const listEl = document.getElementById('sounds-list')
    try {
        const data = await (await fetch(API('/sounds'))).json()
        const names = Object.keys(data.index || {})
        const aliases = Object.keys(data.aliases || {})
        integrations.updateSounds({
            count: names.length,
            aliases: aliases.length,
        })
        renderSoundList(listEl, names)
    } catch {
        if (listEl) {
            listEl.innerHTML =
                '<div class="loading-sound-text">Error loading sounds</div>'
        }
    }
}

function renderSoundList(container, names) {
    if (!container) return
    if (!names.length) {
        container.innerHTML =
            '<div class="loading-sound-text">No sounds found.</div>'
        return
    }
    const wrap = document.createElement('div')
    wrap.className = 'sound-chip-list'
    for (const name of names) {
        const chip = document.createElement('button')
        chip.className = 'sound-chip'
        chip.textContent = name
        chip.title = 'Click to play'
        chip.addEventListener('click', () => playSound(name))
        wrap.appendChild(chip)
    }
    container.replaceChildren(wrap)
}

async function playSound(name) {
    if (!name) return
    try {
        const res = await fetch(API('/sounds/play'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sound_name: name }),
        })
        const data = await res.json()
        if (isError(res, data))
            logs.log(`Sound error [${data.code}]: ${errText(data)}`, 'error')
        else logs.log(`Playing sound: ${name}`, 'event')
    } catch (e) {
        logs.log(`Sound error: ${e.message}`, 'error')
    }
}

function playSoundEffect() {
    const name = document.getElementById('sound-test-name').value.trim()
    if (!name) return
    playSound(name)
}

function refreshTab(tab) {
    if (tab === 'controls') updatePerformanceStats()
    else if (tab === 'integrations') {
        refreshSoundEffects()
    } else if (tab === 'memory') {
        memory.updateStatsDisplay()
        memory.renderSubTab()
    }
}

function wirePanelTabs() {
    document.querySelectorAll('.panel-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            const name = tab.id.replace('panel-', '')
            panel.switchTab(name)
            refreshTab(name)
        })
    })
}

function wireMemorySubTabs() {
    document.querySelectorAll('.memory-sub-tab').forEach((tab) => {
        tab.addEventListener('click', () =>
            memory.switchSubTab(tab.id.replace('mem-tab-', ''))
        )
    })
}

function wireChatControls() {
    document
        .getElementById('microphone-chat-button')
        .addEventListener('click', toggleMicrophoneListening)
    document
        .getElementById('send-chat-button')
        .addEventListener('click', sendChatMessage)
    document.getElementById('chat-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendChatMessage()
    })
    status.initMicButtonHover()

    continuousListener.onSpeechStart = () => {
        logs.log('Speech detected', 'debug')
        connection.sendAction('set_state', { state: 'listening' })
        micVoiceActive = true
        currentState.state = 'listening'
        refreshMicSpeaking()
        // if the avatar is talking, cut it off
        if (currentState.isSpeaking) {
            connection.sendAction('set_state', { state: 'idle' })
            fetch(API('/interrupt'), { method: 'POST' }).catch(() => {})
        }
    }
    continuousListener.onSpeechEnd = () => {
        logs.log('Speech ended', 'debug')
        connection.sendAction('set_state', { state: 'idle' })
        micVoiceActive = false
        refreshMicSpeaking()
    }
    continuousListener.onAudioReady = (blob) => sendStreamingVoice(blob)
    continuousListener.onError = (e) => {
        micVoiceActive = false
        status.updateMicButton(false)
        chat.addMessage(`Microphone error: ${e.message}`, 'system')
        logs.log(`Microphone error: ${e.name} - ${e.message}`, 'error')
    }
}

function wireControlButtons() {
    getControlGroupButtons('Expression').forEach((btn) => {
        btn.addEventListener('click', () =>
            setAvatarExpression(btn.textContent.trim().toLowerCase())
        )
    })
    loadColorButtons()
    getControlGroupButtons('State').forEach((btn) => {
        btn.addEventListener('click', () =>
            setAvatarState(btn.textContent.trim().toLowerCase())
        )
    })

    document
        .getElementById('mode-filtered')
        .addEventListener('click', () => setProfanityFilterEnabled(true))
    document
        .getElementById('mode-unfiltered')
        .addEventListener('click', () => setProfanityFilterEnabled(false))
}

function wireIntegrationControls() {
    const sounds = getControlGroupButtons('Sound Effects')
    if (sounds[0]) sounds[0].addEventListener('click', refreshSoundEffects)
    if (sounds[1]) sounds[1].addEventListener('click', playSoundEffect)
}

function wireSettings() {
    const overlay = document.getElementById('settings-overlay')
    const settings = loadSettings()

    document
        .getElementById('settings-button')
        .addEventListener('click', () => overlay.classList.remove('hidden'))
    document
        .getElementById('settings-close')
        .addEventListener('click', () => overlay.classList.add('hidden'))
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.classList.add('hidden')
    })

    document
        .getElementById('clear-history-btn')
        .addEventListener('click', clearConversationAndHistory)

    document
        .getElementById('erase-memories-btn')
        .addEventListener('click', eraseMemories)

    // segmented picker bound to a settings key, dataset attr carries the value
    const wireSegment = (containerId, key, attr, parse = (v) => v) => {
        const buttons = document.querySelectorAll(`#${containerId} button`)
        buttons.forEach((btn) => {
            const value = parse(btn.dataset[attr])
            btn.classList.toggle('active', value === settings[key])
            btn.addEventListener('click', () => {
                settings[key] = value
                saveSettings(settings)
                applySettings(settings)
                buttons.forEach((b) => b.classList.remove('active'))
                btn.classList.add('active')
            })
        })
    }

    wireSegment('theme-buttons', 'theme', 'theme')
    wireSegment('scale-buttons', 'scale', 'scale', Number)
}

function wireLogControls() {
    const logButtons = document.querySelectorAll('.log-controls-bar button')
    if (logButtons[0])
        logButtons[0].addEventListener('click', () => logs.clear())
}

document.addEventListener('DOMContentLoaded', () => {
    applySettings(loadSettings())

    wirePanelTabs()
    wireMemorySubTabs()
    wireChatControls()
    wireControlButtons()
    wireIntegrationControls()
    wireLogControls()
    wireSettings()

    status.setDefaults()
    integrations.setDefaults()
    memory.setDefaults()

    memory.onMessage = (text, level) => logs.log(text, level)
    memory.onConversationChange = () => {
        chat.clear()
        restoreConversation()
    }

    connection.addEventListener('status-change', (e) => {
        status.updateConnection(e.detail.status, e.detail.isError)
        logs.log(
            `Connection: ${e.detail.status}`,
            e.detail.isError ? 'warn' : 'event'
        )
    })
    connection.addEventListener('message', (e) => handleMessage(e.detail))
    connection.connect()

    restoreConversation()
})

window.addEventListener('beforeunload', () => {
    if (continuousListener.isListening) continuousListener.stop()
})
