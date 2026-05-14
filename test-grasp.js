// Minimal end-to-end GRASP auth test.
// Run with:  npx electron test-grasp.js
// Uses Electron's session/cookie machinery the same way Transcribely will.

const { app, BrowserWindow, session } = require('electron');
const log = (...a) => console.log('[grasp-test]', ...a);

const MAIL = 'https://midway-api.us-east-2.prod.mail.grasp.amazon.dev';

app.whenReady().then(async () => {
  // 1) Create a hidden window so Electron initializes its default session
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false } });
  const sess = session.defaultSession;

  // 2) Load ~/.midway/cookie into Electron's cookie jar for midway-auth.amazon.com
  // Electron's session won't automatically read ~/.midway/cookie, so we seed it.
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const cookiePath = path.join(os.homedir(), '.midway', 'cookie');
  if (!fs.existsSync(cookiePath)) {
    log('❌ No ~/.midway/cookie — run mwinit first');
    app.quit();
    return;
  }
  const cookieText = fs.readFileSync(cookiePath, 'utf8');
  let seeded = 0;
  for (const line of cookieText.split('\n')) {
    if (!line || line.startsWith('#') && !line.startsWith('#HttpOnly_')) continue;
    const clean = line.replace(/^#HttpOnly_/, '');
    const parts = clean.split('\t');
    if (parts.length < 7) continue;
    const [domain, , pathv, secure, expires, name, value] = parts;
    try {
      await sess.cookies.set({
        url: `https://${domain.replace(/^\./, '')}${pathv}`,
        domain,
        path: pathv,
        secure: secure === 'TRUE',
        httpOnly: line.startsWith('#HttpOnly_'),
        expirationDate: parseInt(expires, 10) || undefined,
        name,
        value,
      });
      seeded++;
    } catch (e) { /* ignore malformed */ }
  }
  log(`Seeded ${seeded} cookies from ~/.midway/cookie`);

  // 3) Try SSO login — follow redirects, let Electron handle cookies
  try {
    await win.loadURL(`${MAIL}/sso/login`);
    log('Final URL after SSO:', win.webContents.getURL());

    // 4) Inspect what cookies we now have on the GRASP domain
    const graspCookies = await sess.cookies.get({
      url: MAIL,
    });
    log(`GRASP-domain cookies: ${graspCookies.length}`);
    for (const c of graspCookies) {
      log(`  - ${c.name} = ${c.value.slice(0, 20)}... (httpOnly=${c.httpOnly})`);
    }

    const hasToken = graspCookies.some(c => c.name === 'amzn_sso_token');
    const hasRfp = graspCookies.some(c => c.name === 'amzn_sso_rfp');

    if (hasToken && hasRfp) {
      log('✅ SUCCESS — both amzn_sso_token and amzn_sso_rfp present. Auth chain works.');
    } else {
      log('⚠️  Missing cookies:');
      if (!hasToken) log('   - amzn_sso_token NOT set');
      if (!hasRfp) log('   - amzn_sso_rfp NOT set');
    }
  } catch (e) {
    log('❌ loadURL failed:', e.message);
  }

  app.quit();
});
