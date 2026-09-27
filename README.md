# Spacetime Glitchography

Planetary generative glitch dioramas (single-page WebGPU app).

## Local

```bash
npm run dev
# → http://localhost:4177
```

## Deploy

```bash
npm run deploy
```

## Source

- `index.html` / `spacetime-glitchography.html` — main app

## Analytics

Vercel Web Analytics + Speed Insights are enabled on production.
Custom events: `autogenerate`, `seed_change`, `proof`, `archive`, `recall`, `reset`, `audio_toggle`, `param_change`, `param_dice`, `archetype_change`.
View data: Vercel Dashboard → spacetime-glitchography → Analytics.

## Links, birthday specimens and print editions

| URL | What it does |
|---|---|
| `?seed=48291` | Opens a specific world. |
| `?birthday=1991-03-14` | Birthday specimen. The seed is `YYYYMMDD`, the three inks come from the month's birthstone, and the dials are locked so a date always gives the same world. Add `&name=Ada` to print a name on the certificate. |
| `?studio` | Owner mode. **PRINT 6K** works without sealing. Add `&autoprint` to download the print automatically once the world renders, which suits batch rendering. Add `&px=8192` to force a size. |

**PRINT 6K** renders the square at the largest size the GPU allows: 6144px, then 4096px on desktop, and 3072px on iPad and phones because iOS caps canvas size. It stamps a certificate strip under the image with the designation, name, seed, class, birthday and provenance, then downloads the PNG. A blank frame is detected and retried at the next size down. A lost GPU device asks for a reload.

**Seed editions** (`seedgate.js`, `seedgate-ui.js`): set `SEAL.payee` in `index.html` to the address `mrio.eth` resolves to, and the print button becomes **SEAL & PRINT 6K · 0.002 ETH**. The first valid payment on Base whose memo names a seed claims that world. The claim unlocks the print, and the transaction is stamped onto the certificate. While the payee is still the zero-address placeholder, public visitors see "PRINT EDITIONS SOON" and nothing can be sent. Test on Base Sepolia first (`chainId: 84532`).
