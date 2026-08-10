// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// electron-builder afterSign hook — notarize the macOS app with Apple.
//
// Deliberately GATED on the credentials being present in the environment. With
// no APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID (the current state,
// and every non-mac build), this returns immediately and the build proceeds
// unsigned/ad-hoc exactly as before — so landing this can't break CI. The
// moment those secrets exist in the release workflow, notarization runs.
//
// Pairs with mac.hardenedRuntime + build/entitlements.mac.plist in
// package.json, and with macBuildIsSigned() in main.js (which only enables
// mac auto-update once the running build is actually Developer ID signed).

'use strict';

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!appleId || !appleIdPassword || !teamId) {
    console.log('[notarize] skipped — APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set (unsigned/ad-hoc build)');
    return;
  }

  // @electron/notarize ships with electron-builder — no extra dependency.
  const { notarize } = require('@electron/notarize');
  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`[notarize] submitting ${appName}.app to Apple (team ${teamId}) — this can take a few minutes…`);
  await notarize({ appPath, appleId, appleIdPassword, teamId });
  console.log('[notarize] done — ticket stapled');
};
