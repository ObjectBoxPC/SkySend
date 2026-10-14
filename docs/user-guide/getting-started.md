# Getting Started

SkySend is a minimalist, self-hostable, end-to-end encrypted service for sharing files and notes. The server stores ciphertext and never has access to a key, a file name or the content of a note.

## What is SkySend?

SkySend shares files and notes so that only the recipient can read them. Everything is encrypted in your browser before it leaves your device, and the key travels in the URL fragment (`#`), which browsers never send to the server.

- **No accounts** - No registration, no login. My Links keeps track of your shares in the browser.
- **No tracking** - No telemetry, no analytics
- **One container** - Docker with an SQLite database, files on disk or in an S3-compatible bucket
- **No trust required** - The server is cryptographically blind to your data

What you can share:

- **Files and folders** - One file, several at once or a whole folder, zipped in the browser before encryption
- **Notes** - Made of blocks, so text, Markdown, passwords, code and SSH keys can be combined in one note
- **File requests** - An upload link for someone else. The files or the note they send are encrypted for you alone, see [File Requests](/user-guide/file-requests).

Every share is deleted after a set time, or earlier once it reaches its limit of downloads or views. A note can burn after reading, and an optional password adds a second factor on top of the link.

## How It Works

```
1. You select a file in your browser
2. A 256-bit secret is generated, and HKDF derives separate keys from it
3. The file is encrypted (AES-256-GCM) in your browser, its name and size separately
4. The ciphertext is uploaded to the server
5. You get a share link: https://your-instance.com/file/<id>#<secret>
6. The recipient opens the link
7. Their browser reads the secret from the URL fragment
8. The ciphertext is downloaded and decrypted in their browser
```

The server only ever sees ciphertext. The secret lives exclusively in the URL fragment, which browsers never send to the server (per the HTTP specification). [Encryption Design](/user-guide/security/encryption) covers the details.

## Quick Start

Take the Compose file from [Installation](/user-guide/installation#docker-installation), then start it:

```bash
docker compose up -d
```

Then open [http://localhost:3000](http://localhost:3000). Only `BASE_URL` is required, see [Environment Variables](/user-guide/configuration/environment-variables).

## Next Steps

- [Installation](/user-guide/installation) - Different ways to deploy SkySend
- [First Steps](/user-guide/first-steps) - Upload your first file
- [File Requests](/user-guide/file-requests) - Let someone send you files
- [CLI Client](/user-guide/client-cli/) - Upload and download from the terminal
- [Docker Setup](/user-guide/self-hosting/docker) - Detailed Docker configuration
- [Configuration](/user-guide/configuration/environment-variables) - All environment variables
