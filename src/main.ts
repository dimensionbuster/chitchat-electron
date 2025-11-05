import { app, BrowserWindow, ipcMain, screen, Tray, Menu, session, powerSaveBlocker, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
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
const chatRoomWindows = new Map<string, BrowserWindow>()
const dialogWindows = new Map<string, { window: BrowserWindow; resolve: (result: boolean) => void }>()
let powerSaveBlockerId: number | null = null

// ============================================================================
// 초기 설정
// ============================================================================

// Handle creating/removing shortcuts on Windows when installing/uninstalling
if (started) {
  app.quit()
}

// Single Instance Lock - 하나의 인스턴스만 실행 허용
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  // 이미 다른 인스턴스가 실행 중이면 종료
  console.log('Another instance is already running. Exiting...')
  app.quit()
} else {
  // 두 번째 인스턴스가 실행되려고 할 때
  app.on('second-instance', () => {
    console.log('Second instance attempted to start')
    // 메인 윈도우가 있으면 포커스
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    } else {
      createWindow()
    }
  })
}

// Storage 오류 방지를 위한 앱 초기 설정
app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors')
app.commandLine.appendSwitch('disable-site-isolation-trials')
// Quota management 개선
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer')

// userData 경로가 존재하는지 확인하고 생성
const userDataPath = app.getPath('userData')
if (!fs.existsSync(userDataPath)) {
  fs.mkdirSync(userDataPath, { recursive: true })
  console.log('Created userData directory:', userDataPath)
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
    width: 410,
    height: 700,
    frame: false,
    icon: iconPath,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      // 영구 세션 파티션 사용 - IndexedDB 데이터 영구 보존
      partition: 'persist:chitchat',
      webSecurity: true,
      backgroundThrottling: false, // 백그라운드에서도 실시간 통신 유지
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

  // 개발 모드에서만 개발 도구 열기
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.webContents.openDevTools()
    
    // DevTools 콘솔 필터 설정 (Autofill 오류 무시)
    mainWindow.webContents.on('devtools-opened', () => {
      mainWindow?.webContents.devToolsWebContents?.executeJavaScript(`
        console.defaultError = console.error.bind(console);
        console.error = (...args) => {
          const msg = args.join(' ');
          if (!msg.includes('Autofill')) {
            console.defaultError(...args);
          }
        };
      `).catch(() => {/* ignore */})
    })
  }

  // 페이지 로드 완료 후 IndexedDB 상태 확인
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('Main window loaded - IndexedDB should be available')
    mainWindow?.webContents.executeJavaScript(`
      console.log('IndexedDB available:', typeof indexedDB !== 'undefined');
      console.log('localStorage available:', typeof localStorage !== 'undefined');
      console.log('sessionStorage available:', typeof sessionStorage !== 'undefined');
    `).catch(console.error)
  })

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

  // 초기 메뉴 설정
  updateTrayMenu()

  // 클릭 시 메뉴 표시
  tray.on('click', () => {
    tray?.popUpContextMenu()
  })
}

/**
 * 트레이 메뉴 동적 업데이트
 */
