### 🔧 CI/CD

- **infra**: Pull requests into dev build the Docker image and the CLI binaries whenever their changes reach them, and pull requests into main always build both, without waiting for an approval.
- **infra**: The CLI binaries are built with a fixed version of Bun instead of the newest one, whose lookup failed the Windows build of a release.
