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
    // Ad-hoc signing for macOS — no Apple Developer account required, but
    // satisfies the Apple Silicon hard requirement that every binary be
    // at least signed ad-hoc. Without this, downloaded .app bundles get
    // flagged as "damaged" and refuse to launch.
    osxSign: {
      identity: '-',
      optionsForFile: () => ({
        hardenedRuntime: false,
      }),
    },
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
};

export default config;
