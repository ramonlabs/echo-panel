let overlay

function ensureOverlay() {
    if (overlay) return overlay
    overlay = document.createElement('div')
    overlay.className = 'modal-overlay hidden'
    overlay.innerHTML = `
        <div class="modal-box">
            <div class="modal-message"></div>
            <div class="modal-actions">
                <button class="modal-cancel">Cancel</button>
                <button class="modal-confirm">Confirm</button>
            </div>
        </div>`
    document.body.appendChild(overlay)
    return overlay
}

// promise-based replacement for window.confirm
export function confirmModal(
    message,
    { confirmText = 'Confirm', danger = false } = {}
) {
    const el = ensureOverlay()
    el.querySelector('.modal-message').textContent = message
    const confirmBtn = el.querySelector('.modal-confirm')
    const cancelBtn = el.querySelector('.modal-cancel')
    confirmBtn.textContent = confirmText
    confirmBtn.classList.toggle('danger', danger)
    el.classList.remove('hidden')

    return new Promise((resolve) => {
        const ctrl = new AbortController()
        const opts = { signal: ctrl.signal }
        const close = (result) => {
            el.classList.add('hidden')
            ctrl.abort()
            resolve(result)
        }
        confirmBtn.addEventListener('click', () => close(true), opts)
        cancelBtn.addEventListener('click', () => close(false), opts)
        el.addEventListener(
            'click',
            (e) => e.target === el && close(false),
            opts
        )
        document.addEventListener(
            'keydown',
            (e) => e.key === 'Escape' && close(false),
            opts
        )
        confirmBtn.focus()
    })
}