function updateTrayMenu(): void {
  if (!tray || tray.isDestroyed()) {
    return
  }

  const menuItems: Electron.MenuItemConstructorOptions[] = [
    {
      label: '홈 화면 열기',
      click: () => {
        showMainWindow()
      }
    },
    {
      type: 'separator'
    }
  ]

  // 활성 채팅방 목록 추가
  if (chatRoomWindows.size > 0) {
    menuItems.push({
      label: '채팅방',
      submenu: Array.from(chatRoomWindows.entries()).map(([roomId, window]) => ({
        label: `📱 ${roomId}`,
        submenu: [
          {
            label: '창 열기',
            click: () => {
              if (!window.isDestroyed()) {
                if (window.isMinimized()) window.restore()
                window.show()
                window.focus()
              }
            }
          },
          {
            label: '창 닫기',
            click: () => {
              if (!window.isDestroyed()) {
                window.destroy()
              }
              chatRoomWindows.delete(roomId)
              updateTrayMenu()
            }
          }
        ]
      }))
    })
    menuItems.push({
      type: 'separator'
    })
  }

  menuItems.push(
    {
      label: '모든 창 열기',
      click: () => {
        showAllWindows()
      }
    },
    {
      label: '모든 창 숨기기',
      click: () => {
        hideAllWindows()
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
  )

  const contextMenu = Menu.buildFromTemplate(menuItems)
  tray.setContextMenu(contextMenu)
}

/**
 * 모든 창 표시
 */
function showAllWindows(): void {
  // 메인 윈도우 표시
  showMainWindow()
  
  // 모든 채팅방 창 표시
  chatRoomWindows.forEach((window) => {
    if (!window.isDestroyed()) {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    }
  })
}

/**
 * 모든 창 숨기기
 */
function hideAllWindows(): void {
  // 메인 윈도우 숨기기
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide()
  }
  
  // 모든 채팅방 창 숨기기
  chatRoomWindows.forEach((window) => {
    if (!window.isDestroyed()) {
      window.hide()
    }
  })
}

// ============================================================================
// 알림 윈도우 관리
// ============================================================================

/**
 * 알림 윈도우 생성
 */
function createNotification(authorName: string, text: string, messageId:string, roomId: string): void {
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
      partition: 'persist:chitchat', // 같은 파티션 사용
      webSecurity: true,
      backgroundThrottling: false, // 백그라운드에서도 실시간 통신 유지
    },
  })

  // 알림 페이지 로드
  const notificationUrl = `/notification?authorName=${encodeURIComponent(authorName)}&text=${encodeURIComponent(text)}&messageId=${encodeURIComponent(messageId)}&roomId=${encodeURIComponent(roomId)}`
  
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
// 다이얼로그 윈도우 관리
// ============================================================================

/**
 * 다이얼로그 윈도우 생성 (숨김 상태로 생성, Vue가 크기 측정 후 resizeAndShowDialog 호출)
 */
function createDialogWindow(
  message: string,
  type: 'alert' | 'confirm',
  dialogId: string,
  resolve: (result: boolean) => void,
  parentWindow: BrowserWindow
): void {
  const preloadPath = path.join(__dirname, 'preload.js')
  
  // 초기 크기는 작게 설정 (Vue에서 실제 크기 측정 후 조정됨)
  const dialogWindow = new BrowserWindow({
    width: 100,
    height: 100,
    parent: parentWindow, // 부모 창 설정
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    modal: true, // 모달 설정
    show: false, // 숨김 상태로 생성
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      partition: 'persist:chitchat',
      webSecurity: true,
      backgroundThrottling: false, // 백그라운드에서도 실시간 통신 유지
    },
  })

  // 다이얼로그 페이지 로드
  const dialogUrl = `/dialog?message=${encodeURIComponent(message)}&type=${type}&dialogId=${encodeURIComponent(dialogId)}`
  
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    dialogWindow.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}#${dialogUrl}`)
  } else {
    dialogWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      { hash: dialogUrl }
    )
  }

  // 창이 닫힐 때 자동으로 취소 처리
  dialogWindow.on('closed', () => {
    const dialogInfo = dialogWindows.get(dialogId)
    if (dialogInfo) {
      dialogInfo.resolve(false) // 창이 닫히면 취소로 간주
      dialogWindows.delete(dialogId)
    }
  })

  // 다이얼로그 맵에 추가
  dialogWindows.set(dialogId, { window: dialogWindow, resolve })
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
// 채팅방 윈도우 관리
// ============================================================================

/**
 * 새로운 채팅방 윈도우 생성
 */
