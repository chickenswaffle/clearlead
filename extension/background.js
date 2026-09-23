async function enableApplicationCopilot() {
  try { await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); }
  catch { /* Older Chromium builds keep the extension installed but cannot open the persistent panel. */ }
}

chrome.runtime.onInstalled.addListener(enableApplicationCopilot);
chrome.runtime.onStartup.addListener(enableApplicationCopilot);
enableApplicationCopilot();
