# Mapa podobienstwa spolek

To jest lokalny prototyp podobny do mapy zwierzat z ksiazki: zamiast cech obrazu uzywa cech spolek. Narzedzie tworzy mape podobienstwa oraz ranking kandydatow do dalszej analizy.

Nie jest to rekomendacja inwestycyjna ani prognoza ceny. Mapa pomaga zawęzic liste spolek, ktore warto sprawdzic recznie.

## Jak uruchomic

1. Otworz `stock-map.html` w przegladarce.
2. Kliknij `Wczytaj przyklad syntetyczny`, zeby zobaczyc jak dziala.
3. Potem wgraj wlasny plik CSV w formacie z `stock-map-template.csv`.

## Dane

Minimalnie potrzebna jest kolumna:

```text
ticker
```

Najlepiej dodac:

```text
name, sector, country,
pe, ps, pb,
roe, roic,
revenue_growth, eps_growth,
fcf_margin, operating_margin,
debt_to_equity,
momentum_12m, volatility, beta,
market_cap
```

Wartosci procentowe wpisuj jako liczby, np. `18` dla 18%. Wyceny typu P/E, P/S i P/B wpisuj jako zwykle liczby.

Do rynku surowcow wtornych dodalem tez `secondary-raw-materials-watchlist.csv`. To lista obserwacyjna ze scoringiem 1-5, a nie twarde rekomendacje kupna. Kolumny `*_score` sa pozytywne, a kolumny `*_risk` obnizaja wynik.

Dla biotechnologii dodalem `biotech-watchlist.csv`. W tej branzy wynik trzeba czytac ostrozniej, bo pojedynczy odczyt badan klinicznych, decyzja FDA albo emisja akcji moze zmienic profil spolki w jeden dzien. Szczegolnie wazne sa kolumny `clinical_risk`, `regulatory_risk`, `financing_risk` i `concentration_risk`.

Dla szerokiego rynku dodalem `market-themes-watchlist.csv`. To mapa obszarow, nie pojedynczych rekomendacji. W kolumnie `notes` sa przykladowe tickery i ETF-y, ktore moga sluzyc jako radary dla danego trendu.

Dla tematu sieci energetycznych dodalem `power-grid-watchlist.csv`. To juz koszyk konkretnych spolek z kilku warstw lancucha: core equipment, kable, wykonawcy, grid automation, data-center power, dystrybutorzy i bardziej spekulacyjne zasilanie onsite.

Dla kolejnych tematow dodalem `data-power-watchlist.csv` i `ai-infra-watchlist.csv`. Pierwszy obejmuje energie dla centrów danych: atom, gaz, onsite power, baterie, grid interconnect i paliwo jadrowe. Drugi obejmuje lancuch infrastruktury AI: akceleratory, foundry, semicap, pamiec HBM, sieci, optyke, storage, serwery oraz zasilanie/chlodzenie.

Dodalem tez `core-shortlist.csv` i `research-next-steps.md`. To najwazniejsza lista robocza, bo laczy spolki powtarzajace sie w kilku trendach naraz.

## Monitoring autonomiczny

Pliki monitoringu:

```text
monitoring-config.json
scripts/update-monitoring.js
run-monitoring.ps1
setup-monitoring-task.ps1
monitoring-dashboard.html
data/monitoring-data.js
data/monitoring-history.json
```

Jak uzyc:

1. Uruchom `run-monitoring.ps1`, zeby pobrac aktualne ceny i wygenerowac snapshot.
2. Otworz `monitoring-dashboard.html`.
3. Filtruj po statusie `CORE`, `WATCH`, `SPEC` albo po akcji typu `WATCH_PULLBACK`, `REVIEW_BUY_ZONE`, `DO_NOT_CHASE`.

Zeby ustawic codzienna automatyczna aktualizacje w Windows Task Scheduler, uruchom `setup-monitoring-task.ps1`. Domyslnie zadanie aktualizuje dane codziennie o 18:15.

Pipeline pobiera dzienne ceny przez publiczny endpoint Yahoo Chart. Nie pobiera automatycznie fundamentalow, backlogu ani komentarzy z raportow kwartalnych; te punkty nadal trzeba aktualizowac recznie po wynikach.

Po kazdym przebiegu pipeline tworzy tez:

```text
alerts.md
daily-report.md
data/alerts.json
elite-flow-report.md
research/sector-radar-report.md
```

Rekomendacje zrodel danych i plan podpiecia fundamentalow sa w `fundamentals-plan.md`. Moja rekomendacja: ceny zostawic na Yahoo Chart, a fundamenty i estimates pobierac z Financial Modeling Prep po dodaniu `FMP_API_KEY`.

Po aktywacji FMP Starter sprawdz dostepne endpointy:

```powershell
node .\scripts\fmp-smoke-test.js AAPL
```

Pipeline automatycznie probuje pobrac FMP `profile`, `ratios-ttm`, `key-metrics-ttm`, statementy TTM, growth, enterprise value i financial scores. Niedostepny endpoint nie przerywa runu; raport dzienny pokazuje realne pokrycie.

W testowym smoke runie dla `AAPL` dzialaly: `profile`, `ratiosTTM`, `keyMetricsTTM`, `growth`, `enterpriseValue`, `financialScores`. Endpointy statementow TTM (`incomeTTM`, `balanceTTM`, `cashFlowTTM`) zwracaly `402`, wiec pipeline po pierwszym takim bledzie pomija je w dalszej czesci runu, zeby nie marnowac requestow.

