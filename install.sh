#!/bin/sh
# Installs the memtro command: one standalone executable, no Node.js needed.
#
#   curl -fsSL https://raw.githubusercontent.com/memtro-org/memtro-cli/main/install.sh | sh
#
# Settings (environment variables):
#   MEMTRO_VERSION=0.2.0       install this version (with or without a leading v) instead of the latest
#   MEMTRO_INSTALL_DIR=<dir>   install here instead of $HOME/.memtro/bin
#   MEMTRO_MODIFY_PATH=1       add the directory to PATH in your shell's startup file (otherwise it only says how)
#
# What it does: downloads the release's tarball for this computer and the release's checksums.txt from the same
# GitHub release, checks the SHA-256, checks the new executable starts, and moves it into place. It never uses
# sudo, never asks a question, and changes no file outside the install directory unless MEMTRO_MODIFY_PATH=1.
#
# The whole script is one function called on the last line, so a download cut short runs nothing.

main() {
	set -eu

	releases="https://github.com/memtro-org/memtro-cli/releases"
	# MEMTRO_RELEASE_BASE is deliberately undocumented: the tests point it at a local server standing in for
	# GitHub releases. Plain http is accepted only on a loopback address.
	base="${MEMTRO_RELEASE_BASE:-$releases}"
	install_dir="${MEMTRO_INSTALL_DIR:-${HOME:-}/.memtro/bin}"
	tmp=""
	staged=""

	case "${1:-}" in
		"") ;;
		-h | --help)
			usage
			return 0
			;;
		*) fail "unknown argument: $1 (settings are environment variables; see --help)" ;;
	esac

	case "$base" in
		https://*) protocols="=https" ;;
		http://127.0.0.1:* | http://127.0.0.1/* | http://localhost:* | http://localhost/*) protocols="=http,https" ;;
		*) fail "MEMTRO_RELEASE_BASE must be an https URL" ;;
	esac
	base="${base%/}"

	if [ -z "${HOME:-}" ] && [ -z "${MEMTRO_INSTALL_DIR:-}" ]; then
		fail "HOME is not set; set MEMTRO_INSTALL_DIR to choose where memtro goes"
	fi
	case "$install_dir" in
		/*) ;;
		*) fail "MEMTRO_INSTALL_DIR must be an absolute path (got $install_dir)" ;;
	esac
	case "$install_dir" in
		*'"'* | *'$'* | *'`'* | *'\'*) fail "the install directory must not contain quotes, \$, \` or \\" ;;
	esac

	detect_platform
	asset="memtro-${os}-${arch}.tar.gz"

	need uname
	need tar
	need mktemp
	need awk
	if command -v curl >/dev/null 2>&1; then
		downloader=curl
	elif command -v wget >/dev/null 2>&1; then
		downloader=wget
	else
		fail "neither curl nor wget is installed; install one and run this again"
	fi
	if command -v sha256sum >/dev/null 2>&1; then
		hasher="sha256sum"
	elif command -v shasum >/dev/null 2>&1; then
		hasher="shasum -a 256"
	else
		fail "neither sha256sum nor shasum is installed, so the download cannot be checked; nothing was installed"
	fi

	trap cleanup EXIT
	trap 'exit 129' HUP
	trap 'exit 130' INT
	trap 'exit 143' TERM
	tmp="$(mktemp -d 2>/dev/null || mktemp -d -t memtro)"

	if [ -n "${MEMTRO_VERSION:-}" ]; then
		version="${MEMTRO_VERSION#v}"
		valid_version "$version" || fail "MEMTRO_VERSION=$MEMTRO_VERSION is not a version (expected something like 0.2.0)"
	else
		say "Finding the latest memtro release..."
		download "$base/latest/download/latest.json" "$tmp/latest.json" || fail "could not find the latest release at $base"
		version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$tmp/latest.json" | head -n 1)"
		valid_version "$version" || fail "the latest release does not name a valid version"
	fi
	tag="v$version"

	say "Downloading memtro $version for $os-$arch..."
	download "$base/download/$tag/checksums.txt" "$tmp/checksums.txt" || fail "could not download checksums.txt for $tag (is there a release $tag?)"
	expected="$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1; exit }' "$tmp/checksums.txt")"
	if [ -z "$expected" ]; then
		fail "release $tag has no build for $os-$arch ($asset)"
	fi
	download "$base/download/$tag/$asset" "$tmp/$asset" || fail "could not download $asset from release $tag"

	actual="$($hasher "$tmp/$asset" | awk '{ print $1 }')"
	if [ "$actual" != "$expected" ]; then
		fail "checksum mismatch for $asset (expected $expected, got $actual); nothing was installed"
	fi

	# The archive must hold exactly one entry, the regular file `memtro`: list it before extracting anything. The
	# verbose listing's first character is the entry's type in both GNU and BSD tar (`-` for a regular file), so a
	# link or device named memtro is refused here too, not only after extraction.
	listing="$(tar -tzf "$tmp/$asset")" || fail "$asset is not a readable archive"
	if [ "$listing" != "memtro" ] && [ "$listing" != "./memtro" ]; then
		fail "$asset holds something other than the single file memtro; nothing was installed"
	fi
	kind="$(tar -tvzf "$tmp/$asset" | awk '{ print substr($0, 1, 1) }')" || fail "$asset is not a readable archive"
	if [ "$kind" != "-" ]; then
		fail "$asset holds something other than a regular file memtro; nothing was installed"
	fi
	mkdir "$tmp/x"
	tar -xzf "$tmp/$asset" -C "$tmp/x"
	if [ ! -f "$tmp/x/memtro" ] || [ -L "$tmp/x/memtro" ]; then
		fail "$asset did not hold a regular file memtro"
	fi

	mkdir -p "$install_dir" || fail "could not create $install_dir"
	# A fresh, unpredictable name: mktemp creates it, so nothing already there (a link) is followed or reused.
	staged="$(mktemp "$install_dir/.memtro-install.XXXXXX")" || fail "could not write to $install_dir"
	cp "$tmp/x/memtro" "$staged" || fail "could not write to $install_dir"
	chmod 755 "$staged"
	# Prove the file that is about to be installed starts, with no Memtro key or profile in its environment.
	reported="$(env -i PATH="${PATH:-/usr/bin:/bin}" HOME="${HOME:-/}" MEMTRO_NO_UPDATE_CHECK=1 "$staged" --version 2>/dev/null)" || reported=""
	if [ "$reported" != "$version" ]; then
		fail "the downloaded memtro did not start (it reported \"$reported\", expected $version); nothing was installed"
	fi

	previous=""
	if [ -f "$install_dir/memtro" ]; then
		previous="$(env -i PATH="${PATH:-/usr/bin:/bin}" HOME="${HOME:-/}" MEMTRO_NO_UPDATE_CHECK=1 "$install_dir/memtro" --version 2>/dev/null || true)"
	fi
	mv -f "$staged" "$install_dir/memtro"
	staged=""

	if [ -n "$previous" ] && [ "$previous" != "$version" ]; then
		say "Replaced memtro $previous with memtro $version at $install_dir/memtro"
	else
		say "Installed memtro $version at $install_dir/memtro"
	fi
	path_advice
}

usage() {
	cat <<'EOF'
Installs memtro, a coding agent in your terminal.

  curl -fsSL https://raw.githubusercontent.com/memtro-org/memtro-cli/main/install.sh | sh

Environment variables:
  MEMTRO_VERSION=0.2.0       install this version instead of the latest
  MEMTRO_INSTALL_DIR=<dir>   install here instead of $HOME/.memtro/bin
  MEMTRO_MODIFY_PATH=1       add the directory to PATH in your shell's startup file
EOF
}

say() {
	printf '%s\n' "$*"
}

fail() {
	printf 'memtro install: %s\n' "$*" >&2
	exit 1
}

need() {
	command -v "$1" >/dev/null 2>&1 || fail "this installer needs $1, which is not installed"
}

cleanup() {
	if [ -n "${staged:-}" ]; then rm -f "$staged"; fi
	if [ -n "${tmp:-}" ]; then rm -rf "$tmp"; fi
}

valid_version() {
	printf '%s\n' "$1" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'
}

download() {
	if [ "$downloader" = curl ]; then
		curl --fail --silent --show-error --location --proto "$protocols" --proto-redir "$protocols" --tlsv1.2 \
			--retry 2 --connect-timeout 20 --output "$2" "$1"
	elif [ "$protocols" = "=https" ]; then
		wget --quiet --https-only --output-document="$2" "$1"
	else
		wget --quiet --output-document="$2" "$1"
	fi
}

detect_platform() {
	kernel="$(uname -s)"
	machine="$(uname -m)"
	case "$kernel" in
		Darwin) os=darwin ;;
		Linux) os=linux ;;
		MINGW* | MSYS* | CYGWIN* | Windows_NT)
			fail "memtro does not run natively on Windows yet; install it inside WSL (https://learn.microsoft.com/windows/wsl/install) and run this there"
			;;
		*) fail "there is no memtro for $kernel; it runs on macOS and Linux" ;;
	esac
	case "$machine" in
		arm64 | aarch64) arch=arm64 ;;
		x86_64 | amd64) arch=x64 ;;
		*) fail "there is no memtro for $kernel on $machine; it runs on arm64 and x86_64" ;;
	esac
	# An x86_64 shell on Apple silicon (Rosetta) still gets the native build.
	if [ "$os" = darwin ] && [ "$arch" = x64 ]; then
		if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ] || [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then
			arch=arm64
		fi
	fi
	if [ "$os" = linux ] && is_musl; then
		fail "this Linux uses musl libc (Alpine or similar); memtro's Linux build needs glibc for now. Use a glibc distribution, or build memtro from source with Node.js (https://github.com/memtro-org/memtro-cli#from-source)"
	fi
}

is_musl() {
	if [ -f /etc/alpine-release ]; then return 0; fi
	for f in /lib/ld-musl-*; do
		if [ -e "$f" ]; then return 0; fi
	done
	if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then return 0; fi
	return 1
}

path_advice() {
	case ":${PATH:-}:" in
		*:"$install_dir":*)
			say "Type memtro to start."
			return 0
			;;
	esac
	shell_name="$(basename "${SHELL:-sh}")"
	if [ -z "${HOME:-}" ]; then
		say ""
		say "$install_dir is not on your PATH. Add it in your shell's startup file:"
		say ""
		say "  export PATH=\"$install_dir:\$PATH\""
		say ""
		return 0
	fi
	case "$shell_name" in
		zsh)
			rc="${ZDOTDIR:-$HOME}/.zshrc"
			line="export PATH=\"$install_dir:\$PATH\""
			;;
		bash)
			if [ "$os" = darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi
			line="export PATH=\"$install_dir:\$PATH\""
			;;
		fish)
			rc="${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"
			line="fish_add_path \"$install_dir\""
			;;
		*)
			rc="$HOME/.profile"
			line="export PATH=\"$install_dir:\$PATH\""
			;;
	esac
	if [ "${MEMTRO_MODIFY_PATH:-}" = 1 ]; then
		if [ -f "$rc" ] && grep -qxF "$line" "$rc"; then
			say "$rc already adds $install_dir to PATH."
		else
			mkdir -p "$(dirname "$rc")"
			printf '\n# memtro\n%s\n' "$line" >>"$rc"
			say "Added $install_dir to PATH in $rc."
		fi
		say "Open a new terminal (or run: $line), then type memtro to start."
	else
		say ""
		say "$install_dir is not on your PATH. Add it by putting this line in $rc:"
		say ""
		say "  $line"
		say ""
		say "(or run this installer with MEMTRO_MODIFY_PATH=1 to have it added). Then open a new terminal and type memtro to start."
	fi
}

main "$@"
