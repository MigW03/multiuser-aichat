#!/bin/sh
# Wraps the release binary in a minimal .app so macOS treats it as a normal app (Dock icon, app switcher).
set -e
cd "$(dirname "$0")/.."
cargo build --release
APP=target/MultiuserChat.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp target/release/multiuser-chat "$APP/Contents/MacOS/"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Multiuser Chat</string>
  <key>CFBundleIdentifier</key><string>com.migw03.multiuserchat</string>
  <key>CFBundleExecutable</key><string>multiuser-chat</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
echo "Built $APP"
