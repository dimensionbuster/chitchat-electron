// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

console.log('===== PRELOAD SCRIPT STARTED =====');

import { contextBridge, ipcRenderer } from 'electron'

console.log('Preload: Imports loaded');

declare global {
    interface Window {
        electronApi: ContextBridgeApi;
    }
}

export type ContextBridgeApi = {
    newChatMessage: (payload: { authorName: string; text: string }) => void,
    createNotification: (authorName: string, text: string, messageId: string, roomId: string) => void,
    closeNotification: (id: string) => void,
    clickNotification: (roomId: string, userName?: string) => void,
    sendLogMessage: (level: 'info' | 'warn' | 'error', message: string) => void,
    windowMinimize: () => void,
    windowMaximize: () => void,
    windowClose: () => void,
    openChatRoom: (roomId: string, userName?: string) => void,
    showMainWindow: () => void,
    openExternal: (url: string) => void,
    // 커스텀 다이얼로그 API
    showDialog: (message: string) => Promise<void>,
    showConfirm: (message: string) => Promise<boolean>,
    closeDialog: (dialogId: string, result: boolean) => void,
    resizeAndShowDialog: (dialogId: string, width: number, height: number) => void,
    // 배경 이미지 API
    setBackgroundImage: (type: 'home' | 'chat' | 'notification', imageData: ArrayBuffer) => Promise<boolean>,
    getBackgroundImage: (type: 'home' | 'chat' | 'notification') => Promise<string | null>,
    removeBackgroundImage: (type: 'home' | 'chat' | 'notification') => Promise<boolean>,
    selectBackgroundImage: () => Promise<ArrayBuffer | null>,
    // 설정 창 API
    openSettings: () => void,
}

const exposedApi: ContextBridgeApi = {
    newChatMessage: (payload: { authorName: string; text: string }) => ipcRenderer.send(
        'new-chat-message',
        payload.authorName,
        payload.text
    ),
    createNotification: (authorName: string, text: string, messageId: string, roomId: string) => ipcRenderer.send(
        'create-notification',
        authorName,
        text,
        messageId,
        roomId
    ),
    closeNotification: (id:string) => ipcRenderer.send(
        'close-notification',
        id
    ),
    sendLogMessage: (level: 'info' | 'warn' | 'error', message: string) => ipcRenderer.send(
        'log-message',
        { level, message }
    ),
    windowMinimize: () => {
        console.log('windowMinimize called');
        ipcRenderer.send('window-minimize');
    },
    windowMaximize: () => {
        console.log('windowMaximize called');
        ipcRenderer.send('window-maximize');
    },
    windowClose: () => {
        console.log('windowClose called');
        ipcRenderer.send('window-close');
    },
    clickNotification: (roomId: string, userName?: string) => {
        console.log('clickNotification called with roomId:', roomId, 'userName:', userName);
        ipcRenderer.send('click-notification', roomId, userName);
    },
    openChatRoom: (roomId: string, userName?: string) => {
        console.log('openChatRoom called with roomId:', roomId, 'userName:', userName);
        ipcRenderer.send('open-chat-room', roomId, userName);
    },
    showMainWindow: () => {
        console.log('showMainWindow called');
        ipcRenderer.send('show-main-window');
    },
    openExternal: (url: string) => {
        console.log('openExternal called with url:', url);
        ipcRenderer.send('open-external', url);
    },
    // 커스텀 다이얼로그 API
    showDialog: (message: string): Promise<void> => {
        console.log('showDialog called:', message);
        return ipcRenderer.invoke('show-dialog', message);
    },
    showConfirm: (message: string): Promise<boolean> => {
        console.log('showConfirm called:', message);
        return ipcRenderer.invoke('show-confirm', message);
    },
    closeDialog: (dialogId: string, result: boolean) => {
        console.log('closeDialog called:', dialogId, result);
        ipcRenderer.send('close-dialog', dialogId, result);
    },
    resizeAndShowDialog: (dialogId: string, width: number, height: number) => {
        console.log('resizeAndShowDialog called:', dialogId, width, height);
        ipcRenderer.send('resize-and-show-dialog', dialogId, width, height);
    },
    // 배경 이미지 API
    setBackgroundImage: (type: 'home' | 'chat' | 'notification', imageData: ArrayBuffer): Promise<boolean> => {
        console.log('setBackgroundImage called:', type);
        return ipcRenderer.invoke('set-background-image', type, imageData);
    },
    getBackgroundImage: (type: 'home' | 'chat' | 'notification'): Promise<string | null> => {
        console.log('getBackgroundImage called:', type);
        return ipcRenderer.invoke('get-background-image', type);
    },
    removeBackgroundImage: (type: 'home' | 'chat' | 'notification'): Promise<boolean> => {
        console.log('removeBackgroundImage called:', type);
        return ipcRenderer.invoke('remove-background-image', type);
    },
    selectBackgroundImage: (): Promise<ArrayBuffer | null> => {
        console.log('selectBackgroundImage called');
        return ipcRenderer.invoke('select-background-image');
    },
    // 설정 창 API
    openSettings: () => {
        console.log('openSettings called');
        ipcRenderer.send('open-settings');
    }
}

