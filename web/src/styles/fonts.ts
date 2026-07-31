/**
 * Self-hosted font faces (§4.2), via @fontsource — NOT a CDN. Vite bundles
 * the referenced woff2 files as same-origin, hashed assets under
 * `web/dist/assets/`, which satisfies the server's strict CSP `font-src
 * 'self'` (server/src/app.ts). Only the specific weights actually used are
 * imported.
 */

// Cairo — the app's primary Arabic face for BOTH display/brand and body/UI
// (AR + Latin), the familiar modern Arabic-web look. Weights: 400/500 body,
// 600/700 headings, wordmark, and the brass Seal.
import '@fontsource/cairo/400.css';
import '@fontsource/cairo/500.css';
import '@fontsource/cairo/600.css';
import '@fontsource/cairo/700.css';

// IBM Plex Mono — data/tokens, ASCII only (§4.2: weights 400, 500)
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
