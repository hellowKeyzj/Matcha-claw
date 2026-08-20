import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('release mac signing config', () => {
  it('pins the Rust toolchain, cross targets, and Windows bundled runtime preparation', async () => {
    const workflow = await readFile('.github/workflows/release.yml', 'utf8');

    expect(workflow).toContain("RUSTUP_TOOLCHAIN: '1.97.0'");
    expect(workflow).toContain('uses: dtolnay/rust-toolchain@1.97.0');
    expect(workflow).toContain('targets: aarch64-apple-darwin, x86_64-apple-darwin, aarch64-unknown-linux-gnu, x86_64-unknown-linux-gnu, aarch64-pc-windows-msvc, x86_64-pc-windows-msvc');
    const installDependencies = workflow.indexOf('      - name: Install dependencies\n        run: pnpm install --frozen-lockfile');
    const prepareWindowsDependencies = workflow.indexOf("      - name: Prepare Windows bundled runtime dependencies\n        if: matrix.platform == 'win'\n        run: pnpm run prep:win-binaries");
    expect(prepareWindowsDependencies).toBeGreaterThan(installDependencies);
  });

  it('creates and signs an exact Windows x64 NSIS installed-package evidence receipt', async () => {
    const workflow = await readFile('.github/workflows/release.yml', 'utf8');

    expect(workflow).toContain('attestations: write');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('      - name: Prove Windows x64 installed NSIS runtime host');
    expect(workflow).toContain("$installers = @(Get-ChildItem -LiteralPath $releaseDirectory -File -Filter '*-win-x64.exe')");
    expect(workflow).toContain('Expected exactly one Windows x64 NSIS installer from the release build; found $($installers.Count).');
    expect(workflow).not.toContain('WINDOWS_NSIS_BUILD_STARTED_AT');
    expect(workflow).toContain('$nsisInstallStopwatch = [System.Diagnostics.Stopwatch]::StartNew()');
    expect(workflow).toContain('& $installer.FullName /S "/D=$installRoot"\n            $nsisInstallStopwatch.Stop()\n            $nsisInstallExitCode = $LASTEXITCODE\n            $nsisInstallDurationMs = [Math]::Floor($nsisInstallStopwatch.Elapsed.TotalMilliseconds)');
    expect(workflow).toContain('--nsis-install-duration-ms $nsisInstallDurationMs --nsis-install-exit-code $nsisInstallExitCode');
    expect(workflow).toContain('--receipt $receiptPath');
    expect(workflow).toContain('--workflow-ref "$env:GITHUB_WORKFLOW_REF"');
    expect(workflow).toContain("WINDOWS_NSIS_EVIDENCE_RECEIPT=$receiptPath");
    expect(workflow).toContain('      - name: Attest Windows x64 NSIS package execution evidence');
    expect(workflow).toContain('uses: actions/attest-build-provenance@v3');
    expect(workflow).toContain('subject-path: ${{ env.WINDOWS_NSIS_EVIDENCE_RECEIPT }}');
    expect(workflow).toContain('release/runtime-host-package-evidence-*.json');
  });

  it('fails closed for every required native package-proof runner and preserves receipts in deploy bundles', async () => {
    const workflow = await readFile('.github/workflows/release.yml', 'utf8');

    expect(workflow).toContain('macOS arm64 package proof requires a macOS/ARM64 runner; got $RUNNER_OS/$RUNNER_ARCH.');
    expect(workflow).toContain('macOS x64 package proof requires a macOS/X64 runner; got $RUNNER_OS/$RUNNER_ARCH.');
    expect(workflow).toContain('Installed NSIS proof requires a Windows x64 runner; got $env:RUNNER_OS/$env:RUNNER_ARCH.');
    expect(workflow).toContain('Windows ARM64 package proof requires a Windows/ARM64 runner; got $env:RUNNER_OS/$env:RUNNER_ARCH.');
    expect(workflow).toContain('Linux x64 package proof requires a Linux/X64 runner; got $RUNNER_OS/$RUNNER_ARCH.');
    expect(workflow).toContain('Linux ARM64 package proof requires a Linux/ARM64 runner; got $RUNNER_OS/$RUNNER_ARCH.');
    expect(workflow).toContain('if [ "$RUNNER_OS" != "macOS" ] || [ "$RUNNER_ARCH" != "ARM64" ]; then');
    expect(workflow).toContain('if [ "$RUNNER_OS" != "macOS" ] || [ "$RUNNER_ARCH" != "X64" ]; then');
    expect(workflow).toContain("if ($env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ARCH -ne 'X64') {");
    expect(workflow).toContain("if ($env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ARCH -ne 'ARM64') {");
    expect(workflow).toContain('if [ "$RUNNER_OS" != "Linux" ] || [ "$RUNNER_ARCH" != "X64" ]; then');
    expect(workflow).toContain('if [ "$RUNNER_OS" != "Linux" ] || [ "$RUNNER_ARCH" != "ARM64" ]; then');
    expect(workflow).toContain('-name "runtime-host-package-evidence-*.json" -o \\');
  });

  it('routes all eleven declared package cells through native installed-package smoke receipts', async () => {
    const workflow = await readFile('.github/workflows/release.yml', 'utf8');
    const receiptPaths = [
      'runtime-host-package-evidence-darwin-x64-dmg.json',
      'runtime-host-package-evidence-darwin-arm64-dmg.json',
      'runtime-host-package-evidence-darwin-x64-zip.json',
      'runtime-host-package-evidence-darwin-arm64-zip.json',
      'runtime-host-package-evidence-win32-x64-nsis.json',
      'runtime-host-package-evidence-win32-arm64-nsis.json',
      'runtime-host-package-evidence-linux-x64-appimage.json',
      'runtime-host-package-evidence-linux-arm64-appimage.json',
      'runtime-host-package-evidence-linux-x64-deb.json',
      'runtime-host-package-evidence-linux-arm64-deb.json',
      'runtime-host-package-evidence-linux-x64-rpm.json',
    ];

    expect(new Set(receiptPaths).size).toBe(11);
    for (const receiptPath of receiptPaths) {
      expect(workflow).toContain(receiptPath);
    }
    expect(workflow).not.toContain('runtime-host-package-evidence-linux-arm64-rpm.json');
    expect(workflow).toContain('      - name: Prove macOS arm64 mounted package runtime host');
    expect(workflow).toContain('      - name: Prove macOS x64 mounted and extracted package runtime host');
    expect(workflow).toContain('--platform darwin --arch arm64 --target dmg');
    expect(workflow).toContain('--platform darwin --arch arm64 --target zip');
    expect(workflow).toContain('--platform darwin --arch arm64 --target dmg --unpacked');
    expect(workflow).toContain('--platform darwin --arch arm64 --target zip --unpacked');
    expect(workflow).toContain('--platform darwin --arch x64 --target "$target"');
    expect(workflow).toContain('      - name: Prove Windows x64 installed NSIS runtime host');
    expect(workflow).toContain('      - name: Prove Windows ARM64 installed NSIS runtime host');
    expect((workflow.match(/\$nsisInstallStopwatch = \[System\.Diagnostics\.Stopwatch\]::StartNew\(\)/g) ?? []).length).toBe(2);
    expect((workflow.match(/--nsis-install-duration-ms \$nsisInstallDurationMs --nsis-install-exit-code \$nsisInstallExitCode/g) ?? []).length).toBe(2);
    expect((workflow.match(/& \$installer\.FullName \/S "\/D=\$installRoot"\n            \$nsisInstallStopwatch\.Stop\(\)\n            \$nsisInstallExitCode = \$LASTEXITCODE\n            \$nsisInstallDurationMs = \[Math\]::Floor\(\$nsisInstallStopwatch\.Elapsed\.TotalMilliseconds\)/g) ?? []).length).toBe(2);
    expect(workflow).toContain('--platform win32 --arch x64 --target nsis');
    expect(workflow).toContain('--platform win32 --arch arm64 --target nsis');
    expect(workflow).toContain('      - name: Prove Linux x64 extracted package runtime host');
    expect(workflow).toContain('      - name: Prove Linux ARM64 extracted package runtime host');
    expect(workflow).toContain('--platform linux --arch x64 --target "$target"');
    expect(workflow).toContain('--platform linux --arch arm64 --target "$target"');
    expect(workflow).toContain('runs-on: macos-13');
    expect(workflow).toContain('runs-on: windows-11-arm');
    expect(workflow).toContain('runs-on: ubuntu-24.04-arm');
    expect(workflow).toContain('needs: [release, prove-macos-x64-packages, prove-windows-arm64-package, prove-linux-arm64-packages]');
    expect(workflow).toContain("needs.prove-macos-x64-packages.result == 'success' || needs.prove-macos-x64-packages.result == 'skipped'");
    expect(workflow).toContain("needs.prove-windows-arm64-package.result == 'success' || needs.prove-windows-arm64-package.result == 'skipped'");
    expect(workflow).toContain("needs.prove-linux-arm64-packages.result == 'success' || needs.prove-linux-arm64-packages.result == 'skipped'");
  });

  it('attests and publishes every installed-native-run receipt', async () => {
    const workflow = await readFile('.github/workflows/release.yml', 'utf8');
    const receiptSubjects = [
      'MACOS_ARM64_DMG_EVIDENCE_RECEIPT',
      'MACOS_ARM64_ZIP_EVIDENCE_RECEIPT',
      'MACOS_X64_DMG_EVIDENCE_RECEIPT',
      'MACOS_X64_ZIP_EVIDENCE_RECEIPT',
      'WINDOWS_NSIS_EVIDENCE_RECEIPT',
      'WINDOWS_ARM64_NSIS_EVIDENCE_RECEIPT',
      'LINUX_X64_APPIMAGE_EVIDENCE_RECEIPT',
      'LINUX_X64_DEB_EVIDENCE_RECEIPT',
      'LINUX_X64_RPM_EVIDENCE_RECEIPT',
      'LINUX_ARM64_APPIMAGE_EVIDENCE_RECEIPT',
      'LINUX_ARM64_DEB_EVIDENCE_RECEIPT',
    ];

    expect(new Set(receiptSubjects).size).toBe(11);
    for (const subject of receiptSubjects) {
      expect(workflow).toContain('subject-path: ${{ env.' + subject + ' }}');
    }
    expect(workflow).toContain('MACOS_X64_DMG_EVIDENCE_RECEIPT=$dmg_receipt_path');
    expect(workflow).toContain('MACOS_X64_ZIP_EVIDENCE_RECEIPT=$zip_receipt_path');
    expect(workflow).toContain('WINDOWS_ARM64_NSIS_EVIDENCE_RECEIPT=$receiptPath');
    expect(workflow).toContain('LINUX_ARM64_APPIMAGE_EVIDENCE_RECEIPT=$appimage_receipt_path');
    expect(workflow).toContain('LINUX_ARM64_DEB_EVIDENCE_RECEIPT=$deb_receipt_path');
    expect(workflow).toContain('name: release-package-evidence-macos-x64');
    expect(workflow).toContain('name: release-package-evidence-windows-arm64');
    expect(workflow).toContain('name: release-package-evidence-linux-arm64');
    expect(workflow).toContain('release/mac/MatchaClaw.app/**');
    expect(workflow).toContain('release/win-arm64-unpacked/**');
    expect(workflow).toContain('release/linux-arm64-unpacked/**');
    expect(workflow).toContain('release-artifacts/**/runtime-host-package-evidence-*.json');
  });

  it('loads explicit x64 and ARM64 MSVC environments before Windows native host builds', async () => {
    const workflow = await readFile('.github/workflows/release.yml', 'utf8');

    expect(workflow).toContain('      - name: Build Windows native runtime hosts');
    expect(workflow).toContain('shell: cmd');
    expect(workflow).toContain('Microsoft.VisualStudio.Component.VC.Tools.x86.x64');
    expect(workflow).toContain('vcvarsall.bat" x64');
    expect(workflow).toContain('Hostx64\\x64\\cl.exe');
    expect(workflow).toContain('node scripts/build-runtime-host-native.mjs --platform win32 --arch x64');
    expect(workflow).toContain('vcvarsall.bat" x64_arm64');
    expect(workflow).toContain('Hostx64\\arm64\\cl.exe');
    expect(workflow).toContain('node scripts/build-runtime-host-native.mjs --platform win32 --arch arm64');
  });

  it('copies the native runtime directory into its matching packaged target directory', async () => {
    const config = await readFile('electron-builder.yml', 'utf8');

    expect(config).toContain('from: runtime-host/dist/darwin-${arch}\n      to: bin/darwin-${arch}');
    expect(config).toContain('from: runtime-host/dist/win32-${arch}\n      to: bin/win32-${arch}');
    expect(config).toContain('from: runtime-host/dist/linux-${arch}\n      to: bin/linux-${arch}');
  });

  it('keeps electron-builder mac defaults sign-capable (no hardcoded unsigned)', async () => {
    const config = await readFile('electron-builder.yml', 'utf8');
    expect(config).not.toContain('identity: null');
    expect(config).toContain('notarize: true');
  });

  it('builds signed mac apps with a single explicit notarization submission per arch', async () => {
    const workflow = await readFile('.github/workflows/release.yml', 'utf8');
    expect(workflow).toContain('if [ -z "${CSC_LINK:-}" ] || [ -z "${CSC_KEY_PASSWORD:-}" ]; then');
    expect(workflow).toContain('if [ -z "${APPLE_ID:-}" ] || [ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] || [ -z "${APPLE_TEAM_ID:-}" ]; then');
    expect(workflow).toContain('pnpm exec electron-builder --mac dir --x64 --arm64 --publish never -c.mac.notarize=false');
    expect(workflow).toContain('submit_notary x64 "release/mac/MatchaClaw.app"');
    expect(workflow).toContain('submit_notary arm64 "release/mac-arm64/MatchaClaw.app"');
    expect(workflow).toContain('Refusing to submit again automatically to avoid duplicate Apple notarization quota usage.');
    expect(workflow).not.toContain('-c.mac.identity=null');
  });
});
