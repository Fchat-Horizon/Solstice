#!/bin/bash

# Script to bump version numbers in package.json files
# Usage: ./bump_version.sh [--tag]
#   --tag: Skip version update and just create a git tag for the current version

# Colors for better output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Flag for tag-only mode
TAG_ONLY=false

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --tag)
      TAG_ONLY=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: ./bump_version.sh [--tag]"
      echo "  --tag: Skip version update and just create a git tag for the current version"
      exit 1
      ;;
  esac
done

# Check if jq is installed (required for JSON manipulation)
if ! command -v jq &> /dev/null; then
    echo -e "${YELLOW}Error: jq is not installed.${NC}"
    echo "jq is required for JSON manipulation."
    echo "Please install jq first:"
    echo "  - On Debian/Ubuntu: sudo apt install jq"
    echo "  - On Fedora: sudo dnf install jq"
    echo "  - On Arch Linux: sudo pacman -S jq"
    echo "  - On macOS: brew install jq"
    exit 1
fi

# Check if node is installed (required to run the version-sync script)
if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}Error: node is not installed.${NC}"
    echo "node is required to sync the electron, mobile, and Android versions."
    exit 1
fi

# Paths to version-bearing files
ROOT_PACKAGE="package.json"
ELECTRON_PACKAGE="electron/package.json"
SYNC_SCRIPT="scripts/sync-electron-version.js"

# Check if files exist
if [ ! -f "$ROOT_PACKAGE" ]; then
    echo -e "${YELLOW}Error: $ROOT_PACKAGE not found.${NC}"
    exit 1
fi

if [ ! -f "$ELECTRON_PACKAGE" ]; then
    echo -e "${YELLOW}Error: $ELECTRON_PACKAGE not found.${NC}"
    exit 1
fi

# Get current versions
ROOT_CURRENT_VERSION=$(jq -r '.version' "$ROOT_PACKAGE")
ELECTRON_CURRENT_VERSION=$(jq -r '.version' "$ELECTRON_PACKAGE")

echo -e "Current versions:"
echo -e "  Root package.json: ${GREEN}$ROOT_CURRENT_VERSION${NC}"
echo -e "  Electron package.json: ${GREEN}$ELECTRON_CURRENT_VERSION${NC}"
echo

# If versions don't match, warn the user
if [[ "$ROOT_CURRENT_VERSION" != "$ELECTRON_CURRENT_VERSION" ]]; then
    echo -e "${YELLOW}Warning: Version mismatch between package.json files!${NC}"
    echo -e "Please run this script without --tag first to sync versions."
    
    if [[ "$TAG_ONLY" == true ]]; then
        read -p "Do you want to continue tagging with root package.json version ($ROOT_CURRENT_VERSION)? (y/n): " VERSION_MISMATCH_CONFIRM
        if [[ ! $VERSION_MISMATCH_CONFIRM =~ ^[Yy]$ ]]; then
            echo "Operation cancelled."
            exit 0
        fi
    fi
fi

# Set NEW_VERSION to current version if in tag-only mode
if [[ "$TAG_ONLY" == true ]]; then
    NEW_VERSION=$ROOT_CURRENT_VERSION
else
    # Ask for the new version
    read -p "Enter new version number (e.g., 1.30.1): " NEW_VERSION

    # Validate input (basic validation)
    if [[ ! $NEW_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
        echo -e "${YELLOW}Error: Invalid version format. Expected format: X.Y.Z or X.Y.Z-tag${NC}"
        exit 1
    fi

    # Confirm the change
    echo
    echo -e "Will update version from ${GREEN}$ROOT_CURRENT_VERSION${NC} to ${GREEN}$NEW_VERSION${NC} across all version files (root, electron, mobile, Android)."
    read -p "Continue? (y/n): " CONFIRM

    if [[ ! $CONFIRM =~ ^[Yy]$ ]]; then
        echo "Operation cancelled."
        exit 0
    fi

    # Update versions
    echo "Updating versions..."

    # Update root package.json
    jq ".version = \"$NEW_VERSION\"" "$ROOT_PACKAGE" > "$ROOT_PACKAGE.tmp" && mv "$ROOT_PACKAGE.tmp" "$ROOT_PACKAGE"

    # Sync the remaining version-bearing files from the root version:
    #   electron/package.json, mobile/package.json, and the Android
    #   build.gradle (versionName + incremented versionCode).
    node "$SYNC_SCRIPT" "$NEW_VERSION"

    # Check if updates were successful
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ Successfully updated version to $NEW_VERSION across all version files.${NC}"
    else
        echo -e "${YELLOW}Error: Failed to update one or more version files.${NC}"
        exit 1
    fi
fi

# Check if git is available
if command -v git &> /dev/null; then
    # If we are in tag-only mode, skip to tagging
    if [[ "$TAG_ONLY" == true ]]; then
        echo -e "Tag-only mode: Creating git tag for current version v$NEW_VERSION"
    else
        echo
        # Ask if user wants to git add and commit
        read -p "Do you want to git add and commit these changes? (y/n): " GIT_CONFIRM
        
        if [[ $GIT_CONFIRM =~ ^[Yy]$ ]]; then
            echo -e "${BLUE}Running git add...${NC}"
            git add "$ROOT_PACKAGE" "$ELECTRON_PACKAGE" mobile/package.json mobile/android/app/build.gradle
            
            if [ $? -eq 0 ]; then
                echo -e "${BLUE}Running git commit...${NC}"
                git commit -m "Bump version to $NEW_VERSION"
                
                if [ $? -eq 0 ]; then
                    echo -e "${GREEN}✓ Successfully committed version bump to $NEW_VERSION${NC}"
                else
                    echo -e "${YELLOW}Warning: Failed to commit changes.${NC}"
                    exit 1
                fi
            else
                echo -e "${YELLOW}Warning: Failed to add files to git.${NC}"
                exit 1
            fi
        else
            echo
            echo -e "Changes were not committed. If you want to commit them later:"
            echo -e "  git add package.json electron/package.json mobile/package.json mobile/android/app/build.gradle"
            echo -e "  git commit -m \"Bump version to $NEW_VERSION\""
            echo -e "  git tag -a \"v$NEW_VERSION\" -m \"Version $NEW_VERSION\""
            exit 0
        fi
    fi
    
    # Ask if user wants to create a git tag
    if [[ "$TAG_ONLY" == true ]]; then
        TAG_CONFIRM="y"
    else
        echo
        read -p "Do you want to create a git tag for v$NEW_VERSION? (y/n): " TAG_CONFIRM
    fi
    
    if [[ $TAG_CONFIRM =~ ^[Yy]$ ]]; then
        echo -e "${BLUE}Creating git tag v$NEW_VERSION...${NC}"
        git tag -a "v$NEW_VERSION" -m "Version $NEW_VERSION"
        
        if [ $? -eq 0 ]; then
            echo -e "${GREEN}✓ Successfully created git tag v$NEW_VERSION${NC}"
            echo -e "To push the tag to remote, use: ${BLUE}git push origin v$NEW_VERSION${NC}"
        else
            echo -e "${YELLOW}Warning: Failed to create git tag.${NC}"
        fi
    fi
else
    echo
    echo -e "Git not found. You may want to manually commit these changes:"
    echo -e "  git add package.json electron/package.json mobile/package.json mobile/android/app/build.gradle"
    echo -e "  git commit -m \"Bump version to $NEW_VERSION\""
    echo -e "  git tag -a \"v$NEW_VERSION\" -m \"Version $NEW_VERSION\""
fi