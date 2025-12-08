import { app, BrowserWindow, ipcMain, screen, Tray, Menu, session, powerSaveBlocker, powerMonitor, shell, dialog, autoUpdater } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import http from 'node:http'
import started from 'electron-squirrel-startup'
import { updateElectronApp } from 'update-electron-app'

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
const watchPartyWindows = new Map<string, BrowserWindow>()
let powerSaveBlockerId: number | null = null
let localServer: http.Server | null = null
let localServerPort = 0

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
// 자동 업데이트 설정
// ============================================================================

// 패키징된 앱에서만 자동 업데이트 활성화
if (app.isPackaged) {
  updateElectronApp({
    updateInterval: '10 minutes', // 10분마다 업데이트 확인
    logger: console, // 업데이트 로그 활성화
  })
  console.log('Auto-update enabled')
} else {
  console.log('Auto-update disabled in development mode')
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

  // iframe 등에서 새 창 열기 차단 (YouTube 임베드 등)
  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' }
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

  // 활성 채팅방 목록 추가 - 클릭 시 바로 열기
  if (chatRoomWindows.size > 0) {
    menuItems.push({
      label: '채팅방',
      submenu: Array.from(chatRoomWindows.entries()).map(([roomId, window]) => ({
        label: `📱 ${roomId}`,
        click: () => {
          if (!window.isDestroyed()) {
            if (window.isMinimized()) window.restore()
            window.show()
            window.focus()
          }
        }
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
  if (window && !window.isDestroyed()) {
    window.minimize()
  }
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
  if (window && !window.isDestroyed()) {
    window.close()
  }
}

/**
 * 창 완전히 닫기 (확실하게 종료)
 */
function handleWindowDestroy(event: Electron.IpcMainEvent): void {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (window && !window.isDestroyed()) {
    window.destroy()
  }
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
      webSecurity: false, // file:// 프로토콜에서 YouTube iframe 허용
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
    // 프로덕션: file:// 프로토콜로 로드 (IndexedDB 공유를 위해 로컬 서버 사용 안 함)
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

  // iframe 등에서 새 창 열기 차단 (YouTube 임베드 등)
  chatWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' }
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
  
  // 마지막 열린 채팅방 목록 저장
  saveLastOpenedRooms()

  // 창이 완전히 닫힐 때 맵에서 제거 및 트레이 메뉴 업데이트
  chatWindow.on('closed', () => {
    chatRoomWindows.delete(roomId)
    updateTrayMenu()
    
    // 마지막 열린 채팅방 목록 업데이트
    saveLastOpenedRooms()
    
    console.log(`Chat room window closed: ${roomId}`)
  })
}

// ============================================================================
// Watch Party 윈도우 관리
// ============================================================================

/**
 * Watch Party 전용 창 생성 (BrowserWindow with iframe)
 */
function createWatchPartyWindow(roomId: string, youtubeUrl?: string, userName?: string): void {
  console.log(`[WatchParty] Creating window for room: ${roomId}, youtubeUrl: ${youtubeUrl}, userName: ${userName}`)
  
  // 이미 해당 roomId의 Watch Party 창이 열려있으면 포커스
  const existing = watchPartyWindows.get(roomId)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    // 새 URL이 있으면 Vue 컴포넌트에 전달 (IPC로)
    if (youtubeUrl) {
      existing.webContents.send('watch-party:load-youtube-url', youtubeUrl)
    }
    return
  }

  const preloadPath = path.join(__dirname, 'preload.js')
  const iconPath = path.join(__dirname, '../../assets/originaltwi.ico')
  
  // BrowserWindow 생성 (프레임 없는 창)
  const window = new BrowserWindow({
    width: 1200,
    height: 720,
    minWidth: 854,
    minHeight: 480,
    frame: false,
    icon: iconPath,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:chitchat',
      backgroundThrottling: false,
      webSecurity: true, // Vue 컴포넌트는 보안 유지
    },
  })

  // 새 창 열기 차단
  window.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' }
  })

  // Watch Party 컴포넌트 로드 (localhost에서만 로드)
  let watchPartyUrl = `/watch-party?roomId=${encodeURIComponent(roomId)}`
  if (youtubeUrl) {
    watchPartyUrl += `&youtubeUrl=${encodeURIComponent(youtubeUrl)}`
  }
  if (userName) {
    watchPartyUrl += `&userName=${encodeURIComponent(userName)}`
  }
  
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    // 개발 모드: Vite dev 서버
    window.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}#${watchPartyUrl}`)
  } else if (localServerPort > 0) {
    // 프로덕션: localhost 서버 (YouTube iframe을 위해 필수)
    window.loadURL(getLocalServerUrl(watchPartyUrl))
  } else {
    // fallback: file:// (YouTube iframe이 작동하지 않음)
    console.warn('[WatchParty] Local server not available - YouTube iframe will not work with file:// protocol')
    window.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      { hash: watchPartyUrl }
    )
  }

  // 개발 모드에서만 DevTools
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    window.webContents.openDevTools()
  }

  // 페이지 로드 완료 로그
  window.webContents.on('did-finish-load', () => {
    console.log(`[WatchParty] Window loaded for room: ${roomId}`)
  })
  
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(`[WatchParty] Failed to load: ${errorCode} - ${errorDescription}`)
  })

  // Watch Party는 X 버튼 클릭 시 완전히 종료 (다른 창들과 달리)
  // (닫을 때 숨기지 않고 바로 종료)

  // 맵에 추가
  watchPartyWindows.set(roomId, window)

  // 창이 완전히 닫힌 후 맵에서 제거
  window.on('closed', () => {
    console.log(`[WatchParty] Window closed for room: ${roomId}`)
    watchPartyWindows.delete(roomId)
  })

  console.log(`[WatchParty] Window created for room: ${roomId}`)
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

