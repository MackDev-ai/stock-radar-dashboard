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

Workflow bedzie tez dzialal automatycznie w dni robocze o `22:35 UTC`.

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

To ogranicza dostep do dashboardu bez zmiany kodu aplikacji.

## Dlaczego Cloudflare zamiast public GitHub Pages

Licencja FMP rozroznia uzycie prywatne od publicznego wyswietlania/redystrybucji danych. Cloudflare Pages z Access pozwala traktowac dashboard jako prywatne narzedzie researchowe, zamiast publicznej strony z danymi.
