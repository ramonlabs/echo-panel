import { CONFIG } from './config.js'
import { confirmModal } from './modal.js'

const USER_FIELDS = ['name', 'nickname', 'timezone', 'interests']
const REQUIRED_USER_FIELDS = ['name']
const CONVO_PAGE_SIZE = 10

// the browser ships the full iana list, so we do not hardcode zones
function timezoneOptions() {
    try {
        return Intl.supportedValuesOf('timeZone')
    } catch {
        return [Intl.DateTimeFormat().resolvedOptions().timeZone].filter(
            Boolean
        )
    }
}

export class MemoryUI {
    constructor() {
        this.apiUrl = CONFIG.memoryApiUrl
        this.currentSubTab = 'list'
        this.onMessage = null
        this.onConversationChange = null
        this.convoMessages = []
        this.convoPage = 0
        this.convoTotal = 0
        this.views = {
            list: document.getElementById('memory-view-list'),
            conversation: document.getElementById('memory-view-conversation'),
            user: document.getElementById('memory-view-user'),
            add: document.getElementById('memory-view-add'),
        }
        document
            .getElementById('submit-memory-btn')
            .addEventListener('click', () => this.submitNewMemory())
    }

    setDefaults() {
        const lt = document.getElementById('stat-long-term')
        const st = document.getElementById('stat-short-term')
        if (lt) lt.textContent = '-'
        if (st) st.textContent = '-'
    }

    async fetchStats() {
        try {
            return await (await fetch(`${this.apiUrl}/stats`)).json()
        } catch {
            return { long_term_memories: 0, short_term_messages: 0 }
        }
    }

    async updateStatsDisplay() {
        const lt = document.getElementById('stat-long-term')
        const st = document.getElementById('stat-short-term')
        try {
            const data = await this.fetchStats()
            if (lt) lt.textContent = data.long_term_memories ?? 0
            if (st) st.textContent = data.short_term_messages ?? 0
        } catch {
            if (lt) lt.textContent = '?'
            if (st) st.textContent = '?'
        }
    }

    switchSubTab(tab) {
        this.currentSubTab = tab
        document
            .querySelectorAll('.memory-sub-tab')
            .forEach((t) => t.classList.remove('active'))
        document.getElementById(`mem-tab-${tab}`).classList.add('active')
        this.renderSubTab()
    }

    renderSubTab() {
        Object.values(this.views).forEach((v) =>
            v?.classList.add('memory-view-hidden')
        )
        this.views[this.currentSubTab]?.classList.remove('memory-view-hidden')

        if (this.currentSubTab === 'list') this.renderMemoriesList()
        else if (this.currentSubTab === 'conversation')
            this.renderConversation()
        else if (this.currentSubTab === 'user') this.renderUserInfo()
    }

    async renderMemoriesList() {
        const container = this.views.list
        if (!container) return
        container.innerHTML = '<div class="empty-state">Loading...</div>'
        try {
            const data = await (
                await fetch(`${this.apiUrl}/memories?limit=50`)
            ).json()
            const memories = data.memories || []
            if (!memories.length) {
                container.innerHTML =
                    '<div class="empty-state">No memories yet. Use "+ Add" to create one.</div>'
                return
            }
            memories.sort(
                (a, b) =>
                    (b.metadata?.timestamp || 0) - (a.metadata?.timestamp || 0)
            )
            const list = document.createElement('div')
            list.className = 'memory-list'
            for (const mem of memories) {
                const item = document.createElement('div')
                item.className = 'memory-item'

                const type = document.createElement('div')
                type.className = 'memory-type'
                type.textContent = mem.metadata?.memory_type || 'fact'

                const text = document.createElement('div')
                text.className = 'memory-text'
                text.textContent = mem.content

                const del = document.createElement('button')
                del.className = 'memory-delete'
                del.textContent = '×'
                del.addEventListener('click', () =>
                    this.deleteMemory(mem.id, item)
                )

                item.append(type, text, del)
                list.appendChild(item)
            }
            container.replaceChildren(list)
        } catch {
            container.innerHTML =
                '<div class="empty-state">Failed to load memories</div>'
        }
    }