// ============================================================================
// 전원 관리 및 시스템 이벤트 (절전 모드 대응)
// ============================================================================

/**
 * 모든 윈도우에 절전모드 복귀 이벤트 전송
 */
function notifyWindowsOfResume(): void {
  console.log('[PowerManagement] 모든 윈도우에 복귀 알림 전송')
  
  // 메인 윈도우
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('system-resume')
  }
  
  // 채팅방 윈도우들
  chatRoomWindows.forEach((window) => {
    if (!window.isDestroyed()) {
      window.webContents.send('system-resume')
    }
  })
}

// ============================================================================
// 로컬 HTTP 서버 (프로덕션 빌드용) - YouTube iframe Permissions Policy 해결
// ============================================================================

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
}

function startLocalServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    const rendererPath = path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`)
    
    localServer = http.createServer((req, res) => {
      let urlPath = req.url || '/'
      
      // hash 라우팅 처리 - 모든 경로를 index.html로
      if (urlPath.includes('?') || !urlPath.includes('.')) {
        urlPath = '/index.html'
      }
      
      const filePath = path.join(rendererPath, urlPath)
      const ext = path.extname(filePath).toLowerCase()
      const contentType = MIME_TYPES[ext] || 'application/octet-stream'
      
      fs.readFile(filePath, (err, data) => {
        if (err) {
          // 파일이 없으면 index.html 반환 (SPA 라우팅)
          fs.readFile(path.join(rendererPath, 'index.html'), (err2, indexData) => {
            if (err2) {
              res.writeHead(404)
              res.end('Not Found')
              return
            }
            // Permissions-Policy 헤더 추가
            res.writeHead(200, {
              'Content-Type': 'text/html',
              'Permissions-Policy': 'autoplay=*, encrypted-media=*, accelerometer=*, gyroscope=*, picture-in-picture=*, clipboard-write=*'
            })
            res.end(indexData)
          })
          return
        }
        
        // Permissions-Policy 헤더 추가
        const headers: Record<string, string> = {
          'Content-Type': contentType
        }
        if (ext === '.html') {
          headers['Permissions-Policy'] = 'autoplay=*, encrypted-media=*, accelerometer=*, gyroscope=*, picture-in-picture=*, clipboard-write=*'
        }
        
        res.writeHead(200, headers)
        res.end(data)
      })
    })
    
    // 사용 가능한 포트 찾기 (45678 부터 시도)
    const tryPort = (port: number) => {
      localServer!.listen(port, 'localhost', () => {
        localServerPort = port
        console.log(`[LocalServer] Started on http://localhost:${port}`)
        resolve(port)
      }).on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          tryPort(port + 1)
        } else {
          reject(err)
        }
      })
    }
    
    tryPort(45678)
  })
}

