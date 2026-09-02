# Online deployment plan

GitHub Pages jest obecnie publicznym fallbackiem. Docelowy prywatny wariant to Cloudflare Pages z Cloudflare Access; szczegoly i bezpieczna kolejnosc przelaczenia sa w `cloudflare-pages.md`.

Ten wariant uruchamia dashboard jako statyczna strone na GitHub Pages, a GitHub Actions dziala jako cron.

## Co sie dzieje automatycznie

1. Workflow `Stock Radar Update` startuje recznie albo wedlug harmonogramu.
2. Skrypty pobieraja dane FMP i SEC:
   - `scripts/update-monitoring.js`
   - `scripts/generate-deep-dive.js CANDIDATES`
   - `scripts/valuation-scenarios.js`
   - `scripts/generate-sector-radar.js`
   - `scripts/update-elite-flow.js`
3. `scripts/build-online-dashboard.js` buduje folder `site-dist`.
4. GitHub Pages publikuje `site-dist` jako dashboard online.

## Harmonogram

Workflow jest ustawiony na dni robocze o `22:25 UTC`, czyli po zamknieciu rynku USA. W Warszawie to zwykle:

- `23:25` w czasie zimowym,
- `00:25` nastepnego dnia w czasie letnim.

## Konfiguracja GitHub

1. Utworz repozytorium na GitHubie i wrzuc tam projekt.
2. Wejdz w `Settings -> Secrets and variables -> Actions`.
3. Dodaj sekret:
   - Name: `FMP_API_KEY`
   - Value: Twoj klucz FMP
4. Wejdz w `Settings -> Pages`.
5. Ustaw `Build and deployment -> Source` na `GitHub Actions`.
6. Wejdz w `Actions -> Stock Radar Update -> Run workflow`.

Po pierwszym udanym uruchomieniu dashboard bedzie pod adresem:

```text
https://<twoj-login>.github.io/<nazwa-repo>/
```

## Bezpieczenstwo

- `.env` zostaje lokalnie i jest ignorowany przez `.gitignore`.
- Klucz FMP nie jest publikowany w dashboardzie.
- Publiczne GitHub Pages pokaza wygenerowane wyniki i watchlisty kazdemu, kto zna adres.
- Dla prywatnego dostepu lepszy bedzie prywatny GitHub Pages, Cloudflare Pages z Access albo Vercel z autoryzacja.
- Samo ustawienie repozytorium jako prywatne nie zabezpiecza publicznego wdrozenia. Najpierw nalezy uruchomic i sprawdzic Cloudflare Access.

## Pliki online

- `index.html` - glowny dashboard
- `reports.html` - lista raportow
- `stock-map.html` - mapa / eksploracja spolek
- `research/deep-dives/` - deep dive'y kandydatow
- `daily-report.md`, `elite-flow-report.md`, `sec-analysis.md`, `alerts.md`
