# 🏗️ Architettura Tecnica del Progetto

## 📋 Panoramica

Sistema di gestione contenuti (CMS) headless completo per menù digitale, con backend serverless su Cloudflare Workers, rigenerazione automatica JSON, e interfaccia frontend ottimizzata.

> Migrato da Netlify a Cloudflare Workers: dettagli in [`MIGRATION_REPORT.md`](./MIGRATION_REPORT.md), guida operativa in [`CLOUDFLARE_DEPLOY.md`](./CLOUDFLARE_DEPLOY.md).

## 🔧 Stack Tecnologico

### Frontend
- **HTML5**: Struttura semantica
- **CSS3**: Styling responsive con CSS Grid e Flexbox
- **JavaScript Vanilla**: Nessuna dipendenza esterna

### Backend (Cloudflare Worker — `src/worker/`)
- **routes/save-data.ts**: Salvataggio dati + rigenerazione JSON nello stesso commit
- **routes/read-data.ts**: Lettura dati con fallback JSON statici
- **routes/auth.ts**: Login e verifica token (HMAC SHA-256)
- **routes/cloudinary-signature.ts**: Firma per upload diretto browser→Cloudinary
- **routes/upload-image.ts**: Relay upload Base64 (fallback legacy)
- **routes/health.ts**: Liveness pubblica + diagnostica autenticata
- **router.ts**: Routing `/api/*` e fallback SPA `/admin/*`

### CMS
- **cms-simple.js**: CMS custom con autenticazione, CRUD completo, ricerca globale
- **cms-styles.css**: Stili dedicati pannello admin

### Storage
- **GitHub**: Versioning file markdown
- **JSON Statici**: Cache pre-generata per performance
- **Cloudinary**: Storage immagini (opzionale)

### Hosting
- **Cloudflare Workers + Static Assets**: Worker per le API, asset statici da `dist/` (build allowlist), CI/CD con Workers Builds

## 🔒 Modello di scrittura (integrità dei dati)

GitHub è la fonte autoritativa: i `.md` sono i record, i JSON aggregati sono viste
derivate che il **sito pubblico legge**. Se le due cose divergono, il menù mostra dati
sbagliati pur avendo i markdown corretti — il fallimento più insidioso del sistema.
Le regole che lo impediscono:

1. **Un solo commit immutabile per richiesta.** All'inizio di ogni scrittura il Worker
   legge HEAD del branch e ci **pinna** tutte le letture (`?ref=<commit sha>`). Nessuna
   parte della transazione vede un branch che si muove sotto.
2. **Transazione ricostruita a ogni tentativo.** `.md` e JSON aggregato finiscono nello
   stesso commit, con `parents: [HEAD]` e PATCH della ref **senza `force`**: se un altro
   admin ha committato nel frattempo GitHub risponde 422 non-fast-forward e l'intera
   transazione — snapshot, verifica OCC, rigenerazione JSON — riparte da dati freschi.
   Nessun risultato calcolato prima del conflitto viene riusato.
3. **Letture fail-closed.** Solo un 404 significa "non esiste". Ogni altro errore (429,
   502, timeout) aborta la scrittura con 429/503: un guasto upstream non può più essere
   scambiato per "collezione vuota" e svuotare un JSON aggregato.
4. **OCC su SHA del blob.** Il client manda lo SHA che ha letto; se il blob è cambiato la
   risposta è 409. La verifica è obbligatoria: se non si può eseguire, non si committa.
5. **Budget di subrequest.** Un Worker free ha 50 fetch esterne per invocazione. Il client
   GitHub le conta e si ferma prima con un errore azionabile, invece di morire a metà
   commit. I batch sono limitati a 30 elementi per richiesta (il CMS li spezza da solo).

Recovery: se un JSON aggregato risultasse disallineato, si rigenera in locale con
`npm run build:data` e si committa. Non esiste (più) un endpoint di rigenerazione
completa nel Worker: costava una chiamata per ogni `.md` e sfondava il limite di
subrequest su collezioni grandi.

## 📁 Struttura del Progetto

