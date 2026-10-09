// pair-server.js
// Bot Telegram de "pairing" pour AKANE MD v2.5.
//
// Ce que ça fait :
//   1. Quelqu'un tape /pair sur Telegram (avec son numéro WhatsApp).
//   2. Le serveur crée une SESSION WHATSAPP INDÉPENDANTE pour ce numéro
//      (dossier de session séparé, socket Baileys séparé) et demande un
//      code de pairing (8 caractères) à WhatsApp pour ce numéro.
//   3. Le code est envoyé sur Telegram. La personne l'entre dans
//      WhatsApp > Appareils connectés > Connecter un appareil > "Se
//      connecter avec le numéro de téléphone".
//   4. Dès que la connexion s'ouvre, le bot est actif pour CE numéro,
//      et Telegram reçoit une confirmation.
//
// ── Pourquoi une session par numéro (important) ───────────────────────────
// Le bug connu "tous les numéros pairés sont traités comme le même bot"
// vient presque toujours du fait de réutiliser UNE SEULE variable/instance
// de socket globale pour tout le monde. Ici, chaque numéro a :
//   - son propre dossier d'auth : ./sessions/<numero>/
//   - son propre socket Baileys, stocké dans sessions.get(numero)
//   - ses propres event listeners (jamais partagés entre numéros)
// Ne modifie jamais ce fichier pour utiliser un seul "sock" partagé.
//
// ── Intégration avec le vrai bot AKANE MD ─────────────────────────────────
// Au démarrage, ce script clone TOUT SEUL le repo AKANE-MD-v2.5 (git clone
// + npm install) s'il n'est pas déjà présent sur le serveur — voir
// ensureRepoCloned() plus bas. Ensuite, il essaie de charger automatiquement
// le point d'entrée du repo (lu depuis son package.json) et de détecter la
// fonction qui gère les messages — voir loadBotModule().
//
// ⚠️ Je n'ai jamais pu lire le contenu réel du repo (GitHub bloque la
// lecture automatisée sur github.com, et je n'ai pas d'accès réseau direct
// pour tester le clone moi-même). La détection automatique ci-dessous est
// donc une BEST-EFFORT : au premier lancement, regarde les logs de la
// console — ils affichent la liste des exports trouvés dans le module
// chargé. Si aucun candidat ne matche, dis-moi le nom exact du fichier et
// de la fonction/export à utiliser et je fixe `HANDLER_EXPORT_NAME` en dur.
//
// ── Installation ───────────────────────────────────────────────────────
//   npm install telegraf @whiskeysockets/baileys pino
//   (git doit être installé sur le serveur pour le clone automatique)
//
// ── Lancement ─────────────────────────────────────────────────────────
//   node pair-server.js

import { Telegraf, Markup } from 'telegraf';
import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    delay,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { pathToFileURL } from 'url';
import http from 'http';
import crypto from 'crypto';

// ── Configuration (tout en dur) ────────────────────────────────────────
const CONFIG = {
    TELEGRAM_BOT_TOKEN: '8863220568:AAEa2Nxj1qJM7Gyg4HFbGz8Btxdz_Gzhh0w', // via @BotFather
    SESSIONS_DIR: './sessions',                        // un sous-dossier par numéro
    RELAY_URL: 'https://website-v2-5.onrender.com',
RELAY_SECRET: 'nxhYh2LCIp5SSxvMQCjmMavCCAguenB',
    // ── Accueil Telegram (canal + groupe) ──
    CHANNEL_USERNAME: '@akane_md',
    CHANNEL_LINK: 'https://t.me/akane_md',
    GROUP_LINK: 'https://t.me/+u1LxUwWBtxBlMzE0',
    GROUP_CHAT_ID: null,   // ID du groupe (ex : -1001234567890). Sinon, tape /setgroup dans le groupe (en admin)
    WELCOME_MEDIA: 'https://tinyurl.com/232hz8de', // photo, GIF ou vidéo (lien direct ou tinyurl)
    GOODBYE_MEDIA: 'https://tinyurl.com/2cho3aoh',
    REPO_URL: 'https://github.com/akanefx2003/AKANE-MD-v2.5.git',
    PAIRING_CODE: 'AKANEMD9',                          // code de pairing fixe (8 caractères)
    REPO_DIR: './AKANE-MD-v2.5',                        // où le repo est cloné
    // Si l'auto-détection échoue, mets ici le nom exact de l'export à
    // utiliser (ex: 'handleMessages', 'default'...) et le script l'utilisera
    // directement sans essayer de deviner.
    HANDLER_EXPORT_NAME: null,
    // ── Menu Telegram ──
    MENU_PHOTO_URL: 'https://tinyurl.com/26jaawp5',   // photo affichée avec le menu
    OWNER_USERNAME: 'dev_akane',                       // sans le @
    DEV_CHANNEL_URL: '',                               // lien de ta chaîne (ex: https://t.me/... ou WhatsApp)
    // ── Admin ──
    ADMIN_PASSWORD: 'AKANE',   // demandé pour /annonce et pour déconnecter un numéro qui n'est pas le sien
    ADMIN_IDS: [],             // (optionnel) IDs Telegram autorisés à essayer le mot de passe. Vide = tout le monde peut essayer
    DATA_DIR: './data',        // liste des utilisateurs Telegram (pour /annonce)
    // ── API web : le site de pairing (Render / Vercel...) appelle CE bot ──
    WEB_PORT: Number(process.env.PORT || process.env.SERVER_PORT || 3000),
    WEB_ORIGINS: ['*'],        // recommandé : ['https://ton-site.vercel.app'] pour n'autoriser que ton site
    WEB_RATE_LIMIT: 5,         // demandes de code max par IP (et par numéro) ...
    WEB_RATE_WINDOW_MS: 10 * 60 * 1000, // ... sur cette durée
    WEB_NOTIFY_CHAT_ID: null,  // (optionnel) chat Telegram prévenu à chaque pairing lancé depuis le site
};

if (!CONFIG.TELEGRAM_BOT_TOKEN || CONFIG.TELEGRAM_BOT_TOKEN.includes('METS_TON_TOKEN')) {
    console.error('❌ Renseigne TELEGRAM_BOT_TOKEN dans CONFIG en haut du fichier.');
    process.exit(1);
}

fs.mkdirSync(CONFIG.SESSIONS_DIR, { recursive: true });
fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });

// ── Clonage automatique du repo AKANE-MD-v2.5 ─────────────────────────────
function ensureRepoCloned() {
    if (fs.existsSync(path.join(CONFIG.REPO_DIR, '.git'))) {
        // Repo déjà cloné : on ne touche plus à rien, on garde tel quel la
        // version locale (pas de git pull, pour éviter d'écraser des modifs
        // locales ou de tomber sur un fichier corrompu après un pull partiel).
        console.log('📦 Repo AKANE-MD-v2.5 déjà présent — on ignore la mise à jour, on garde la version locale.');
        return;
    }
    console.log(`⬇️  Clonage de ${CONFIG.REPO_URL} dans ${CONFIG.REPO_DIR}...`);
    try {
        execSync(`git clone ${CONFIG.REPO_URL} ${CONFIG.REPO_DIR}`, {
            stdio: 'inherit',
            timeout: 30000, // 30s max — au-delà, on considère que ça bloque
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, // jamais de prompt interactif
        });
    } catch (err) {
        console.error('❌ Le clonage a échoué ou a dépassé 30s. Causes probables :');
        console.error('   • Le repo est privé (git demandait un login qui ne peut jamais arriver ici)');
        console.error('   • Pas d\'accès réseau sortant vers github.com depuis ce serveur');
        console.error('   Détail :', err.message);
        process.exit(1);
    }
    console.log('📦 Installation des dépendances du repo cloné (npm install)...');
    execSync('npm install', { cwd: CONFIG.REPO_DIR, stdio: 'inherit' });
    console.log('✅ Repo cloné et installé.');
}

