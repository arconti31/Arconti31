# 📱 Guida Rapida per il Ristoratore

## Come Gestire il Menù Digitale

### 🔐 Accesso al Pannello

1. Apri il browser (Chrome, Safari, Firefox)
2. Vai su: `https://arconti31.com/admin`
3. Inserisci **email** e **password**
4. Sei dentro!

---

## 📋 Pannello di Controllo

Una volta dentro vedrai la sidebar con tutte le sezioni:

| Sezione | Cosa contiene |
|---------|---------------|
| ⚙️ Gestione Categorie | Crea e gestisci le categorie del menù |
| Menù Food | Piatti, hamburger, panini, ecc. |
| Menù Beverage: Birre | Tutte le birre (spina, bottiglia, speciali) |
| Menù Beverage: Cocktails | Cocktail e drink |
| Menù Beverage: Analcolici | Bevande senza alcol |
| Menù Beverage: Bibite | Coca, Fanta, ecc. |
| Menù Beverage: Caffetteria | Caffè, cappuccino, ecc. |
| Menù Beverage: Bollicine | Prosecco, spumanti |
| Menù Beverage: Bianchi fermi | Vini bianchi |
| Menù Beverage: Vini rossi | Vini rossi |

---

## ➕ Aggiungere un Nuovo Prodotto

1. Clicca sulla sezione desiderata (es. "Menù Food")
2. Clicca il pulsante **"Nuovo"** in alto
3. Compila i campi:

| Campo | Descrizione |
|-------|-------------|
| **Nome** | Nome del prodotto (obbligatorio) |
| **Categoria/Sezione** | Dove apparirà nel menù |
| **Immagine** | Foto grande del prodotto (opzionale) |
| **Logo** | Logo piccolo accanto al nome (opzionale) |
| **Descrizione** | Breve descrizione (max 500 caratteri) |
| **Descrizione Dettagliata** | Per il popup (max 2000 caratteri) |
| **Prezzo** | Il prezzo in euro (es. 5.50) |
| **Formato** | Es: Calice, Bottiglia 0,75L, Boccale 0,5L |
| **Gradazione** | Solo per alcolici (es. 5.2%) |
| **Tag Speciali** | Novità, Biologico, Più venduto, ecc. |
| **Allergeni** | Glutine, Lattosio, Solfiti, ecc. |
| **Disponibile** | Spunta se disponibile |
| **Ordine** | Numero per ordinare (1, 2, 3...) |

4. Clicca **"Salva"** in alto a destra
5. Aspetta 30-60 secondi → Il prodotto appare sul sito!

---

## ✏️ Modificare un Prodotto

1. Dalla lista, clicca sul prodotto
2. Modifica i campi che vuoi
3. Clicca **"Salva"**
4. Fatto! Il menù si aggiorna automaticamente

---

## 🗑️ Eliminare un Prodotto

1. Clicca sul prodotto
2. Clicca **"Elimina"** in alto
3. Conferma l'eliminazione
4. Il prodotto sparisce dal menù

---

## 🏷️ Gestire le Categorie

### Creare una Nuova Categoria

1. Vai su "⚙️ Gestione Categorie"
2. Clicca "Nuovo"
3. Compila:
   - **Nome**: Nome visibile (es. "Hamburger Speciali")
   - **Slug**: ID unico (es. "hamburger-speciali")
   - **Tipo**: Food o Beverage
   - **Icona**: Emoji (es. 🍔)
   - **Immagine**: Foto della categoria
   - **Ordine**: Posizione nel menù
4. Salva

### Nascondere una Categoria

Se vuoi nascondere temporaneamente una categoria:
1. Apri la categoria
2. Togli la spunta da "Visibile"
3. Salva

---

## 📸 Caricare Immagini

### Opzione 1: Incolla URL (Più Facile)

Puoi usare immagini già online:
- Google Drive (rendi pubblico)
- Imgur
- Qualsiasi URL pubblico

### Opzione 2: Upload Diretto

Se configurato Cloudinary:
1. Clicca sul campo immagine
2. Seleziona o trascina la foto
3. Attendi upload

### Consigli per le Foto

- ✅ Foto chiare e ben illuminate
- ✅ Formato: JPG o PNG
- ✅ Dimensione: 800x600 pixel minimo
- ✅ Peso: massimo 5MB
- ❌ Evita foto sfocate o troppo scure

---

## 📱 Da Smartphone

Il pannello admin funziona perfettamente da mobile:
1. Apri il browser
2. Vai su `arconti31.com/admin`
3. Login
4. Gestisci tutto con tap e swipe!

---

## ⏱️ Tempi di Aggiornamento

| Azione | Tempo |
|--------|-------|
| Modifica semplice | 30-60 secondi |
| Caricamento foto | 1-2 minuti |
| Nuova categoria | 1-2 minuti |

Se non vedi la modifica: **ricarica la pagina** (tira giù su mobile)

---

## 💡 Trucchi Utili

1. **Numeri con spazi**: Usa 10, 20, 30... per l'ordine, così puoi inserire prodotti in mezzo (15, 25...)

2. **Prodotto non disponibile**: Invece di eliminarlo, togli la spunta da "Disponibile"

3. **Tag Speciali**: Usa "Novità" per i nuovi arrivi, "Più venduto" per i bestseller

4. **Allergeni**: Segnala sempre gli allergeni per sicurezza clienti

5. **Descrizione dettagliata**: Usa per informazioni extra (abbinamenti, storia, ingredienti)

---

## 🆘 Risoluzione Problemi

### Non vedo le modifiche
- Aspetta 1-2 minuti
- Ricarica la pagina (Ctrl+F5 o tira giù)
- Chiudi e riapri il browser

### Ho sbagliato qualcosa
- Nessun problema! Modifica o elimina quando vuoi
- Tutte le versioni sono salvate su GitHub

### Ho dimenticato la password
- Contatta l'amministratore del sito
- La password è configurata come secret su Cloudflare (`ADMIN_PASSWORD`)

### L'immagine non si carica
- Prova un'immagine più piccola (< 5MB)
- Prova formato JPG invece di PNG
- Usa un URL esterno come alternativa

---

## ✅ Checklist Prima di Salvare

- [ ] Nome prodotto corretto
- [ ] Prezzo giusto
- [ ] Categoria corretta
- [ ] Descrizione senza errori
- [ ] Allergeni indicati
- [ ] Disponibilità corretta
- [ ] Ordine impostato

---

## 🎯 Esempi Pratici

### Aggiungere un Nuovo Hamburger

```
Nome: Hamburger Gorgonzola
Categoria: Hamburger di bufala
Prezzo: 14.50
Descrizione: Carne di bufala, gorgonzola DOP, rucola, noci caramellate
Allergeni: ✓ Glutine, ✓ Lattosio, ✓ Frutta a Guscio
Tag: ✓ Novità
Disponibile: ✓
Ordine: 5
```

### Aggiungere una Birra Stagionale

```
Nome: Birra di Natale 2024
Sezione: Birre speciali in bottiglia
Prezzo: 7.50
Descrizione: Birra speziata con cannella e arancia
Gradazione: 8%
Tag: ✓ Novità, ✓ Specialità
Disponibile: ✓
Ordine: 1
```

---

**Ricorda**: Ogni modifica è salvata automaticamente e il menù si aggiorna da solo. Non devi fare nient'altro! 🎉
