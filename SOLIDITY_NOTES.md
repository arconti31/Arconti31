# Note di solidità (breaking changes e azioni esterne)

Documento breve e operativo. Descrive cosa cambia con l'aggiornamento di solidità del CMS e **cosa devi fare tu** fuori dal codice (Cloudflare, GitHub, DNS).

Per setup e deploy: [`admin/SETUP.md`](./admin/SETUP.md) e [`CLOUDFLARE_DEPLOY.md`](./CLOUDFLARE_DEPLOY.md).

---

## Breaking changes

1. **`REPO_OWNER` e `REPO_NAME` sono sempre obbligatori**
   Non c'è più un default nel codice (niente più fallback silenzioso a un repo "storico").
   Se mancano, **il CMS non salva** (comportamento *fail-loud*: errore chiaro, non salvataggio sul posto sbagliato).

2. **Senza `REPO_*` tra le variabili del Worker il CMS si ferma**
   Vale per la produzione e per ogni ambiente cliente. Impostale **prima** o **subito** al deploy.

3. **Branch GitHub configurabile**
   Il branch di scrittura non è più solo hardcodato: usa `GITHUB_BRANCH` (opzionale, default `main`).

4. **Segreto token CMS obbligatorio e separato dalla password**
   Con Cloudflare `CMS_TOKEN_SECRET` è **obbligatorio**: senza, l'auth fallisce volutamente
   con 500 `AUTH_CONFIG_MISSING` (nessun fallback sulla password).

---

## Cosa fa il codice ora (in sintesi)

| Comportamento | Dettaglio |
|---------------|-----------|
| Target repo | Solo da env: `REPO_OWNER` + `REPO_NAME` (obbligatori) |
| Branch commit | `GITHUB_BRANCH` se impostato, altrimenti `main` |
| Login CMS | `ADMIN_EMAIL` + `ADMIN_PASSWORD` |
| Firma token sessione | `CMS_TOKEN_SECRET` (obbligatorio, fail-loud) |
| Cartella Cloudinary | `CLOUDINARY_FOLDER` opzionale |
| CORS extra | `ALLOWED_ORIGINS` (virgola-separate); l'origine del sito è già considerata |
| Health check | `/api/health` deve rispondere **ok** |
| Messaggio dopo salvataggio | Il CMS può mostrare dove ha scritto, es. **«Salvato su owner/repo»** |

---

## Azioni esterne obbligatorie (tu / Cloudflare / GitHub)

Queste operazioni **non** si risolvono solo con il codice. Fallle a mano.

### A) Sul Worker di produzione

Secret (`npx wrangler secret put <NOME>`): `GITHUB_TOKEN`, `ADMIN_PASSWORD`,
`CMS_TOKEN_SECRET`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`.

Variabili (dashboard → Workers → arconti31 → Settings → Variables): `REPO_OWNER`,
`REPO_NAME`, `ADMIN_EMAIL`, e opzionali `GITHUB_BRANCH`, `CLOUDINARY_CLOUD_NAME`,
`CLOUDINARY_FOLDER`, `ALLOWED_ORIGINS`.

Dopo le modifiche: redeploy (`npm run deploy:cloudflare`) o attendi il deploy automatico
da push su `main` (Workers Builds).

Test:
1. Health: apri `https://arconti31.com/api/health` → deve dare `{"ok":true}`.
2. CMS: login → modifica di prova → salva → sul repo GitHub corretto deve comparire
   il commit; il CMS può mostrare «Salvato su owner/repo».

### B) Ambiente cliente (handoff)

1. Imposta **sempre**:
   - `REPO_OWNER` = username GitHub **del cliente**
   - `REPO_NAME` = nome esatto del repository del cliente
   - `GITHUB_TOKEN` = token Classic del cliente (scope `repo`)
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `CMS_TOKEN_SECRET`
2. Opzionali consigliati: `GITHUB_BRANCH`, Cloudinary, `ALLOWED_ORIGINS`.
3. Redeploy dopo le env/secret.
4. Test health + test salvataggio con commit **solo** sul repo del cliente.

### C) Freeze writer su un ambiente VECCHIO (prima che il ristorante usi il CMS nuovo)

Per evitare che qualcuno salvi ancora sul vecchio mentre il menù "vero" è sul nuovo:

1. **Rimuovi** il secret `GITHUB_TOKEN` dal worker/account vecchio
   (`npx wrangler secret delete GITHUB_TOKEN`), **oppure**
2. **Cambia** `ADMIN_PASSWORD` sul vecchio (così il login vecchio non funziona più
   con la password comunicata al ristorante).

Fai questo **prima** che il ristorante usi regolarmente il CMS nuovo.

### D) Rollback (se un deploy va male)

Vedi [`CLOUDFLARE_DEPLOY.md`](./CLOUDFLARE_DEPLOY.md) §11:

```bash
npx wrangler versions list     # trova la versione precedente funzionante
npx wrangler rollback [version-id]
```

Effetto immediato (< 1 minuto), nessuna build necessaria. In alternativa, redeploy
dall'ultimo commit funzionante.

---

## Env minime (promemoria)

**Obbligatorie**

```
GITHUB_TOKEN=ghp_...
REPO_OWNER=username_github
REPO_NAME=nome_repo
ADMIN_EMAIL=email@esempio.it
ADMIN_PASSWORD=********
CMS_TOKEN_SECRET=segreto_random_lungo
```

**Opzionali (consigliate dove indicato)**

```
GITHUB_BRANCH=main
CLOUDINARY_FOLDER=nome-cartella
ALLOWED_ORIGINS=https://altro-dominio.example
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_UPLOAD_PRESET=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
```

---

## Checklist rapida post-deploy

- [ ] `REPO_OWNER` e `REPO_NAME` presenti sulle variabili del Worker **giusto**
- [ ] Redeploy fatto dopo le env/secret
- [ ] `/api/health` → ok
- [ ] Login CMS ok
- [ ] Salvataggio CMS → commit sul **repo corretto** (messaggio tipo «Salvato su owner/repo»)
- [ ] Freeze writer fatto su eventuali ambienti vecchi (token rimosso o password cambiata)
- [ ] (Se dominio nuovo) cutover DNS solo dopo test verdi; rollback pronto (§11)

---

## Riferimenti

- Setup CMS: [`admin/SETUP.md`](./admin/SETUP.md)
- Deploy generale: [`CLOUDFLARE_DEPLOY.md`](./CLOUDFLARE_DEPLOY.md)