// Charge le module principal du repo cloné (le vrai index.js d'AKANE MD) et
// récupère directement sa fonction handleMessage — plus de devinette de nom
// d'export : index.js exporte maintenant explicitement handleMessage,
// handleGroupUpdate et pluginManager pour cet usage précis. Il faut aussi
// initialiser pluginManager (charger les plugins) UNE SEULE FOIS ici, sinon
// aucune commande ("menu" y compris) ne sera reconnue pour les sessions
// pairées depuis Telegram.
async function loadBotModule() {
    const pkgPath = path.join(CONFIG.REPO_DIR, 'package.json');
    let mainFile = 'index.js';
    if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        mainFile = pkg.main || mainFile;
    }

    const entryPath = path.resolve(CONFIG.REPO_DIR, mainFile);
    if (!fs.existsSync(entryPath)) {
        console.warn(`⚠️ Point d'entrée introuvable : ${entryPath}. Le bot restera en mode "pairing seul".`);
        return { module: null, handlerFn: null };
    }

    const mod = await import(pathToFileURL(entryPath).href);
    console.log('📋 Exports trouvés dans', mainFile, ':', Object.keys(mod));

    let handlerFn = null;
    if (typeof mod.handleMessage === 'function') {
        handlerFn = mod.handleMessage;
        console.log('✅ handleMessage trouvé et branché.');
    } else if (CONFIG.HANDLER_EXPORT_NAME && typeof mod[CONFIG.HANDLER_EXPORT_NAME] === 'function') {
        handlerFn = mod[CONFIG.HANDLER_EXPORT_NAME];
    } else {
        // repli : anciens noms possibles, au cas où index.js n'a pas encore
        // été mis à jour avec l'export explicite handleMessage
        const candidates = ['handleMessages', 'handler', 'messageHandler', 'default'];
        for (const name of candidates) {
            if (typeof mod[name] === 'function') {
                handlerFn = mod[name];
                console.log(`✅ Handler auto-détecté : export "${name}"`);
                break;
            }
        }
    }

    if (!handlerFn) {
        console.warn(
            '⚠️ Aucun handler détecté. Vérifie que index.js exporte bien "handleMessage" ' +
            '(export { handleMessage } en bas du fichier).'
        );
    }

    // Charge les plugins une seule fois, sinon aucune commande ("menu" y
    // compris) ne sera reconnue pour les sessions pairées depuis Telegram.
    if (mod.pluginManager && typeof mod.pluginManager.loadAll === 'function') {
        await mod.pluginManager.loadAll();
        console.log('✅ Plugins chargés pour les sessions pairées depuis Telegram.');
    }

    return { module: mod, handlerFn };
}

// numero (string, chiffres uniquement) -> { sock, status, telegramChatId }
const sessions = new Map();
// telegramChatId -> Set<numero>  (pour /status et /unpair)
const chatToNumbers = new Map();

function cleanNumber(raw) {
    return (raw || '').replace(/[^0-9]/g, '');
}

function trackChatNumber(chatId, number) {
    if (!chatToNumbers.has(chatId)) chatToNumbers.set(chatId, new Set());
    chatToNumbers.get(chatId).add(number);
}

// ── Données persistantes : utilisateurs Telegram + propriétaire de chaque session ──
const USERS_FILE = path.join(CONFIG.DATA_DIR, 'users.json');
function loadUsers() {
    try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return []; }
}
const users = new Set(loadUsers());
function saveUsers() {
    try { fs.writeFileSync(USERS_FILE, JSON.stringify([...users])); }
    catch (e) { console.warn('⚠️ Sauvegarde users.json impossible :', e.message); }
}

// Le propriétaire (chat Telegram qui a fait /pair) est stocké dans le dossier de
// la session : il survit aux redémarrages et disparaît avec la session.
const ownerFile = (number) => path.join(CONFIG.SESSIONS_DIR, number, '.owner');
function saveOwner(number, chatId) {
    try {
        fs.mkdirSync(path.dirname(ownerFile(number)), { recursive: true });
        fs.writeFileSync(ownerFile(number), String(chatId));
    } catch {}
}
function readOwner(number) {
    try {
        const v = Number(fs.readFileSync(ownerFile(number), 'utf8').trim());
        return Number.isFinite(v) && v !== 0 ? v : null;
    } catch { return null; }
}
function isRegistered(number) {
    try {
        return !!JSON.parse(fs.readFileSync(path.join(CONFIG.SESSIONS_DIR, number, 'creds.json'), 'utf8')).registered;
    } catch { return false; }
}

function untrackNumber(number) {
    for (const set of chatToNumbers.values()) set.delete(number);
}

// Supprime la session en local (mémoire + dossier), sans parler à WhatsApp.
function dropSessionLocal(number) {
    if (typeof botMarkDisconnected === 'function') botMarkDisconnected(number);
    sessions.delete(number);
    untrackNumber(number);
    fs.rmSync(path.join(CONFIG.SESSIONS_DIR, number), { recursive: true, force: true });
}

async function removeSession(number) {
    const entry = sessions.get(number);
    sessions.delete(number); // d'abord : les events de fermeture de l'ancien socket seront ignorés
    if (entry) await entry.sock.logout().catch(() => {});
    dropSessionLocal(number);
}

// ── Mot de passe admin ──────────────────────────────────────────────────
const escapeHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const say = (ctx, t) => ctx.reply(`<b>${t}</b>`, { parse_mode: 'HTML' });

const pending = new Map();      // chatId -> { type, number?, text?, expires, tries }
const lockedUntil = new Map();  // chatId -> timestamp (trop d'essais ratés)
const PENDING_TTL = 2 * 60 * 1000;
const MAX_TRIES = 3;
const LOCK_MS = 10 * 60 * 1000;

function canTryAdmin(ctx) {
    return !CONFIG.ADMIN_IDS.length || CONFIG.ADMIN_IDS.includes(ctx.from?.id);
}

async function askPassword(ctx, action, prompt) {
    if (Date.now() < (lockedUntil.get(ctx.chat.id) || 0)) {
        return say(ctx, '🚫 TROP D\'ESSAIS RATÉS. RÉESSAIE PLUS TARD.');
    }
    if (!canTryAdmin(ctx)) return say(ctx, '⛔ ACTION RÉSERVÉE À L\'ADMIN.');
    pending.set(ctx.chat.id, { ...action, expires: Date.now() + PENDING_TTL, tries: 0 });
    return say(ctx, prompt);
}

async function broadcast(ctx, text) {
    const html = `<b>📢 ANNONCE</b>\n\n<b>${escapeHtml(text)}</b>\n\n<b>— DEV AKANE 🌹</b>`;
    let ok = 0, fail = 0;
    for (const id of [...users]) {
        try {
            await bot.telegram.sendMessage(id, html, { parse_mode: 'HTML' });
            ok++;
        } catch (err) {
            fail++;
            if (err?.response?.error_code === 403) users.delete(id); // a bloqué le bot
        }
        await delay(60); // reste sous la limite d'envoi de Telegram
    }
    saveUsers();
    return say(ctx, `✅ ANNONCE ENVOYÉE : ${ok} REÇU(S) / ${fail} ÉCHEC(S)`);
}

// Message du code de pairing, même cadre que le menu v2.5.
// Le code n'est PAS écrit dans le texte : le seul moyen de l'obtenir est le bouton
// vert « COPIER LE CODE » (copy_text natif Telegram, style "success" = vert).
function pairCodeMessage(number, code) {
    const b = (t) => `<b>${t}</b>`;
    const text = [
        b('╭⊷〔 CODE DE PAIRING WHATSAPP 〕'),
        b(`┃ · ͟͟͞͞➳❥ NUMÉRO : +${escapeHtml(number)}`),
        b('┠─ 🄰🄺🄰🄽🄴 🄼🄳 v2.5'),
        b('┃ · ͟͟͞͞➳❥ WHATSAPP → APPAREILS CONNECTÉS'),
        b('┃ · ͟͟͞͞➳❥ CONNECTER UN APPAREIL'),
        b('┃ · ͟͟͞͞➳❥ SE CONNECTER AVEC LE NUMÉRO'),
        b('┃ · ͟͟͞͞➳❥ COLLE LE CODE COPIÉ ⏱️'),
        b('┃ · ͟͟͞͞➳❥ LE CODE PEUT EXPIRER. NE LE PARTAGE JAMAIS 🔐'),
        b('╰⊷─────────◈'),
        b('POWER BY DEV AKANE 🌹'),
    ].join('\n');
    const reply_markup = {
        inline_keyboard: [[{ text: '📋 COPIER LE CODE', copy_text: { text: String(code) }, style: 'success' }]],
    };
    return { text, extra: { parse_mode: 'HTML', reply_markup } };
}