function createChatRoomWindow(roomId: string, userName?: string): void {
  // 이미 해당 roomId의 창이 열려있으면 표시 및 포커스
  const existingWindow = chatRoomWindows.get(roomId)
  if (existingWindow && !existingWindow.isDestroyed()) {
    if (existingWindow.isMinimized()) existingWindow.restore()
    existingWindow.show()
    existingWindow.focus()
    return
  }

  const preloadPath = path.join(__dirname, 'preload.js')
  const iconPath = path.join(__dirname, '../../assets/originaltwi.ico')
  
  const chatWindow = new BrowserWindow({
    width: 900,
    height: 700,
    frame: false,
    icon: iconPath,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:chitchat',
      webSecurity: true,
      backgroundThrottling: false, // 백그라운드에서도 실시간 통신 유지
    },
  })

  // 채팅방 URL 구성
  let chatUrl = `/chat?roomId=${encodeURIComponent(roomId)}`
  if (userName) {
    chatUrl += `&name=${encodeURIComponent(userName)}`
  }
  
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    chatWindow.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}#${chatUrl}`)
  } else {
    chatWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      { hash: chatUrl }
    )
  }

  // 개발 모드에서만 개발 도구 열기
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    chatWindow.webContents.openDevTools()
    
    // DevTools 콘솔 필터 설정 (Autofill 오류 무시)
    chatWindow.webContents.on('devtools-opened', () => {
      chatWindow.webContents.devToolsWebContents?.executeJavaScript(`
        console.defaultError = console.error.bind(console);
        console.error = (...args) => {
          const msg = args.join(' ');
          if (!msg.includes('Autofill')) {
            console.defaultError(...args);
          }
        };
      `).catch(() => {/* ignore */})
    })
  }

  // 페이지 로드 완료 로그
  chatWindow.webContents.on('did-finish-load', () => {
    console.log(`Chat room window loaded: ${roomId}`)
  })

  // X 버튼 클릭 시 창을 닫는 대신 숨기기 (백그라운드 실행 유지)
  chatWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      chatWindow.hide()
      console.log(`Chat room window hidden: ${roomId}`)
    }
  })

  // 맵에 추가
  chatRoomWindows.set(roomId, chatWindow)
  
  // 트레이 메뉴 업데이트
  updateTrayMenu()

  // 창이 완전히 닫힐 때 맵에서 제거 및 트레이 메뉴 업데이트
  chatWindow.on('closed', () => {
    chatRoomWindows.delete(roomId)
    updateTrayMenu()
    console.log(`Chat room window closed: ${roomId}`)
  })
}

// ============================================================================
// 앱 생명주기 이벤트
// ============================================================================

// ============================================================================
// 백그라운드 성능 최적화 설정
// ============================================================================

// 앱 전체의 백그라운드 throttling 비활성화
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-features', 'WebContentsDiscard')

app.on('ready', async () => {
  // Power Save Blocker 활성화 - 시스템 절전 모드 방지
  powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension')
  console.log('Power Save Blocker activated:', powerSaveBlocker.isStarted(powerSaveBlockerId))
  
  // IndexedDB 및 LocalStorage를 위한 세션 설정
  // partition 설정으로 영구 저장소 활성화
  console.log('userData path:', app.getPath('userData'))
  
  // 세션 설정: quota 오류 방지 및 storage 최적화
  const mainSession = session.fromPartition('persist:chitchat')
  
  // Storage quota 설정 (충분한 공간 할당)
  await mainSession.clearStorageData({
    storages: ['serviceworkers', 'cachestorage', 'websql']
  }).catch((err: Error) => console.warn('Clear storage warning:', err.message))
  
  // CSP 설정: WebRTC 및 WebSocket 연결 허용
  mainSession.webRequest.onHeadersReceived((details: Electron.OnHeadersReceivedListenerDetails, callback: (response: Electron.HeadersReceivedResponse) => void) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; " +
          "connect-src 'self' ws: wss: http: https: data: blob:; " +
          "img-src 'self' data: blob: https:; " +
          "media-src 'self' data: blob:; " +
          "style-src 'self' 'unsafe-inline';"
        ]
      }
    })
  })
  
  console.log('Session configured successfully')
  
  // Windows에서 자동 시작 설정 (첫 실행 시)
  if (process.platform === 'win32') {
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: true, // 시작 시 백그라운드로 실행
      path: process.execPath,
    })
    console.log('Auto-start enabled')
  }
  
  createWindow()
  createTray()
})

