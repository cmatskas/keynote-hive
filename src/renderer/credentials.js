function showSuccessToast(message) {
    Toastify({ text: message, duration: 3000, gravity: 'top', position: 'right', className: 'toast-success' }).showToast();
}

function showErrorToast(message) {
    Toastify({ text: message, duration: 6000, gravity: 'top', position: 'right', className: 'toast-error' }).showToast();
}

document.addEventListener('DOMContentLoaded', async () => {
    if (window.themeManager) await window.themeManager.initializeFromSettings();

    // Pre-fill if credentials already exist
    try {
        const credentials = await window.electronAPI.invoke('load-credentials');
        if (credentials) {
            document.getElementById('accessKeyId').value    = credentials.accessKeyId || '';
            document.getElementById('secretAccessKey').value = credentials.secretAccessKey || '';
            document.getElementById('region').value          = credentials.region || 'us-east-1';
            document.getElementById('sessionToken').value    = credentials.sessionToken || '';
        }
    } catch {}

    setupPasteDetection();
});

document.getElementById('credentialsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const saveBtn = document.getElementById('saveBtn');
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="bi bi-hourglass-split"></i> Connecting…';

    try {
        const credentials = {
            accessKeyId:     document.getElementById('accessKeyId').value.trim(),
            secretAccessKey: document.getElementById('secretAccessKey').value.trim(),
            region:          document.getElementById('region').value,
            sessionToken:    document.getElementById('sessionToken').value.trim() || null,
            profileName:     'default'
        };

        await window.electronAPI.invoke('save-credentials', credentials);

        const result = await window.electronAPI.invoke('validate-credentials');
        if (!result.valid) {
            throw new Error(result.errors?.[0] || 'Credentials could not be validated');
        }

        await window.electronAPI.invoke('navigate-to-main');

    } catch (error) {
        showErrorToast(error.message);
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="bi bi-check-circle"></i> Save & Connect';
    }
});

// ── Paste detection ───────────────────────────────────────────

function setupPasteDetection() {
    ['accessKeyId', 'secretAccessKey', 'sessionToken'].forEach(id => {
        document.getElementById(id)?.addEventListener('paste', handlePaste);
    });
    document.getElementById('credentialsForm').addEventListener('paste', handlePaste);
}

function handlePaste(event) {
    const text = (event.clipboardData || window.clipboardData).getData('text');
    if (isAwsCredentialFormat(text)) {
        event.preventDefault();
        const creds = parseAwsCredentials(text);
        if (creds) { populateCredentialFields(creds); showSuccessToast('Credentials detected and populated!'); }
    }
}

function isAwsCredentialFormat(text) {
    return /AWS_ACCESS_KEY_ID\s*=\s*[A-Z0-9]+/i.test(text) &&
           /AWS_SECRET_ACCESS_KEY\s*=\s*[A-Za-z0-9+/=]+/i.test(text);
}

function parseAwsCredentials(text) {
    try {
        const get = (pattern) => { const m = text.match(pattern); return m?.[1]?.trim(); };
        return {
            accessKeyId:     get(/(?:set\s+|export\s+)?AWS_ACCESS_KEY_ID\s*=\s*([A-Z0-9]+)/im),
            secretAccessKey: get(/(?:set\s+|export\s+)?AWS_SECRET_ACCESS_KEY\s*=\s*([A-Za-z0-9+/=]+)/im),
            sessionToken:    get(/(?:set\s+|export\s+)?AWS_SESSION_TOKEN\s*=\s*([A-Za-z0-9+/=]+)/im),
            region:          get(/(?:set\s+|export\s+)?AWS_(?:DEFAULT_)?REGION\s*=\s*([a-z0-9-]+)/im),
        };
    } catch { return null; }
}

function populateCredentialFields(creds) {
    if (creds.accessKeyId)     document.getElementById('accessKeyId').value     = creds.accessKeyId;
    if (creds.secretAccessKey) document.getElementById('secretAccessKey').value = creds.secretAccessKey;
    if (creds.sessionToken)    document.getElementById('sessionToken').value    = creds.sessionToken;
    if (creds.region) {
        const sel = document.getElementById('region');
        if ([...sel.options].find(o => o.value === creds.region)) sel.value = creds.region;
    }
}

async function pasteCredentialsFromClipboard() {
    try {
        const text = await navigator.clipboard.readText();
        if (isAwsCredentialFormat(text)) {
            const creds = parseAwsCredentials(text);
            if (creds) { populateCredentialFields(creds); showSuccessToast('Credentials pasted successfully!'); return; }
        }
        Toastify({ text: 'No AWS credentials found in clipboard', duration: 3000, gravity: 'top', position: 'right', className: 'toast-info' }).showToast();
    } catch {
        Toastify({ text: 'Paste credentials directly into any field', duration: 3000, gravity: 'top', position: 'right', className: 'toast-info' }).showToast();
    }
}