// Rempli au démarrage par loadBotModule() — voir main() tout en bas.
let botHandlerFn = null;
// Envoie le DM de confirmation ("AKANE MD CONNECTER AVEC SUCCÈS" + liens) —
// exactement le même message que reçoit le numéro principal du bot. Sans ça,
// le pairing Telegram réussissait bien côté WhatsApp mais ce message
// n'arrivait jamais (seule la confirmation Telegram était envoyée).
let botSendConnectedMessage = null;
// Fonctions exportées par index.js / boutons.js : elles donnent aux sessions
// Telegram exactement le même comportement que le bot déployé directement sur
// un panel (tag « Voir la chaîne » sur chaque message + abonnement à la chaîne
// + événements de groupe).
let botApplyCanalInfo = null;
let botFollowChannel = null;
let botGroupHandlerFn = null;
// Chrono d'uptime par numéro (depuis la connexion WhatsApp, pas depuis le démarrage du bot Telegram).
let botMarkConnected = null;
let botMarkDisconnected = null;

// Appelée une seule fois par session, juste après que la connexion soit
// "open". `sock` est LE socket de cette session (et seulement celle-ci).
// IMPORTANT : handleMessage(sock, event) attend l'ÉVÉNEMENT complet (avec
// event.messages, un tableau, et event.type) — exactement comme index.js
// l'utilise pour sa propre session. Ne PAS extraire messages[0] et l'envoyer
// seul : c'était le bug qui faisait que rien ne répondait jamais côté
// WhatsApp après un pairing réussi depuis Telegram (le handler recevait un
// objet dans un format qu'il ne reconnaissait pas, ou n'était jamais appelé
// du tout faute d'avoir été détecté).
function attachBotHandler(sock, number) {
    sock.ev.on('messages.upsert', async (event) => {
        try {
            if (botHandlerFn) {
                await botHandlerFn(sock, event);
            } else {
                console.warn(`⚠️ [${number}] Message reçu mais aucun handler branché (voir CONFIG.HANDLER_EXPORT_NAME).`);
            }
        } catch (err) {
            console.warn(`⚠️ [${number}] Erreur handler message :`, err.message);
        }
    });

    sock.ev.on('group-participants.update', (update) => {
        if (!botGroupHandlerFn) return;
        botGroupHandlerFn(sock, update).catch((err) =>
            console.warn(`⚠️ [${number}] Erreur handler groupe :`, err.message)
        );
    });
}

// Démarre (ou redémarre) la session WhatsApp d'UN numéro. Sert pour :
//   - un nouveau pairing (/pair)            → requestCode = true
//   - la restauration au démarrage du serveur → chatId lu depuis sessions/<numero>/.owner
//   - la reconnexion automatique après une coupure
async function startSession(number, chatId, { requestCode = false, onCode = null, onError = null } = {}) {
    const sessionPath = path.join(CONFIG.SESSIONS_DIR, number);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    if (chatId) saveOwner(number, chatId);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.macOS('Chrome'), // requis pour le pairing par code
    });

    // Tag « Voir la chaîne » sur TOUS les messages envoyés par ce socket.
    if (typeof botApplyCanalInfo === 'function') botApplyCanalInfo(sock);

    sessions.set(number, {
        sock,
        status: state.creds.registered ? 'connecting' : 'pairing',
        telegramChatId: chatId ?? null,
    });
    if (chatId) trackChatNumber(chatId, number);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        const entry = sessions.get(number);
        // Socket remplacé, ou session supprimée entre-temps : on ignore.
        if (!entry || entry.sock !== sock) return;
        const owner = entry.telegramChatId;

        if (connection === 'open') {
            entry.status = 'connected';
            webSet(number, { status: 'connected', code: null });
            if (typeof botMarkConnected === 'function') botMarkConnected(sock);
            attachBotHandler(sock, number);
            if (typeof botFollowChannel === 'function') botFollowChannel(sock).catch(() => {});
            console.log(`✅ [${number}] Session connectée.`);

            // Premier "open" seulement (marqueur) : pas de message à chaque redémarrage
            // du serveur ni à chaque reconnexion.
            const marker = path.join(sessionPath, '.welcomed');
            if (!fs.existsSync(marker)) {
                fs.writeFileSync(marker, String(Date.now()));
                if (owner) {
                    bot.telegram.sendMessage(
                        owner,
                        `🎉 Le numéro +${number} est maintenant connecté ! Le bot est actif pour ce numéro.`
                    ).catch(() => {});
                }
                if (typeof botSendConnectedMessage === 'function') {
                    setTimeout(() => {
                        botSendConnectedMessage(sock).catch((err) =>
                            console.warn(`⚠️ [${number}] Message de connexion WhatsApp :`, err.message)
                        );
                    }, 3000);
                } else {
                    console.warn(`⚠️ [${number}] sendConnectedMessage indisponible (index.js pas à jour ?) — DM de connexion non envoyé.`);
                }
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;

            if (statusCode === DisconnectReason.loggedOut) {
                webSet(number, { status: 'error', error: 'Numéro déconnecté depuis le téléphone.' });
                dropSessionLocal(number);
                if (owner) {
                    bot.telegram.sendMessage(
                        owner,
                        `🔌 Le numéro +${number} a été déconnecté (déconnexion depuis le téléphone). Retape /pair pour reconnecter.`
                    ).catch(() => {});
                }
                console.log(`🔌 [${number}] Déconnecté (logout), session supprimée.`);
                return;
            }

            // Code de pairing jamais saisi / expiré : inutile de reconnecter en boucle.
            if (!sock.authState.creds.registered) {
                webSet(number, { status: 'expired', code: null });
                dropSessionLocal(number);
                if (owner) {
                    bot.telegram.sendMessage(
                        owner,
                        `⌛ Le code de pairing pour +${number} a expiré. Retape /pair pour en avoir un nouveau.`
                    ).catch(() => {});
                }
                return;
            }

            console.warn(`⚠️ [${number}] Connexion fermée, tentative de reconnexion...`);
            entry.status = 'connecting';
            await delay(2000);
            if (sessions.get(number)?.sock !== sock) return; // supprimée pendant l'attente
            startSession(number, owner).catch((err) =>
                console.warn(`⚠️ [${number}] Reconnexion impossible :`, err.message)
            );
        }
    });

    // Demande le code de pairing seulement pour un nouveau pairing
    if (requestCode && !sock.authState.creds.registered) {
        await delay(1500); // laisse le socket s'initialiser avant de demander le code
        try {
            const code = await sock.requestPairingCode(number, CONFIG.PAIRING_CODE);
            if (onCode) onCode(code); // demande venue du site : le code part vers le site
            if (chatId) {
                const msg = pairCodeMessage(number, code);
                await bot.telegram.sendMessage(chatId, msg.text, msg.extra);
            }
        } catch (err) {
            sessions.delete(number);
            untrackNumber(number);
            if (onError) onError(err);
            if (chatId) await bot.telegram.sendMessage(chatId, `❌ Impossible de générer un code pour +${number} : ${err.message}`);
        }
    }
}

// Au démarrage du serveur : reconnecte toutes les sessions déjà pairées
// (dossiers ./sessions/<numero>/ avec creds.json). Plus besoin de refaire /pair.
async function restoreSessions() {
    let dirs = [];
    try {
        dirs = fs.readdirSync(CONFIG.SESSIONS_DIR, { withFileTypes: true })
            .filter((d) => d.isDirectory() && /^[0-9]{6,}$/.test(d.name))
            .map((d) => d.name);
    } catch {}

    let restored = 0;
    for (const number of dirs) {
        if (!isRegistered(number)) {
            console.log(`⏭️ [${number}] Pairing jamais terminé, session ignorée.`);
            continue;
        }
        const chatId = readOwner(number);
        if (chatId && !users.has(chatId)) users.add(chatId);
        try {
            await startSession(number, chatId);
            restored++;
        } catch (err) {
            console.warn(`⚠️ [${number}] Restauration impossible :`, err.message);
        }
        await delay(1500); // évite de connecter tous les numéros d'un coup
    }
    saveUsers();
    console.log(`♻️ ${restored} session(s) WhatsApp restaurée(s).`);
}

