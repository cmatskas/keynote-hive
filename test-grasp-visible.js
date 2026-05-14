// Full SSO flow test — handles the JSON bootstrap response.
// Run with:  npx electron test-grasp-visible.js
const { app, BrowserWindow, session } = require('electron');

const MAIL = 'https://midway-api.us-east-2.prod.mail.grasp.amazon.dev';

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 800 });

  win.webContents.on('did-navigate', (_, url) => console.log('[nav]', url));
  win.webContents.on('did-redirect-navigation', (_, url) => console.log('[redir]', url));

  // Step 1 — hit /sso/login, get JSON bootstrap
  await win.loadURL(`${MAIL}/sso/login`);

  // Read the JSON response from the page
  const bodyText = await win.webContents.executeJavaScript('document.body.innerText');
  console.log('[step 1 body]', bodyText.slice(0, 200));

  let authnEndpoint = null;
  try {
    const json = JSON.parse(bodyText);
    if (json.is_authenticated) {
      console.log('[step 1] Already authenticated');
    } else {
      authnEndpoint = json.authn_endpoint;
      console.log('[step 1] Not authenticated, following authn_endpoint');
    }
  } catch {
    console.log('[step 1] Response was not JSON');
  }

  // Step 2 — navigate to authn_endpoint (this triggers Midway SSO)
  if (authnEndpoint) {
    console.log('[step 2] Loading authn_endpoint...');
    await win.loadURL(authnEndpoint);
    // Wait a moment for any redirect chain to complete
    await new Promise(r => setTimeout(r, 3000));
    console.log('[step 2] Final URL:', win.webContents.getURL());
    const body2 = await win.webContents.executeJavaScript('document.body.innerText').catch(() => '');
    console.log('[step 2 body]', body2.slice(0, 300));
  }

  // Step 3 — check cookies
  const graspCookies = await session.defaultSession.cookies.get({ url: MAIL });
  console.log(`\n[FINAL] GRASP cookies (${graspCookies.length}):`);
  for (const c of graspCookies) {
    console.log(`  - ${c.name} = ${c.value.slice(0, 30)}...`);
  }

  const hasToken = graspCookies.some(c => c.name === 'amzn_sso_token');
  const hasRfp = graspCookies.some(c => c.name === 'amzn_sso_rfp');
  if (hasToken && hasRfp) {
    console.log('\n✅ SUCCESS — both cookies present, ready to build integration');
  } else {
    console.log(`\n⚠️  Missing: token=${hasToken} rfp=${hasRfp}`);
  }
});

app.on('window-all-closed', () => app.quit());
