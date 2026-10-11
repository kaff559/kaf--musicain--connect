#!/bin/sh
set -e

echo "Installing Node.js via Homebrew..."
brew install node

echo "Installing npm dependencies..."
cd "$CI_PRIMARY_REPOSITORY_PATH/mobile"
npm install

echo "Syncing Capacitor web assets and config into the iOS project..."
npx cap sync ios

echo "Installing CocoaPods dependencies..."
cd "$CI_PRIMARY_REPOSITORY_PATH/mobile/ios/App"
pod install

echo "ci_post_clone.sh completed successfully"