// ── Bot Telegram ────────────────────────────────────────────────────────
const bot = new Telegraf(CONFIG.TELEGRAM_BOT_TOKEN);

// Mémorise chaque utilisateur (chat privé) pour pouvoir lui envoyer les /annonce.
bot.use((ctx, next) => {
    if (ctx.chat?.type === 'private' && !users.has(ctx.chat.id)) {
        users.add(ctx.chat.id);
        saveUsers();
    }
    return next();
});

// ── Abonnement obligatoire : canal (+ groupe si son ID est connu) avant d'utiliser le bot ──
// Ne concerne que les chats privés. Si Telegram ne permet pas de vérifier (bot pas admin du
// canal), on laisse passer pour ne bloquer personne par erreur.
const subCache = new Map(); // userId -> expiration du "déjà vérifié"
const SUB_TTL = 30 * 1000; // court : si quelqu'un quitte, il est vite re-bloqué
async function subStatus(tg, userId) {
    const check = async (chat) => {
        try { return isMember(await tg.getChatMember(chat, userId)) ? 'ok' : 'no'; } catch { return '?'; }
    };
    const ch = await check(CONFIG.CHANNEL_USERNAME);
    const gid = groupId();
    const gr = gid ? await check(gid) : '-';
    return { ch, gr };
}
async function isSubscribed(tg, userId) {
    if (CONFIG.ADMIN_IDS.includes(userId)) return true;
    if ((subCache.get(userId) || 0) > Date.now()) return true;
    const { ch, gr } = await subStatus(tg, userId);
    if (ch === 'ok' && gr === 'ok') { subCache.set(userId, Date.now() + SUB_TTL); return true; }
    // Strict : canal ET groupe obligatoires. Si on ne peut pas vérifier, on bloque aussi.
    if (gr === '-') console.warn('⚠️ ID du groupe inconnu : tape /setgroup dans le groupe (en admin) ou renseigne GROUP_CHAT_ID. Tout le monde reste bloqué tant que ce n\'est pas fait.');
    if (ch === '?' || gr === '?') console.warn('⚠️ Vérification d\'abonnement impossible : le bot doit être ADMIN du canal et présent dans le groupe.');
    return false;
}
const gateText = () => [
    '╭⊷〔 ACCÈS VERROUILLÉ 〕',
    '┃ · ͟͟͞͞➳❥ REJOINS LE CANAL ET LE GROUPE',
    '┃ · ͟͟͞͞➳❥ PUIS CLIQUE SUR VÉRIFIER',
    '┠─ 🄰🄺🄰🄽🄴 🄼🄳 v2.5',
    '┃ · ͟͟͞͞➳❥ SANS ABONNEMENT, LE BOT RESTE BLOQUÉ 🔒',
    '╰⊷─────────◈',
    'POWER BY DEV AKANE 🌹',
].map((l) => `<b>${l}</b>`).join('\n');

bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== 'private' || !ctx.from) return next();
    if (!ctx.message && !ctx.callbackQuery) return next();
    if (ctx.callbackQuery?.data === 'verify_sub') return next();
    if (await isSubscribed(ctx.telegram, ctx.from.id)) return next();
    if (ctx.callbackQuery) await ctx.answerCbQuery('🔒 Abonne-toi d\'abord au canal et au groupe.', { show_alert: true }).catch(() => {});
    return ctx.reply(gateText(), { parse_mode: 'HTML', ...tgKeyboard() }).catch(() => {});
});

// Auto-détection du groupe : tant que son ID n'est pas enregistré, le bot compare le lien d'invitation
// du groupe où il reçoit un message avec CONFIG.GROUP_LINK (marche si le bot est admin du groupe).
// Sinon : /setgroup dans le groupe, en admin.
const groupTried = new Set();
const linkTail = (l) => String(l || '').split('?')[0].replace(/\/+$/, '').split('/').pop().replace(/^\+/, '');
bot.use(async (ctx, next) => {
    try {
        const c = ctx.chat;
        if (c && ['group', 'supergroup'].includes(c.type) && !groupId() && !groupTried.has(c.id)) {
            groupTried.add(c.id);
            const full = await ctx.telegram.getChat(c.id);
            if (full.invite_link && linkTail(full.invite_link) === linkTail(CONFIG.GROUP_LINK)) {
                saveTg({ ...loadTg(), groupId: c.id });
                console.log(`✅ Groupe détecté automatiquement : ${c.title} (${c.id})`);
            }
        }
    } catch {}
    return next();
});

// Première fois que quelqu'un démarre le bot : lui seul reçoit les boutons canal/groupe sur le menu.
const WELCOMED_FILE = path.join(CONFIG.DATA_DIR, 'welcomed.json');
const welcomedUsers = new Set((() => { try { return JSON.parse(fs.readFileSync(WELCOMED_FILE, 'utf8')); } catch { return []; } })());
function isFirstStart(userId) {
    if (welcomedUsers.has(userId)) return false;
    welcomedUsers.add(userId);
    try { fs.writeFileSync(WELCOMED_FILE, JSON.stringify([...welcomedUsers])); } catch {}
    return true;
}

// ── Menu Telegram : tout en GRAS (HTML) sauf les noms de /commandes ─────────
const BOT_START_TIME = Date.now();

// Lettres du menu (AK4NE MD) + nom de la commande.
// NB : Telegram n'accepte que lettres/chiffres/_ dans une commande → "dev_channel"
// et non "dev-channel" (sinon le clic sur la commande ne marche pas).
const MENU_COMMANDS = [
    ['A', 'pair'],
    ['K', 'unpair'],
    ['4', 'uptime'],
    ['N', 'ping'],
    ['E', 'dev_channel'],
    ['M', 'menu'],
    ['D', 'owner'],
    ['✦', 'start'],
];

function formatUptime(ms) {
    const total = Math.floor(ms / 1000);
    const h = String(Math.floor(total / 3600)).padStart(2, '0');
    const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return `${h}h:${m}min:${s}s`;
}