function getLocalServerUrl(hashPath: string): string {
  return `http://localhost:${localServerPort}/#${hashPath}`
}

app.on('ready', async () => {
  // 프로덕션 모드에서 로컬 서버 시작 (YouTube iframe Permissions Policy 해결)
  if (!MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    try {
      await startLocalServer()
    } catch (err) {
      console.error('[LocalServer] Failed to start:', err)
    }
  }
  
  // Power Save Blocker 활성화 - 시스템 절전 모드 방지
  powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension')
  console.log('Power Save Blocker activated:', powerSaveBlocker.isStarted(powerSaveBlockerId))
  
  // 🔥 전원 관리 이벤트 리스너 (절전 모드 대응)
  powerMonitor.on('suspend', () => {
    console.log('[PowerManagement] 시스템 절전 모드 진입')
  })
  
  powerMonitor.on('resume', () => {
    console.log('[PowerManagement] 시스템 절전 모드 복귀')
    // 짧은 지연 후 윈도우에 알림 (시스템 안정화 대기)
    setTimeout(() => {
      notifyWindowsOfResume()
    }, 500)
  })
  
  powerMonitor.on('lock-screen', () => {
    console.log('[PowerManagement] 화면 잠금')
  })
  
  powerMonitor.on('unlock-screen', () => {
    console.log('[PowerManagement] 화면 잠금 해제')
    // 잠금 해제 시에도 연결 상태 확인
    setTimeout(() => {
      notifyWindowsOfResume()
    }, 500)
  })
  
  // 🔥 AC/배터리 전환 감지 (노트북)
  powerMonitor.on('on-ac', () => {
    console.log('[PowerManagement] AC 전원 연결')
  })
  
  powerMonitor.on('on-battery', () => {
    console.log('[PowerManagement] 배터리 모드 전환')
  })
  
  // IndexedDB 및 LocalStorage를 위한 세션 설정
  // partition 설정으로 영구 저장소 활성화
  console.log('userData path:', app.getPath('userData'))
  
  // 세션 설정: quota 오류 방지 및 storage 최적화
  const mainSession = session.fromPartition('persist:chitchat')
  
  // Storage quota 설정 (충분한 공간 할당)
  await mainSession.clearStorageData({
    storages: ['serviceworkers', 'cachestorage', 'websql']
  }).catch((err: Error) => console.warn('Clear storage warning:', err.message))
  
  // YouTube 광고 관련 요청 차단
  mainSession.webRequest.onBeforeRequest(
    {
      urls: [
        // YouTube 광고 API
        '*://www.youtube.com/youtubei/v1/player/ad_break*',
        '*://www.youtube.com/api/stats/ads*',
        '*://www.youtube.com/pagead/*',
        '*://www.youtube.com/ptracking*',
        // Google 광고 네트워크
        '*://pagead2.googlesyndication.com/*',
        '*://www.googleadservices.com/*',
        '*://googleads.g.doubleclick.net/*',
        '*://*.googlesyndication.com/*',
        '*://ad.doubleclick.net/*',
        // 광고 추적 스크립트
        '*://www.google.com/pagead/*',
        '*://www.gstatic.com/adsense/*',
        // IMA SDK (광고 플레이어)
        '*://imasdk.googleapis.com/*'
      ]
    },
    (details, callback) => {
      console.log('[Ad Blocked]', details.url.substring(0, 80))
      callback({ cancel: true })
    }
  )
  
  // CSP 설정: WebRTC 및 WebSocket 연결 허용
  mainSession.webRequest.onHeadersReceived((details: Electron.OnHeadersReceivedListenerDetails, callback: (response: Electron.HeadersReceivedResponse) => void) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; " +
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.youtube.com https://www.youtube-nocookie.com https://s.ytimg.com https://www.google.com https://*.googlevideo.com; " +
          "connect-src 'self' ws: wss: http: https: data: blob:; " +
          "img-src 'self' data: blob: https:; " +
          "media-src 'self' data: blob: https: http:; " +
          "font-src 'self' data: https://fonts.gstatic.com https:; " +
          "frame-src 'self' https://youtube.com https://www.youtube.com https://youtube-nocookie.com https://www.youtube-nocookie.com; " +
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;"
        ],
        // YouTube iframe에 필요한 Permissions-Policy
        // (self)와 https://www.youtube.com 등 허용
        'Permissions-Policy': [
          'autoplay=(self "https://www.youtube.com" "https://www.youtube-nocookie.com"), ' +
          'encrypted-media=(self "https://www.youtube.com" "https://www.youtube-nocookie.com"), ' +
          'accelerometer=(self "https://www.youtube.com" "https://www.youtube-nocookie.com"), ' +
          'gyroscope=(self "https://www.youtube.com" "https://www.youtube-nocookie.com"), ' +
          'picture-in-picture=(self "https://www.youtube.com" "https://www.youtube-nocookie.com"), ' +
          'clipboard-write=(self), ' +
          'web-share=(self)'
        ]
      }
    })
  })
  
  // YouTube 관련 권한 허용
  mainSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = ['media', 'mediaKeySystem', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen']
    if (allowedPermissions.includes(permission)) {
      callback(true)
    } else {
      callback(false)
    }
  })
  
  // Permissions Policy 체크 허용 (YouTube iframe 등)
  mainSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    // YouTube 관련 origin에서 오는 권한 요청 허용
    const allowedOrigins = [
      'https://www.youtube.com',
      'https://youtube.com',
      'https://www.youtube-nocookie.com',
      'https://youtube-nocookie.com',
      'https://s.ytimg.com',
      'https://i.ytimg.com'
    ]
    
    const allowedPermissions = [
      'media',
      'mediaKeySystem', 
      'clipboard-read',
      'clipboard-sanitized-write',
      'fullscreen',
      'pointerLock'
    ]
    
    // YouTube origin 허용
    if (allowedOrigins.some(origin => requestingOrigin.startsWith(origin))) {
      return true
    }
    
    // 특정 권한 허용
    if (allowedPermissions.includes(permission)) {
      return true
    }
    
    return false
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
  
  // 약간의 지연 후 마지막 열린 채팅방 복원
  setTimeout(() => {
    restoreLastOpenedRooms()
  }, 1000) // 1초 지연 (메인 윈도우가 완전히 로드된 후)
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
ipcMain.on('window-destroy', handleWindowDestroy)

