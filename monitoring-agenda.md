# Agenda monitoringu

## Cel

Dashboard ma dzialac jako radar, ktory codziennie wskazuje, co warto sprawdzic recznie. Nie podejmuje decyzji inwestycyjnych automatycznie.

## Codziennie

1. Otworz `daily-report.md`.
2. Sprawdz sekcje `Nowe raporty SEC`.
3. Sprawdz `Ryzyka do kontroli`.
4. Sprawdz `Okazje / pullback do sprawdzenia`.
5. Otworz `monitoring-dashboard.html`, jesli chcesz zobaczyc wykres i szczegoly spolki.

Priorytet:

```text
NEW SEC
REVIEW_RISK
REVIEW_BUY_ZONE
WATCH_PULLBACK
MONITOR
```

## Raz w tygodniu

1. Przejrzyj `monitoring-history.json`.
2. Sprawdz, ktore spolki czesto wpadaja w `REVIEW_RISK`.
3. Zaktualizuj statusy w `monitoring-config.json`:

```text
CORE
WATCH
SPEC
AVOID NOW
```

4. Usun spolki, ktore przestaly pasowac do tezy.
5. Dodaj nowe kandydaty tylko wtedy, gdy maja jasna ekspozycje tematyczna.

## Po raporcie kwartalnym

1. Otworz link SEC z dashboardu.
2. Sprawdz `sec-analysis.md`.
3. Zweryfikuj slowa-klucze:

```text
backlog
orders
book-to-bill
data center
AI
grid
transmission
margin
guidance
outlook
supply chain
capacity
```

4. Zapisz reczny wniosek w `monitoring-config.json`, w polach:

```text
thesis
watch
risk
status
```

## Kiedy reagowac

`REVIEW_BUY_ZONE`:
Sprawdz, czy spadek ceny jest korekta wyceny czy pogorszeniem biznesu.

`REVIEW_RISK`:
Sprawdz, czy teza nie peka. Priorytet maja spadek guidance, spadek backlogu, presja marz i problemy supply chain.

`WATCH_PULLBACK`:
Nie oznacza kupna. Oznacza, ze spolka weszla w strefe, w ktorej warto odswiezyc analize.

`DO_NOT_CHASE`:
Nie gon cen spekulacyjnych nazw po mocnym ruchu.

## Aktualny stan UX

Dashboard jest poprawny technicznie:

```text
brak bledow konsoli
15 spolek w tabeli
agenda renderuje sie poprawnie
SEC links dzialaja dla 14/15 spolek
brakujace fundamenty pokazuja "-" zamiast mylacego 0.0%
```

Najwieksze ograniczenia:

```text
FMP nie zwraca fundamentalow w obecnym planie
tabela jest szeroka i najlepiej dziala na desktopie
parser SEC jest heurystyczny i wymaga recznej interpretacji
Prysmian nie ma prostego dopasowania SEC
```