function formatDate(d = new Date()) {
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${dd}/${mm}/${d.getFullYear()}`;
}

function connectedCount() {
    let n = 0;
    for (const s of sessions.values()) if (s.status === 'connected') n++;
    return n;
}

function connectedBreakdown() {
    let web = 0, telegram = 0;
    for (const sess of sessions.values()) if (sess.status === 'connected') (sess.telegramChatId ? telegram++ : web++);
    return { web, telegram };
}

function buildMenu() {
    const b = (t) => `<b>${t}</b>`;
    const lines = [
        b('╭⊷〔 BOT-INFOS 〕'),
        b('┃· ͟͟͞͞➳❥ UPTIME : ' + formatUptime(Date.now() - BOT_START_TIME)),
        b('┃ · ͟͟͞͞➳❥ DATE : ' + formatDate()),
        b('┃ · ͟͟͞͞➳❥ PREFIX : /'),
        b('┃ · ͟͟͞͞➳❥ LANGUE : français x english'),
        b('┃ · ͟͟͞͞➳❥ COMMANDES : ' + MENU_COMMANDS.length),
        b('┠─ 🄰🄺🄰🄽🄴 🄼🄳 v2.5'),
        b('┃ · ͟͟͞͞➳❥ THÈME : jin woo'),
        b('┃ · ͟͟͞͞➳❥ DEV : akane'),
        b('╭─────────◈'),
        // le nom de la commande reste HORS des balises <b> (et cliquable)
        ...MENU_COMMANDS.map(([letter, cmd]) => `${b('┃ ' + letter + ' ❥')} /${cmd}`),
        b('╰⊷─────────◈'),
        b('POWER BY DEV AKANE 🌹'),
    ];
    return lines.join('\n');
}

// Télécharge la photo une seule fois (tinyurl redirige : Telegram ne suit pas
// toujours les redirections, donc on récupère l'image nous-mêmes et on l'envoie).
let menuPhotoBuffer = null;
async function getMenuPhoto() {
    if (menuPhotoBuffer) return menuPhotoBuffer;
    const res = await fetch(CONFIG.MENU_PHOTO_URL, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (!type.startsWith('image/')) throw new Error(`Le lien ne renvoie pas une image (${type || 'type inconnu'})`);
    menuPhotoBuffer = Buffer.from(await res.arrayBuffer());
    return menuPhotoBuffer;
}

async function sendMenu(ctx, withButtons = false) {
    const caption = buildMenu(); // < 1024 caractères, OK pour une légende de photo
    const extra = withButtons ? tgKeyboard() : {};
    try {
        const photo = await getMenuPhoto();
        await ctx.replyWithPhoto({ source: photo }, { caption, parse_mode: 'HTML', ...extra });
    } catch (err) {
        console.warn('⚠️ Photo du menu indisponible, envoi du menu en texte :', err.message);
        await ctx.reply(caption, { parse_mode: 'HTML', ...extra });
    }
}

bot.start((ctx) => sendMenu(ctx, ctx.chat.type === 'private' && isFirstStart(ctx.from.id)));
bot.command('menu', (ctx) => sendMenu(ctx, false));

bot.command('uptime', (ctx) =>
    ctx.reply(`<b>⏱️ UPTIME : ${formatUptime(Date.now() - BOT_START_TIME)}</b>`, { parse_mode: 'HTML' })
);

// Ping : même cadre que sur le bot WhatsApp (label en gras, valeur en italique, liens en bas).
bot.command('ping', async (ctx) => {
    const t0 = Date.now();
    const sent = await ctx.reply('<b>🏓 PONG...</b>', { parse_mode: 'HTML' });
    const latency = Date.now() - t0;
    const { telegram: viaBot, web: viaSite } = connectedBreakdown();
    const P = '┃ · ͟͟͞͞➳❥';
    const row = (label, value) => `<b>${P}</b> <b>${label} :</b> <i>${value}</i>`;
    const botUser = ctx.botInfo?.username || 'akanemdv2_5_bot';
    const text = [
        '<b>╭⊷─────────◈</b>',
        row('pong', `${latency}ms`),
        row('runtime', formatUptime(Date.now() - BOT_START_TIME)),
        row('via le bot', viaBot),
        row('via le site', viaSite),
        '<b>┠─ 🄰🄺🄰🄽🄴 🄼🄳 v2.5</b>',
        `<b>${P} total :</b> <b><i>${connectedCount()}</i></b>`,
        `<b>${P}</b> <b>bot link :</b>`,
        '<b>┃</b>',
        `🔗${CONFIG.RELAY_URL}`,
        `🔗https://t.me/${botUser}`,
        '<b>╰⊷─────────◈</b>',
        '<blockquote><b>BY DEV AKANE 🌹</b></blockquote>',
    ].join('\n');
    await ctx.telegram.editMessageText(ctx.chat.id, sent.message_id, undefined, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        disable_web_page_preview: true,
    });
});

bot.command('owner', (ctx) =>
    ctx.reply(`<b>👑 OWNER : @${CONFIG.OWNER_USERNAME}</b>`, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
            Markup.button.url('💬 CONTACTER LE DEV', `https://t.me/${CONFIG.OWNER_USERNAME}`),
        ]),
    })
);

const sendDevChannel = (ctx) =>
    ctx.reply(
        CONFIG.DEV_CHANNEL_URL
            ? `<b>📢 CHAÎNE DU DEV :</b>\n${CONFIG.DEV_CHANNEL_URL}`
            : '<b>📢 CHAÎNE DU DEV : PAS ENCORE CONFIGURÉE</b>',
        { parse_mode: 'HTML' }
    );
bot.command('dev_channel', sendDevChannel);
bot.hears(/^\/dev-channel(@\w+)?$/i, sendDevChannel); // tolère l'ancienne écriture avec tiret

bot.command('pair', async (ctx) => {
    const arg = ctx.message.text.split(' ').slice(1).join(' ');
    const number = cleanNumber(arg);

    if (!number || number.length < 8) {
        return ctx.reply('❌ Envoie ton numéro avec l\'indicatif, ex : /pair 2250700000000');
    }

    const existing = sessions.get(number);
    if (existing && existing.status !== 'pairing') {
        return ctx.reply(`✅ Le numéro +${number} est déjà connecté.`);
    }
    // Numéro déjà pairé par quelqu'un d'autre (session sur disque mais pas encore en mémoire)
    const savedOwner = readOwner(number);
    if (!existing && isRegistered(number) && savedOwner && savedOwner !== ctx.chat.id) {
        return ctx.reply(`❌ Le numéro +${number} est déjà lié à un autre utilisateur.`);
    }
    // Nouveau /pair alors qu'un code est déjà en attente : on ferme l'ancien socket
    if (existing) {
        try { existing.sock.end(undefined); } catch {}
    }

    await ctx.reply(`<b>⏳ CRÉATION D'UNE SESSION WHATSAPP SÉCURISÉE POUR +${number}...</b>`, { parse_mode: 'HTML' });
    startSession(number, ctx.chat.id, { requestCode: true }).catch((err) =>
        ctx.reply(`❌ Erreur : ${err.message}`)
    );
});

bot.command('status', (ctx) => {
    const numbers = chatToNumbers.get(ctx.chat.id);
    if (!numbers || numbers.size === 0) {
        return ctx.reply('Aucune session liée à ce chat. Utilise /pair pour en créer une.');
    }
    const lines = [...numbers].map((n) => {
        const s = sessions.get(n);
        return `+${n} — ${s?.status === 'connected' ? '✅ connecté' : '⏳ en attente'}`;
    });
    ctx.reply(lines.join('\n'));
});

bot.command('unpair', async (ctx) => {
    const arg = ctx.message.text.split(' ').slice(1).join(' ');
    const number = cleanNumber(arg);
    const entry = sessions.get(number);

    if (!number || !entry) return ctx.reply('❌ Ce numéro n\'a pas de session active.');

    // Le propriétaire (celui qui a fait /pair) peut déconnecter son numéro librement.
    if (entry.telegramChatId === ctx.chat.id) {
        await removeSession(number);
        return ctx.reply(`🗑️ Session de +${number} supprimée.`);
    }

    // Numéro qui n'est pas à toi : seul l'admin peut, avec le mot de passe.
    return askPassword(
        ctx,
        { type: 'unpair', number },
        `🔐 CE NUMÉRO N'EST PAS LIÉ À TON COMPTE. ENVOIE LE MOT DE PASSE ADMIN POUR DÉCONNECTER +${number}.`
    );
});

bot.command('annonce', async (ctx) => {
    const text = ctx.message.text.replace(/^\/annonce(@\w+)?\s*/i, '').trim();
    if (!text) return say(ctx, '❌ UTILISE : /annonce SUIVI DE TON MESSAGE');

    return askPassword(
        ctx,
        { type: 'annonce', text },
        `🔐 ENVOIE LE MOT DE PASSE ADMIN POUR DIFFUSER CETTE ANNONCE À ${users.size} UTILISATEUR(S).`
    );
});

// Redémarre le bot (mot de passe admin d'abord). Le process s'arrête avec le code 1 : l'hébergeur
// (panel Pterodactyl avec détection de crash, pm2, Railway, Render...) le relance tout seul.
bot.command('restart', async (ctx) => {
    if (ctx.chat.type !== 'private') return say(ctx, '⛔ UTILISE CETTE COMMANDE EN PRIVÉ.');
    return askPassword(ctx, { type: 'restart' }, '🔐 ENVOIE LE MOT DE PASSE ADMIN POUR REDÉMARRER LE BOT.');
});

