/**
 * Self-hosted font faces (§4.2), via @fontsource — NOT a CDN. Vite bundles
 * the referenced woff2 files as same-origin, hashed assets under
 * `web/dist/assets/`, which satisfies the server's strict CSP `font-src
 * 'self'` (server/src/app.ts). Only the specific weights actually used are
 * imported.
 */

// Reem Kufi — display/brand (§4.2: weights 500, 700)
import '@fontsource/reem-kufi/500.css';
import '@fontsource/reem-kufi/700.css';

// IBM Plex Sans Arabic — body/UI, AR+Latin (§4.2: weights 400, 500, 600)
import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/500.css';
import '@fontsource/ibm-plex-sans-arabic/600.css';

// IBM Plex Mono — data/tokens, ASCII only (§4.2: weights 400, 500)
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