```
arconti31/
├── admin/
│   ├── index.html          # Pannello CMS
│   ├── cms-simple.js       # CMS JavaScript (71KB)
│   ├── cms-styles.css      # Stili CMS
│   ├── config.yml          # Configurazione collezioni
│   ├── config.json         # Config JSON
│   ├── manifest.json       # PWA Manifest
│   ├── sw.js               # Service Worker
│   └── SETUP.md            # Guida setup CMS
│
├── src/worker/             # Backend Cloudflare Worker (TypeScript)
│   ├── index.ts            # Entry point
│   ├── router.ts           # Routing /api/* + fallback SPA admin
│   ├── routes/             # health, auth, read-data, save-data, cloudinary…
│   ├── lib/                # auth, cors, github, collections, http, validate…
│   └── __tests__/          # test Vitest (routing, auth, OCC, concorrenza, fail-closed)
│
├── food/
│   ├── food.json           # JSON pre-generato
│   └── *.md                # File markdown prodotti
│
├── beers/
│   ├── beers.json          # JSON pre-generato
│   └── *.md                # File markdown birre
│
├── beverages/
│   └── beverages.json      # JSON aggregato bevande
│
├── categorie/
│   ├── categorie.json      # JSON categorie
│   └── *.md                # Definizioni categorie
│
├── cocktails/              # Collezione cocktails
├── analcolici/             # Collezione analcolici
├── bibite/                 # Collezione bibite
├── caffetteria/            # Collezione caffetteria
├── bollicine/              # Collezione bollicine
├── bianchi-fermi/          # Collezione vini bianchi
├── vini-rossi/             # Collezione vini rossi
│
├── css/
│   └── style.css           # Stili frontend
│
├── js/
│   └── app.js              # Logica frontend
│
├── images/
│   ├── beverages/          # Immagini bevande
│   └── minicard sezioni/   # Immagini categorie
│
├── index.html              # Homepage menù
├── menu.html               # Pagina menù
├── ristoranti.html         # Pagina ristorante
├── wrangler.jsonc          # Configurazione Cloudflare Workers
├── cloudflare/             # _headers e _redirects copiati in dist/
├── scripts/build-cloudflare.mjs  # Build dist/ (allowlist)
├── package.json            # Dipendenze Node.js
└── README.md               # Documentazione
```

## 🔄 Flusso di Lavoro

### 1. Modifica Contenuti (Ristoratore)

```
Ristoratore → /admin → Login (email/password)
                ↓
        Modifica/Aggiungi Prodotto
                ↓
        Clicca "Salva"
                ↓
        Worker /api/save-data
                ↓
        Salva .md su GitHub + Rigenera JSON
                ↓
        Commit automatico
```

### 2. Rigenerazione Automatica JSON

```
save-data riceve richiesta
        ↓
Salva file .md su GitHub
        ↓
Legge tutti i .md della collezione
        ↓
Genera JSON aggregato (food.json, beers.json, ecc.)
        ↓
Commit JSON su GitHub
        ↓
Sito aggiornato (30-60 sec)
```

### 3. Lettura Dati (CMS/Frontend)

```
Richiesta dati
        ↓
read-data cerca JSON statico
        ↓
Se JSON esiste → ritorna dati (veloce!)
        ↓
Se JSON non esiste → fallback API GitHub
        ↓
Se rate limit → fallback JSON statico
```

### 4. Visualizzazione (Utente)

```
Utente visita sito
        ↓
Browser carica index.html
        ↓
JavaScript fetch JSON statici
        ↓
Rendering categorie
        ↓
Lazy loading immagini
```

## 🗂️ Gestione Dati

### Collezioni Configurate

| Collezione | Folder | JSON Output |
|------------|--------|-------------|
| Categorie | categorie/ | categorie/categorie.json |
| Food | food/ | food/food.json |
| Birre | beers/ | beers/beers.json |
| Cocktails | cocktails/ | beverages/beverages.json |
| Analcolici | analcolici/ | beverages/beverages.json |
| Bibite | bibite/ | beverages/beverages.json |
| Caffetteria | caffetteria/ | beverages/beverages.json |
| Bollicine | bollicine/ | beverages/beverages.json |
| Bianchi fermi | bianchi-fermi/ | beverages/beverages.json |
| Vini rossi | vini-rossi/ | beverages/beverages.json |

### Formato Dati

**File Markdown (sorgente)**
```markdown
---
nome: "Hamburger Classico"
category: "hamburger-bufala"
prezzo: 12.50
descrizione: "Carne di bufala 100%, pomodoro, insalata"
allergeni:
  - "Glutine"
  - "Lattosio"
tags:
  - "Più venduto"
disponibile: true
order: 1
---
```

**File JSON (generato automaticamente)**
```json
{
  "food": [
    {
      "nome": "Hamburger Classico",
      "category": "hamburger-bufala",
      "prezzo": 12.50,
      "descrizione": "Carne di bufala 100%, pomodoro, insalata",
      "allergeni": ["Glutine", "Lattosio"],
      "tags": ["Più venduto"],
      "disponibile": true,
      "order": 1
    }
  ],
  "foodByCategory": { ... },
  "categoryOrder": { ... }
}
```

## 🔐 Autenticazione e Sicurezza

### Sistema Login

