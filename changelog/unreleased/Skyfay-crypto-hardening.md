### 🎨 Improvements

- **crypto**: Decrypted metadata only accepts sizes that are whole numbers.
- **server**: Uploads and notes are only created with auth and owner tokens of exactly 32 bytes.
- **web**: The download service worker passes on a MIME type only when it has the usual form.

### 📝 Documentation

- **docs**: The security pages now say that whoever holds a link can also delete the share through the API.

### 🧪 Tests

- **crypto**: Frozen values pin the auth and owner token derivation, the password box key is checked to be non-extractable, and the base64url decoder is checked to refuse the standard alphabet.
