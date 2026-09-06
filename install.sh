#!/usr/bin/env bash
set -e

# Check for uninstall invocation
if [ "$1" = "--uninstall" ] || [ "$1" = "-u" ] || [ "$1" = "uninstall" ]; then
  shift || true
  if command -v forge >/dev/null 2>&1; then
    exec forge uninstall "$@"
  elif [ -x "$HOME/.forge/bin/forge" ]; then
    exec "$HOME/.forge/bin/forge" uninstall "$@"
  else
    echo "Forge binary not found. Cleaning up ~/.forge/bin and shell integration..."
    rm -rf "$HOME/.forge/bin"
    if [ "$1" = "--purge" ] || [ "$2" = "--purge" ]; then
      rm -rf "$HOME/.forge"
      echo "✓ Purged ~/.forge"
    fi
    # Clean shell exports
    for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
      if [ -f "$rc" ] && grep -qs '\.forge/bin' "$rc"; then
        grep -v '\.forge/bin' "$rc" > "${rc}.tmp" && mv "${rc}.tmp" "$rc"
        echo "✓ Cleaned $rc"
      fi
    done
    echo "Forge uninstalled."
    exit 0
  fi
fi

REPO="dilkuwor/forge"

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64|aarch64)
        FILE="forge-darwin-arm64"
        ;;
      x86_64)
        FILE="forge-darwin-x64"
        ;;
      *)
        echo "Error: Unsupported architecture: $ARCH on macOS"
        exit 1
        ;;
    esac
    ;;
  Linux)
    case "$ARCH" in
      x86_64|amd64)
        FILE="forge-linux-x64"
        ;;
      *)
        echo "Error: Unsupported architecture: $ARCH on Linux"
        exit 1
        ;;
    esac
    ;;
  *)
    echo "Error: Unsupported operating system: $OS"
    exit 1
    ;;
esac

INSTALL_DIR="$HOME/.forge/bin"
mkdir -p "$INSTALL_DIR"
TARGET="$INSTALL_DIR/forge"

URL="https://github.com/${REPO}/releases/latest/download/${FILE}"

echo "Downloading forge ($FILE) from GitHub Releases..."
curl -fsSL "$URL" -o "$TARGET"
chmod +x "$TARGET"

EXPORT_LINE='export PATH="$HOME/.forge/bin:$PATH"'

# Append to ~/.zshrc if missing
if [ -f "$HOME/.zshrc" ]; then
  if ! grep -qs '\.forge/bin' "$HOME/.zshrc"; then
    echo "" >> "$HOME/.zshrc"
    echo "$EXPORT_LINE" >> "$HOME/.zshrc"
  fi
fi

# Append to ~/.bashrc if missing
if [ -f "$HOME/.bashrc" ]; then
  if ! grep -qs '\.forge/bin' "$HOME/.bashrc"; then
    echo "" >> "$HOME/.bashrc"
    echo "$EXPORT_LINE" >> "$HOME/.bashrc"
  fi
fi

echo "Successfully installed forge to $TARGET"
echo "restart the terminal, then run forge"
echo ""
echo "To uninstall forge at any time, run: forge uninstall"