    async renderConversation() {
        this.convoPage = 0
        await this.loadConvoPage()
    }

    // fetches only the current page from the server
    async loadConvoPage() {
        const container = this.views.conversation
        if (!container) return
        container.innerHTML = '<div class="empty-state">Loading...</div>'
        try {
            const offset = this.convoPage * CONVO_PAGE_SIZE
            const data = await (
                await fetch(
                    `${this.apiUrl}/conversation/list?limit=${CONVO_PAGE_SIZE}&offset=${offset}`
                )
            ).json()
            this.convoMessages = data.messages || []
            this.convoTotal = data.total || 0
            this.renderConvoPage()
        } catch {
            container.innerHTML =
                '<div class="empty-state">No conversation history.</div>'
        }
    }

    // renders the already-fetched page from cache, no network
    renderConvoPage() {
        const container = this.views.conversation
        if (!this.convoTotal) {
            container.innerHTML =
                '<div class="empty-state">No conversation history.</div>'
            return
        }
        const list = document.createElement('div')
        list.className = 'memory-list'
        for (const m of this.convoMessages)
            list.appendChild(this.buildConvoTurn(m))

        container.replaceChildren(list)
        const pageCount = Math.ceil(this.convoTotal / CONVO_PAGE_SIZE)
        if (pageCount > 1) container.appendChild(this.buildPager(pageCount))
    }

    buildConvoTurn(m) {
        const turn = document.createElement('div')
        turn.className = 'convo-turn'
        if (m.user_message)
            turn.appendChild(this.buildConvoRow('user', m.user_message))
        if (m.assistant_response)
            turn.appendChild(
                this.buildConvoRow('assistant', m.assistant_response)
            )
        if (m.id != null) {
            const del = document.createElement('button')
            del.className = 'memory-delete convo-delete'
            del.textContent = '×'
            del.addEventListener('click', () => this.deleteConversation(m.id))
            turn.appendChild(del)
        }
        return turn
    }

    buildPager(pageCount) {
        const pager = document.createElement('div')
        pager.className = 'convo-pager'

        const prev = document.createElement('button')
        prev.textContent = '<'
        prev.disabled = this.convoPage === 0
        prev.addEventListener('click', () => {
            this.convoPage--
            this.loadConvoPage()
        })

        const label = document.createElement('span')
        label.textContent = `Page ${this.convoPage + 1} of ${pageCount}`

        const next = document.createElement('button')
        next.textContent = '>'
        next.disabled = this.convoPage >= pageCount - 1
        next.addEventListener('click', () => {
            this.convoPage++
            this.loadConvoPage()
        })

        pager.append(prev, label, next)
        return pager
    }

    buildConvoRow(role, text) {
        const item = document.createElement('div')
        item.className = `memory-item convo-${role}`
        const label = document.createElement('div')
        label.className = 'memory-type'
        label.textContent = role
        const body = document.createElement('div')
        body.className = 'memory-text'
        body.textContent = text
        item.append(label, body)
        return item
    }

    async renderUserInfo() {
        const container = this.views.user
        if (!container) return
        container.innerHTML = '<div class="empty-state">Loading...</div>'
        try {
            const data = await (await fetch(`${this.apiUrl}/user/info`)).json()
            const userInfo = data.user_info || []
            const info = {}
            for (const mem of userInfo) {
                const match = mem.content.match(/^(.+?):\s*(.+)$/)
                if (match) info[match[1]] = match[2]
            }

            const form = document.createElement('div')
            form.className = 'user-info-form'
            for (const field of USER_FIELDS) {
                const row = document.createElement('div')
                row.className = 'user-info-row'

                const label = document.createElement('label')
                label.textContent =
                    field.charAt(0).toUpperCase() + field.slice(1)
                // mark required fields so it is clear what must be filled
                if (REQUIRED_USER_FIELDS.includes(field)) {
                    const star = document.createElement('span')
                    star.className = 'required-marker'
                    star.textContent = ' *'
                    label.appendChild(star)
                }

                const input = this.buildUserField(field, info[field] || '')
                row.append(label, input)
                form.appendChild(row)
            }
            const save = document.createElement('button')
            save.id = 'save-user-info-btn'
            save.textContent = 'Save'
            save.addEventListener('click', () => this.saveUserInfo())
            form.appendChild(save)

            container.replaceChildren(form)
        } catch {
            container.innerHTML =
                '<div class="empty-state">Failed to load user info</div>'
        }
    }

