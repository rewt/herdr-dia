// Open the panel on toolbar click: side panel where supported, a tab otherwise.
chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (chrome.sidePanel?.open) {
    try { await chrome.sidePanel.open({ windowId: tab.windowId }); return; } catch {}
  }
  chrome.tabs.create({ url: chrome.runtime.getURL('panel.html') });
});
