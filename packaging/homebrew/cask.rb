# Homebrew cask for tmb's {{CHANNEL}} channel. Rendered by scripts/package-managers.ts from a
# release: do not edit the rendered copy in the tap, edit this template.
cask "{{CASK}}" do
  version "{{VERSION}}"

  on_macos do
    on_arm do
      sha256 "{{SHA256_DARWIN_ARM64}}"
      url "{{DOWNLOAD}}/tmb-darwin-arm64"

      binary "tmb-darwin-arm64", target: "{{PROGRAM}}"
    end
    on_intel do
      sha256 "{{SHA256_DARWIN_X64}}"
      url "{{DOWNLOAD}}/tmb-darwin-x64"

      binary "tmb-darwin-x64", target: "{{PROGRAM}}"
    end
  end
  on_linux do
    on_arm do
      sha256 "{{SHA256_LINUX_ARM64}}"
      url "{{DOWNLOAD}}/tmb-linux-arm64"

      binary "tmb-linux-arm64", target: "{{PROGRAM}}"
    end
    on_intel do
      sha256 "{{SHA256_LINUX_X64}}"
      url "{{DOWNLOAD}}/tmb-linux-x64"

      binary "tmb-linux-x64", target: "{{PROGRAM}}"
    end
  end

  name "{{NAME}}"
  desc "Harness for coding agents: a record, a code graph and an enforced workflow"
  homepage "https://github.com/trustmybot/tmb-releases"

  livecheck do
    skip "Updated by tmb's release workflow"
  end

  # tmb updates itself from its channel between sessions, so Homebrew leaves upgrades to it.
  auto_updates true

  caveats <<~EOS
    {{PROGRAM}} updates itself from the {{CHANNEL}} channel between sessions.
    Run `{{PROGRAM}} setup` in a project, then start your agent program there.
  EOS
end