    buildUserField(field, value) {
        if (field === 'timezone') {
            const select = document.createElement('select')
            select.id = `user-${field}`
            const blank = document.createElement('option')
            blank.value = ''
            blank.textContent = 'Select timezone...'
            select.appendChild(blank)
            for (const zone of timezoneOptions()) {
                const opt = document.createElement('option')
                opt.value = zone
                opt.textContent = zone
                select.appendChild(opt)
            }
            select.value = value
            return select
        }

        const input = document.createElement('input')
        input.type = 'text'
        input.id = `user-${field}`
        input.value = value
        input.placeholder = `Enter ${field}...`
        return input
    }

    // confirm then DELETE, returns true once the server removed it
    async confirmDelete(message, path) {
        if (
            !(await confirmModal(message, {
                confirmText: 'Delete',
                danger: true,
            }))
        )
            return false
        const res = await fetch(`${this.apiUrl}${path}`, { method: 'DELETE' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return true
    }

    async deleteMemory(memoryId, itemEl) {
        try {
            if (
                !(await this.confirmDelete(
                    'Delete this memory?',
                    `/memory/${memoryId}`
                ))
            )
                return
            itemEl?.remove()
            if (!this.views.list.querySelector('.memory-item')) {
                this.views.list.innerHTML =
                    '<div class="empty-state">No memories yet. Use "+ Add" to create one.</div>'
            }
            this.updateStatsDisplay()
        } catch (e) {
            this.onMessage?.(`Failed to delete memory: ${e.message}`, 'error')
        }
    }

    async deleteConversation(conversationId) {
        try {
            if (
                !(await this.confirmDelete(
                    'Delete this exchange?',
                    `/conversation/${conversationId}`
                ))
            )
                return
            this.convoMessages = this.convoMessages.filter(
                (m) => m.id !== conversationId
            )
            this.convoTotal = Math.max(0, this.convoTotal - 1)
            // page emptied by the delete, step back and refetch
            if (!this.convoMessages.length && this.convoPage > 0) {
                this.convoPage--
                await this.loadConvoPage()
            } else {
                this.renderConvoPage()
            }
            this.updateStatsDisplay()
            this.onConversationChange?.()
        } catch (e) {
            this.onMessage?.(
                `Failed to delete conversation: ${e.message}`,
                'error'
            )
        }
    }

    async submitNewMemory() {
        const content = document
            .getElementById('add-memory-content')
            .value.trim()
        const type = document.getElementById('add-memory-type').value
        if (!content) return
        try {
            await fetch(`${this.apiUrl}/remember`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content,
                    memory_type: type,
                    importance: 0.5,
                    source: 'user',
                }),
            })
            document.getElementById('add-memory-content').value = ''
            this.switchSubTab('list')
            this.updateStatsDisplay()
            this.onMessage?.('Memory added', 'event')
        } catch {
            this.onMessage?.('Failed to add memory', 'error')
        }
    }

    async saveUserInfo() {
        for (const field of REQUIRED_USER_FIELDS) {
            const input = document.getElementById(`user-${field}`)
            if (!input || !input.value.trim()) {
                this.onMessage?.(`${field} is required`, 'error')
                input?.focus()
                return
            }
        }
        for (const field of USER_FIELDS) {
            const input = document.getElementById(`user-${field}`)
            if (input && input.value.trim()) {
                try {
                    await fetch(`${this.apiUrl}/user/info`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            key: field,
                            value: input.value.trim(),
                        }),
                    })
                } catch {}
            }
        }
        this.updateStatsDisplay()
        this.onMessage?.('User info saved', 'event')
    }
}
