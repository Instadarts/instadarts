# InstaDarts — standalone archive

This archive contains the server and browser app in `instadarts.mjs`, with their dependencies
included. No npm installation or build step is needed.

## Run

1. Install Node.js 22.22.0 or newer.
2. Extract the entire archive and open a terminal in the extracted folder.
3. Start the server:

   ```sh
   node instadarts.mjs
   ```

Open one of the addresses printed in the terminal. The default ports are 3000 for HTTP and 3001
for HTTPS. Use a printed HTTPS address on scoring phones so their browsers can access the camera.
The default certificate is self-signed: verify that the address belongs to your server before
accepting the browser's certificate warning.

On the match screen, select **Pair a Scoring Device** and scan its QR code with the scoring phone.
Follow the phone's setup steps, then create a local or online match on the match screen.
Keep the server terminal open while playing; press Ctrl+C to stop. Matches are stored in memory
and are lost when the server stops.

## Configure

Settings are optional. Copy [instadarts.config.example.jsonc](instadarts.config.example.jsonc) to
`instadarts.config.jsonc` beside `instadarts.mjs`, edit the settings you need, and restart the server.
The example explains ports, certificates, capacity, scoring and media options. A custom settings
file can also be selected through the `INSTADARTS_CONFIG` environment variable.

## Licenses

InstaDarts is licensed under the GNU AGPL v3; see [LICENSE](LICENSE). Bundled dependencies and their
licenses are listed in [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).
