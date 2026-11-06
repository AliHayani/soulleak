// Gaming mini-player: a small borderless, transparent, always-on-top window, hidden until the shortcut toggles it.
// It shows without taking focus (so the game keeps keyboard input) and snaps to the nearest screen corner.
const { BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');
const { readStartupConfig, writeStartupConfig } = require('../shared/platform');

const OVERLAY_SHORTCUT = 'Control+Alt+I';
const SIZE = { width: 460, height: 76 };
const MARGIN = 18;
const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

function createOverlay(getMainWindow) {
  let win = null;
  let lastState = null;
  let corner = CORNERS.includes(readStartupConfig().overlayCorner) ? readStartupConfig().overlayCorner : 'top-right';
  let placing = false;

  function boundsFor(which, area) {
    const x = which.endsWith('left') ? area.x + MARGIN : area.x + area.width - SIZE.width - MARGIN;
    const y = which.startsWith('top') ? area.y + MARGIN : area.y + area.height - SIZE.height - MARGIN;
    return { x: Math.round(x), y: Math.round(y), width: SIZE.width, height: SIZE.height };
  }

  function place(area) {
    if (!win) return;
    placing = true;
    win.setBounds(boundsFor(corner, area));
    setTimeout(() => { placing = false; }, 150);
  }

  // After a drag, jump to whichever corner of that screen is closest.
  function snapToNearestCorner() {
    if (!win || placing) return;
    const b = win.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    corner = `${cy < area.y + area.height / 2 ? 'top' : 'bottom'}-${cx < area.x + area.width / 2 ? 'left' : 'right'}`;
    writeStartupConfig({ overlayCorner: corner });
    place(area);
  }

  function notifyMain(visible) {
    const main = getMainWindow();
    if (main && !main.isDestroyed()) main.webContents.send('overlay-visibility', visible);
  }

  function build() {
    win = new BrowserWindow({
      ...SIZE,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      backgroundColor: '#00000000',
      title: 'Soulleak mini-player',
      webPreferences: {
        preload: path.join(__dirname, 'overlay-preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    // Highest window level, so it stays above borderless/windowed-fullscreen games.
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.loadFile(path.join(__dirname, '../renderer/overlay.html'));
    win.webContents.on('did-finish-load', () => {
      if (lastState) win.webContents.send('overlay-state', lastState);
    });
    win.on('closed', () => { win = null; notifyMain(false); });
  }

  // Many borderless games make their own window top-most too, and Windows puts the last-activated top-most window
  // first, so each time the game takes focus it covers the mini-player. While it's showing, put it back on top
  // twice a second. This never takes focus, so the game keeps the keyboard.
  let keepOnTop = null;
  function stayOnTop(on) {
    clearInterval(keepOnTop);
    keepOnTop = null;
    if (!on) return;
    keepOnTop = setInterval(() => {
      if (!win || win.isDestroyed() || !win.isVisible()) { clearInterval(keepOnTop); keepOnTop = null; return; }
      win.setAlwaysOnTop(true, 'screen-saver', 1);
      win.moveTop();
    }, 500);
  }

  function toggle() {
    if (!win) build();
    if (win.isVisible()) {
      stayOnTop(false);
      win.hide();
      notifyMain(false);
      return;
    }
    // Open on the screen the cursor is on, which is usually where the game is.
    place(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea);
    win.showInactive();
    win.setAlwaysOnTop(true, 'screen-saver', 1);
    win.moveTop();
    stayOnTop(true);
    notifyMain(true);
  }

  // Dragging is done here rather than with a CSS drag region: the window follows the cursor
  // from grip-press to release, then snaps to the nearest corner.
  let dragTimer = null;
  ipcMain.on('overlay-drag-start', () => {
    if (!win) return;
    const b = win.getBounds();
    const p = screen.getCursorScreenPoint();
    const offset = { x: p.x - b.x, y: p.y - b.y };
    clearInterval(dragTimer);
    dragTimer = setInterval(() => {
      if (!win || win.isDestroyed()) return clearInterval(dragTimer);
      const c = screen.getCursorScreenPoint();
      placing = true;
      win.setBounds({ x: c.x - offset.x, y: c.y - offset.y, width: SIZE.width, height: SIZE.height });
    }, 16);
  });
  ipcMain.on('overlay-drag-end', () => {
    clearInterval(dragTimer);
    dragTimer = null;
    placing = false;
    snapToNearestCorner();
  });

  ipcMain.on('overlay-toggle', toggle);
  ipcMain.on('overlay-state', (e, state) => {
    lastState = state;
    if (win && !win.isDestroyed()) win.webContents.send('overlay-state', state);
  });
  ipcMain.on('overlay-command', (e, action, value) => {
    const main = getMainWindow();
    if (main && !main.isDestroyed()) main.webContents.send('media-control', action, value);
  });

  if (!globalShortcut.register(OVERLAY_SHORTCUT, toggle)) {
    console.warn('[overlay] could not register', OVERLAY_SHORTCUT);
  }

  return {
    toggle,
    destroy() {
      stayOnTop(false);
      try { globalShortcut.unregister(OVERLAY_SHORTCUT); } catch (_) {}
      if (win && !win.isDestroyed()) win.destroy();
    }
  };
}

module.exports = { createOverlay, OVERLAY_SHORTCUT };
