// electron-builder configuration.
//
// The base config lives in package.json "build" (unsigned by default:
// mac.identity = null). This wrapper adds macOS Developer ID signing +
// notarization ONLY when the certificate is present in the environment
// (process.env.CSC_LINK). That conditional is the whole point:
//
//   - With the secrets (CI mac jobs: CSC_LINK/CSC_KEY_PASSWORD/APPLE_*): a real
//     Developer ID signed + hardened-runtime + notarized build, so macOS
//     auto-update turns on (main.js macBuildIsSigned()).
//   - Without them (local dev, forks, the pre-secret state): the base unsigned
//     build, unchanged. It does NOT try to ad-hoc hardened-runtime sign, which
//     is what failed the v1.10.2 build ("⨯ ... not a file") when no cert was
//     present. See docs/macos-code-signing.md.
//
// electron-builder auto-detects electron-builder.js and uses it instead of
// package.json "build"; we re-export the package.json build so win/linux and
// every other setting are preserved verbatim.

'use strict';

const pkg = require('./package.json');
const config = { ...pkg.build };

if (process.env.CSC_LINK) {
  config.afterSign = 'scripts/notarize.js';                 // @electron/notarize; skips if APPLE_* absent
  config.mac = { ...config.mac };
  delete config.mac.identity;                               // was null (skip); let it use the imported cert
  config.mac.hardenedRuntime = true;                        // required for notarization
  config.mac.entitlements = 'build/entitlements.mac.plist';
  config.mac.entitlementsInherit = 'build/entitlements.mac.plist';
}

module.exports = config;
