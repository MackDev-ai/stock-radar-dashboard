# Scaling and costs

Stan na 2026-08-25. Ceny i limity trzeba okresowo sprawdzac u dostawcow.

## Obecny zakres

- Online dashboard: GitHub Pages
- Cron: GitHub Actions
- Repo: publiczne `MackDev-ai/stock-radar-dashboard`
- Sekret: `FMP_API_KEY` w GitHub Actions
- Universe: 225 tickerow
- Glowne koszyki: AI infra, data power, power grid, distressed rebound, AI software, healthcare innovation, recycling, critical minerals, defense, crypto

## Model pracy przy 225 tickerach

Pipeline dzieli prace na dwie warstwy:

1. Warstwa szybka dla calego universe:
   - ceny dzienne,
   - podstawowy profil FMP,
   - scoring,
   - dashboard,
   - alerty,
   - sector radar.
2. Warstwa glebsza z limitami:
   - analiza tresci SEC tylko dla pierwszych `max_sec_analysis_per_run` tickerow,
   - Form 4 insider flow rotacyjnie po `maxTickersPerRun` tickerow na przebieg,
   - deep dive tylko dla wybranych kandydatow.

To pozwala monitorowac 200+ nazw bez niepotrzebnego przeciazania FMP i SEC.

## GitHub

Publiczne repo:

- GitHub Pages: wystarcza GitHub Free.
- GitHub Actions: standardowe runnery sa darmowe dla publicznych repo.
- Obecny workflow powinien miescic sie w darmowym uzyciu.

Prywatne repo:

- GitHub Pages dla prywatnego repo wymaga platnego planu GitHub.
- GitHub Actions w prywatnym repo zuzywa miesieczne minuty konta.
- Prywatna publikacja Pages ma dodatkowe ograniczenia organizacyjne.

Rekomendacja: obecny publiczny wariant jest OK, skoro nie ma danych poufnych.

## FMP

Free:

- 250 requestow dziennie.
- Wystarczy do testow i ograniczonego odswiezania.
- Przy 225 spolkach jest za ciasno, jezeli pobieramy profil i dodatkowe fundamenty.

Starter:

- Około 22 USD miesiecznie przy rozliczeniu rocznym.
- 300 requestow na minute.
- US coverage i 5 lat historii.
- Minimum sensowne, jezeli universe jest glownie USA i ADR.

Premium:

- Około 59 USD miesiecznie przy rozliczeniu rocznym.
- 750 requestow na minute.
- 30 lat historii.
- USA, UK i Kanada.
- Lepszy wariant roboczy dla 150-300 spolek.

Ultimate:

- Około 149 USD miesiecznie przy rozliczeniu rocznym.
- 3000 requestow na minute.
- Global coverage, transcripts, ETF holdings, 13F i bulk/batch.
- Potrzebny, jezeli chcemy globalny radar bez kompromisow.

Rekomendacja: Premium jako docelowy plan dla 225 tickerow. Starter mozna testowac, ale ograniczy historie, zakres geograficzny i wygode.

## SEC

SEC EDGAR nie jest platny, ale ma limity fair access. Skrypty maja opoznienie requestow i rotacje, zeby nie przekraczac limitow.

## Co dodac pozniej

1. Batch endpoints FMP dla quote/profile/fundamentals.
2. Osobny nocny workflow weekly dla ciezszych danych: 13F, transcripts, pelne ratios.
3. Historia scoringu per ticker w osobnym pliku.
4. Alerty mailowe albo Slack/Discord.
5. Automatyczne kandydaty do deep dive na podstawie zmiany rankingu.
