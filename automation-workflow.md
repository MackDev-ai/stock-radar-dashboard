# Automatyczny pipeline monitoringu spolek

Cel: codziennie aktualizowac radar spolek, wykrywac zmiany, generowac dashboard i raporty researchowe bez recznego zbierania danych. System nie podejmuje decyzji inwestycyjnych. Ma filtrowac szum i wskazywac, co trzeba przeczytac.

## 1. Warstwy systemu

### Warstwa A - konfiguracja

Pliki:

- `monitoring-config.json` - watchlista, progi alertow, tickery Yahoo/FMP, teza, ryzyko.
- `research-decisions.csv` - reczna kolejka decyzji: Candidate, Waiting, Monitor, Needs review.
- `monitoring-events.csv` - kalendarz wynikow, konferencji, dat przegladu.
- `manual-fundamentals.csv` - opcjonalne fundamenty, gdy darmowy FMP nie daje ratios/statements.
- `political-trades.csv` - reczny import transakcji politykow z House/Senate/OGE albo agregatorow.

Zasada: konfiguracja i decyzje sa jawne w plikach. Automat moze liczyc score, ale nie powinien sam trwale zmieniac decyzji bez recznej kontroli.

### Warstwa B - pobieranie danych

Aktualne zrodla:

- Yahoo Chart - ceny dzienne, 52w high/low, momentum, zmiennosc.
- FMP free profile - market cap, beta, sektor, industry, profil spolki.
- SEC EDGAR - 10-K, 10-Q, 8-K, 20-F, 6-K i tekst filingow.
- SEC EDGAR Form 4 - insider buys/sells dla spolek z watchlisty.
- Manual CSV - ratios/wycena, jesli brak dostepu API.

SEC ma limit ruchu. Moduly SEC powinny pracowac wolno i stabilnie: niewiele dokumentow na ticker, opoznienie miedzy requestami i cache stanu w `data/`.

Kontrola limitow FMP:

- Profil i fundamenty sa odtwarzane z ostatniego publicznego snapshotu oraz lokalnego cache.
- Dzisiejszy limit 60 oznacza liczbe spolek w rotacji deep, a nie 60 requestow; jedna spolka moze wymagac kilku endpointow.
- Dane deep z poprzednich rotacji pozostaja przy spolce, dlatego pokrycie calego uniwersum narasta z dnia na dzien.
- Dashboard pokazuje liczbe faktycznych requestow FMP z kazdego przebiegu.
- Ceny nie ida przez FMP, wiec nie zuzywaja limitu API FMP.

### Warstwa C - obliczenia

Skrypt:

```powershell
node .\scripts\update-monitoring.js
```

Liczy:

- drawdown od high 52w,
- momentum 5/20/60/120/252d,
- volatility 60d annualized,
- alerty cenowe,
- alerty fundamentalne, jesli dane sa dostepne,
- slowa-klucze w najnowszym filing SEC,
- `researchScore` 0-100,
- `nextStep`: DEEP_DIVE, CHECK_PULLBACK, RISK_REVIEW, READ_FILING, TRACK,
- decyzje z `research-decisions.csv`.

Wyniki:

- `data/monitoring-data.js`
- `data/monitoring-history.json`
- `data/alerts.json`
- `daily-report.md`
- `alerts.md`
- `new-filings.md`
- `sec-analysis.md`
- `elite-flow-report.md`

### Warstwa D - dashboard

Plik:

- `monitoring-dashboard.html`

Widoki:

- metryki portfela radarowego,
- Top radar,
- Agenda dzienna,
- tabela watchlisty,
- filtry po statusie, akcji, kroku i decyzji,
- szczegoly spolki,
- linki SEC,
- elite flow z Form 4,
- wykres ceny.

### Warstwa E - deep dive

Skrypt:

```powershell
node .\scripts\generate-deep-dive.js DECISIONS
```

Tryby:

- `ETN` - pojedyncza spolka.
- `CANDIDATES` - tylko status Candidate.
- `DECISIONS` - kanoniczna kolejka decyzji uzywana przez automatyczny pipeline.
- `ALL` - cala watchlista.

Wyniki:

- `research/deep-dives/*.md`

### Warstwa F - wycena scenariuszowa

Skrypt:

```powershell
node .\scripts\valuation-scenarios.js
```

Wynik:

- `research/valuation-scenarios.md`

Na razie model ma ETN. Kolejne spolki trzeba dodac po zebraniu guidance/EPS/FCF.

### Warstwa G - elite flow

Skrypt:

```powershell
node .\scripts\update-elite-flow.js
```

Automatycznie:

- sprawdza najnowsze SEC Form 4 dla spolek z watchlisty,
- wyciaga insider buys, sells, grants i option exercises,
- liczy prosty score sygnalu,
- laczy sygnal z drawdownem i statusem distressed,
- zapisuje `data/elite-flow-data.js` i `elite-flow-report.md`.

Ręcznie:

- `political-trades.csv` sluzy do wpisow z House/Senate/OGE albo agregatorow.
- Polityczne disclosures sa opoznione, wiec traktujemy je jako sygnal sektorowy, nie timing.

## 2. Obecny automatyczny przebieg

