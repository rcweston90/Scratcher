// Scratcher service worker: opens the side panel from the toolbar, the
// shortcut and the right-click menu, and keeps pads in step with Chrome sync.

importScripts('sync.js');

const INBOX_KEY = 'inbox';
const MENU_ID = 'send-to-scratcher';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

// Sync: the panel only touches local storage; this mirrors it to
// chrome.storage.sync, which the browser syncs to the user's other computers.
const syncEngine = ScratcherSync.createEngine({ local: chrome.storage.local, sync: chrome.storage.sync });
chrome.storage.onChanged.addListener((changes, area) => syncEngine.onChanged(changes, area));
chrome.runtime.onStartup.addListener(() => syncEngine.schedule(1000));
syncEngine.schedule(1500); // catch up on anything missed while asleep

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Send to Scratcher',
    contexts: ['selection'],
  });
});

// Open panels register here so the shortcut can close them again.
const openPanels = new Map(); // windowId -> port

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel') return;
  port.onMessage.addListener((msg) => {
    if (msg?.windowId != null) openPanels.set(msg.windowId, port);
  });
  port.onDisconnect.addListener(() => {
    for (const [id, p] of openPanels) if (p === port) openPanels.delete(id);
  });
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'toggle-panel' || !tab) return;
  const port = openPanels.get(tab.windowId);
  if (port) {
    port.postMessage({ type: 'close' });
  } else {
    // Must run straight away, while the key press still counts as a user gesture.
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.selectionText || !tab) return;
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);
  // The panel picks text up from the inbox, so nothing is lost if it isn't open yet.
  chrome.storage.local.get(INBOX_KEY).then((r) => {
    const inbox = Array.isArray(r[INBOX_KEY]) ? r[INBOX_KEY] : [];
    inbox.push({ text: info.selectionText, windowId: tab.windowId, at: Date.now() });
    return chrome.storage.local.set({ [INBOX_KEY]: inbox });
  }).catch(console.error);
});
