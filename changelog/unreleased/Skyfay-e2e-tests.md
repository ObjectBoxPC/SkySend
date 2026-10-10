### 📝 Documentation

- **docs**: The testing guide explains how to run and write the end-to-end tests.

### 🧪 Tests

- **infra**: End-to-end tests share files and notes and send to file requests in Chromium, Firefox and WebKit, then open them on the other side. They check that keys, filenames, passwords and contents never reach the server and that each browser downloads the way it should.

### 🔧 CI/CD

- **infra**: Pull requests run the end-to-end tests in a job of their own, which keeps the screenshots, videos and traces of a failed run for seven days.
