# Releasing ViewEditor

`npm run release` publishes a new version. It raises the version in `package.json`, commits it, tags the
commit with your release notes, and pushes the commit and tag together. The tag starts the **Release**
workflow, which tests the app and builds the Windows and macOS installers on GitHub's servers, then
publishes them. You don't need a Mac to ship the Mac version.

1. Commit and push the work you're releasing, and check that the **Build** workflow passed on the
   repository's **Actions** tab. It's the same build the release uses.
2. Run `npm run release` with the new version, then one quoted line for each change. Each line appears under
   **What's new** on the release page:

   ```bash
   npm run release -- <new version> "<what changed>" "<what else changed>"
   ```

   Replace each `<…>`, angle brackets included, with your own text:
   - the version: three numbers, higher than the one in `package.json` (or the same, for the first release)
   - each change: one short sentence written for the people who use ViewEditor

   Add `--dry-run` to see the plan and the release notes without changing anything.

   Before it changes anything, it checks that:
   - the version isn't lower than the current one
   - you have no uncommitted changes
   - nobody has pushed to the branch since you last pulled
   - the tag doesn't exist yet

   If a check fails, it says what's wrong and changes nothing.

3. Follow the **Release** workflow on the **Actions** tab. `npm run release` prints the link. It builds:
   - `ViewEditor-Setup-<version>.exe` for Windows
   - `ViewEditor-<version>-arm64.dmg` and `ViewEditor-<version>-x64.dmg` for Apple silicon and Intel Macs

   It then publishes the release. The release notes contain:
   - **What's new**, from your lines
   - the download notes from `.github/release-notes.md`
   - a link to every change since the last release

**If the build fails**, nothing is published. Delete the tag on GitHub and on your computer, replacing
`<version>` with the version you released:

```bash
git push origin :refs/tags/v<version>
```

```bash
git tag -d v<version>
```

Then fix the problem, commit and push the fix, and run `npm run release` again with the same version and
notes. `package.json` already has that version, so this time it only tags and pushes.

Once a release is published, it can't be replaced this way. To change its notes, open the release on
GitHub and click **Edit**.

## Signing

These builds have no publisher certificate: the Windows installer is unsigned, and the Mac app has only an
ad-hoc signature, without which Apple silicon Macs won't open it at all. Users see a warning the first time
they open either one, and the release notes explain how to get past it. To remove the warnings, you need a
Windows code-signing certificate and an Apple Developer ID.

## How installed copies update

ViewEditor checks the latest GitHub release 10 seconds after it starts, then every 4 hours
(`src/main/updater.ts`):

- **Windows:** it downloads a newer version in the background and shows **Restart now**. If the user
  doesn't restart, the new version installs the next time they quit ViewEditor.
- **macOS:** it only says a new version is out. **Download** opens the release page. macOS only installs
  updates signed with a Developer ID, and these builds have an ad-hoc signature.
- **`npm run dev`:** this never checks.

The checks read files that electron-builder writes next to the installers, and the workflow attaches them
to the release: `latest.yml` (Windows), `latest-mac.yml`, and the `.blockmap` files, which let Windows
download only what changed. Don't delete them from a release.

Every published release reaches everyone within a few hours, and you can't take it back from copies that
have already updated. If a release is broken, publish a fixed one with a higher version.

**Full updates on macOS.** Once you have a Developer ID certificate:

1. Sign and notarise the Mac build instead of using `build/adhoc-mac.yml`.
2. Add `zip` to `mac.target` in `electron-builder.yml`. Mac updates install from the zip, not the DMG. Add
   `release/*.zip` to the files `.github/workflows/build.yml` uploads.
3. In `updateMode` in `src/shared/update.ts`, return `'install'` for `darwin` too.

Copies with the ad-hoc signature can't install a signed update, so Mac users install the first signed
version by hand. The notice tells them it's out.

## FFmpeg

The installers contain FFmpeg under the GPL version 3, so its source has to stay available to anyone who
gets them. `licenses/FFMPEG.md` and `.github/release-notes.md` link to the source of the exact builds, and
both need updating when FFmpeg changes.

- **Windows** uses the binaries from the `ffmpeg-ffprobe-static` npm package.
- **macOS** can't. That package's Mac binaries were compiled with `--enable-nonfree`, which FFmpeg defines
  as not redistributable. `scripts/mac-ffmpeg.mjs` swaps in Jellyfin's GPL build whenever a Mac app is
  packed, and the **Build** workflow fails if a non-free FFmpeg ends up in one.

To move to a newer Jellyfin build, change `VERSION` and both `sha256` values in `scripts/mac-ffmpeg.mjs`.
The hashes are on the [release's assets](https://github.com/jellyfin/jellyfin-ffmpeg/releases).