`run-monitoring.ps1` uruchamia teraz:

```powershell
node .\scripts\update-monitoring.js
node .\scripts\generate-deep-dive.js DECISIONS
node .\scripts\valuation-scenarios.js
node .\scripts\generate-sector-radar.js
node .\scripts\update-elite-flow.js
```

Czyli jedno odpalenie:

1. Pobiera dane.
2. Aktualizuje dashboard.
3. Aktualizuje alerty.
4. Aktualizuje raport dzienny.
5. Generuje deep dive dla kandydatow.
6. Generuje scenariusze wyceny.
7. Generuje sektorowy radar okazji.
8. Generuje elite-flow report dla insiderow i recznych political trades.

## 3. Harmonogram

### Tryby GitHub Actions

Sa trzy osobne tryby publikacji:

- `Stock Radar Update` (`.github/workflows/stock-radar.yml`) - pełny skan. Pobiera FMP/SEC/ceny, generuje deep dive, wyceny, sector radar, elite flow, wysyła Telegram i publikuje dashboard.
- `Dashboard UI Deploy` (`.github/workflows/dashboard-ui.yml`) - szybki deploy UI. Nie odpytuje FMP/SEC i nie wysyła Telegrama. Buduje dashboard z ostatnich zapisanych danych i publikuje GitHub Pages.
- `Cloudflare Pages Deploy` (`.github/workflows/cloudflare-pages.yml`) - reczny zapasowy deploy ostatniego poprawnego snapshotu; nie uruchamia drugiego skanu rynku.

Zasada operacyjna: po zmianie HTML/CSS/JS dashboardu używać `Dashboard UI Deploy`; po zmianie danych, scoringu, universe albo raportów używać `Stock Radar Update`.

### Codziennie po zamknieciu rynku

Uruchamia Windows Task Scheduler:

- task: `Codex Stock Monitoring Dashboard`
- plik: `run-monitoring.ps1`
- godzina: 18:15 lokalnie

To wystarczy dla danych dziennych i SEC.

### Tygodniowo

Ręcznie albo dodatkowym taskiem:

- przejrzec `daily-report.md`,
- przejrzec `elite-flow-report.md`,
- otworzyc dashboard,
- sprawdzic `Candidate` i `Needs review`,
- uaktualnic `research-decisions.csv`.

### Miesiecznie / po wynikach

- uzupelnic `manual-fundamentals.csv`,
- dodac scenariusze wyceny dla kolejnych spolek,
- przepisac `decision_note` i `invalidation_trigger`.

## 4. Docelowy workflow decyzyjny

1. Automat znajduje ruchy ceny, filing SEC i ranking.
2. Dashboard pokazuje `Top radar`.
3. `daily-report.md` mowi, co trzeba przeczytac.
4. Deep dive zbiera dane w jednym miejscu.
5. Czlowiek zmienia `research-decisions.csv`.
6. Kolejny przebieg zachowuje decyzje i przelicza score.

Najwazniejsza zasada: score jest sygnalem, decyzja jest osobnym statusem.

## 5. Co trzeba dodac dalej

### Priorytet 1

- Dodac modele wyceny dla Schneider, CEG, Prysmian i Hubbell.
- Dodac `manual-fundamentals.csv` z P/E, EV/EBITDA, FCF yield, net debt/EBITDA.
- Dodac progi alertow na valuation, nie tylko na cene.

### Priorytet 2

- Automatycznie wykrywac upcoming earnings z FMP, gdy endpoint bedzie dostepny, albo prowadzic to w `monitoring-events.csv`.
- Dodac tygodniowy raport porownawczy zmian score.
- Dodac eksport CSV z rankingiem.

### Priorytet 3

- Powiadomienia email/Slack/Teams.
- Baza danych zamiast plikow JSON.
- Hosting dashboardu.
- Integracja z Notion/Airtable do pracy researchowej.

## 6. Minimalna wersja bez platnego API

Mozna dzialac tak:

- ceny z Yahoo,
- profile z FMP free z cache,
- SEC z EDGAR,
- fundamenty recznie raz na miesiac,
- decyzje recznie w `research-decisions.csv`,
- political trades recznie w `political-trades.csv`,
- automatyczny dashboard i raporty codziennie.

To jest obecnie najlepszy stosunek wartosci do kosztu.

## 7. Wersja docelowa z API

Pelniejsze API ma sens dopiero, gdy chcemy automatycznie pobierac:

- income statement,
- balance sheet,
- cash flow,
- ratios TTM,
- key metrics TTM,
- analyst estimates,
- earnings calendar.

Wtedy scoring moze uwzgledniac:

- ROIC,
- FCF yield,
- growth durability,
- leverage,
- valuation vs history,
- earnings revisions.

## 8. Operacyjna instrukcja

Codziennie:

```powershell
.\run-monitoring.ps1
```

Otworz dashboard:

```powershell
.\open-dashboard.ps1
```

Po przegladzie:

1. Zmien `research-decisions.csv`.
2. Opcjonalnie uzupelnij `manual-fundamentals.csv`.
3. Odpal `.\run-monitoring.ps1`.
4. Przeczytaj `daily-report.md`.
