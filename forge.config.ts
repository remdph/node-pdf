import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { notarize } from '@electron/notarize';
import { execFileSync } from 'node:child_process';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'NodePDF',
    // Linux makers (MakerDeb in particular) expect the binary inside the
    // packaged folder to match the lowercased project `name` field. Force
    // it here so .deb / .rpm find the executable.
    executableName: 'node-pdf',
    // forge resolves per-platform extensions: icon.ico / icon.icns / icon.png
    icon: './icon',
    // Make the icon available at runtime via process.resourcesPath.
    extraResource: ['./icon.png'],
    // macOS code signing with a Developer ID Application certificate.
    // Falls back to ad-hoc signing when APPLE_SIGNING_IDENTITY is unset
    // (e.g. forks/CI without secrets) so the build doesn't fail outright.
    osxSign: {
      identity:
        process.env.APPLE_SIGNING_IDENTITY ||
        'Developer ID Application: HONTRACK S. DE R.L. (A384K33T3Y)',
      optionsForFile: () => ({
        hardenedRuntime: true,
        entitlements: './build/entitlements.mac.plist',
        'entitlements-inherit': './build/entitlements.mac.plist',
      }),
    },
    // Notarize the signed .app with Apple. Only runs when the three env
    // vars are present — otherwise forge silently skips notarization,
    // which keeps local "just build something" workflows usable.
    osxNotarize:
      process.env.APPLE_ID && process.env.APPLE_ID_PASSWORD && process.env.APPLE_TEAM_ID
        ? {
            appleId: process.env.APPLE_ID,
            appleIdPassword: process.env.APPLE_ID_PASSWORD,
            teamId: process.env.APPLE_TEAM_ID,
          }
        : undefined,
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      // We renamed the executable to lowercase via executableName above, so
      // Squirrel needs to be told which .exe to wrap (defaults to <name>.exe
      // based on packagerConfig.name = "NodePDF" and would not match).
      exe: 'node-pdf.exe',
      setupIcon: './icon.ico',
    }),
    // Keep the .zip alongside the .dmg for users who want a portable bundle.
    new MakerZIP({}, ['darwin']),
    new MakerDMG({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: 'src/main/index.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/index.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
  hooks: {
    // electron-forge signs and notarizes the .app inside packagerConfig,
    // but the .dmg produced by MakerDMG is left unsigned. Sign + notarize +
    // staple the DMG itself so Gatekeeper accepts the downloaded volume
    // (`spctl --assess --type install` → "Notarized Developer ID").
    postMake: async (_forgeConfig, makeResults) => {
      if (process.platform !== 'darwin') return makeResults;

      const identity =
        process.env.APPLE_SIGNING_IDENTITY ||
        'Developer ID Application: HONTRACK S. DE R.L. (A384K33T3Y)';
      const { APPLE_ID, APPLE_ID_PASSWORD, APPLE_TEAM_ID } = process.env;
      const canNotarize = Boolean(APPLE_ID && APPLE_ID_PASSWORD && APPLE_TEAM_ID);

      for (const result of makeResults) {
        for (const artifact of result.artifacts) {
          if (!artifact.endsWith('.dmg')) continue;
          console.log(`[postMake] signing ${artifact}`);
          execFileSync(
            'codesign',
            ['--sign', identity, '--timestamp', '--force', artifact],
            { stdio: 'inherit' },
          );
          if (!canNotarize) {
            console.log('[postMake] notarize env vars missing, skipping notarization');
            continue;
          }
          console.log(`[postMake] notarizing ${artifact} (Apple round-trip)`);
          await notarize({
            appPath: artifact,
            appleId: APPLE_ID!,
            appleIdPassword: APPLE_ID_PASSWORD!,
            teamId: APPLE_TEAM_ID!,
          });
          console.log(`[postMake] stapling ${artifact}`);
          execFileSync('xcrun', ['stapler', 'staple', artifact], { stdio: 'inherit' });
        }
      }
      return makeResults;
    },
  },
};

export default config;
