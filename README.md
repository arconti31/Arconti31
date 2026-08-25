# 🍽️ Menù Digitale Arconti31

Sistema di gestione contenuti (CMS) completo per menù digitale di ristorante/bar, con pannello di amministrazione semplice e intuitivo.

## ✨ Caratteristiche

- ✅ **100% Gratuito** - Hosting su Cloudflare Workers (free plan), nessun costo mensile
- 📱 **Mobile-First** - Perfetto su smartphone e tablet
- ⚡ **Velocissimo** - Sito statico ottimizzato con JSON pre-generati
- 🎨 **CMS Personalizzato** - Interfaccia grafica in italiano per gestire il menù
- 🖼️ **Upload Immagini** - Cloudinary o URL esterni
- 🔄 **Aggiornamento Automatico** - JSON rigenerati automaticamente ad ogni modifica
- 📴 **PWA Ready** - Funziona anche offline
- 🔐 **Autenticazione Sicura** - Login con email/password via Cloudflare Worker (token HMAC)
- 🚀 **Zero Manutenzione** - Nessun database, nessun server da gestire

## 📚 Categorie Gestibili

### 🍔 Menù Food
- Hamburger di bufala
- Hamburger Fassona e Street food
- Panini
- Griglieria
- Piatti Speciali
- Piadine
- Fritti
- Dolci
- Aperitivo
- E altre categorie personalizzabili

### 🍺 Menù Beverage
- **Birre** (4 sezioni: artigianali a rotazione, alla spina, speciali in bottiglia, frigo)
- **Cocktails**
- **Analcolici**
- **Bibite**
- **Caffetteria**
- **Bollicine** (Prosecco, Spumanti)
- **Bianchi fermi**
- **Vini rossi**

## ☁️ Hosting: Cloudflare Workers

Il progetto gira su **Cloudflare Workers + Static Assets**. Backend in `src/worker/`,
build statico in `dist/`. Dominio: `arconti31.com` (+ `www`), DNS su Cloudflare.
La migrazione da Netlify è completata e il codice legacy Netlify è stato rimosso.

- Guida deploy, DNS e rollback: **[`CLOUDFLARE_DEPLOY.md`](./CLOUDFLARE_DEPLOY.md)**
- Report storico della migrazione: **[`MIGRATION_REPORT.md`](./MIGRATION_REPORT.md)**

## 🚚 Passaggio ad account del cliente (handoff)

Per spostare il progetto su GitHub/Cloudflare del cliente, parti da
**[`CLOUDFLARE_DEPLOY.md`](./CLOUDFLARE_DEPLOY.md)** (secret, dominio, deploy) e dalla
checklist di solidità in **[`SOLIDITY_NOTES.md`](./SOLIDITY_NOTES.md)** §B.

## 🧱 Solidità CMS (env obbligatorie)

Dopo l’aggiornamento di solidità, **`REPO_OWNER` e `REPO_NAME` sono sempre obbligatori**. Senza di esse il CMS **non salva**. Con Cloudflare è inoltre obbligatorio `CMS_TOKEN_SECRET`.  
Checklist operativa, freeze writer, health e rollback DNS: **[`SOLIDITY_NOTES.md`](./SOLIDITY_NOTES.md)**.

## 🚀 Setup Iniziale

### 1. Crea Repository GitHub

