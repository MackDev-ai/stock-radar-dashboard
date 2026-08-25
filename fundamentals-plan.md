# Rekomendowane zrodla danych

## 1. Financial Modeling Prep

Najlepszy pierwszy wybor do tego projektu, bo ma szeroki zakres: ceny, profile, statementy, ratios, key metrics, enterprise value, SEC filings i estimates. Dobrze pasuje do dashboardu, ktory ma laczyc wycene, wzrost, zadluzenie, marze i alerty.

Wymagane: `FMP_API_KEY`.

Co warto pobierac:

```text
profile
income statement quarterly
balance sheet quarterly
cash flow quarterly
key metrics TTM
ratios TTM
enterprise value
analyst estimates
SEC filings
```

## 2. Tiingo

Dobre zrodlo dla cen i uporzadkowanych fundamentalow USA/ADR. Ma sens, jesli chcesz czystsze dane do backtestow i mniej recznego czyszczenia.

Wymagane: `TIINGO_API_KEY`.

## 3. Alpha Vantage

Dobre jako tanie lub darmowe zrodlo startowe. Ma company overview, income statement, balance sheet, cash flow, earnings i kalendarze, ale limity oraz czestotliwosc aktualizacji moga byc mniej wygodne przy wiekszej liczbie tickerow.

Wymagane: `ALPHAVANTAGE_API_KEY`.

## Moja rekomendacja

Zostaw:

```text
Yahoo Chart - ceny dzienne
```

Dodaj:

```text
Financial Modeling Prep - fundamenty, wyceny, estimates, filings
```

Pozniej:

```text
SEC EDGAR - darmowe potwierdzanie 10-K, 10-Q, 8-K dla USA
RSS/IR pages - newsy, wyniki i backlog dla Europy
```

## Czy potrzebne jest pelne API FMP?

Nie. Do obecnego dashboardu nie jest potrzebny pelny pakiet FMP.

Obecny pipeline ma juz:

```text
ceny dzienne - Yahoo Chart
SEC filings - bezposrednio z SEC EDGAR
analize slow-kluczy SEC - lokalnie
alerty techniczne - lokalnie
```

Z FMP potrzebny bylby tylko minimalny zakres fundamentalny:

```text
profile
quote albo quote-short
ratios-ttm
key-metrics-ttm
income-statement-ttm
balance-sheet-statement-ttm
cash-flow-statement-ttm
income-statement-growth
```

Opcjonalne, ale niekonieczne:

```text
analyst-estimates
earnings calendar
earnings transcripts
news
bulk endpoints
insider trading
13F
ESG
real-time market data
```

W praktyce wystarczy plan FMP, ktory daje dostep do financial statements, ratios i key metrics dla spolek z naszej watchlisty. Nie potrzebujemy pelnego API z newsami, transkryptami, real-time market data, insiderami, ESG ani bulk data.

Aktualny darmowy zakres pozwala pobierac `stable/profile`, ale nie pozwala pobierac statementow, ratios ani key metrics. Pipeline uzywa wiec FMP profile z cache na 7 dni, zeby nie marnowac limitu 250 requestow.

`stable/profile` daje:

```text
price
marketCap
beta
lastDividend
range
volume
averageVolume
sector
industry
exchange
country
cik
website
employees
```

To wystarcza do wzbogacenia dashboardu, ale nie wystarcza do pelnych alertow fundamentalnych typu P/E, EV/EBITDA, marze, zadluzenie i wzrost.

## Minimalny model fundamentalny

Po podpieciu API dashboard powinien dodac alerty:

```text
VALUATION_STRETCHED - EV/EBITDA lub P/E powyzej progu
GROWTH_DECELERATION - wzrost przychodow spada 2 kwartaly z rzedu
MARGIN_PRESSURE - marza operacyjna spada r/r
DEBT_RISK - net debt / EBITDA powyzej progu
GUIDANCE_RAISED - zarzad podniosl prognoze
GUIDANCE_CUT - zarzad obnizyl prognoze
```

## Stan wdrozenia

Pipeline ma juz opcjonalna integracje FMP. Bez klucza API dziala tylko warstwa cenowa. Po dodaniu `.env` z:

```text
FMP_API_KEY=twoj_klucz
```

skrypt `run-monitoring.ps1` zacznie probowac pobierac:

```text
ratios-ttm
key-metrics-ttm
income-statement-ttm
balance-sheet-statement-ttm
cash-flow-statement-ttm
analyst-estimates
```

W dashboardzie pojawia sie kolumny P/E TTM, EV/EBITDA i net debt/EBITDA, a w szczegolach ROE, ROIC i marze.

## Fallback bez dzialajacego API

Jezeli FMP zwraca 401/402/403, uzyj `manual-fundamentals.csv`. Mozesz go wygenerowac z eksportu z Koyfin, TIKR, maklera albo arkusza Google.

Szablon:

```text
manual-fundamentals-template.csv
```

Pipeline automatycznie polaczy ten plik po kolumnie `ticker`. Obslugiwane kolumny:

```text
ticker
pe_ttm
ps_ttm
pb_ttm
ev_ebitda_ttm
roe_ttm
roic_ttm
operating_margin_ttm
fcf_margin_ttm
net_debt_ebitda_ttm
revenue_growth_yoy
eps_growth_yoy
```
