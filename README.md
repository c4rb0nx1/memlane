# Memlane

## Install

Check whether Memlane is already installed:

```sh
memlane --help
```

If that works, skip the install steps. Otherwise install from the public repo
outside the worktree you want to initialize:

```sh
mkdir -p ~/tools
git clone https://github.com/c4rb0nx1/memlane.git ~/tools/memlane
cd ~/tools/memlane
npm install
npm run build
npm install -g .
```

## Initialize

From the root of the target worktree:

```sh
memlane init --name <short-workstream-id> --gist "<one-line summary>"
```

If local Ollama support was requested and Ollama is already working:

```sh
memlane init --name <short-workstream-id> --gist "<one-line summary>" --with-ollama
```

Restart the agent or client after initialization.
