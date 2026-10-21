// X Takip Denetimi — arka plan servis çalışanı
// Görevi yalnızca: içerik betiğinden gelen istatistik mesajlarını alıp
// simge rozetine (badge) yazmak. Olay bazlı çalışır, sürekli RAM tutmaz.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'xfl.stats' && sender.tab && sender.tab.tabId != null) {
    const count = Number(msg.count) || 0;
    // Rozet en fazla 4 karakter gösterir; 9999 üstünü kısalt
    const text = count > 0 ? (count > 999 ? '999+' : String(count)) : '';
    try {
      chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.tabId, color: '#f4212e' });
      chrome.action.setBadgeTextColor({ tabId: sender.tab.tabId, color: '#ffffff' });
      chrome.action.setBadgeText({ tabId: sender.tab.tabId, text });
    } catch (e) {
      // Sekke kapanmış olabilir — sessiz geç
    }
  }
  sendResponse && sendResponse({ ok: true });
});
