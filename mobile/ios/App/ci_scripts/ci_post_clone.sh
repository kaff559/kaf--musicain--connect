#!/bin/sh
set -e

echo "Installing Node.js via Homebrew..."
brew install node

echo "Installing npm dependencies..."
cd "$CI_PRIMARY_REPOSITORY_PATH/mobile"
npm install

echo "Installing CocoaPods dependencies..."
cd "$CI_PRIMARY_REPOSITORY_PATH/mobile/ios/App"
pod install

echo "ci_post_clone.sh completed successfully"