// 개발자 도구 토글 (F12)
ipcMain.on('toggle-devtools', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (window) {
    if (window.webContents.isDevToolsOpened()) {
      window.webContents.closeDevTools()
    } else {
      window.webContents.openDevTools()
    }
  }
})

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

// 설정 창 열기
let settingsWindow: BrowserWindow | null = null

function createSettingsWindow(parentWindow?: BrowserWindow): void {
  // 이미 열려있으면 포커스
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore()
    settingsWindow.show()
    settingsWindow.focus()
    return
  }

  const preloadPath = path.join(__dirname, 'preload.js')
  
  settingsWindow = new BrowserWindow({
    width: 720,
    height: 700,
    parent: parentWindow || undefined,
    frame: false,
    resizable: true,
    minimizable: true,
    maximizable: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:chitchat',
      webSecurity: true,
    },
  })

  const settingsUrl = '/settings'
  
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    settingsWindow.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}#${settingsUrl}`)
  } else {
    settingsWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      { hash: settingsUrl }
    )
  }

  // 개발 모드에서 DevTools 열기
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    settingsWindow.webContents.openDevTools()
  }

  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
}

ipcMain.on('open-settings', (event) => {
  const parentWindow = BrowserWindow.fromWebContents(event.sender) || undefined
  createSettingsWindow(parentWindow)
})

// Watch Party 창 열기
ipcMain.on('open-watch-party', (_event, roomId: string, youtubeUrl?: string, userName?: string) => {
  console.log('IPC: open-watch-party', { roomId, youtubeUrl, userName })
  createWatchPartyWindow(roomId, youtubeUrl, userName)
})

