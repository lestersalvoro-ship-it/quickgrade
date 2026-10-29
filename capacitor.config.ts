import type { CapacitorConfig } from '@capacitor/cli';

/**
 * QuickGrade Android wrapper.
 *
 * The app opens your hosted QuickGrade server (HTTPS) inside a native WebView, so
 * sign-in cookies, scanning and grading work exactly as on the website, and the
 * app picks up server updates without a reinstall. Set the server address with
 * QUICKGRADE_SERVER_URL when syncing/building (see docs/android.md).
 */
const serverUrl = process.env.QUICKGRADE_SERVER_URL?.trim().replace(/\/+$/, '') || '';

if (serverUrl && !/^https:\/\//.test(serverUrl) && !process.env.QUICKGRADE_ALLOW_HTTP) {
  throw new Error('QUICKGRADE_SERVER_URL must start with https:// (set QUICKGRADE_ALLOW_HTTP=1 only for local testing).');
}

const config: CapacitorConfig = {
  appId: process.env.QUICKGRADE_APP_ID || 'ph.quickgrade.app',
  appName: 'QuickGrade',
  webDir: 'android-shell',
  server: serverUrl
    ? {
        url: serverUrl,
        cleartext: serverUrl.startsWith('http://'),
        allowNavigation: [new URL(serverUrl).host],
        errorPath: 'error.html',
      }
    : { androidScheme: 'https' },
  android: {
    backgroundColor: '#f5f6f8',
    // Lets the web app recognise the Android wrapper without relying on injected scripts
    // (QuickGrade's Content-Security-Policy blocks inline script injection).
    appendUserAgent: 'QuickGradeAndroid/1',
    allowMixedContent: false,
    webContentsDebuggingEnabled: !!process.env.QUICKGRADE_WEBVIEW_DEBUG,
  },
};

export default config;
