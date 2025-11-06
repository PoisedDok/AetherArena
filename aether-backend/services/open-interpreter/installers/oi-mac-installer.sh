#!/bin/bash
set -e

echo "Starting Open Interpreter installation..."
sleep 2
echo "This will take approximately 5 minutes..."
sleep 2

# Define pyenv paths and environment
PYENV_ROOT="$HOME/.pyenv"
PATH="$PYENV_ROOT/bin:$PATH"

# Check if Git is installed
if command -v git >/dev/null; then
    echo "Git is already installed."
else
    # Detect the operating system
    OS="$(uname -s)"

    case "$OS" in
        Linux)
            # Assume a Debian-based or Fedora-based system
            if command -v apt >/dev/null; then
                echo "Installing Git on Debian-based Linux..."
                # Check and install sudo if not present
                if ! command -v sudo &> /dev/null; then
                    apt-get update && apt-get install -y sudo
                fi
                sudo apt install -y git-all
            elif command -v dnf >/dev/null; then
                echo "Installing Git on Fedora-based Linux..."
                # Check and install sudo if not present
                if ! command -v sudo &> /dev/null; then
                    dnf install -y sudo
                fi
                sudo dnf install -y git-all
            else
                echo "Package manager not supported. Please install Git manually."
            fi
            ;;
        Darwin)
            echo "Installing Git on macOS..."
            # Install Git using Xcode Command Line Tools
            xcode-select --install
            ;;
        *)
            echo "Unsupported OS: $OS"
            ;;
    esac
fi

echo "Starting installation of pyenv..."

INSTALL_URL="https://pyenv.run"

# Check if pyenv is already installed
if command -v pyenv &> /dev/null; then
    echo "pyenv is already installed."
else
    # Try to download and install pyenv using available commands
    if command -v curl &> /dev/null; then
        echo "Using curl to download pyenv..."
        curl -L "$INSTALL_URL" | bash
    else
        echo "Neither curl nor wget is available."
        if [ "$(uname -s)" = "Linux" ]; then
            echo "Linux detected. Attempting to install sudo and curl..."

            # Check and install sudo if not present
            if ! command -v sudo &> /dev/null; then
                apt-get update && apt-get install -y sudo
            fi

            # Install curl using sudo
            if command -v sudo &> /dev/null; then
                sudo apt-get update && sudo apt-get install -y curl
                if command -v curl &> /dev/null; then
                    echo "Using curl to download pyenv..."
                    curl -L "$INSTALL_URL" | bash
                else
                    echo "Failed to install curl. Installation of pyenv cannot proceed."
                fi
            else
                echo "Unable to install sudo. Manual installation required."
            fi
        else
            echo "Failed to install curl. Installation of pyenv cannot proceed."
        fi
    fi
fi

# Setup pyenv in current shell
export PYENV_ROOT="$HOME/.pyenv"
export PATH="$PYENV_ROOT/bin:$PATH"
eval "$(pyenv init --path)"
eval "$(pyenv init -)"

# On macOS, ensure we have the necessary dependencies for Python building
if [ "$(uname -s)" = "Darwin" ]; then
    echo "Installing Python build dependencies on macOS..."
    if command -v brew &> /dev/null; then
        brew install openssl readline sqlite3 xz zlib tcl-tk
    else
        echo "Homebrew not found. Installing Homebrew..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        brew install openssl readline sqlite3 xz zlib tcl-tk
    fi
fi

# Install Python and remember the version
python_version=3.11
echo "Installing Python ${python_version}..."
pyenv install $python_version --skip-existing

# Set this version as global
pyenv global $python_version

# Verify Python installation
installed_version=$(pyenv which python)
echo "Using Python at: $installed_version"
pyenv version

# Use the specific Python version to install open-interpreter
pyenv exec pip install open-interpreter

# Create a simple wrapper script in /usr/local/bin if it doesn't exist
if [ ! -f "/usr/local/bin/interpreter" ]; then
    echo "Creating interpreter wrapper script with local mode enabled by default..."
    echo '#!/bin/bash
export PYENV_ROOT="$HOME/.pyenv"
export PATH="$PYENV_ROOT/bin:$PATH"
eval "$(pyenv init --path)"
eval "$(pyenv init -)"
pyenv exec interpreter --local "$@"' | sudo tee /usr/local/bin/interpreter > /dev/null
    sudo chmod +x /usr/local/bin/interpreter
fi

# Create default profile directory and configuration
mkdir -p "$HOME/.config/interpreter/profiles"
if [ ! -f "$HOME/.config/interpreter/profiles/default.yaml" ]; then
    echo "Creating default profile with local mode enabled..."
    echo "# Open Interpreter default configuration
offline: true
local: true
auto_run: false
# You can adjust these based on your local model's capabilities
max_tokens: 1000
context_window: 3000" | tee "$HOME/.config/interpreter/profiles/default.yaml" > /dev/null
fi

echo "Open Interpreter has been installed with local mode enabled by default."
echo "Run the following command to use it:"
echo "interpreter"
echo ""
echo "For best results, add these lines to your ~/.zshrc or ~/.bash_profile:"
echo 'export PYENV_ROOT="$HOME/.pyenv"'
echo 'export PATH="$PYENV_ROOT/bin:$PATH"'
echo 'eval "$(pyenv init --path)"'
echo 'eval "$(pyenv init -)"'
echo ""
echo "To modify the default configuration, edit:"
echo "$HOME/.config/interpreter/profiles/default.yaml"