// Watch Party 명령 처리 (Vue 컴포넌트가 iframe을 직접 관리하므로 간소화)
ipcMain.on('watch-party-command', (event, command: string, data: string) => {
  console.log('[WatchParty] IPC: watch-party-command', command, data)
  
  // BrowserWindow 찾기
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window) {
    console.warn('[WatchParty] Window not found for sender')
    return
  }
  
  // 명령을 다시 renderer로 전달 (Vue 컴포넌트가 처리)
  window.webContents.send('watch-party:execute-command', command, data)
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

// ============================================================================
// 배경 이미지 관리
// ============================================================================

const BACKGROUNDS_DIR = path.join(app.getPath('userData'), 'backgrounds')

// 배경 디렉토리 초기화
function ensureBackgroundsDir(): void {
  if (!fs.existsSync(BACKGROUNDS_DIR)) {
    fs.mkdirSync(BACKGROUNDS_DIR, { recursive: true })
    console.log('Created backgrounds directory:', BACKGROUNDS_DIR)
  }
}

// 배경 이미지 파일 경로 가져오기
function getBackgroundPath(type: 'home' | 'chat' | 'notification'): string {
  return path.join(BACKGROUNDS_DIR, `${type}-background.png`)
}

// 자동 업데이트 - 수동 체크
ipcMain.handle('check-for-updates', async () => {
  if (!app.isPackaged) {
    return { available: false, message: '개발 모드에서는 업데이트를 확인할 수 없습니다.' }
  }
  
  try {
    autoUpdater.checkForUpdates()
    return { available: true, message: '업데이트를 확인 중입니다...' }
  } catch (error) {
    console.error('Update check failed:', error)
    return { available: false, message: '업데이트 확인 중 오류가 발생했습니다.' }
  }
})

ipcMain.handle('get-app-version', async () => {
  return app.getVersion()
})

// 배경 이미지 설정
ipcMain.handle('set-background-image', async (_event, type: 'home' | 'chat' | 'notification', imageData: ArrayBuffer): Promise<boolean> => {
  try {
    ensureBackgroundsDir()
    const filePath = getBackgroundPath(type)
    const buffer = Buffer.from(imageData)
    fs.writeFileSync(filePath, buffer)
    console.log(`[Background] Saved ${type} background:`, filePath)
    return true
  } catch (error) {
    console.error(`[Background] Failed to save ${type} background:`, error)
    return false
  }
})

// 배경 이미지 가져오기 (base64 data URL로 반환)
ipcMain.handle('get-background-image', async (_event, type: 'home' | 'chat' | 'notification'): Promise<string | null> => {
  try {
    const filePath = getBackgroundPath(type)
    if (!fs.existsSync(filePath)) {
      return null
    }
    const buffer = fs.readFileSync(filePath)
    const base64 = buffer.toString('base64')
    // MIME 타입 추정 (PNG로 저장하므로 PNG 사용)
    return `data:image/png;base64,${base64}`
  } catch (error) {
    console.error(`[Background] Failed to load ${type} background:`, error)
    return null
  }
})

// 배경 이미지 삭제
ipcMain.handle('remove-background-image', async (_event, type: 'home' | 'chat' | 'notification'): Promise<boolean> => {
  try {
    const filePath = getBackgroundPath(type)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
      console.log(`[Background] Removed ${type} background`)
    }
    return true
  } catch (error) {
    console.error(`[Background] Failed to remove ${type} background:`, error)
    return false
  }
})

// 배경 이미지 선택 다이얼로그
ipcMain.handle('select-background-image', async (): Promise<ArrayBuffer | null> => {
  try {
    const result = await dialog.showOpenDialog({
      title: '배경 이미지 선택',
      filters: [
        { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] }
      ],
      properties: ['openFile']
    })

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    const filePath = result.filePaths[0]
    if (!filePath) {
      return null
    }
    const buffer = fs.readFileSync(filePath)
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  } catch (error) {
    console.error('[Background] Failed to select image:', error)
    return null
  }
})

// ============================================================================
// 알림 소리 관리
// ============================================================================

const NOTIFICATION_SOUNDS_DIR = path.join(app.getPath('userData'), 'notification-sounds')
const NOTIFICATION_SETTINGS_FILE = path.join(app.getPath('userData'), 'notification-settings.json')
const LAST_OPENED_ROOMS_FILE = path.join(app.getPath('userData'), 'last-opened-rooms.json')
const STYLE_SETTINGS_FILE = path.join(app.getPath('userData'), 'style-settings.json')

