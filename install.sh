#!/usr/bin/env bash
# One-line installer for opencode-plugin-cc
# Usage (inside Claude Code):
#   ! curl -fsSL https://raw.githubusercontent.com/brian250713/opencode-plugin-cc/main/install.sh | bash
#
# Or clone + run locally:
#   ! bash <(curl -fsSL https://raw.githubusercontent.com/brian250713/opencode-plugin-cc/main/install.sh)

set -euo pipefail

REPO="brian250713/opencode-plugin-cc"
PLUGIN_NAME="opencode"
MARKETPLACE_NAME="brian250713-opencode-plugin-cc"
# Marketplace name used before the repo was detached from tasict/opencode-plugin-cc.
LEGACY_MARKETPLACE_NAME="tasict-opencode-plugin-cc"
BRANCH="main"

CLAUDE_DIR="$HOME/.claude"
MARKETPLACES_DIR="$CLAUDE_DIR/plugins/marketplaces"
CACHE_DIR="$CLAUDE_DIR/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME"
KNOWN_MKT="$CLAUDE_DIR/plugins/known_marketplaces.json"
INSTALLED="$CLAUDE_DIR/plugins/installed_plugins.json"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[opencode-plugin]${NC} $1"; }
warn()  { echo -e "${YELLOW}[opencode-plugin]${NC} $1"; }
error() { echo -e "${RED}[opencode-plugin]${NC} $1"; exit 1; }

# --- Pre-checks ---
[ -d "$CLAUDE_DIR" ] || error "Claude Code directory not found at $CLAUDE_DIR. Is Claude Code installed?"

mkdir -p "$CLAUDE_DIR/plugins/marketplaces" "$CLAUDE_DIR/plugins/cache"

# --- Step 1: Clone marketplace ---
MKT_DIR="$MARKETPLACES_DIR/$MARKETPLACE_NAME"

if [ -d "$MKT_DIR" ]; then
  info "Marketplace already exists, pulling latest..."
  git -C "$MKT_DIR" pull --ff-only origin "$BRANCH" 2>/dev/null || true
else
  info "Cloning marketplace from GitHub..."
  # Try SSH first, fall back to HTTPS
  if git clone --depth 1 -b "$BRANCH" "git@github.com:$REPO.git" "$MKT_DIR" 2>/dev/null; then
    info "Cloned via SSH."
  elif git clone --depth 1 -b "$BRANCH" "https://github.com/$REPO.git" "$MKT_DIR" 2>/dev/null; then
    info "Cloned via HTTPS."
  else
    error "Failed to clone repository. Please check your network and GitHub access."
  fi
fi

# --- Step 2: Read plugin version ---
PLUGIN_JSON="$MKT_DIR/plugins/$PLUGIN_NAME/.claude-plugin/plugin.json"
[ -f "$PLUGIN_JSON" ] || error "plugin.json not found at $PLUGIN_JSON"

# Paths go through argv: Git Bash converts them for a native Windows python3,
# but not when they are embedded in the script text.
VERSION=$(python3 -c "import json, sys; print(json.load(open(sys.argv[1]))['version'])" "$PLUGIN_JSON" 2>/dev/null || echo "1.0.0")
GIT_SHA=$(git -C "$MKT_DIR" rev-parse HEAD 2>/dev/null || echo "unknown")
NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

info "Plugin version: $VERSION (sha: ${GIT_SHA:0:12})"

# --- Step 3: Copy plugin to cache ---
CACHE_VERSION_DIR="$CACHE_DIR/$VERSION"
rm -rf "$CACHE_VERSION_DIR"
mkdir -p "$CACHE_VERSION_DIR"
cp -R "$MKT_DIR/plugins/$PLUGIN_NAME/." "$CACHE_VERSION_DIR/"
info "Plugin cached at $CACHE_VERSION_DIR"

# --- Step 4: Register marketplace in known_marketplaces.json ---
if [ ! -f "$KNOWN_MKT" ]; then
  echo '{}' > "$KNOWN_MKT"
fi

python3 - "$KNOWN_MKT" "$MKT_DIR" <<PY || warn "Could not update known_marketplaces.json (non-fatal)"
import json, os, sys
path, location = sys.argv[1:3]
with open(path, encoding="utf-8") as f:
    data = json.load(f)