// ══ ACCUEIL TELEGRAM (canal + groupe) ═══════════════════════════════════
// Bienvenue / au revoir avec photo ou vidéo + 3 boutons (suivre le canal, rejoindre le groupe,
// vérifier l'abonnement). Groupe : messages de service Telegram. Canal : mises à jour
// « chat_member » (le bot doit être ADMIN du canal pour les recevoir et pour poster).
const TG_FILE = path.join(CONFIG.DATA_DIR, 'telegram.json');
const loadTg = () => { try { return JSON.parse(fs.readFileSync(TG_FILE, 'utf8')); } catch { return {}; } };
const saveTg = (o) => { try { fs.writeFileSync(TG_FILE, JSON.stringify(o)); } catch {} };
const groupId = () => CONFIG.GROUP_CHAT_ID || loadTg().groupId || null;
const isMember = (m) => ['creator', 'administrator', 'member'].includes(m?.status) || (m?.status === 'restricted' && m.is_member);
const isOurChannel = (chat) => chat.type === 'channel' && ('@' + (chat.username || '')).toLowerCase() === CONFIG.CHANNEL_USERNAME.toLowerCase();
const isOurGroup = (chat) => ['group', 'supergroup'].includes(chat.type) && (!groupId() || chat.id === groupId());

const mediaCache = new Map();
async function loadMedia(url) {
    if (!url) return null;
    if (mediaCache.has(url)) return mediaCache.get(url);
    const res = await fetch(url, { redirect: 'follow' }); // tinyurl redirige : on télécharge nous-mêmes
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    const kind = type.startsWith('video/') ? 'video' : type === 'image/gif' ? 'animation' : type.startsWith('image/') ? 'photo' : null;
    if (!kind) throw new Error(`type non supporté (${type || 'inconnu'})`);
    const media = { kind, source: Buffer.from(await res.arrayBuffer()) };
    if (media.source.length < 20 * 1024 * 1024) mediaCache.set(url, media);
    return media;
}

const tgKeyboard = () => ({
    reply_markup: {
        inline_keyboard: [
            // style : primary = bleu, success = vert (Bot API 9.4). Libellés courts = boutons plus compacts.
            [
                { text: '📢 CANAL', url: CONFIG.CHANNEL_LINK, style: 'primary' },
                { text: '👥 GROUPE', url: CONFIG.GROUP_LINK, style: 'primary' },
            ],
            [{ text: '✅ VÉRIFIER MON ABONNEMENT', callback_data: 'verify_sub', style: 'success' }],
        ],
    },
});

async function greet(ctx, chat, user, kind, { dm = false } = {}) {
    const welcome = kind === 'welcome';
    let count = null;
    const tg = ctx.telegram;
    try { count = await (tg.getChatMembersCount || tg.getChatMemberCount).call(tg, chat.id); } catch {}
    const name = escapeHtml([user.first_name, user.last_name].filter(Boolean).join(' ') || 'Inconnu');
    const caption = [
        `╭⊷〔 ${welcome ? 'BIENVENUE' : 'AU REVOIR'} 〕`,
        `┃ · ͟͟͞͞➳❥ NOM : ${name}`,
        `┃ · ͟͟͞͞➳❥ ID : ${user.id}`,
        `┃ · ͟͟͞͞➳❥ USER : ${user.username ? '@' + escapeHtml(user.username) : '—'}`,
        ...(count != null ? [`┃ · ͟͟͞͞➳❥ ${welcome ? 'MEMBRES' : 'RESTANTS'} : ${count}`] : []),
        '┠─ 🄰🄺🄰🄽🄴 🄼🄳 v2.5',
        `┃ · ͟͟͞͞➳❥ ${name} ${welcome ? 'A REJOINT' : 'A QUITTÉ'} ${escapeHtml(chat.title || 'AKANE MD')}.`,
        welcome ? '┃ · ͟͟͞͞➳❥ RESPECTE TOUT LE MONDE, AMUSE-TOI BIEN 🌹' : '┃ · ͟͟͞͞➳❥ TOUS LES CHEMINS SE SÉPARENT UN JOUR 🥀',
        ...(dm ? ['┃ · ͟͟͞͞➳❥ ACCÈS AU BOT BLOQUÉ TANT QUE TU NE REVIENS PAS 🔒'] : []),
        '╰⊷─────────◈',
        'POWER BY DEV AKANE 🌹',
    ].map((l) => `<b>${l}</b>`).join('\n');
    const kb = (welcome || dm) ? tgKeyboard() : {};
    const opts = { caption, parse_mode: 'HTML', ...kb };
    try {
        const media = await loadMedia(welcome ? CONFIG.WELCOME_MEDIA : CONFIG.GOODBYE_MEDIA);
        if (media) {
            const method = { photo: 'sendPhoto', video: 'sendVideo', animation: 'sendAnimation' }[media.kind];
            return await tg[method](chat.id, { source: media.source }, opts);
        }
    } catch (err) { if (!dm) console.warn('⚠️ Média d\'accueil indisponible, envoi en texte :', err.message); }
    return tg.sendMessage(chat.id, caption, { parse_mode: 'HTML', ...kb }).catch((err) => { if (!dm) console.warn('⚠️ Accueil Telegram :', err.message); });
}

// Anti-doublon : Telegram peut envoyer le message de service ET la mise à jour chat_member.
const recentGreets = new Map();
async function announce(ctx, chat, user, kind) {
    const key = `${chat.id}:${user.id}:${kind}`;
    const now = Date.now();
    if (now - (recentGreets.get(key) || 0) < 30000) return;
    recentGreets.set(key, now);
    if (recentGreets.size > 500) for (const [k, t] of recentGreets) if (now - t > 30000) recentGreets.delete(k);
    if (kind === 'goodbye') {
        subCache.delete(user.id); // a quitté : bloqué immédiatement
        // Au revoir aussi en privé (si la personne a déjà démarré le bot), avec les boutons pour revenir
        greet(ctx, { id: user.id, title: chat.title }, user, 'goodbye', { dm: true }).catch(() => {});
    }
    return greet(ctx, chat, user, kind);
}

bot.on('new_chat_members', async (ctx) => {
    if (!isOurGroup(ctx.chat)) return;
    for (const m of ctx.message.new_chat_members) if (!m.is_bot) await announce(ctx, ctx.chat, m, 'welcome');
});
bot.on('left_chat_member', async (ctx) => {
    const m = ctx.message.left_chat_member;
    if (isOurGroup(ctx.chat) && !m.is_bot) await announce(ctx, ctx.chat, m, 'goodbye');
});
// Canal ET groupe : indispensable pour les grands groupes où Telegram masque les messages de service
// (le bot doit être admin pour recevoir ces mises à jour).
bot.on('chat_member', async (ctx) => {
    const u = ctx.chatMember;
    if (!u || !(isOurChannel(u.chat) || isOurGroup(u.chat))) return;
    const user = u.new_chat_member.user;
    if (user.is_bot) return;
    const was = isMember(u.old_chat_member), now = isMember(u.new_chat_member);
    if (!was && now) await announce(ctx, u.chat, user, 'welcome');
    else if (was && !now) await announce(ctx, u.chat, user, 'goodbye');
});

bot.action('verify_sub', async (ctx) => {
    const check = async (chat) => {
        try { return isMember(await ctx.telegram.getChatMember(chat, ctx.from.id)) ? 'ok' : 'no'; } catch { return '?'; }
    };
    const ch = await check(CONFIG.CHANNEL_USERNAME);
    const gid = groupId();
    const gr = gid ? await check(gid) : '-';
    const icon = { ok: '✅', no: '❌', '?': '⚠️', '-': '➖' };
    let verdict = 'Vérification impossible pour le moment.';
    if (ch === 'ok' && gr === 'ok') verdict = 'Merci, tu es bien abonné 🌹';
    else if (ch === 'no' || gr === 'no') verdict = 'Rejoins le canal ET le groupe avec les boutons, puis revérifie.';
    else if (gr === '-') verdict = 'Groupe non configuré : l\'admin doit taper /setgroup dans le groupe.';
    await ctx.answerCbQuery(`CANAL : ${icon[ch]}   GROUPE : ${icon[gr]}\n${verdict}`, { show_alert: true }).catch(() => {});
    if (ch === 'ok' && gr === 'ok') {
        subCache.set(ctx.from.id, Date.now() + SUB_TTL);
        if (ctx.chat?.type === 'private') {
            await say(ctx, '✅ ACCÈS DÉBLOQUÉ. TAPE /menu POUR COMMENCER.').catch(() => {});
        }
    }
});