// 스타일 설정 메모리 캐시 (로컬 서버 창들에서 사용)
let cachedStyleSettings: unknown = null

// ============================================================================
// 마지막 열린 채팅방 관리
// ============================================================================

/**
 * 마지막 열린 채팅방 목록 저장
 */
function saveLastOpenedRooms(): void {
  try {
    const openedRooms = Array.from(chatRoomWindows.keys())
    fs.writeFileSync(LAST_OPENED_ROOMS_FILE, JSON.stringify(openedRooms, null, 2), 'utf-8')
    console.log('[LastOpenedRooms] Saved:', openedRooms)
  } catch (error) {
    console.error('[LastOpenedRooms] Failed to save:', error)
  }
}

/**
 * 마지막 열린 채팅방 목록 불러오기
 */
function loadLastOpenedRooms(): string[] {
  try {
    if (fs.existsSync(LAST_OPENED_ROOMS_FILE)) {
      const data = fs.readFileSync(LAST_OPENED_ROOMS_FILE, 'utf-8')
      const rooms = JSON.parse(data) as string[]
      console.log('[LastOpenedRooms] Loaded:', rooms)
      return Array.isArray(rooms) ? rooms : []
    }
  } catch (error) {
    console.error('[LastOpenedRooms] Failed to load:', error)
  }
  return []
}

/**
 * 앱 시작 시 마지막 열린 채팅방 자동으로 열기
 */
function restoreLastOpenedRooms(): void {
  const lastRooms = loadLastOpenedRooms()
  if (lastRooms.length > 0) {
    console.log('[LastOpenedRooms] Restoring rooms:', lastRooms)
    // 약간의 지연을 두고 창들을 순차적으로 열기
    lastRooms.forEach((roomId, index) => {
      setTimeout(() => {
        createChatRoomWindow(roomId)
      }, index * 200) // 200ms 간격
    })
  }
}

// 알림 소리 디렉토리 초기화
function ensureNotificationSoundsDir(): void {
  if (!fs.existsSync(NOTIFICATION_SOUNDS_DIR)) {
    fs.mkdirSync(NOTIFICATION_SOUNDS_DIR, { recursive: true })
    console.log('Created notification sounds directory:', NOTIFICATION_SOUNDS_DIR)
  }
}

// 커스텀 알림 소리 파일 경로
function getNotificationSoundPath(): string {
  return path.join(NOTIFICATION_SOUNDS_DIR, 'custom-sound.mp3')
}

// 알림 소리 설정 로드
function loadNotificationSettings(): { volume: number; enabled: boolean } {
  try {
    if (fs.existsSync(NOTIFICATION_SETTINGS_FILE)) {
      const data = fs.readFileSync(NOTIFICATION_SETTINGS_FILE, 'utf8')
      return JSON.parse(data)
    }
  } catch (error) {
    console.error('[NotificationSound] Failed to load settings:', error)
  }
  return { volume: 0.5, enabled: true }
}

// 알림 소리 설정 저장
function saveNotificationSettings(settings: { volume?: number; enabled?: boolean }): void {
  try {
    const current = loadNotificationSettings()
    const updated = { ...current, ...settings }
    fs.writeFileSync(NOTIFICATION_SETTINGS_FILE, JSON.stringify(updated, null, 2))
    console.log('[NotificationSound] Settings saved:', updated)
  } catch (error) {
    console.error('[NotificationSound] Failed to save settings:', error)
  }
}

// 커스텀 알림 소리 설정
ipcMain.handle('set-notification-sound', async (_event, audioData: ArrayBuffer): Promise<boolean> => {
  try {
    ensureNotificationSoundsDir()
    const filePath = getNotificationSoundPath()
    const buffer = Buffer.from(audioData)
    fs.writeFileSync(filePath, buffer)
    console.log('[NotificationSound] Saved custom sound:', filePath)
    return true
  } catch (error) {
    console.error('[NotificationSound] Failed to save custom sound:', error)
    return false
  }
})