// Expose API first
console.log('Preload: Exposing electronApi to mainWorld');
contextBridge.exposeInMainWorld('electronApi', exposedApi)
console.log('Preload: electronApi exposed');

// ALSO expose individual functions directly on window to prevent loss
contextBridge.exposeInMainWorld('__electronWindowMinimize', exposedApi.windowMinimize);
contextBridge.exposeInMainWorld('__electronWindowMaximize', exposedApi.windowMaximize);
contextBridge.exposeInMainWorld('__electronWindowClose', exposedApi.windowClose);

console.log('Preload: Individual functions exposed as backup');

// Inject titlebar when DOM is ready
window.addEventListener('DOMContentLoaded', () => {
    console.log('DOMContentLoaded - protecting electronApi');
    
    const win = window as Window & typeof globalThis & {
      __electronWindowMinimize?: () => void;
      __electronWindowMaximize?: () => void;
      __electronWindowClose?: () => void;
    };
    console.log('electronApi status:', {
        electronApi: !!win.electronApi,
        electronApiKeys: win.electronApi ? Object.keys(win.electronApi) : [],
        backupMinimize: !!win.__electronWindowMinimize,
        backupMaximize: !!win.__electronWindowMaximize,
        backupClose: !!win.__electronWindowClose,
        allWindowKeys: Object.keys(win).filter((k: string) => k.includes('electron'))
    });
    
    // Inject titlebar directly - don't rely on external function
    setTimeout(() => {
        // 알림창이나 다이얼로그 창인지 확인
        const isNotificationWindow = window.location.hash.includes('/notification');
        const isDialogWindow = window.location.hash.includes('/dialog');
        
        if (isNotificationWindow || isDialogWindow) {
            console.log('Notification or Dialog window detected - skipping titlebar injection');
            return;
        }
        
        console.log('Injecting titlebar directly in preload');
        
        // Inject CSS
        const style = document.createElement('style');
        style.id = 'electron-titlebar-styles';
        style.textContent = `
            #electron-custom-titlebar {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                height: 32px;
                background: #2f3241;
                color: #fff;
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 0;
                z-index: 999999;
                user-select: none;
                box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
            }
            
            #electron-custom-titlebar .titlebar-drag-area {
                flex: 1;
                display: flex;
                align-items: center;
                height: 100%;
                padding-left: 12px;
                -webkit-app-region: drag;
            }
            
            #electron-custom-titlebar .titlebar-title {
                font-size: 13px;
                font-weight: 500;
            }
            
            #electron-custom-titlebar .titlebar-controls {
                display: flex;
                height: 100%;
                -webkit-app-region: no-drag;
            }
            
            #electron-custom-titlebar .titlebar-button {
                width: 46px;
                height: 32px;
                border: none;
                background: transparent;
                color: #fff;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: background-color 0.15s ease;
                padding: 0;
            }
            
            #electron-custom-titlebar .titlebar-button:hover {
                background: rgba(255, 255, 255, 0.1);
            }
            
            #electron-custom-titlebar .titlebar-button.close:hover {
                background: #e81123;
            }
            
            body {
                padding-top: 32px !important;
            }
        `;
        document.head.appendChild(style);

        // Create titlebar HTML
        const titlebar = document.createElement('div');
        titlebar.id = 'electron-custom-titlebar';
        titlebar.innerHTML = `
            <div class="titlebar-drag-area">
                <span class="titlebar-title">ChitChat</span>
            </div>
            <div class="titlebar-controls">
                <button class="titlebar-button minimize" type="button" title="최소화">
                    <svg width="12" height="12" viewBox="0 0 12 12">
                        <rect y="5" width="12" height="1" fill="currentColor" />
                    </svg>
                </button>
                <button class="titlebar-button maximize" type="button" title="최대화">
                    <svg width="12" height="12" viewBox="0 0 12 12">
                        <rect x="1" y="1" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1" />
                    </svg>
                </button>
                <button class="titlebar-button close" type="button" title="닫기">
                    <svg width="12" height="12" viewBox="0 0 12 12">
                        <path d="M1 1L11 11M11 1L1 11" stroke="currentColor" stroke-width="1" />
                    </svg>
                </button>
            </div>
        `;

        // Insert titlebar
        if (document.body) {
            document.body.insertBefore(titlebar, document.body.firstChild);
            
            // Attach event listeners using IPC directly
            const minimizeBtn = titlebar.querySelector('.minimize');
            const maximizeBtn = titlebar.querySelector('.maximize');
            const closeBtn = titlebar.querySelector('.close');

            if (minimizeBtn) {
                minimizeBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    console.log('Minimize clicked - sending IPC');
                    ipcRenderer.send('window-minimize');
                }, true);
            }

            if (maximizeBtn) {
                maximizeBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    console.log('Maximize clicked - sending IPC');
                    ipcRenderer.send('window-maximize');
                }, true);
            }

            if (closeBtn) {
                closeBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    console.log('Close clicked - sending IPC');
                    ipcRenderer.send('window-close');
                }, true);
            }
            
            console.log('Titlebar injected and event listeners attached!');
        }
    }, 50);
});