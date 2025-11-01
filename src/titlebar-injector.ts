/**
 * Titlebar injector for Electron
 * Injects a custom titlebar into the page without modifying the source code
 */

export function injectCustomTitlebar() {
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
        
        #app {
            margin-top: 0 !important;
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

    // Wait for body to be available and insert titlebar
    const insertTitlebar = () => {
        if (document.body) {
            document.body.insertBefore(titlebar, document.body.firstChild);
            attachEventListeners(titlebar);
        } else {
            setTimeout(insertTitlebar, 10);
        }
    };

    insertTitlebar();
}

function attachEventListeners(titlebar: HTMLElement) {
    const minimizeBtn = titlebar.querySelector('.minimize');
    const maximizeBtn = titlebar.querySelector('.maximize');
    const closeBtn = titlebar.querySelector('.close');

    // Helper function to safely call electron functions
    const callElectronFunction = (funcName: string, backupName: string) => {
        const win = window as any;
        
        // Try primary API first
        if (win.electronApi && typeof win.electronApi[funcName] === 'function') {
            console.log(`Calling electronApi.${funcName}`);
            win.electronApi[funcName]();
            return true;
        }
        
        // Fall back to backup function
        if (typeof win[backupName] === 'function') {
            console.log(`Calling backup ${backupName}`);
            win[backupName]();
            return true;
        }
        
        console.error(`Neither electronApi.${funcName} nor ${backupName} available`);
        return false;
    };

    if (minimizeBtn) {
        minimizeBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('Minimize button clicked');
            callElectronFunction('windowMinimize', '__electronWindowMinimize');
        }, true);
    }

    if (maximizeBtn) {
        maximizeBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('Maximize button clicked');
            callElectronFunction('windowMaximize', '__electronWindowMaximize');
        }, true);
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('Close button clicked');
            callElectronFunction('windowClose', '__electronWindowClose');
        }, true);
    }
}
