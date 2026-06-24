# Homebrew formula for knock-knock.
#
# This is the source of truth that belongs in a tap repo named
# `homebrew-knock-knock` (so users run `brew install <owner>/knock-knock/knock-knock`).
# The release workflow (.github/workflows/release.yml) bumps `version` and the
# four `sha256` values from dist/SHA256SUMS.txt on each tagged release.
#
# It ships the prebuilt, Bun-embedded binary — there is no `bun` dependency for
# end users.
class KnockKnock < Formula
  desc "Collaborating coding agents over Discord, gated by your own allow/ask/deny rules"
  homepage "https://github.com/ryanyen2/knock-knock"
  version "0.1.0"
  license "MIT"

  BASE = "https://github.com/ryanyen2/knock-knock/releases/download/v#{version}".freeze

  on_macos do
    if Hardware::CPU.arm?
      url "#{BASE}/knock-knock-darwin-arm64"
      sha256 "REPLACE_DARWIN_ARM64_SHA256"
    else
      url "#{BASE}/knock-knock-darwin-x64"
      sha256 "REPLACE_DARWIN_X64_SHA256"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "#{BASE}/knock-knock-linux-arm64"
      sha256 "REPLACE_LINUX_ARM64_SHA256"
    else
      url "#{BASE}/knock-knock-linux-x64"
      sha256 "REPLACE_LINUX_X64_SHA256"
    end
  end

  def install
    bin.install Dir["knock-knock-*"].first => "knock-knock"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/knock-knock --version")
  end
end
