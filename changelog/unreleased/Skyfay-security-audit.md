### 🔒 Security

- **web**: A download shows and saves the file under a cleaned name, so a sender can no longer disguise its type with characters that reverse the text, like an exe that shows as a pdf.
- **web**: Downloads reach the browser as plain files that it never opens as a page of the instance, whatever type the sender named.
- **server**: The metadata of an upload can only be stored once, also when two requests arrive at the same time.
- **server**: With AWS S3, the content security policy allows downloads from the instance's own bucket only, instead of from every bucket in its region.

### 📝 Documentation

- **docs**: The rate limiting guide says which address of `X-Forwarded-For` counts and what to do behind a CDN.

### 🧪 Tests

- **web**: Unit tests check that a download is saved under a cleaned name as a plain file and that the download service worker forbids the browser to run what it hands over.
- **server**: Unit tests cover metadata sent twice at once and the content security policy of an AWS S3 bucket.
