# Setup CMS Arconti31

## ⚠️ IMPORTANTE: Configurazione Cloudflare Workers

Per far funzionare il CMS devi configurare **secret e variabili** sul Worker Cloudflare.

> **NOTA**: Il menù digitale si aggiorna automaticamente quando salvi dal CMS! I JSON vengono rigenerati automaticamente, non serve alcun intervento manuale.

> ⚠️ **`REPO_OWNER`, `REPO_NAME` e `CMS_TOKEN_SECRET` sono sempre obbligatori.**  
> Senza `REPO_OWNER`/`REPO_NAME` il CMS **non salva** (niente default nel codice).  
> Senza `CMS_TOKEN_SECRET` il **login fallisce** con errore 500 (fail-loud, niente fallback sulla password).

---

## Passo 1: Crea un Token GitHub (CLASSIC)

> ⚠️ **ATTENZIONE**: Devi creare un token **CLASSIC**, NON "Fine-grained"!

1. Vai su: https://github.com/settings/tokens
2. Clicca **"Generate new token"** → **"Generate new token (classic)"**
3. Compila:
   - **Note**: `Arconti31 CMS`
   - **Expiration**: `No expiration` (o scegli durata)
   - **Scopes**: Seleziona ✅ `repo` (Full control of private repositories)
4. Clicca **"Generate token"**
5. **COPIA SUBITO IL TOKEN** (inizia con `ghp_...`) - lo vedrai solo una volta!

---

## Passo 2: Configura Secret e Variabili su Cloudflare

**Secret** (valori sensibili) — da terminale nel progetto:

```bash
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put CMS_TOKEN_SECRET
npx wrangler secret put CLOUDINARY_API_KEY      # per upload immagini
npx wrangler secret put CLOUDINARY_API_SECRET   # per upload immagini
```