data["$MARKETPLACE_NAME"] = {
    "source": {"source": "github", "repo": "$REPO"},
    "installLocation": os.path.normpath(location),
    "lastUpdated": "$NOW",
}
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY

# --- Step 5: Register plugin in installed_plugins.json ---
if [ ! -f "$INSTALLED" ]; then
  echo '{"version": 2, "plugins": {}}' > "$INSTALLED"
fi

python3 - "$INSTALLED" "$CACHE_VERSION_DIR" <<PY || error "Failed to update installed_plugins.json"
import json, os, sys
path, install_path = sys.argv[1:3]
with open(path, encoding="utf-8") as f:
    data = json.load(f)
data.setdefault("plugins", {})["$PLUGIN_NAME@$MARKETPLACE_NAME"] = [{
    "scope": "user",
    "installPath": os.path.normpath(install_path),
    "version": "$VERSION",
    "installedAt": "$NOW",
    "lastUpdated": "$NOW",
    "gitCommitSha": "$GIT_SHA",
}]
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY

# --- Step 6: Migrate from the legacy marketplace name ---
# Without this, an existing install keeps loading next to the new one (every
# /opencode:* command twice), and the companion loses its data dir, including
# the server password a still-running `opencode serve` was started with.
LEGACY_DATA="$CLAUDE_DIR/plugins/data/$PLUGIN_NAME-$LEGACY_MARKETPLACE_NAME"
NEW_DATA="$CLAUDE_DIR/plugins/data/$PLUGIN_NAME-$MARKETPLACE_NAME"
if [ -d "$LEGACY_DATA" ] && [ ! -e "$NEW_DATA" ]; then
  mv "$LEGACY_DATA" "$NEW_DATA" && info "Moved plugin data to $NEW_DATA"
fi

LEGACY_MKT_DIR="$MARKETPLACES_DIR/${LEGACY_MARKETPLACE_NAME:?}"
LEGACY_CACHE_DIR="$CLAUDE_DIR/plugins/cache/${LEGACY_MARKETPLACE_NAME:?}"
if [ -d "$LEGACY_MKT_DIR" ] || [ -d "$LEGACY_CACHE_DIR" ]; then
  rm -rf "$LEGACY_MKT_DIR" "$LEGACY_CACHE_DIR"
  info "Removed legacy $LEGACY_MARKETPLACE_NAME marketplace files."
fi

python3 - "$KNOWN_MKT" "$INSTALLED" "$CLAUDE_DIR/settings.json" <<PY || warn "Could not migrate legacy plugin registration (non-fatal)"
import json, os, sys
known, installed, settings = sys.argv[1:4]
old_mkt, new_mkt = "$LEGACY_MARKETPLACE_NAME", "$MARKETPLACE_NAME"
old_plugin, new_plugin = "$PLUGIN_NAME@" + old_mkt, "$PLUGIN_NAME@" + new_mkt

def update(path, fn):
    if not os.path.isfile(path):
        return
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if fn(data):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")

def known_fn(d):
    return d.pop(old_mkt, None) is not None

def installed_fn(d):
    return d.get("plugins", {}).pop(old_plugin, None) is not None

def settings_fn(d):
    changed = False
    enabled = d.get("enabledPlugins")
    if isinstance(enabled, dict) and old_plugin in enabled:
        enabled.setdefault(new_plugin, enabled.pop(old_plugin))
        changed = True
    extra = d.get("extraKnownMarketplaces")
    if isinstance(extra, dict) and old_mkt in extra:
        extra.pop(old_mkt)
        extra.setdefault(new_mkt, {"source": {"source": "github", "repo": "$REPO"}})
        changed = True
    return changed

update(known, known_fn)
update(installed, installed_fn)
update(settings, settings_fn)
PY

# --- Done ---
echo ""
info "Installation complete!"
echo ""
echo -e "  ${GREEN}Next step:${NC} Run this command inside Claude Code:"
echo ""
echo -e "    ${YELLOW}/reload-plugins${NC}"
echo ""
echo -e "  Then verify with:"
echo ""
echo -e "    ${YELLOW}/opencode:setup${NC}"
echo ""
