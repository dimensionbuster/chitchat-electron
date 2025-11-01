import { app, BrowserWindow, ipcMain, screen, Tray, Menu } from 'electron'
import path from 'node:path'
import started from 'electron-squirrel-startup'

// ============================================================================
// 환경 변수 및 전역 상수
// ============================================================================

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined
declare const MAIN_WINDOW_VITE_NAME: string

const NOTIFICATION_WIDTH = 300
const NOTIFICATION_HEIGHT = 100
const NOTIFICATION_AUTO_CLOSE_MS = 15000

// ============================================================================
// 전역 상태
// ============================================================================

let isQuitting = false
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
const notificationWindows = new Set<BrowserWindow>()

// ============================================================================
// 초기 설정
// ============================================================================

// Handle creating/removing shortcuts on Windows when installing/uninstalling
if (started) {
  app.quit()
}

// ============================================================================
// 메인 윈도우 관리
// ============================================================================

/**
 * 메인 윈도우 생성 또는 표시
 */
function createWindow(): void {
  // 이미 존재하면 포커스만
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow()
    return
  }

  const preloadPath = path.join(__dirname, 'preload.js')
  const iconPath = path.join(__dirname, '../../assets/originaltwi.ico')
  
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    frame: false,
    icon: iconPath,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // 개발 모드에서 페이지 로드
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    )
  }

  // 개발 도구 열기
  // mainWindow.webContents.openDevTools()

  // X 버튼 클릭 시 창을 닫는 대신 숨기기 (백그라운드 실행 유지)
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
      console.log('Main window hidden - keeping app running in background')
    }
  })

  // 메인 윈도우가 완전히 닫힐 때 참조 정리
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/**
 * 메인 윈도우 표시 및 포커스
 */
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  
  mainWindow.show()
  mainWindow.focus()
}

// ============================================================================
// 시스템 트레이 관리
// ============================================================================

/**
 * 시스템 트레이 아이콘 생성
 */
function createTray(): void {
  if (tray && !tray.isDestroyed()) {
    return
  }

  // 트레이 아이콘 경로
  const iconPath = path.join(__dirname, '../../assets/originaltwi.ico')
  
  tray = new Tray(iconPath)
  tray.setToolTip('ChitChat - 채팅 앱')

  // 트레이 컨텍스트 메뉴
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '창 열기',
      click: () => {
        showMainWindow()
      }
    },
    {
      type: 'separator'
    },
    {
      label: '종료',
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])

  tray.setContextMenu(contextMenu)

  // 더블클릭으로 창 열기
  tray.on('double-click', () => {
    showMainWindow()
  })
}

// ============================================================================
// 알림 윈도우 관리
// ============================================================================

/**
 * 알림 윈도우 생성
 */
function createNotification(authorName: string, text: string, messageId:string): void {
  const display = screen.getPrimaryDisplay()
  const { workArea } = display

  // 화면 우측 하단에 위치 계산
  const notificationX = workArea.x + workArea.width - NOTIFICATION_WIDTH - 10
  const notificationY = workArea.y + workArea.height - NOTIFICATION_HEIGHT - 10

  const preloadPath = path.join(__dirname, 'preload.js')
  
  const notificationWindow = new BrowserWindow({
    width: NOTIFICATION_WIDTH,
    height: NOTIFICATION_HEIGHT,
    x: notificationX,
    y: notificationY,
    frame: false,
    alwaysOnTop: true,
    transparent: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    show: false,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  // 알림 페이지 로드
  const notificationUrl = `/notification?authorName=${encodeURIComponent(authorName)}&text=${encodeURIComponent(text)}&messageId=${encodeURIComponent(messageId)}`
  
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    notificationWindow.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}#${notificationUrl}`)
  } else {
    notificationWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      { hash: notificationUrl }
    )
  }

  // 준비되면 표시
  notificationWindow.once('ready-to-show', () => {
    notificationWindow.showInactive()
    try { 
      notificationWindow.moveTop() 
    } catch { 
      // Ignore on older Electron versions
    }
  })

  // 알림 창 추적
  notificationWindows.add(notificationWindow)
  notificationWindow.on('closed', () => {
    notificationWindows.delete(notificationWindow)
  })

  // 안전 장치: 렌더러 실패 시 자동 닫기
  setTimeout(() => {
    if (!notificationWindow.isDestroyed()) {
      try { 
        notificationWindow.close() 
      } catch { 
        // Ignore errors
      }
    }
  }, NOTIFICATION_AUTO_CLOSE_MS)
}

/**
 * 가장 최근 알림 닫기
 */
function closeLastNotification(): void {
  const lastNotification = Array.from(notificationWindows).pop()
  if (lastNotification && !lastNotification.isDestroyed()) {
    try { 
      lastNotification.close() 
    } catch { 
      // Ignore errors
    }
  }
}

// ============================================================================
// 윈도우 제어 핸들러
// ============================================================================

/**
 * 윈도우 최소화
 */
function handleWindowMinimize(event: Electron.IpcMainEvent): void {
  const window = BrowserWindow.fromWebContents(event.sender)
  window?.minimize()
}

/**
 * 윈도우 최대화/복원 토글
 */
function handleWindowMaximize(event: Electron.IpcMainEvent): void {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window) return

  if (window.isMaximized()) {
    window.unmaximize()
  } else {
    window.maximize()
  }
}

/**
 * 윈도우 닫기
 */
function handleWindowClose(event: Electron.IpcMainEvent): void {
  const window = BrowserWindow.fromWebContents(event.sender)
  window?.close()
}

// ============================================================================
// 앱 생명주기 이벤트
// ============================================================================

app.on('ready', () => {
  createWindow()
  createTray()
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => {
  // 채팅 앱이므로 백그라운드에서 계속 실행
  console.log('All windows closed - keeping app running in background')
})

app.on('activate', () => {
  // macOS에서 dock 아이콘 클릭 시 창 다시 열기
  createWindow()
})

// ============================================================================
// IPC 메시지 핸들러
// ============================================================================

// 알림 관련
ipcMain.on('new-chat-message', (_event, authorName: string, text: string, messageId: string) => {
  createNotification(authorName, text, messageId)
})

ipcMain.on('create-notification', (_event, authorName: string, text: string, messageId: string) => {
  createNotification(authorName, text, messageId)
})

ipcMain.on('close-notification', () => {
  closeLastNotification()
})

ipcMain.on('click-notification', () => {
  showMainWindow()
})

// 윈도우 제어
ipcMain.on('window-minimize', handleWindowMinimize)
ipcMain.on('window-maximize', handleWindowMaximize)
ipcMain.on('window-close', handleWindowClose)

// 로깅
ipcMain.on('log-message', (_event, { level, message }: { level: 'info' | 'warn' | 'error'; message: string }) => {
  switch (level) {
    case 'info':  console.log('INFO:', message); break
    case 'warn':  console.warn('WARN:', message); break
    case 'error': console.error('ERROR:', message); break
  }
})
