# Homebrew cask for tmb's {{CHANNEL}} channel. Rendered by scripts/package-managers.ts from a
# release: do not edit the rendered copy in the tap, edit this template.
cask "{{CASK}}" do
  version "{{VERSION}}"

  on_macos do
    on_arm do
      sha256 "{{SHA256_DARWIN_ARM64}}"
      url "{{DOWNLOAD}}/tmb-darwin-arm64"
    end
    on_intel do
      sha256 "{{SHA256_DARWIN_X64}}"
      url "{{DOWNLOAD}}/tmb-darwin-x64"
    end
  end
  on_linux do
    on_arm do
      sha256 "{{SHA256_LINUX_ARM64}}"
      url "{{DOWNLOAD}}/tmb-linux-arm64"
    end
    on_intel do
      sha256 "{{SHA256_LINUX_X64}}"
      url "{{DOWNLOAD}}/tmb-linux-x64"
    end
  end

  # A tmb program knows itself by its file's name, and a cask's binary is a symlink, which the
  # program does not see. So the file itself takes the program's name before it is linked, and
  # tmb-dev never takes itself for tmb (trustmybot/tmb#89, Part 2).
  preflight do
    Dir.glob("#{staged_path}/tmb-{darwin,linux}-*").each do |file|
      File.rename(file, "#{staged_path}/{{PROGRAM}}")
    end
  end
  binary "{{PROGRAM}}"

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
    Run `{{PROGRAM}} init` in a project, then start your agent program there.
  EOS
end
