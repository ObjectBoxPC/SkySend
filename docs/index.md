---
layout: home

hero:
  name: "SkySend"
  text: "Encrypted File & Note Sharing"
  tagline: End-to-end encrypted and self-hostable. Everything is encrypted in the browser, and the key never reaches the server.
  image:
    src: /logo.svg
    alt: SkySend
  actions:
    - theme: brand
      text: Get Started
      link: /user-guide/getting-started
    - theme: alt
      text: Developer Guide
      link: /developer-guide/
    - theme: alt
      text: Public Instances
      link: /instances

features:
  - icon: 🐳
    title: Self-Hosting
    details: One Docker container with SQLite, behind the reverse proxy you already run.
    link: /user-guide/self-hosting/docker
    linkText: Docker setup
  - icon: ⚙️
    title: Configuration
    details: Every environment variable, S3 storage, OIDC sign-in, upload limits and quotas.
    link: /user-guide/configuration/environment-variables
    linkText: Environment variables
  - icon: 📥
    title: File Requests
    details: Send someone an upload link. The files or the note they send are encrypted for you alone.
    link: /user-guide/file-requests
    linkText: Create a request
  - icon: 💻
    title: CLI Client
    details: Upload, download and notes from the terminal with the same encryption, plus an interactive TUI.
    link: /user-guide/client-cli/
    linkText: Install the CLI
  - icon: 🔒
    title: Security Design
    details: How the keys are derived, what is encrypted and what the server gets to see.
    link: /user-guide/security/encryption
    linkText: Encryption design
  - icon: 🛠️
    title: Troubleshooting
    details: The errors self-hosters actually hit, each with its cause and its fix.
    link: /user-guide/troubleshooting
    linkText: Find a fix
---

## Quick Start

::: code-group

```yaml [Docker Compose]
services:
  skysend:
    image: skyfay/skysend:latest
    container_name: skysend
    restart: always
    ports:
      - "3000:3000"
    volumes:
      - ./data:/data
      - ./uploads:/uploads
    environment:
      - BASE_URL=http://localhost:3000
```

```bash [Docker Run]
docker run -d --name skysend -p 3000:3000 \
  -e BASE_URL=http://localhost:3000 \
  -v "$(pwd)/data:/data" \
  -v "$(pwd)/uploads:/uploads" \
  skyfay/skysend:latest
```

:::

Then open [http://localhost:3000](http://localhost:3000). Only `BASE_URL` is required, the [environment variables](/user-guide/configuration/environment-variables) cover everything else.

The [CLI client](/user-guide/client-cli/) installs with one line:

::: code-group

```bash [Linux / macOS]
curl -fsSL https://skysend.app/install.sh | sh
```

```powershell [Windows (PowerShell)]
irm https://skysend.app/install.ps1 | iex
```

:::

## New to SkySend?

[skysend.app](https://skysend.app) shows what it does, and [Getting Started](/user-guide/getting-started) explains how it works. The [README](https://github.com/Skyfay/SkySend) on GitHub covers how SkySend is built and tested.
