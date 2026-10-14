### 🐛 Bug Fixes

- **server**: An unknown address under `/api` answers with a 404 instead of the page of the app.

### 🔒 Security

- **web**: A download shows and saves the file under a cleaned name, so a sender can no longer disguise its type with characters that reverse the text, like an exe that shows as a pdf.
- **web**: Downloads reach the browser as plain files that it never opens as a page of the instance, whatever type the sender named.
- **server**: The metadata of an upload can only be stored once, also when two requests arrive at the same time.
- **server**: With AWS S3, the content security policy allows downloads from the instance's own bucket only, instead of from every bucket in its region.
- **server**: The password check of a share whose downloads are used up answers that the share is gone, instead of handing out its encrypted metadata until the next cleanup.

### 📝 Documentation

- **docs**: The rate limiting guide says which address of `X-Forwarded-For` counts and what to do behind a CDN.
- **docs**: The API reference lists the answers of the password check and of an unknown address under `/api` as the server gives them.

### 🧪 Tests

- **web**: Unit tests check that a download is saved under a cleaned name as a plain file and that the download service worker forbids the browser to run what it hands over.
- **server**: Unit tests cover metadata sent twice at once, the password check of a used-up share and the content security policy of an AWS S3 bucket.
- **infra**: A test fails when a file in the repository holds an invisible character that changes how code reads, like a right-to-left override.
- **infra**: An end-to-end test checks that an unknown address under `/api` answers with a 404 in JSON.
