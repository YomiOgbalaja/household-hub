/* Install as an app: a one-tap Install button where the browser offers one (Chrome, Edge, Android),
   and short steps where it does not (iPhone and iPad Safari, Mac Safari). Hidden once installed. */
(function () {
  let deferred = null;
  const KEY = 'hfh:install:dismissed';
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const macSafari = /Macintosh/.test(ua) && /Safari/.test(ua) && !/Chrome|Chromium|Edg|Firefox/.test(ua) && !ios;
  const dismissed = () => { try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; } };

  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; if (typeof render === 'function') render(); });
  window.addEventListener('appinstalled', () => { deferred = null; toast('Installed. Open Household Hub from your home screen or apps.'); render(); });

  function how() {
    if (deferred) return { btn: true, text: 'Add Household Hub to your home screen or apps. It opens in its own window, works offline, and updates itself.' };
    if (ios) return { text: 'In Safari, tap the Share button, then <b>Add to Home Screen</b>, then <b>Add</b>. It opens like an app, works offline, and updates itself.' };
    if (macSafari) return { text: 'In Safari, choose <b>File</b>, then <b>Add to Dock</b>. It opens in its own window and works offline.' };
    return { text: 'In Chrome or Edge, use the install icon at the right of the address bar, or the menu, then <b>Install Household Hub</b>. On Android, open the menu, then <b>Add to Home screen</b>.' };
  }
  function block(withClose) {
    const h = how();
    return `<div class="notice" id="install-card" style="margin-bottom:16px"><div style="flex:1"><div><b>Install the app</b></div><div class="small" style="margin-top:4px">${h.text}</div>
      ${h.btn ? '<div class="row" style="margin-top:10px"><button class="btn primary sm" data-action="install-app">Install</button></div>' : ''}</div>
      ${withClose ? '<button class="btn sm" data-action="install-later" aria-label="Hide">Not now</button>' : ''}</div>`;
  }

  const baseHome4 = VIEWS.home;
  VIEWS.home = () => {
    const html = baseHome4();
    if (standalone() || dismissed()) return html;
    const i = html.indexOf('</div>', html.indexOf('<div class="head">')) ;
    const j = html.indexOf('</div></div>', html.indexOf('<div class="head">'));
    const at = j >= 0 ? j + 12 : (i >= 0 ? i + 6 : 0);
    return html.slice(0, at) + block(true) + html.slice(at);
  };
  const baseSettings4 = VIEWS.settings;
  VIEWS.settings = () => {
    const html = baseSettings4();
    if (standalone()) return html;
    const k = html.indexOf('<div class="card" id="sync-card"');
    return k >= 0 ? html.slice(0, k) + block(false) + html.slice(k) : html + block(false);
  };

  document.addEventListener('click', e => {
    const a = e.target.closest('[data-action]'); if (!a) return;
    if (a.dataset.action === 'install-app' && deferred) { deferred.prompt(); deferred.userChoice.finally(() => { deferred = null; render(); }); }
    if (a.dataset.action === 'install-later') { try { localStorage.setItem(KEY, '1'); } catch (err) { /* fine */ } render(); toast('You can install it any time from Settings & data.'); }
  });
  if (typeof route !== 'undefined' && (route === 'home' || route === 'settings')) render();
})();