1. **Credenziali**: Email + Password configurati in variabili ambiente/secret
2. **Token**: `base64(payload).firma` con firma **HMAC SHA-256** (`CMS_TOKEN_SECRET`, obbligatorio — fail-loud se assente)
3. **Validazione**: Verificata lato server nel Worker (confronto timing-safe)
4. **Scadenza**: Token valido per 30 giorni
5. **Multi-utente**: Supporto email multiple (separate da virgola)

### Sicurezza

- ✅ HTTPS automatico (certificato SSL gratuito)
- ✅ Token non salvato in localStorage (solo sessionStorage)
- ✅ Credenziali in variabili ambiente (non nel codice)
- ✅ GITHUB_TOKEN solo server-side
- ✅ Nessun database esposto

## ⚡ Performance

### Ottimizzazioni

1. **JSON Statici**
   - Lettura da raw.githubusercontent.com
   - Non conta verso rate limit API
   - Caching automatico

2. **Lazy Loading**
   - Immagini caricate solo quando visibili
   - Placeholder durante caricamento

3. **Rigenerazione Intelligente**
   - JSON rigenerati solo alla modifica
   - Commit unico per ogni collezione

4. **Frontend Leggero**
   - Vanilla JS (nessun framework)
   - CSS Grid nativo
   - < 100KB bundle totale

### Metriche Target

- **First Contentful Paint**: < 1.5s
- **Time to Interactive**: < 3s
- **Lighthouse Score**: > 90
- **Bundle Size**: < 100KB (senza immagini)

## 📱 PWA

### Caratteristiche

- **Manifest**: Icone, nome, colori tema
- **Service Worker**: Cache assets statici
- **Installabile**: Aggiungibile a schermata home
- **Offline**: Contenuti cachati disponibili offline

## 🔌 API del Worker (`/api/*`)

### save-data

```javascript
// Azioni supportate:
- login          // Autenticazione utente
- verify-token   // Verifica sessione
- save           // Salva prodotto + rigenera JSON (OCC via SHA → 409 su conflitto)
- delete         // Elimina prodotto + rigenera JSON
- get-cloudinary-config  // Configurazione upload
```

### read-data

```javascript
// Strategie lettura:
1. Prova JSON statico (veloce, no rate limit)
2. mode=api (autenticato): API GitHub per ottenere gli SHA
3. Se JSON mancante → 503 json-miss (mai lista vuota silente)
```

### cloudinary-signature + upload-image

```javascript
// Upload primario: firma dal Worker, upload diretto browser→Cloudinary (signed)
// Fallback: relay Base64 via /api/upload-image
- Richiede: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
```

## 📊 Variabili Ambiente

| Variabile | Obbligatoria | Descrizione |
|-----------|--------------|-------------|
| `GITHUB_TOKEN` | ✅ (secret) | Token Classic con permesso repo |
| `ADMIN_EMAIL` | ✅ | Email ammesse (virgola-separate) |
| `ADMIN_PASSWORD` | ✅ (secret) | Password accesso CMS |
| `CMS_TOKEN_SECRET` | ✅ (secret) | Firma token sessione (fail-loud se assente) |
| `REPO_OWNER` | ✅ | Owner repo GitHub |
| `REPO_NAME` | ✅ | Nome repo GitHub |
| `GITHUB_BRANCH` | ❌ | Default `main` |
| `CLOUDINARY_CLOUD_NAME` | ❌ | Per upload immagini |
| `CLOUDINARY_API_KEY` | ❌ (secret) | Upload firmato |
| `CLOUDINARY_API_SECRET` | ❌ (secret) | Upload firmato |
| `CLOUDINARY_FOLDER` | ❌ | Cartella upload (default `arconti31`) |
| `ALLOWED_ORIGINS` | ❌ | Origini CORS extra |

## 🧪 Testing

### Test Manuali

1. Aggiungi prodotto da /admin
2. Verifica JSON rigenerato su GitHub
3. Ricarica frontend → prodotto visibile
4. Test filtri categorie
5. Test responsive (Chrome DevTools)
6. Test offline (PWA)

## 🔧 Manutenzione

### Zero Manutenzione Richiesta

- ✅ Nessun aggiornamento software
- ✅ Nessun database da ottimizzare
- ✅ Nessun server da patchare
- ✅ Backup automatici (Git)
- ✅ JSON rigenerati automaticamente

### Backup

- Ogni modifica = commit Git
- Storia completa su GitHub
- Rollback Worker: `npx wrangler rollback` (vedi `CLOUDFLARE_DEPLOY.md` §11)

## 📚 Risorse Utili

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Wrangler Docs](https://developers.cloudflare.com/workers/wrangler/)
- [Cloudinary Docs](https://cloudinary.com/documentation)
- [GitHub API Docs](https://docs.github.com/en/rest)