// À taper une fois DANS le groupe, en admin : enregistre son ID pour les messages et la vérification.
bot.command('setgroup', async (ctx) => {
    if (!['group', 'supergroup'].includes(ctx.chat.type)) return say(ctx, 'ENVOIE CETTE COMMANDE DANS LE GROUPE.');
    const anon = ctx.message?.sender_chat?.id === ctx.chat.id; // admin anonyme
    const m = anon ? { status: 'administrator' } : await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id).catch(() => null);
    if (!['creator', 'administrator'].includes(m?.status)) return say(ctx, '⛔ RÉSERVÉ AUX ADMINS DU GROUPE.');
    subCache.clear();
    saveTg({ ...loadTg(), groupId: ctx.chat.id });
    return say(ctx, `✅ GROUPE ENREGISTRÉ (${ctx.chat.id}).`);
});
// Aperçu : un admin du chat voit à quoi ressemblent l'accueil et l'au revoir.
bot.command('testaccueil', async (ctx) => {
    const m = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id).catch(() => null);
    if (ctx.chat.type !== 'private' && !['creator', 'administrator'].includes(m?.status)) return say(ctx, '⛔ RÉSERVÉ AUX ADMINS.');
    await greet(ctx, ctx.chat, ctx.from, 'welcome');
    await greet(ctx, ctx.chat, ctx.from, 'goodbye');
});
// ══ fin ACCUEIL TELEGRAM

// Réception du mot de passe (doit rester APRÈS toutes les bot.command)
bot.on('text', async (ctx) => {
    const p = pending.get(ctx.chat.id);
    if (!p) return;

    if (Date.now() > p.expires) {
        pending.delete(ctx.chat.id);
        return say(ctx, '⌛ DEMANDE EXPIRÉE. RECOMMENCE LA COMMANDE.');
    }

    ctx.deleteMessage().catch(() => {}); // efface le mot de passe du chat

    if (ctx.message.text.trim() !== CONFIG.ADMIN_PASSWORD) {
        p.tries++;
        if (p.tries >= MAX_TRIES) {
            pending.delete(ctx.chat.id);
            lockedUntil.set(ctx.chat.id, Date.now() + LOCK_MS);
            return say(ctx, '🚫 TROP D\'ESSAIS RATÉS. DEMANDE ANNULÉE.');
        }
        return say(ctx, `❌ MOT DE PASSE INCORRECT (${MAX_TRIES - p.tries} ESSAI(S) RESTANT(S))`);
    }

    pending.delete(ctx.chat.id);

    if (p.type === 'unpair') {
        await removeSession(p.number);
        return say(ctx, `🗑️ SESSION DE +${p.number} SUPPRIMÉE.`);
    }
    if (p.type === 'restart') {
        await say(ctx, '♻️ MOT DE PASSE OK. REDÉMARRAGE DU BOT...');
        try { fs.writeFileSync(path.join(CONFIG.DATA_DIR, 'restart.json'), JSON.stringify({ chatId: ctx.chat.id })); } catch {}
        saveUsers();
        setTimeout(() => { try { bot.stop('RESTART'); } catch {} process.exit(1); }, 1500);
        return;
    }
    if (p.type === 'annonce') {
        await say(ctx, '✅ MOT DE PASSE OK. ENVOI EN COURS...');
        return broadcast(ctx, p.text);
    }
});

// ══ API WEB ═══════════════════════════════════════════════════════════
// Le site (front statique sur Render / Vercel...) appelle ce process. Le pairing
// passe par le MÊME startSession() que /pair sur Telegram : session dans
// ./sessions/<numero>/, restaurée au redémarrage, handler branché, etc.
//   POST /api/pair        { number }  → lance le pairing, renvoie { ok, status }
//   GET  /api/code/:num               → { status: pending|ready|connected|expired|error, code }
//   GET  /api/stats                   → { connected }
const webPairings = new Map(); // numero -> { status, code, error, at, readyAt }
function webSet(number, patch) {
    if (webPairings.has(number)) webPairings.set(number, { ...webPairings.get(number), ...patch });
}
const webHits = new Map();
function webRateLimited(key) {
    const now = Date.now();
    const hits = (webHits.get(key) || []).filter((t) => now - t < CONFIG.WEB_RATE_WINDOW_MS);
    const blocked = hits.length >= CONFIG.WEB_RATE_LIMIT;
    if (!blocked) hits.push(now);
    webHits.set(key, hits);
    return blocked;
}
setInterval(() => {
    const now = Date.now();
    for (const [n, w] of webPairings) if (now - w.at > 15 * 60 * 1000) webPairings.delete(n);
    for (const [k, h] of webHits) if (!h.some((t) => now - t < CONFIG.WEB_RATE_WINDOW_MS)) webHits.delete(k);
}, 60 * 1000).unref();

const tokenFile = (n) => path.join(CONFIG.SESSIONS_DIR, n, '.webtoken');
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
async function readJson(req) {
    let raw = '';
    for await (const c of req) { raw += c; if (raw.length > 2048) throw new Error('trop grand'); }
    return JSON.parse(raw || '{}');
}

function startWebApi() {
    const server = http.createServer(async (req, res) => {
        const origin = req.headers.origin;
        const anyOrigin = CONFIG.WEB_ORIGINS.includes('*');
        const originOk = !origin || anyOrigin || CONFIG.WEB_ORIGINS.includes(origin);
        if (origin && originOk) {
            res.setHeader('Access-Control-Allow-Origin', anyOrigin ? '*' : origin);
            res.setHeader('Vary', 'Origin');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        }
        const json = (status, body) => {
            res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(body));
        };
        if (req.method === 'OPTIONS') { res.writeHead(originOk ? 204 : 403); return res.end(); }
        if (!originOk) return json(403, { error: 'Origine non autorisée.' });

        const url = new URL(req.url, 'http://x');
        const route = url.pathname.replace(/\/+$/, '');

        try {
            if (req.method === 'GET' && (route === '/api/health' || route === '')) return json(200, { ok: true });
            if (req.method === 'GET' && route === '/api/stats') {
                // telegramChatId renseigné = session créée via /pair sur Telegram ; sinon = créée depuis le site
                let web = 0, telegram = 0;
                for (const sess of sessions.values()) if (sess.status === 'connected') (sess.telegramChatId ? telegram++ : web++);
                return json(200, { connected: web + telegram, web, telegram });
            }

            if (req.method === 'GET' && route.startsWith('/api/code/')) {
                const number = cleanNumber(route.slice('/api/code/'.length));
                const w = webPairings.get(number);
                if (!w) return json(200, { status: 'not_found' });
                if (sessions.get(number)?.status === 'connected') return json(200, { status: 'connected' });
                if (w.status === 'ready' && Date.now() - w.readyAt > 75 * 1000) return json(200, { status: 'expired' });
                return json(200, { status: w.status, code: w.status === 'ready' ? w.code : null, error: w.error || null });
            }

            if (req.method === 'POST' && route === '/api/pair') {
                let raw = '';
                for await (const chunk of req) { raw += chunk; if (raw.length > 2048) return json(413, { error: 'Requête trop grande.' }); }
                let body = {};
                try { body = JSON.parse(raw || '{}'); } catch { return json(400, { error: 'JSON invalide.' }); }

                const number = cleanNumber(body.number);
                if (number.length < 8 || number.length > 15) {
                    return json(400, { error: "Numéro invalide : indicatif + numéro, sans « + » (ex : 2250700000000)." });
                }
                const ip = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
                if (webRateLimited('ip:' + ip) || webRateLimited('n:' + number)) {
                    return json(429, { error: 'Trop de demandes. Réessaie dans quelques minutes.' });
                }

                const existing = sessions.get(number);
                if (existing && existing.status !== 'pairing') {
                    webPairings.set(number, { status: 'connected', code: null, error: null, at: Date.now() });
                    return json(200, { ok: true, status: 'connected' });
                }
                if (!existing && isRegistered(number)) {
                    if (readOwner(number)) return json(409, { error: 'Ce numéro est déjà lié à un autre utilisateur.' });
                    webPairings.set(number, { status: 'pending', code: null, error: null, at: Date.now() });
                    startSession(number, null).catch((err) => webSet(number, { status: 'error', error: err.message }));
                    return json(200, { ok: true, status: 'pending' });
                }
                if (existing) { try { existing.sock.end(undefined); } catch {} } // ancien code en attente

                // Jeton secret remis au navigateur : seul lui pourra déconnecter ce numéro depuis le site.
                // Seul le hash est gardé sur le serveur, écrit quand le code est prêt (le dossier existe alors).
                const token = crypto.randomBytes(24).toString('hex');
                webPairings.set(number, { status: 'pending', code: null, error: null, at: Date.now() });
                startSession(number, null, {
                    requestCode: true,
                    onCode: (code) => {
                        try { fs.mkdirSync(path.dirname(tokenFile(number)), { recursive: true }); fs.writeFileSync(tokenFile(number), sha(token)); } catch {}
                        webSet(number, { status: 'ready', code, readyAt: Date.now() });
                    },
                    onError: (err) => webSet(number, { status: 'error', error: `Impossible de générer le code : ${err.message}` }),
                }).catch((err) => webSet(number, { status: 'error', error: err.message }));

                if (CONFIG.WEB_NOTIFY_CHAT_ID) {
                    bot.telegram.sendMessage(CONFIG.WEB_NOTIFY_CHAT_ID, `🌐 Pairing lancé depuis le site pour +${number}`).catch(() => {});
                }
                return json(200, { ok: true, status: 'pending', token });
            }

            if (req.method === 'POST' && route === '/api/unpair') {
                let body = {};
                try { body = await readJson(req); } catch { return json(400, { error: 'Requête invalide.' }); }
                const number = cleanNumber(body.number);
                const ip = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
                if (webRateLimited('u:' + ip)) return json(429, { error: 'Trop de demandes. Réessaie dans quelques minutes.' });
                let stored = '';
                try { stored = fs.readFileSync(tokenFile(number), 'utf8').trim(); } catch {}
                if (!stored) {
                    if (!sessions.has(number)) return json(200, { ok: true, gone: true }); // déjà supprimée
                    return json(403, { error: "Cette session n'a pas été créée depuis ce site. Déconnecte-la depuis WhatsApp (Appareils connectés) ou avec /unpair sur Telegram." });
                }
                const given = sha(body.token || '');
                if (given.length !== stored.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(stored))) {
                    return json(403, { error: "Jeton invalide : utilise le navigateur qui a connecté ce numéro, ou déconnecte-le depuis WhatsApp." });
                }
                await removeSession(number); // logout WhatsApp + suppression du dossier de session
                webPairings.delete(number);
                return json(200, { ok: true });
            }

            return json(404, { error: 'Route inconnue.' });
        } catch (err) {
            console.warn('⚠️ API web :', err.message);
            return json(500, { error: 'Erreur serveur.' });
        }
    });
    server.on('error', (err) => console.error('❌ API web :', err.message));
    server.listen(CONFIG.WEB_PORT, () => console.log(`🌐 API web de pairing sur le port ${CONFIG.WEB_PORT}`));
}
// ══ fin API WEB ═══════════════════════════════════════════════════════