1. Vai su [GitHub](https://github.com) e crea un account
2. Clicca su "New Repository"
3. Nome: `arconti31` (o quello che preferisci)
4. Seleziona "Public"
5. Clicca "Create repository"

### 2. Carica i File

1. Scarica tutti i file di questo progetto
2. Caricali nel repository GitHub

### 3. Deploy su Cloudflare Workers

```bash
npm ci
npx wrangler login
npm run deploy:cloudflare
```

Procedura completa (CI/CD con Workers Builds, dominio custom, rollback):
[`CLOUDFLARE_DEPLOY.md`](./CLOUDFLARE_DEPLOY.md).

### 4. Configura Secret e Variabili

Secret via `npx wrangler secret put <NOME>`, variabili via dashboard Cloudflare:

| Variabile | Tipo | Descrizione |
|-----------|------|-------------|
| `GITHUB_TOKEN` | Secret | Token GitHub Classic con permesso `repo` |
| `ADMIN_PASSWORD` | Secret | Password per accesso CMS |
| `CMS_TOKEN_SECRET` | Secret | **Obbligatorio** — segreto firma token sessione |
| `CLOUDINARY_API_KEY` | Secret | Per upload immagini firmato |
| `CLOUDINARY_API_SECRET` | Secret | Per upload immagini firmato |
| `REPO_OWNER` | Var | **Obbligatorio** — username GitHub del proprietario del repo |
| `REPO_NAME` | Var | **Obbligatorio** — nome esatto del repository |
| `ADMIN_EMAIL` | Var | Email admin (può essere multipla, separate da virgola) |
| `GITHUB_BRANCH` | Var | (Opzionale) branch commit CMS, default `main` |
| `CLOUDINARY_CLOUD_NAME` | Var | (Opzionale) Cloud Name Cloudinary |
| `CLOUDINARY_FOLDER` | Var | (Opzionale) Cartella destinazione upload |
| `ALLOWED_ORIGINS` | Var | (Opzionale) Origini CORS extra, virgola-separate |

Dettaglio completo: [`admin/SETUP.md`](./admin/SETUP.md), deploy: [`CLOUDFLARE_DEPLOY.md`](./CLOUDFLARE_DEPLOY.md).

## 📝 Come Gestire il Menù

### Accedere al Pannello

1. Vai su `https://arconti31.arconti31.workers.dev/admin` (o dominio custom)
2. Inserisci email e password configurati
3. Vedrai la sidebar con tutte le collezioni

### Gestire Categorie

1. Clicca su "⚙️ Gestione Categorie"
2. Puoi creare, modificare, riordinare categorie
3. Ogni categoria ha: nome, slug, icona, immagine, ordine, visibilità

### Aggiungere Prodotti

1. Seleziona la collezione (es. "Menù Food", "Birre", "Cocktails")
2. Clicca "Nuovo"
3. Compila i campi richiesti
4. Clicca "Salva"
5. Il menù si aggiorna automaticamente in 30-60 secondi

### Campi Disponibili per Prodotto

- **Nome** (obbligatorio)
- **Categoria/Sezione**
- **Immagine Grande** (opzionale)
- **Logo Piccolo** (opzionale)
- **Descrizione Breve** (max 500 caratteri)
- **Descrizione Dettagliata** (max 2000 caratteri, visibile nel popup)
- **Prezzo**
- **Formato** (es: Boccale 0,5L, Calice)
- **Gradazione Alcolica**
- **Tag Speciali** (Novità, Senza Glutine, Biologico, Più venduto)
- **Allergeni** (Glutine, Lattosio, Solfiti, ecc.)
- **Disponibilità**
- **Ordine**

## 🎨 Personalizzazione

### Cambiare Colori

Modifica il file `css/style.css`, sezione `:root`:

```css
:root {
    --primary: #f59e0b;
    --secondary: #1f2937;
    --text: #374151;
    --bg: #f9fafb;
}
```

### Aggiungere Nuove Categorie

Usa il pannello admin "Gestione Categorie" per creare nuove categorie senza toccare codice.

## 💰 Costi

**ZERO €** - Tutto completamente gratuito:
- Cloudflare Workers: 100.000 richieste/giorno gratis (asset statici illimitati)
- GitHub: Repository pubblici illimitati
- Cloudinary: 25 GB storage gratuito
- Nessun canone mensile

## 🔧 Architettura

- **Frontend**: HTML5, CSS3, JavaScript Vanilla
- **CMS**: Custom (cms-simple.js)
- **Backend**: Cloudflare Worker TypeScript (`src/worker/`), API su `/api/*`
- **Storage**: GitHub + JSON statici
- **Immagini**: Cloudinary (upload diretto firmato) o URL esterni
- **PWA**: Service Worker + Manifest

Dettagli: [`ARCHITETTURA.md`](./ARCHITETTURA.md)

## 📈 Performance

- ✅ Lighthouse Score > 90
- ✅ Caricamento < 2 secondi
- ✅ Mobile-friendly
- ✅ SEO ottimizzato
- ✅ Lazy loading immagini
- ✅ JSON statici (zero rate limiting)

## 📄 Licenza

MIT - Usa liberamente per il tuo ristorante!
Progetto sviluppato da [WebNovis](https://webnovis.com) — Agenzia di sviluppo web e SEO a Rho (Milano).

## 📞 Contatti

**Arconti31**  
Via Vittorio Arconti, 31  
21013 Gallarate VA
