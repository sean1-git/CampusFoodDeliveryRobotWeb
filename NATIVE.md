# Campus Store native apps

Capacitor 8 packages the React UI for Android and iOS. This is a development
integration, not a signed release or an App Store submission. The app remains a
demo: no real payments, school inventory feed, or robot dispatch.

## Configuration and files

- `capacitor.config.ts`: app name `Campus Store`, provisional identifier
  `io.github.sean1git.campusstore`, bundled web directory `dist/native`.
- `android/`: generated Android Studio project, SDK 36, minimum SDK 24.
- `ios/App/`: generated Xcode project using Swift Package Manager.
- `assets/app-logo.png`: supplied bobcat artwork. `scripts/build-native-icons.mjs`
  generates launcher icons and splash screens for both projects.
- `npm run build` still builds the website and server in `dist/client` and
  `dist/server`. `npm run build:native` builds only the mobile web assets.

Confirm the identifier before registering store listings. Changing it later
creates a different app identity. If changing it now, update the config and both
native projects' bundle/application identifiers together.

## Android on Windows

Install Android Studio 2025.2.1 or later, its bundled JDK, and Android SDK 36.
Then, from the repository root:

```sh
npm ci
npm run native:android
```

This rebuilds web assets, runs `cap sync`, generates bobcat assets, and opens
Android Studio. Select an emulator or connected device and Run. Signing and
release AAB generation happen in Android Studio; no signing key is included.

## iOS on a Mac

Use macOS with Xcode 26 or later and its command-line tools. Clone this repository:

```sh
npm ci
npm run native:ios
```

Choose a signing team in Xcode, select a simulator/device, and Run. A Windows web
build and successful Capacitor sync do not validate an iOS build. Store submission
requires the appropriate developer account and release signing.

## Daily development

```sh
npm run native:sync
```

Run after changes to React code, plugins, config, or icon artwork. Native bundles
do not register the website service worker or display the PWA installation button.
There is no production `server.url` setting: the app ships its own UI files.

## Cloud Run connection

Native builds default to `https://projectdemo-250283665537.europe-west1.run.app`.
To change this, put a public HTTPS origin in ignored `.env.native.local`:

```dotenv
VITE_NATIVE_API_ORIGIN=https://your-api.example
```

This value is embedded in the app and must never contain a secret. The origin
must not contain a path, query, or credentials. Native requests accept only
`/api/` paths and disable redirects. Capacitor HTTP handles the native cookie jar;
app code does not copy session cookies into localStorage. The native transport
sends the configured API origin because it is not a browser request. The backend
still verifies its session, account ownership, CSRF token, and idempotency key.
The browser uses the existing relative URLs and same-origin cookies. No wildcard
CORS or weaker server cookie settings were introduced.

Before release, verify on real Android and iOS devices: new demo session,
retained wallet after restart, checkout reservation/confirmation/cancellation,
expired sessions, and offline/reconnect recovery. Native cookie persistence and
platform behavior have not yet been verified on devices.

## Location and maps

Location is optional and requested only when the user taps Use my location.
Android has coarse/fine location permissions; iOS has the plugin-required usage
descriptions. No background location mode or continuous watcher is enabled.
Cancellation/removal still ignores late location results.

The existing map renderer uses Google Maps JavaScript. Its current browser key is
restricted to the deployed web origins; that does not prove it works under
`capacitor://localhost` (iOS) or `https://localhost` (Android). Treat native map
authorization as a release blocker until verified. Prefer integrating the native
Google Maps SDK/plugin with Android package/certificate and iOS bundle-restricted
keys for a store release; do not remove key restrictions or add unrestricted keys
to make the browser map work. API transport alone does not solve map SDK licensing
or key authorization. Pin confirmation remains disabled when the map is not ready.

## Release work still required

Native compilation and device testing, map integration, signing, developer
accounts, store metadata/screenshots, and accurate privacy/location disclosures
remain. This scaffold does not guarantee store approval. The current Cloud Run
SQLite demo also needs durable backend storage before real customer use.

Local SDK paths, generated bundles, keystores, certificates, provisioning profiles,
and `.env` files are ignored. Keep signing credentials in a secret store.

References: [Capacitor workflow](https://capacitorjs.com/docs/basics/workflow),
[environment setup](https://capacitorjs.com/docs/getting-started/environment-setup),
[HTTP](https://capacitorjs.com/docs/apis/http),
[geolocation](https://capacitorjs.com/docs/apis/geolocation).
