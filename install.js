/* AlatiphA SchoolHub — PWA installation helper */
(function () {
  const DISMISS_KEY = 'schoolhub_install_dismissed_until';
  const DISMISS_DAYS = 14;
  let deferredPrompt = null;
  let banner = null;
  let installed = false;
  const isStandalone = () => installed || window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

  const isDismissed = () => Number(localStorage.getItem(DISMISS_KEY) || 0) > Date.now();
  const dismiss = () => localStorage.setItem(DISMISS_KEY, String(Date.now() + DISMISS_DAYS * 86400000));
  const removeBanner = () => {
    if (!banner) return;
    banner.classList.remove('schoolhub-install-show');
    setTimeout(() => { if (banner) banner.remove(); banner = null; }, 250);
  };

  const injectStyles = () => {
    const style = document.createElement('style');
    style.textContent = `
      .schoolhub-install-banner{position:fixed;z-index:1100;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 20px);transform:translate(-50%,140%);width:min(440px,calc(100vw - 28px));display:flex;align-items:center;gap:12px;padding:13px 14px;border:1px solid var(--rule,#ddd3bd);border-radius:14px;background:var(--surface,#fffdf7);color:var(--paper,#16241c);box-shadow:0 12px 34px rgba(0,0,0,.22);font-family:"IBM Plex Sans",Arial,sans-serif;transition:transform .25s ease}.schoolhub-install-banner.schoolhub-install-show{transform:translate(-50%,0)}.schoolhub-install-icon{width:42px;height:42px;flex:none}.schoolhub-install-copy{min-width:0;flex:1}.schoolhub-install-copy strong{display:block;font-size:14px}.schoolhub-install-copy span{display:block;margin-top:2px;color:var(--muted,#627168);font-size:12px;line-height:1.35}.schoolhub-install-actions{display:flex;gap:6px;align-items:center}.schoolhub-install-actions button{border:0;border-radius:7px;padding:8px 11px;font:600 12px "IBM Plex Sans",Arial,sans-serif;cursor:pointer}.schoolhub-install-confirm{background:var(--gold,#a67d12);color:var(--ink,#16241c)}.schoolhub-install-dismiss{background:transparent;color:var(--muted,#627168);font-size:18px!important;padding:6px 8px!important}.schoolhub-ios{display:block;text-align:left}.schoolhub-ios .schoolhub-install-actions{align-self:flex-start}@media(max-width:480px){.schoolhub-install-banner{align-items:flex-start}.schoolhub-install-actions{flex-direction:column-reverse}.schoolhub-install-dismiss{align-self:flex-end}}
    `;
    document.head.appendChild(style);
  };

  const showBanner = (manual = false) => {
    if (banner || isStandalone() || (!manual && isDismissed())) return;
    banner = document.createElement('aside');
    banner.className = 'schoolhub-install-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Install SchoolHub');
    const iosCopy = isIOS
      ? '<strong>Install SchoolHub</strong><span>In Safari, tap Share, then choose Add to Home Screen.</span>'
      : '<strong>Install SchoolHub</strong><span>Add it to this device for faster access and offline use.</span>';
    banner.innerHTML = `<img class="schoolhub-install-icon" src="icon-192.png" alt=""><div class="schoolhub-install-copy">${iosCopy}</div><div class="schoolhub-install-actions"><button class="schoolhub-install-confirm" type="button">${isIOS ? 'Got it' : 'Install'}</button><button class="schoolhub-install-dismiss" type="button" aria-label="Dismiss">×</button></div>`;
    document.body.appendChild(banner);
    requestAnimationFrame(() => banner && banner.classList.add('schoolhub-install-show'));
    banner.querySelector('.schoolhub-install-dismiss').addEventListener('click', () => { dismiss(); removeBanner(); });
    banner.querySelector('.schoolhub-install-confirm').addEventListener('click', async () => {
      if (isIOS) { dismiss(); removeBanner(); return; }
      if (!deferredPrompt) return;
      await requestInstall();
    });
  };

  const requestInstall = async () => {
    const prompt = deferredPrompt;
    if (!prompt) return;
    deferredPrompt = null;
    removeBanner();
    try {
      await prompt.prompt();
      await prompt.userChoice;
    } catch (e) {
      alert('The install prompt could not open. Use your browser menu to install SchoolHub, or refresh and try again.');
    }
  };

  window.SchoolHubInstall = {
    prompt() {
      if (isStandalone()) {
        alert('SchoolHub is already installed and running as an app on this device.');
        return;
      }
      if (!isIOS && !deferredPrompt) {
        alert('Use your browser menu to look for Install SchoolHub, Install app, or Add to Home Screen. If SchoolHub is already installed, open it from your apps. If no install option appears, open this page in Chrome or Edge.');
        return;
      }
      if (deferredPrompt) return requestInstall();
      showBanner(true);
    },
    available() { return !isStandalone() && (!!deferredPrompt || isIOS); }
  };

  injectStyles();
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredPrompt = event;
    if (!isDismissed()) setTimeout(showBanner, 2500);
  });
  window.addEventListener('appinstalled', () => { installed = true; deferredPrompt = null; removeBanner(); });
  if (isIOS && !isStandalone() && !isDismissed()) setTimeout(showBanner, 2500);
})();
