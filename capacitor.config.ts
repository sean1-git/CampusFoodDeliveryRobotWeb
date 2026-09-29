import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // Provisional identifier: confirm before creating either store listing.
  appId: 'io.github.sean1git.campusstore',
  appName: 'Campus Store',
  webDir: 'dist/native',
  android: { path: 'apps/mobile/android' },
  ios: { path: 'apps/mobile/ios' },
  backgroundColor: '#142b52',
};
export default config;
