import { app, BrowserWindow, Menu, session } from 'electron'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { watch } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))

function createWindow() {
    const win = new BrowserWindow({
        width: 350,
        height: 520,
        resizable: true,
        icon: join(__dirname, 'icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: false,
        },
    })

    win.setAlwaysOnTop(true, 'floating')
    win.loadFile(join(__dirname, 'dist/index.html'))

    watch(join(__dirname, 'dist'), { recursive: true }, () => {
        win.webContents.reload()
    })
}

app.whenReady().then(() => {
    Menu.setApplicationMenu(null)

    // let the renderer use the microphone without a prompt
    session.defaultSession.setPermissionRequestHandler(
        (_webContents, permission, callback) => {
            callback(permission === 'media')
        }
    )
    session.defaultSession.setPermissionCheckHandler(
        (_webContents, permission) => permission === 'media'
    )

    createWindow()
})

app.on('window-all-closed', () => app.quit())
