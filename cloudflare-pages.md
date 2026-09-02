# Cloudflare Pages deployment

Docelowy wariant dla dashboardu z danymi FMP:

- GitHub zostaje zrodlem kodu i cronem.
- GitHub Actions buduje `site-dist`.
- Workflow `Cloudflare Pages Deploy` publikuje `site-dist` do Cloudflare Pages.
- Cloudflare Access zabezpiecza dashboard logowaniem.

## Wymagane sekrety GitHub Actions

W repo `MackDev-ai/stock-radar-dashboard` ustaw:

```text
FMP_API_KEY
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

`FMP_API_KEY` jest juz ustawiony.

Po wlaczeniu Cloudflare Access dodaj tez sekrety service tokenu, zeby pipeline mogl odczytac poprzednia historie z chronionego dashboardu:

```text
CF_ACCESS_CLIENT_ID
CF_ACCESS_CLIENT_SECRET
```

Ustaw zmienna repozytorium GitHub Actions (Variables, nie Secrets):

```text
DASHBOARD_URL=https://stock-radar-dashboard.pages.dev/
ENABLE_GITHUB_PAGES=true
```

Do czasu ustawienia tej zmiennej pipeline automatycznie korzysta z obecnego adresu GitHub Pages.

## Cloudflare API token

Token powinien miec minimalnie uprawnienia:

```text
Account -> Cloudflare Pages -> Edit
Account -> Account Settings -> Read
```

Jezeli pozniej automatyzujemy Access przez API, token bedzie potrzebowal tez uprawnien Zero Trust / Access.

## Pierwsze wdrozenie przez CLI

Po zalogowaniu Wranglerem:

```powershell
npx wrangler login
npx wrangler pages deploy site-dist --project-name stock-radar-dashboard --branch main --commit-dirty=true
```

## Automatyczne wdrozenie

Po ustawieniu `CLOUDFLARE_API_TOKEN` i `CLOUDFLARE_ACCOUNT_ID` odpal:

```text
GitHub -> Actions -> Cloudflare Pages Deploy -> Run workflow
```

Po dodaniu sekretow glowny workflow `Stock Radar Update` wdraza ten sam, przetestowany `site-dist` jednoczesnie na Cloudflare Pages i awaryjnie na GitHub Pages. Oddzielny workflow `Cloudflare Pages Deploy` sluzy do recznego ponowienia samego wdrozenia.

## Cloudflare Access

W Cloudflare:

1. Wejdz w `Zero Trust`.
2. `Access -> Applications -> Add an application`.
3. Wybierz `Self-hosted`.
4. Domain ustaw na domenie Cloudflare Pages projektu.
5. Policy:
   - Action: `Allow`
   - Include: `Emails`
   - dodaj swoje adresy email.
6. Zapisz.

7. W `Access -> Service Auth -> Service Tokens` utworz token dla GitHub Actions.
8. Dodaj go do polityki aplikacji jako `Service Auth` i zapisz jego ID oraz sekret w GitHub Actions.

To ogranicza dostep do dashboardu bez zmiany kodu aplikacji.

## Dlaczego Cloudflare zamiast public GitHub Pages

Licencja FMP rozroznia uzycie prywatne od publicznego wyswietlania/redystrybucji danych. Cloudflare Pages z Access pozwala traktowac dashboard jako prywatne narzedzie researchowe, zamiast publicznej strony z danymi.

## Kolejnosc przelaczenia

1. Dodaj `CLOUDFLARE_API_TOKEN` i `CLOUDFLARE_ACCOUNT_ID`.
2. Uruchom `Cloudflare Pages Deploy` i sprawdz adres `pages.dev`.
3. Skonfiguruj Access oraz service token dla pipeline'u.
4. Ustaw `DASHBOARD_URL` na chroniony adres Cloudflare.
5. Uruchom `Stock Radar Update` i sprawdz dashboard oraz link w Telegramie.
6. Ustaw `ENABLE_GITHUB_PAGES=false`, aby workflow przestal publikowac awaryjna kopie publiczna.
7. Dopiero wtedy zmien repozytorium na prywatne i wylacz GitHub Pages.
