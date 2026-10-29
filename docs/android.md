# Android app (APK)

QuickGrade's Android app is a [Capacitor](https://capacitorjs.com) wrapper around your **hosted QuickGrade server**. It opens your server's HTTPS address in a native Android WebView and adds what a browser tab can't:

- A home-screen app with the QuickGrade icon and splash screen; no address bar.
- **Camera permission** for live scanning (asked the first time you tap *Use camera*). *Upload photos* can also open the phone's camera app.
- **Downloads:** answer-sheet PDFs, reports and CSV exports are saved to the phone's *Downloads* folder using your signed-in session.
- The **back button** goes back inside QuickGrade before it closes the app.
- A friendly "Can't reach QuickGrade" screen when there is no connection.

Grading, scores and data all stay on your server, so the app updates whenever the server does and you never reinstall for a new feature. The app needs an internet connection to your server.

> **Before building:** QuickGrade must be running on a public **HTTPS** address (see [deployment.md](deployment.md)), e.g. `https://grade.yourschool.ph`. Android blocks secure cookies and the camera on plain HTTP.

## Build the APK on GitHub (Ubuntu runner): no Android Studio needed

The workflow [`.github/workflows/android.yml`](../.github/workflows/android.yml) builds the app on GitHub's `ubuntu-latest` machines.

1. Open the repository on GitHub, go to **Actions → Android APK → Run workflow**.
2. Enter your server address (e.g. `https://grade.yourschool.ph`) and a version name, then click **Run workflow**.
3. When the run turns green (about 5–10 minutes), open it and download the **QuickGrade-android-…** artifact (a zip).
4. Unzip it, copy `QuickGrade-<version>-debug.apk` to your phone, open it and allow "Install unknown apps" for your file manager or browser when Android asks.

To avoid typing the address every time, set it once under **Settings → Secrets and variables → Actions → Variables → New repository variable**: name `QUICKGRADE_SERVER_URL`. After that, pushing a tag such as `android-v1.0.1` builds automatically.

### Signed release builds (for sharing widely or Google Play)

The debug APK is fine for testing and for installing on your own and colleagues' phones. For a properly signed release APK and a Play Store bundle (`.aab`), create a keystore **once** and keep it safe (losing it means you cannot update the app):

```bash
keytool -genkey -v -keystore quickgrade-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias quickgrade
base64 -w0 quickgrade-release.jks > keystore.b64      # macOS: base64 -i quickgrade-release.jks
```

Add these **repository secrets** (Settings → Secrets and variables → Actions → Secrets):

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | contents of `keystore.b64` |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
| `ANDROID_KEY_ALIAS` | `quickgrade` (or the alias you chose) |
| `ANDROID_KEY_PASSWORD` | the key password |

The next run then also produces `QuickGrade-<version>.apk` (signed) and `QuickGrade-<version>.aab`. Never commit the keystore or its passwords.

## Build locally on Ubuntu (optional)

```bash
# Ubuntu 22.04/24.04
sudo apt install -y openjdk-21-jdk unzip
# Android command-line tools: https://developer.android.com/studio#command-line-tools-only
export ANDROID_HOME=$HOME/Android/Sdk
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"

npm ci
QUICKGRADE_SERVER_URL=https://grade.yourschool.ph npm run android:sync
cd android && ./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
```

`npm run android:open` opens the project in Android Studio instead. For testing against a laptop on your Wi-Fi without HTTPS, set `QUICKGRADE_ALLOW_HTTP=1` with an `http://192.168.x.x:3000` address. This is for testing only: sign-in needs `COOKIE_SECURE=false` on the server.

## Configuration reference

| Variable (at build time) | Purpose |
|---|---|
| `QUICKGRADE_SERVER_URL` | Required. HTTPS address the app opens |
| `QUICKGRADE_VERSION_NAME` / `QUICKGRADE_VERSION_CODE` | Version shown in Android / increasing build number (CI uses the run number) |
| `QUICKGRADE_APP_ID` | Android package id (default `ph.quickgrade.app`). Change it before your first Play Store upload if you want your own, e.g. `ph.edu.yourschool.quickgrade` |
| `QUICKGRADE_WEBVIEW_DEBUG=1` | Enables Chrome remote debugging of the WebView |
| `QUICKGRADE_ALLOW_HTTP=1` | Allows an `http://` address (local testing only) |

The app adds `QuickGradeAndroid/1` to its user agent. The web app uses this to keep export links inside the app so they download instead of opening the browser, where the user would not be signed in.

Regenerate the launcher icons and splash screens from `web/public/icon.svg` with `npm run android:icons`.

## Status

- The Android project, permissions, download handling, icons and the CI workflow are in place.
- The APK **was not compiled in the development environment**: Google's Android SDK download server was blocked there. The first GitHub Actions run is the first real build.
- The app has not yet been tried on a physical phone.