// 커스텀 알림 소리 가져오기 (base64 data URL로 반환)
ipcMain.handle('get-notification-sound', async (): Promise<string | null> => {
  try {
    const filePath = getNotificationSoundPath()
    if (!fs.existsSync(filePath)) {
      return null
    }
    const buffer = fs.readFileSync(filePath)
    const base64 = buffer.toString('base64')
    // MIME 타입을 audio/mpeg로 설정 (MP3)
    return `data:audio/mpeg;base64,${base64}`
  } catch (error) {
    console.error('[NotificationSound] Failed to load custom sound:', error)
    return null
  }
})

// 커스텀 알림 소리 삭제
ipcMain.handle('remove-notification-sound', async (): Promise<boolean> => {
  try {
    const filePath = getNotificationSoundPath()
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
      console.log('[NotificationSound] Removed custom sound')
    }
    return true
  } catch (error) {
    console.error('[NotificationSound] Failed to remove custom sound:', error)
    return false
  }
})

// 알림 소리 파일 선택 다이얼로그
ipcMain.handle('select-notification-sound', async (): Promise<ArrayBuffer | null> => {
  try {
    const result = await dialog.showOpenDialog({
      title: '알림 소리 선택',
      filters: [
        { name: 'Audio Files', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac'] }
      ],
      properties: ['openFile']
    })

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    const filePath = result.filePaths[0]
    if (!filePath) {
      return null
    }
    const buffer = fs.readFileSync(filePath)
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  } catch (error) {
    console.error('[NotificationSound] Failed to select sound:', error)
    return null
  }
})

// 음량 설정
ipcMain.handle('set-notification-volume', async (_event, volume: number): Promise<void> => {
  saveNotificationSettings({ volume })
})

// 음량 가져오기
ipcMain.handle('get-notification-volume', async (): Promise<number> => {
  const settings = loadNotificationSettings()
  return settings.volume
})

// 알림 활성화 설정
ipcMain.handle('set-notification-enabled', async (_event, enabled: boolean): Promise<void> => {
  saveNotificationSettings({ enabled })
})

// 알림 활성화 상태 가져오기
ipcMain.handle('get-notification-enabled', async (): Promise<boolean> => {
  const settings = loadNotificationSettings()
  return settings.enabled
})

// ============================================================================
// 스타일 설정 관리 (로컬 서버 창에서 사용 - WatchParty 등)
// ============================================================================

// 스타일 설정 로드
function loadStyleSettings(): unknown {
  try {
    if (fs.existsSync(STYLE_SETTINGS_FILE)) {
      const data = fs.readFileSync(STYLE_SETTINGS_FILE, 'utf8')
      cachedStyleSettings = JSON.parse(data)
      console.log('[StyleSettings] Loaded from file')
      return cachedStyleSettings
    }
  } catch (error) {
    console.error('[StyleSettings] Failed to load settings:', error)
  }
  return null
}

// 스타일 설정 저장
function saveStyleSettings(settings: unknown): boolean {
  try {
    fs.writeFileSync(STYLE_SETTINGS_FILE, JSON.stringify(settings, null, 2))
    cachedStyleSettings = settings
    console.log('[StyleSettings] Settings saved')
    
    // 모든 창에 설정 변경 알림
    const allWindows = BrowserWindow.getAllWindows()
    allWindows.forEach((window) => {
      if (!window.isDestroyed()) {
        window.webContents.send('style-settings-changed', settings)
      }
    })
    
    return true
  } catch (error) {
    console.error('[StyleSettings] Failed to save settings:', error)
    return false
  }
}

// 스타일 설정 저장 IPC
ipcMain.handle('set-style-settings', async (_event, settings: unknown): Promise<boolean> => {
  return saveStyleSettings(settings)
})

// 스타일 설정 로드 IPC
ipcMain.handle('get-style-settings', async (): Promise<unknown | null> => {
  // 캐시가 있으면 사용, 없으면 파일에서 로드
  if (cachedStyleSettings) {
    return cachedStyleSettings
  }
  return loadStyleSettings()
})

// 배경 이미지 변경 알림 IPC
ipcMain.on('notify-background-changed', (_event, bgType: string) => {
  console.log('[BackgroundChanged] Notifying all windows about background change:', bgType)
  // 모든 창에 배경 변경 알림
  const allWindows = BrowserWindow.getAllWindows()
  allWindows.forEach((window) => {
    if (!window.isDestroyed()) {
      window.webContents.send('background-changed', bgType)
    }
  })
})