## Telegram

Automatyczne alerty Telegram wysyla `scripts/send-telegram-alerts.js`. W GitHub Actions potrzebne sa sekrety:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
TELEGRAM_MIN_SCORE
```

Skrypt bierze top alerty z `data/monitoring-data.js`, filtruje je po `TELEGRAM_MIN_SCORE` oraz po zmianach akcji, decyzji, SEC i alertach ryzyka, a potem wysyla link do zakladki `Alerty`.

Kazda spolka dostaje tez automatyczny `investmentVerdict`: `Warto analizowac`, `Kandydat do inwestycji po deep dive`, `Wstrzymac sie`, `Nie inwestowac teraz`, `Odrzucic na teraz`. To jest werdykt researchowy do kolejki pracy, nie formalna rekomendacja inwestycyjna.

Jezeli API fundamentalne nie jest dostepne w Twoim planie, skopiuj `manual-fundamentals-template.csv` do `manual-fundamentals.csv` i wklej export fundamentalow. Pipeline polaczy te dane automatycznie po tickerze.

## Watchlista decyzji

`research-decisions.csv` trzyma reczny status researchu niezaleznie od automatycznego score. Uzywaj go jako kolejki pracy:

- `Candidate` - spolka ma przejsc do glebszej analizy.
- `Waiting` - czekamy na lepsza cene albo konkretny raport.
- `Needs review` - jest sygnal ryzyka i trzeba zweryfikowac teze.
- `Needs filing` - najpierw przeczytaj nowy filing SEC.
- `Monitor` - zostaje w radarze bez pilnej pracy.

Kolumny `decision_note` i `invalidation_trigger` sa najwazniejsze, bo wymuszaja jasna teze oraz warunek jej odrzucenia.

## Deep dive

Raport dla pojedynczej spolki:

```powershell
node .\scripts\generate-deep-dive.js ETN
```

Raporty dla calej kolejki `Candidate`:

```powershell
node .\scripts\generate-deep-dive.js CANDIDATES
```

Raporty trafiaja do `research/deep-dives/`.

Porownania i workflow:

- `research/ETN-vs-Schneider.md` - porownanie dwoch glownych core compounderow.
- `automation-workflow.md` - opis calego procesu: dane, dashboard, raporty, decyzje, harmonogram.

## Dashboard online

Dodany jest wariant produkcyjny przez GitHub Actions + GitHub Pages:

```text
.github/workflows/stock-radar.yml
.github/workflows/cloudflare-pages.yml
scripts/build-online-dashboard.js
deployment-online.md
cloudflare-pages.md
scaling-and-costs.md
```

GitHub Actions dziala jako cron, a GitHub Pages publikuje folder `site-dist` jako dashboard online. Szczegoly konfiguracji repozytorium, sekretu `FMP_API_KEY` i Pages sa w `deployment-online.md`.

Pipeline pobiera tez najnowsze raporty SEC EDGAR dla tickerow, ktore maja dopasowanie CIK. W dashboardzie pojawia sie ostatni 10-K/10-Q/8-K/20-F/6-K oraz link do dokumentu.

Pipeline wykrywa tez nowe filingi SEC wzgledem poprzedniego przebiegu i zapisuje `new-filings.md`. Kalendarz wynikow/zdarzen mozna prowadzic w `monitoring-events.csv` na bazie `monitoring-events-template.csv`; najblizsze 30 dni trafiaja do dashboardu i `daily-report.md`.

Pipeline analizuje rowniez tresc najnowszego dokumentu SEC i zapisuje `sec-analysis.md`. Analiza jest heurystyczna: liczy slowa-klucze zwiazane z backlogiem, zamowieniami, data center, AI, siecia energetyczna, marzami, guidance i supply chain.

Pipeline monitoruje rowniez `SEC Form 4` dla insiderow spolek z watchlisty i zapisuje `elite-flow-report.md`. Transakcje politykow dopisuj do `political-trades.csv`; oficjalne disclosures sa opoznione i czesto wymagaja recznego importu albo osobnego agregatora.

Modul Form 4 ma ograniczony pobor danych: maksymalnie kilka najnowszych filingow na ticker i opoznienie miedzy requestami, zeby nie blokowac dostepu przez limit SEC.

Codzienny sposob pracy jest opisany w `monitoring-agenda.md`.

Powiadomienie Windows mozna wlaczyc w `monitoring-config.json`, zmieniajac:

```json
"windows_toast": true
```

## Jak czytac wynik

- Punkty blisko siebie oznaczaja spolki o podobnym profilu danych.
- `Score` premiuje wzrost, jakosc, sensowna wycene i momentum.
- Ryzyko, zmiennosc, beta i zadluzenie obnizaja wynik.
- Suwak `Kara za ryzyko` pozwala ustawic, jak konserwatywnie oceniasz spolki.

## Co dalej

Najwieksza wartosc pojawi sie po dodaniu prawdziwych danych fundamentalnych. Dobry kolejny krok to przygotowanie CSV dla np. WIG20/mWIG40 albo S&P 500, a potem porownanie mapy z historycznymi wynikami 3-5 lat.