**Variabili** — [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages** → worker **arconti31** → **Settings** → **Variables**:

### Variabili obbligatorie

| Nome | Valore | Esempio |
|------|--------|---------|
| `REPO_OWNER` | Username GitHub del **proprietario del repo** — **sempre ✅ obbligatorio** | `username-github` |
| `REPO_NAME` | Nome esatto del repository — **sempre ✅ obbligatorio** | `Arconti31` |
| `ADMIN_EMAIL` | Email ammesse (virgola-separate) | `admin@tuodominio.com, staff@tuodominio.com` |

### Variabili opzionali

| Nome | Valore | Note |
|------|--------|------|
| `GITHUB_BRANCH` | Branch su cui il CMS scrive i commit | Default se assente: **`main`** |
| `ALLOWED_ORIGINS` | Origini CORS extra (virgola-separate) | Di solito non serve: l’URL del deployment corrente è già gestito |
| `CLOUDINARY_CLOUD_NAME` | Cloud Name Cloudinary | Per upload immagini |
| `CLOUDINARY_FOLDER` | Cartella destinazione upload | Default `arconti31` |

---

## Passo 3: Fai un Nuovo Deploy

Dopo aver salvato secret e variabili:

```bash
npm run deploy:cloudflare
```

(oppure attendi il deploy automatico di Workers Builds se configurato — vedi `CLOUDFLARE_DEPLOY.md`)

---

## Passo 4: Verifica e accedi al CMS

1. Test health: apri `https://URL-DEL-TUO-SITO/api/health` → deve dare **ok**
2. Vai su: `https://URL-DEL-TUO-SITO/admin/`
3. Inserisci email e password configurati
4. Inizia a gestire il menù!
5. Dopo un salvataggio, verifica che su GitHub compaia il commit sul repo indicato da `REPO_OWNER`/`REPO_NAME`. Il CMS può mostrare un messaggio tipo **«Salvato su owner/repo»**.

Sostituisci sempre `URL-DEL-TUO-SITO` con l’indirizzo reale (es. `arconti31.arconti31.workers.dev` o dominio custom).

---

## Admin Multipli

Per aggiungere più admin, separa le email con virgola:

```
ADMIN_EMAIL = admin@tuodominio.com, manager@tuodominio.com, staff@tuodominio.com
```

Tutti gli utenti useranno la stessa password.

---

## Risoluzione Problemi

### Errore "Password non valida"
- Verifica che `ADMIN_EMAIL` contenga la tua email (case-insensitive)
- Verifica che `ADMIN_PASSWORD` sia esattamente uguale
- Dopo aver modificato secret/variabili, fai sempre un nuovo deploy

### Errore 500 al login (`AUTH_CONFIG_MISSING`)
- Manca il secret `CMS_TOKEN_SECRET` → `npx wrangler secret put CMS_TOKEN_SECRET`

### Errore "Bad credentials" o "401"
- Hai creato un token **Fine-grained** invece di **Classic** → Ricrea il token
- Il token è scaduto → Creane uno nuovo
- Non hai selezionato il permesso `repo` → Ricrea il token

### Errore "GITHUB_TOKEN non configurato"
- Il secret non è stato impostato sul Worker → `npx wrangler secret put GITHUB_TOKEN`

### CMS non salva / errore su repository
- Controlla che `REPO_OWNER` e `REPO_NAME` siano **entrambe** impostate (obbligatorie)
- Rideploya dopo averle aggiunte
- Verifica che il token abbia accesso a quel repo

### Health non ok
- Controlla che l’ultimo deploy sia andato a buon fine
- Guarda i log realtime: `npx wrangler tail`

### Modifiche non visibili
- Attendi 30-60 secondi
- Ricarica la pagina (Ctrl+F5 / Cmd+Shift+R)
- Verifica che il JSON sia aggiornato su GitHub

---

## Sicurezza

- ✅ Credenziali in variabili ambiente/secret (mai nel codice)
- ✅ Token generato per sessione (sessionStorage)
- ✅ Scadenza token dopo 30 giorni
- ✅ `GITHUB_TOKEN` solo lato server
- ✅ `CMS_TOKEN_SECRET` **obbligatorio** (firma HMAC SHA-256, confronto timing-safe)
- ✅ Logout automatico chiudendo il browser

---

## Upload Immagini

### Opzione 1: URL Esterni (Semplice)

Puoi incollare URL di immagini già online:
- **Google Drive**: Condividi pubblicamente
- **Imgur**: Carica e copia link
- **Qualsiasi URL pubblico**

Nel CMS, nel campo "Immagine", incolla l'URL e salva.

### Opzione 2: Cloudinary (Upload Diretto)

L'upload usa la **firma generata dal Worker** (`/api/cloudinary-signature`): il browser
carica il file direttamente su Cloudinary in modalità **signed**. Non serve alcun
upload preset unsigned.

#### 1. Crea account Cloudinary
1. Vai su https://cloudinary.com e registrati (gratuito)
2. Dalla Dashboard, copia **Cloud Name**, **API Key** e **API Secret**

#### 2. Configura sul Worker

```bash
npx wrangler secret put CLOUDINARY_API_KEY
npx wrangler secret put CLOUDINARY_API_SECRET
```

| Nome (variabile) | Valore |
|------|--------|
| `CLOUDINARY_CLOUD_NAME` | Il tuo Cloud Name |
| `CLOUDINARY_FOLDER` | (Opzionale) cartella destinazione, default `arconti31` |

#### 3. Redeploy
Fai un nuovo deploy dopo aver aggiunto secret e variabili.

### Troubleshooting Upload

**Errore 401 (Unauthorized)**:
- Verifica `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` (secret sul Worker)
- Verifica `CLOUDINARY_CLOUD_NAME` esatto
- Fai nuovo deploy

---

## Dove Trovare URL Immagini

### Google Drive
1. Carica immagine
2. Clicca destro → Condividi → "Chiunque abbia il link"
3. Modifica URL:
   - Da: `https://drive.google.com/file/d/FILE_ID/view`
   - A: `https://drive.google.com/uc?export=view&id=FILE_ID`

### Imgur
1. Vai su https://imgur.com
2. Carica immagine
3. Clicca destro → "Copia link immagine"

---

## Riepilogo Variabili Ambiente

| Variabile | Obbligatoria | Descrizione |
|-----------|--------------|-------------|
| `GITHUB_TOKEN` | ✅ (secret) | Token Classic con permesso `repo` (dell'account che possiede il repo) |
| `REPO_OWNER` | ✅ **sempre** | Username GitHub del proprietario del repo. **Senza → CMS non salva** |
| `REPO_NAME` | ✅ **sempre** | Nome esatto del repository. **Senza → CMS non salva** |
| `ADMIN_EMAIL` | ✅ | Email ammesse (virgola-separate) |
| `ADMIN_PASSWORD` | ✅ (secret) | Password accesso CMS |
| `CMS_TOKEN_SECRET` | ✅ (secret) | Segreto firma token sessione. **Senza → login fallisce (500)** |
| `GITHUB_BRANCH` | ❌ | Branch commit CMS (default `main`) |
| `ALLOWED_ORIGINS` | ❌ | Origini extra CORS (virgola-separate). L'origine del deployment corrente è già inclusa automaticamente |
| `CLOUDINARY_CLOUD_NAME` | ❌ | Per upload immagini |
| `CLOUDINARY_API_KEY` | ❌ (secret) | Richiesto per l'upload immagini (signed) |
| `CLOUDINARY_API_SECRET` | ❌ (secret) | Richiesto per l'upload immagini (signed) |
| `CLOUDINARY_FOLDER` | ❌ | Cartella destinazione upload Cloudinary (default `arconti31`) |

> 📖 Deploy, dominio custom e rollback: **`CLOUDFLARE_DEPLOY.md`** (root del progetto).  
> 📖 Migrazione completa verso account del cliente: **`HANDOFF_CLIENTE.md`** (root del progetto).  
> 📖 Breaking changes e azioni esterne obbligatorie: **`SOLIDITY_NOTES.md`**.