app.on('before-quit', () => {
  isQuitting = true
  
  // Power Save Blocker 해제
  if (powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
    powerSaveBlocker.stop(powerSaveBlockerId)
    console.log('Power Save Blocker deactivated')
  }
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
ipcMain.on('new-chat-message', (_event, authorName: string, text: string, messageId: string, roomId: string) => {
  createNotification(authorName, text, messageId, roomId)
})

ipcMain.on('create-notification', (_event, authorName: string, text: string, messageId: string, roomId: string) => {
  createNotification(authorName, text, messageId, roomId)
})

ipcMain.on('close-notification', () => {
  closeLastNotification()
})

ipcMain.on('click-notification', (_event, roomId: string, userName?: string) => {
  // notification 클릭 시 해당 채팅방 창 열기
  if (roomId) {
    createChatRoomWindow(roomId, userName)
  } else {
    // roomId가 없으면 메인 창 표시
    showMainWindow()
  }
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

// 채팅방 창 열기
ipcMain.on('open-chat-room', (_event, roomId: string, userName?: string) => {
  createChatRoomWindow(roomId, userName)
})

// 메인 윈도우 표시
ipcMain.on('show-main-window', () => {
  showMainWindow()
})

// 외부 브라우저에서 링크 열기
ipcMain.on('open-external', (_event, url: string) => {
  // 보안: http, https, ftp 프로토콜만 허용
  if (url.match(/^(https?|ftp):\/\//)) {
    shell.openExternal(url)
  }
})

// 커스텀 다이얼로그 핸들러
ipcMain.handle('show-dialog', async (event, message: string): Promise<void> => {
  const dialogId = crypto.randomUUID()
  const parentWindow = BrowserWindow.fromWebContents(event.sender)
  if (!parentWindow) return
  
  return new Promise<void>((resolve) => {
    createDialogWindow(message, 'alert', dialogId, () => resolve(), parentWindow)
  })
})

ipcMain.handle('show-confirm', async (event, message: string): Promise<boolean> => {
  const dialogId = crypto.randomUUID()
  const parentWindow = BrowserWindow.fromWebContents(event.sender)
  if (!parentWindow) return false
  
  return new Promise<boolean>((resolve) => {
    createDialogWindow(message, 'confirm', dialogId, resolve, parentWindow)
  })
})

ipcMain.on('close-dialog', (_event, dialogId: string, result: boolean) => {
  const dialogInfo = dialogWindows.get(dialogId)
  if (dialogInfo) {
    const { window, resolve } = dialogInfo
    resolve(result)
    dialogWindows.delete(dialogId)
    if (!window.isDestroyed()) {
      window.close()
    }
  }
})

ipcMain.on('resize-and-show-dialog', (_event, dialogId: string, width: number, height: number) => {
  const dialogInfo = dialogWindows.get(dialogId)
  if (dialogInfo && !dialogInfo.window.isDestroyed()) {
    const { window: dialogWindow } = dialogInfo
    const parentWindow = dialogWindow.getParentWindow()

    if (parentWindow && !parentWindow.isDestroyed()) {
      // 부모 창의 중앙에 위치 계산
      const parentBounds = parentWindow.getBounds()
      const dialogX = parentBounds.x + Math.floor((parentBounds.width - width) / 2)
      const dialogY = parentBounds.y + Math.floor((parentBounds.height - height) / 2)

      // 크기와 위치 설정
      dialogWindow.setBounds({ x: dialogX, y: dialogY, width, height })
    } else {
      // 부모 창이 없으면 화면 중앙에 배치
      const display = screen.getPrimaryDisplay()
      const { workArea } = display
      const dialogX = workArea.x + Math.floor((workArea.width - width) / 2)
      const dialogY = workArea.y + Math.floor((workArea.height - height) / 2)
      
      dialogWindow.setBounds({ x: dialogX, y: dialogY, width, height })
    }
    
    // 창 표시
    dialogWindow.show()
    dialogWindow.focus()
    
    console.log(`[Dialog] Resized and shown: ${dialogId}, size: ${width}x${height}`)
  }
})