// ══ RELAIS ════════════════════════════════════════════════════════════
// Demande au relais (Render) s'il y a du travail (long-polling sortant), exécute chaque
// requête sur l'API locale ci-dessus, puis renvoie la réponse au relais.
async function startRelayPoller() {
    if (!CONFIG.RELAY_URL || !CONFIG.RELAY_SECRET) return console.log('ℹ️ Relais web désactivé (RELAY_URL / RELAY_SECRET non définis).');
    const base = CONFIG.RELAY_URL.replace(/\/$/, '');
    const H = { 'x-relay-secret': CONFIG.RELAY_SECRET, 'Content-Type': 'application/json' };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    console.log('🔁 Relais web :', base);
    const handle = async (job) => {
        let out;
        try {
            const r = await fetch(`http://127.0.0.1:${CONFIG.WEB_PORT}${job.path}`, {
                method: job.method,
                headers: { 'Content-Type': 'application/json', 'x-forwarded-for': job.ip || '' },
                body: job.method === 'POST' ? (job.body || '{}') : undefined,
            });
            out = { status: r.status, body: await r.text() };
        } catch { out = { status: 502, body: JSON.stringify({ error: 'API locale du bot injoignable.' }) }; }
        await fetch(`${base}/bot/result/${job.id}`, { method: 'POST', headers: H, body: JSON.stringify(out) }).catch(() => {});
    };
    for (;;) {
        try {
            const r = await fetch(`${base}/bot/poll`, { headers: H, signal: AbortSignal.timeout(35000) });
            if (r.ok) (await r.json()).forEach((j) => handle(j));
            else await wait(5000);
        } catch { await wait(3000); }
    }
}
// ══ fin RELAIS

async function main() {
    ensureRepoCloned();
    const { module, handlerFn } = await loadBotModule();
    botHandlerFn = handlerFn;
    if (module && typeof module.sendConnectedMessage === 'function') {
        botSendConnectedMessage = module.sendConnectedMessage;
    }
    if (module && typeof module.applyCanalInfo === 'function') botApplyCanalInfo = module.applyCanalInfo;
    if (module && typeof module.followOfficialChannel === 'function') botFollowChannel = module.followOfficialChannel;
    if (module && typeof module.handleGroupUpdate === 'function') botGroupHandlerFn = module.handleGroupUpdate;
    if (module && typeof module.markConnected === 'function') botMarkConnected = module.markConnected;
    if (module && typeof module.markDisconnected === 'function') botMarkDisconnected = module.markDisconnected;
    // Le menu WhatsApp affiche « SESSION » : on lui donne le nombre de sessions connectées ici
    if (module && typeof module.setExternalSessionCounter === 'function') module.setExternalSessionCounter(connectedCount);
    if (module && typeof module.setExternalSessionBreakdown === 'function') module.setExternalSessionBreakdown(connectedBreakdown);
    if (!botApplyCanalInfo) {
        console.warn('⚠️ index.js n\'exporte pas applyCanalInfo : le bouton « Voir la chaîne » ne sera pas ajouté aux sessions Telegram (index.js pas à jour sur le repo ?).');
    }

    // Reconnecte toutes les sessions déjà pairées (plus besoin de refaire /pair après un redémarrage)
    await restoreSessions();
    startWebApi(); // le site peut demander des codes dès maintenant
    startRelayPoller(); // pont vers le site hébergé sur Render

    // Après un /restart : prévient la personne que le bot est revenu
    try {
        const rf = path.join(CONFIG.DATA_DIR, 'restart.json');
        if (fs.existsSync(rf)) {
            const { chatId } = JSON.parse(fs.readFileSync(rf, 'utf8'));
            fs.unlinkSync(rf);
            if (chatId) bot.telegram.sendMessage(chatId, '<b>✅ BOT REDÉMARRÉ AVEC SUCCÈS.</b>', { parse_mode: 'HTML' }).catch(() => {});
        }
    } catch {}

    // Liste des commandes visible dans le bouton "Menu" de Telegram
    await bot.telegram.setMyCommands([
        ...MENU_COMMANDS.map(([, cmd]) => ({ command: cmd, description: cmd })),
        { command: 'status', description: 'status' },
    ]).catch((err) => console.warn('⚠️ setMyCommands :', err.message));

    try {
        await bot.launch({ allowedUpdates: ['message', 'callback_query', 'chat_member', 'my_chat_member'] });
    } catch (err) {
        // 401 ici = le TELEGRAM_BOT_TOKEN dans CONFIG est refusé par Telegram (faux ou
        // révoqué). Avant, cette erreur passait par le handler global "unhandledRejection"
        // importé depuis index.js, qui se contentait de l'afficher sans rien faire : le
        // process n'avait alors plus rien à faire et s'éteignait tout seul en silence.
        if (err?.response?.error_code === 401 || /401/.test(err?.message || '')) {
            console.error('❌ Telegram a refusé TELEGRAM_BOT_TOKEN (401 Unauthorized).');
            console.error('   → Reprends le token EXACT donné par @BotFather (commande /token ou /mybots > API Token) et remplace-le en haut du fichier.');
        } else {
            console.error('❌ bot.launch() a échoué :', err?.message || err);
        }
        process.exit(1);
    }
    console.log('🤖 Bot Telegram de pairing lancé.');
}

main().catch((err) => {
    console.error('❌ Démarrage de pair-server.js échoué :', err?.message || err);
    process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
