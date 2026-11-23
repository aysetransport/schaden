/**
 * Schadensfälle – Cloud-Speicher (Google Apps Script)
 *
 * Dieses Skript ist die gemeinsame Datenablage für die Android-App und die Web-App.
 * Alle Daten liegen im Google Drive des Kontos, das das Skript bereitstellt:
 *
 *   Schadensfaelle/
 *     daten.json        alle Fälle, Verlaufseinträge, Anlagen-Verzeichnis und das CRM (Firmen,
 *                       Ansprechpartner, Adressen, Preise, Aktivitäten, Wiedervorlagen, Dokumente)
 *     anlagen/          Fotos und Belege (Dateiname = Kennung der Anlage)
 *     sicherungen/      tägliche Kopie von daten.json (die letzten 14 Tage)
 *
 * Bereitstellen: Bereitstellen → Neue Bereitstellung → Typ „Web-App“,
 * „Ausführen als: Ich“, „Zugriff: Jeder“. Die Adresse (…/exec) in den Apps eintragen.
 * Die PIN wird beim ersten Verbinden in der App festgelegt.
 *
 * Aufruf (wie bei Tagesdispo): POST mit Text-Inhalt {"fn": "<name>", "args": [PIN, …]}
 * Antwort: {"ok": …} oder {"error": "<Meldung>"}.
 */

var ORDNER_NAME = 'Schadensfaelle';
var DATEN_DATEI = 'daten.json';
var ANLAGEN_ORDNER = 'anlagen';
var SICHERUNG_ORDNER = 'sicherungen';
var SICHERUNGEN_BEHALTEN = 14;

var MIN_PIN_LAENGE = 4;
var MAX_FEHLVERSUCHE = 8;
var SPERRE_MINUTEN = 60;

var MAX_ANLAGE_BYTES = 25 * 1024 * 1024;
var MAX_TEXT = 20000;
var API_VERSION = 15; // 15: Korrekturrechnungen (korrekturVon/ersetztDurch); 14: Selbst-Update, E-Rechnung (Leitweg-ID), externe Rechnungen/Leistungszeitraum; 13: Hauptadmin, Cloud-PIN abschaltbar; 12: Auftragsnummer, Betrag und Ankunftszeit an Stopps (Rollkarte); 11: Stopps (mehrere Kunden je Tour); 10: Statuslink, Lieferavis-Felder und Kundenbewertung an Touren; 9: Benutzer-Logins mit Rollen; 8: Zeiterfassung, Aufgaben, Tour-Status und Fahrtenbuch; 7: Tourenplanung und Personal; 6: Fuhrpark; 2: Kontaktdaten des Auftraggebers und Auftraggeber-Liste; 3: Zeichen des Auftraggebers; 4: CRM; 5: Verkaufschancen, Schlagworte

/**
 * CRM-Tabellen: alle hängen über firmaId an einem Auftraggeber (Tabelle „auftraggeber“).
 * Feldarten: text, wort:<Vorgabe> (Aufzählung in Großbuchstaben), datum (JJJJ-MM-TT), cent (ganze Zahl), bool.
 */
var CRM_TABELLEN = {
  adressen: { art: 'wort:SONSTIGE', strasse: 'text', plz: 'text', ort: 'text', notiz: 'text' },
  ansprechpartner: { name: 'text', thema: 'text', telefon: 'text', email: 'text', notiz: 'text' },
  preise: { bezeichnung: 'text', betragCent: 'cent', einheit: 'text', gueltigAb: 'datum', notiz: 'text' },
  aktivitaeten: { datum: 'datum', art: 'wort:SONSTIGES', text: 'text', kontakt: 'text' },
  aufgaben: { faelligAm: 'datum', text: 'text', kontakt: 'text', erledigt: 'bool' },
  dokumente: { titel: 'text', link: 'text', notiz: 'text' },
  chancen: { titel: 'text', wertCent: 'cent', phase: 'wort:ANFRAGE', erwartetAm: 'datum', notiz: 'text' },
  // Angebote und Rechnungen (bisher nur Web-/Windows-App); positionen als JSON-Text
  belege: { art: 'wort:RECHNUNG', nummer: 'text', datum: 'datum', faelligAm: 'datum', status: 'wort:OFFEN', positionen: 'text', mwstProzent: 'cent',
    einleitung: 'text', schluss: 'text', bezahltCent: 'cent', bezahltAm: 'datum', mahnstufe: 'cent', bezug: 'text', notiz: 'text', fallId: 'text', unterzeichner: 'text', extern: 'bool', leistungVon: 'datum', leistungBis: 'datum', bestellnummer: 'text', korrekturVon: 'text', ersetztDurch: 'text' },
  // Fuhrpark (ohne Firma): Fahrzeuge mit den Angaben aus dem Fahrzeugschein, Fristen und Fahrzeugakte.
  // Zahlen (km, kg, kW, Cent, Liter × 100) als ganze Zahlen.
  fahrzeuge: { kennzeichen: 'text', bezeichnung: 'text', art: 'wort:TRANSPORTER', status: 'wort:AKTIV', fahrer: 'text', kmStand: 'cent', wartungKm: 'cent',
    halter: 'text', marke: 'text', modell: 'text', fin: 'text', erstzulassung: 'datum', zgg: 'cent', leergewicht: 'cent', hsn: 'text', tsn: 'text',
    leistungKw: 'cent', kraftstoff: 'text', schadstoffklasse: 'text', achsen: 'cent', farbe: 'text', teil2Nr: 'text',
    huBis: 'datum', spBis: 'datum', uvvBis: 'datum', tachoBis: 'datum', ladeBis: 'datum', wartungBis: 'datum', versicherungBis: 'datum', leasingBis: 'datum', steuerBis: 'datum', kfzSteuerCent: 'cent', kfzSteuerNr: 'text', kfzSteuerAb: 'datum', versicherungCent: 'cent', einsatzKostenCent: 'cent',
    versicherung: 'text', versicherungsNr: 'text', leasinggeber: 'text', leasingRateCent: 'cent', notiz: 'text', leihfahrzeug: 'bool', aliase: 'text' },
  fahrzeugeintraege: { fahrzeugId: 'text', art: 'wort:WARTUNG', datum: 'datum', kmStand: 'cent', betragCent: 'cent', menge: 'cent', werkstatt: 'text', text: 'text' },
  // Personal und Tourenplanung (ohne Firma). Team und Auftraggeber einer Tour über Kennungen, Beifahrer durch Komma getrennt.
  mitarbeiter: { einsatzKostenCent: 'cent', name: 'text', rolle: 'wort:FAHRER', telefon: 'text', email: 'text', adresse: 'text', monteur: 'bool', nichtBei: 'text', aktiv: 'bool',
    fuehrerschein: 'text', fuehrerscheinBis: 'datum', fahrerkarteBis: 'datum', modul95Bis: 'datum', eintritt: 'datum', austritt: 'datum', geburtstag: 'datum', notiz: 'text',
    personalnummer: 'text', anstellung: 'wort:VOLLZEIT', wochenstunden: 'cent', stundenlohnCent: 'cent', urlaubstage: 'cent', resturlaub: 'cent', notfallkontakt: 'text',
    fuehrerscheinKontrolle: 'datum', unterweisungBis: 'datum', arbeitsmedizinBis: 'datum', aliase: 'text', fahrerkarteNr: 'text' },
  // Personalakte: Gespräche, Schulungen, Unterweisungen, Abmahnungen … (bis = gültig bis, z. B. bei Unterweisungen)
  // Lohnabrechnungen als Art LOHN: datum = Monatserster, Beträge in Cent (brutto, netto, Gesamtkosten Arbeitgeber).
  personaleintraege: { mitarbeiterId: 'text', art: 'wort:GESPRAECH', datum: 'datum', bis: 'datum', text: 'text', bruttoCent: 'cent', nettoCent: 'cent', kostenCent: 'cent', stunden: 'cent' },
  abwesenheiten: { mitarbeiterId: 'text', von: 'datum', bis: 'datum', grund: 'text', notiz: 'text' },
  einsatzarten: { name: 'text', beifahrer: 'cent', monteurNoetig: 'bool', notiz: 'text' },
  touren: { datum: 'datum', reihenfolge: 'cent', kennzeichen: 'text', tourNr: 'text', auftraggeberId: 'text', auftraggeber: 'text', name: 'text', uhrzeit: 'text',
    einsatzart: 'text', fahrerId: 'text', beifahrerIds: 'text', notiz: 'text', belegId: 'text', erledigt: 'bool',
    status: 'wort:GEPLANT', beginn: 'text', ende: 'text', kmStart: 'cent', kmEnde: 'cent', empfaenger: 'text', abgeliefertAm: 'text',
    // Endkunde (Lieferavis), Zeitfenster, Statuslink-Code und Bewertung durch den Kunden
    kundeName: 'text', kundeTelefon: 'text', kundeEmail: 'text', kundeAdresse: 'text', zeitfenster: 'text', statusCode: 'text',
    bewertung: 'cent', bewertungText: 'text', bewertetAm: 'text' },
  // Arbeitszeit je Mitarbeiter und Tag (Uhrzeiten als HH:MM, Pause in Minuten)
  // quelle: ERFASST (von Hand), STEMPEL (Fahrer-Modus), PLAN (Entwurf aus dem Tourenplan – bis zur Bestätigung kein Nachweis)
  zeiten: { mitarbeiterId: 'text', datum: 'datum', beginn: 'text', ende: 'text', pauseMin: 'cent', art: 'wort:ARBEIT', notiz: 'text', quelle: 'wort:ERFASST', bestaetigt: 'bool', bestaetigtAm: 'text' },
  // Fahrerkarte (Tachograph): ein Tag eines Fahrers, Minuten je Tätigkeit, Fahrzeuge und km; aktivitaeten = JSON [[min, art, slot], …]
  tachotage: { mitarbeiterId: 'text', kartenNr: 'text', fahrerName: 'text', datum: 'datum', fahrMin: 'cent', arbeitMin: 'cent', bereitMin: 'cent', ruheMin: 'cent',
    beginn: 'text', ende: 'text', km: 'cent', fahrzeuge: 'text', aktivitaeten: 'text' },
  // Interne Aufgaben (ohne Firma), optional mit Bezug (Fall, Tour, Fahrzeug, Mitarbeiter, Firma)
  aufgabenIntern: { titel: 'text', text: 'text', faelligAm: 'datum', zustaendigId: 'text', prioritaet: 'wort:NORMAL', erledigt: 'bool', erledigtAm: 'datum', bezugArt: 'text', bezugId: 'text' },
  // Stopps einer Tour (mehrere Kunden/Adressen): art LIEFERUNG, ABHOLUNG, MONTAGE, SONSTIGES; status OFFEN, ERLEDIGT, PROBLEM
  stopps: { tourId: 'text', reihenfolge: 'cent', art: 'wort:LIEFERUNG', kundeName: 'text', kundeTelefon: 'text', kundeEmail: 'text', adresse: 'text', zeitfenster: 'text',
    notiz: 'text', status: 'wort:OFFEN', erledigtAm: 'text', empfaenger: 'text', statusCode: 'text', bewertung: 'cent', bewertungText: 'text', bewertetAm: 'text',
    auftragNr: 'text', betragCent: 'cent', eta: 'text' }
};
/** Felder einer Firma, die nicht jede App kennt: Fehlen sie in einer Änderung, bleibt der bisherige Wert. */
var FIRMEN_ZUSATZ = ['kundennummer', 'ustId', 'zahlungszielTage', 'schlagworte', 'rechnungBank', 'rechnungIban', 'rechnungBic', 'leitwegId', 'eRechnungEmail'];
var CRM_NAMEN = Object.keys(CRM_TABELLEN);

// ============================== Einstieg ==============================

function doPost(e) {
  var antwort;
  try {
    var anfrage = JSON.parse(e.postData.contents);
    antwort = { ok: aufruf_(String(anfrage.fn), anfrage.args || []) };
  } catch (fehler) {
    antwort = { error: String((fehler && fehler.message) || fehler) };
  }
  return ContentService.createTextOutput(JSON.stringify(antwort)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput('Schadensfälle-Cloud läuft. Diese Adresse in der App eintragen.');
}

/** Ohne PIN erreichbar: verrät nur, ob schon eine PIN festgelegt wurde; Anmeldung mit Benutzername und Passwort. */
var OFFEN = { status: status, pinFestlegen: pinFestlegen, einloggen: einloggen, sendungsstatus: sendungsstatus, bewerten: bewerten };

/** Nur mit gültiger PIN. Das erste Argument jedes Aufrufs ist die PIN. */
var GESCHUETZT = {
  anmelden: anmelden,
  abmelden: abmelden,
  benutzerListe: benutzerListe,
  benutzerSpeichern: benutzerSpeichern,
  benutzerLoeschen: benutzerLoeschen,
  pinAnmeldung: pinAnmeldung,
  stand: stand,
  sync: sync,
  anlageHochladen: anlageHochladen,
  anlageLaden: anlageLaden,
  cloudUpdateInfo: cloudUpdateInfo,
  cloudAktualisieren: cloudAktualisieren,
  cloudAutoUpdate: cloudAutoUpdate
};

function aufruf_(fn, args) {
  if (Object.prototype.hasOwnProperty.call(OFFEN, fn)) return OFFEN[fn].apply(null, args);
  if (!Object.prototype.hasOwnProperty.call(GESCHUETZT, fn)) throw new Error('Unbekannte Funktion: ' + fn);
  ZUGANG_ = pruefeZugang_(args[0]);
  return GESCHUETZT[fn].apply(null, args.slice(1));
}

// ============================== Benutzer und Rollen ==============================
/**
 * Wer die Cloud-PIN kennt, ist Admin. Weitere Benutzer (Fahrer, Disposition) meldet der Admin mit Benutzername und
 * Passwort an. Passwörter liegen nur gesalzen und gehasht in den Skript-Eigenschaften (nicht in daten.json, die an die
 * Geräte geht). Eine Anmeldung ergibt ein Sitzungs-Token („T:…“), das statt der PIN mitgeschickt wird.
 * Rollen: ADMIN (alles), DISPO (alles außer Benutzerverwaltung und Lohndaten), FAHRER (nur eigene Touren, Zeiten,
 * Abwesenheiten, Aufgaben und dazugehörige Fälle). Die Rechte werden hier im Skript durchgesetzt.
 */
var ROLLEN = { ADMIN: 'Admin', DISPO: 'Disposition / Büro', FAHRER: 'Fahrer' };
var SITZUNG_TAGE = 90;
var MIN_PASSWORT = 6;
var ZUGANG_ = { rolle: 'ADMIN' };
function benutzer_() { return JSON.parse(PropertiesService.getScriptProperties().getProperty('BENUTZER') || '{}'); }
function speichereBenutzer_(b) { PropertiesService.getScriptProperties().setProperty('BENUTZER', JSON.stringify(b)); }
function loginNormal_(l) { return String(l == null ? '' : l).trim().toLowerCase(); }
function oeffentlich_(b) { return { id: b.id, login: b.login, name: b.name, rolle: b.rolle, mitarbeiterId: b.mitarbeiterId || '', aktiv: b.aktiv !== false, hauptadmin: !!b.hauptadmin, geaendertAm: b.geaendertAm || '', letzteAnmeldung: b.letzteAnmeldung || '' }; }
/** Ist die Anmeldung mit der Cloud-PIN abgeschaltet? (Dann nur noch Benutzer-Logins.) */
function pinAus_() { return PropertiesService.getScriptProperties().getProperty('PIN_AUS') === '1'; }
function hauptadmin_() { var a = benutzer_(), h = null; Object.keys(a).forEach(function (k) { if (a[k].hauptadmin && a[k].aktiv !== false && a[k].rolle === 'ADMIN') h = a[k]; }); return h; }
/**
 * NOTFALL: Im Apps-Script-Editor diese Funktion auswählen und „Ausführen“ – schaltet die Anmeldung mit der
 * Cloud-PIN wieder ein (z. B. wenn das Passwort des Hauptadmins verloren ist). Nur der Besitzer des Google-Kontos kann das.
 */
function notfallPinAnmeldungEinschalten() { PropertiesService.getScriptProperties().deleteProperty('PIN_AUS'); return 'Die Anmeldung mit der Cloud-PIN ist wieder eingeschaltet.'; }

function pruefeZugang_(zugang) {
  var z = String(zugang == null ? '' : zugang);
  if (z.indexOf('T:') !== 0) {
    if (pinAus_()) throw new Error('PIN_AUS: Die Anmeldung mit der Cloud-PIN ist abgeschaltet – bitte mit Benutzername und Passwort anmelden.');
    pruefePin_(z); return { rolle: 'ADMIN', pin: true, hauptadmin: true };
  }
  var props = PropertiesService.getScriptProperties(), schluessel = 'SITZUNG_' + hash_(z, 'sitzung');
  var s = JSON.parse(props.getProperty(schluessel) || 'null');
  var b = s && benutzer_()[s.b];
  if (!s || !b || b.aktiv === false || b.version !== s.v || s.bis < Date.now()) {
    if (s) props.deleteProperty(schluessel);
    throw new Error('Anmeldung abgelaufen – bitte erneut anmelden (Passwort bzw. PIN)');
  }
  return { rolle: b.rolle, benutzerId: b.id, mitarbeiterId: b.mitarbeiterId || '', name: b.name, sitzung: schluessel, hauptadmin: !!b.hauptadmin && b.rolle === 'ADMIN' };
}
function nurHauptadmin_() { if (!ZUGANG_.hauptadmin) throw new Error('Nur der Hauptadmin darf das.'); }
/** Anmeldung mit der Cloud-PIN ab- oder einschalten (nur Hauptadmin; abschalten nur angemeldet als Hauptadmin-Login). */
function pinAnmeldung(an) {
  nurHauptadmin_();
  var props = PropertiesService.getScriptProperties();
  if (an) { props.deleteProperty('PIN_AUS'); return { pinAus: false }; }
  var h = hauptadmin_();
  if (!h) throw new Error('Erst einen Hauptadmin festlegen (Benutzer → Admin → „Hauptadmin“).');
  if (ZUGANG_.benutzerId !== h.id) throw new Error('Zum Abschalten bitte als Hauptadmin (' + h.login + ') mit Benutzername und Passwort anmelden – so ist sicher, dass dieser Login funktioniert.');
  props.setProperty('PIN_AUS', '1');
  return { pinAus: true };
}
function nurAdmin_() { if (ZUGANG_.rolle !== 'ADMIN') throw new Error('Nur für Admins'); }

/** Anmeldung mit Benutzername und Passwort. */
function einloggen(login, passwort) {
  login = loginNormal_(login);
  var props = PropertiesService.getScriptProperties(), jetzt = Date.now(), fk = 'FEHL_' + login;
  var zaehler = JSON.parse(props.getProperty(fk) || '{"n":0,"bis":0}');
  if (zaehler.bis > jetzt) throw new Error('GESPERRT: Zu viele falsche Eingaben. Bitte in ' + Math.ceil((zaehler.bis - jetzt) / 60000) + ' Minuten erneut versuchen.');
  var alle = benutzer_(), b = null;
  Object.keys(alle).forEach(function (k) { if (alle[k].login === login) b = alle[k]; });
  if (!b || b.aktiv === false || hash_(String(passwort == null ? '' : passwort), b.salz) !== b.hash) {
    zaehler.n = (zaehler.bis && zaehler.bis <= jetzt ? 0 : zaehler.n) + 1;
    zaehler.bis = zaehler.n >= MAX_FEHLVERSUCHE ? jetzt + SPERRE_MINUTEN * 60000 : 0;
    props.setProperty(fk, JSON.stringify(zaehler));
    throw new Error('Benutzername oder Passwort falsch');
  }
  if (zaehler.n) props.deleteProperty(fk);
  // abgelaufene Sitzungen aufräumen
  var alleProps = props.getProperties();
  Object.keys(alleProps).forEach(function (k) { if (k.indexOf('SITZUNG_') === 0) { try { if (JSON.parse(alleProps[k]).bis < jetzt) props.deleteProperty(k); } catch (e) { props.deleteProperty(k); } } });
  var token = 'T:' + Utilities.getUuid() + Utilities.getUuid();
  props.setProperty('SITZUNG_' + hash_(token, 'sitzung'), JSON.stringify({ b: b.id, v: b.version, bis: jetzt + SITZUNG_TAGE * 864e5 }));
  b.letzteAnmeldung = new Date(jetzt).toISOString(); alle[b.id] = b; speichereBenutzer_(alle);
  return { token: token, rolle: b.rolle, name: b.name, mitarbeiterId: b.mitarbeiterId || '', hauptadmin: !!b.hauptadmin && b.rolle === 'ADMIN', api: API_VERSION };
}
function abmelden() { if (ZUGANG_.sitzung) PropertiesService.getScriptProperties().deleteProperty(ZUGANG_.sitzung); return true; }
function benutzerListe() {
  nurAdmin_();
  var b = benutzer_();
  return Object.keys(b).map(function (k) { return oeffentlich_(b[k]); }).sort(function (x, y) { return x.name < y.name ? -1 : 1; });
}
/** Legt einen Benutzer an oder ändert ihn. Neues Passwort, Sperre oder Rollenwechsel beenden alle seine Sitzungen. */
function benutzerSpeichern(roh) {
  nurAdmin_();
  roh = roh || {};
  var sperre = LockService.getScriptLock(); sperre.waitLock(20000);
  try {
    var alle = benutzer_(), id = roh.id ? kennung_(roh.id) : Utilities.getUuid().toLowerCase(), alt = alle[id];
    var login = loginNormal_(roh.login);
    if (!/^[a-z0-9._-]{3,40}$/.test(login)) throw new Error('Benutzername: 3–40 Zeichen, nur Buchstaben a–z, Ziffern, Punkt, Minus, Unterstrich.');
    Object.keys(alle).forEach(function (k) { if (k !== id && alle[k].login === login) throw new Error('Den Benutzernamen gibt es schon.'); });
    if (!ROLLEN[roh.rolle]) throw new Error('Unbekannte Rolle');
    var passwort = roh.passwort == null ? '' : String(roh.passwort);
    if (!alt && !passwort) throw new Error('Bitte ein Passwort festlegen.');
    if (passwort && passwort.length < MIN_PASSWORT) throw new Error('Das Passwort braucht mindestens ' + MIN_PASSWORT + ' Zeichen.');
    var b = alt || { id: id, version: 1 };
    var aktiv = roh.aktiv !== false;
    // Admins und der Hauptadmin werden nur vom Hauptadmin verwaltet; der Hauptadmin bleibt Admin und aktiv.
    if ((roh.rolle === 'ADMIN' || (alt && alt.rolle === 'ADMIN') || roh.hauptadmin) && !ZUGANG_.hauptadmin) throw new Error('Admins verwaltet nur der Hauptadmin.');
    if (alt && alt.hauptadmin && (roh.rolle !== 'ADMIN' || !aktiv)) throw new Error('Der Hauptadmin bleibt Admin und aktiv – erst einen anderen Hauptadmin bestimmen.');
    if (roh.hauptadmin && (roh.rolle !== 'ADMIN' || !aktiv)) throw new Error('Hauptadmin kann nur ein aktiver Admin sein.');
    if (alt && (passwort || alt.rolle !== roh.rolle || (alt.aktiv !== false) !== aktiv || (alt.mitarbeiterId || '') !== (roh.mitarbeiterId || ''))) b.version = (b.version || 1) + 1;
    b.login = login; b.name = text_(roh.name || login).slice(0, 80); b.rolle = roh.rolle; b.mitarbeiterId = roh.mitarbeiterId ? kennung_(roh.mitarbeiterId) : ''; b.aktiv = aktiv;
    if (passwort) { b.salz = Utilities.getUuid(); b.hash = hash_(passwort, b.salz); }
    if (roh.hauptadmin === true && !b.hauptadmin) { Object.keys(alle).forEach(function (k) { if (alle[k].hauptadmin) { alle[k].hauptadmin = false; } }); b.hauptadmin = true; }
    b.geaendertAm = new Date().toISOString();
    alle[id] = b; speichereBenutzer_(alle);
    return benutzerListe();
  } finally { sperre.releaseLock(); }
}
function benutzerLoeschen(id) {
  nurAdmin_();
  var alle = benutzer_(), b = alle[kennung_(id)];
  if (b && b.hauptadmin) throw new Error('Der Hauptadmin kann nicht gelöscht werden – erst einen anderen Hauptadmin bestimmen.');
  if (b && b.rolle === 'ADMIN' && !ZUGANG_.hauptadmin) throw new Error('Admins verwaltet nur der Hauptadmin.');
  delete alle[kennung_(id)]; speichereBenutzer_(alle);
  return benutzerListe();
}

/** Was ein Fahrer sehen darf: eigene Touren (ab 45 Tagen zurück), deren Firmen, Team, Fälle, Anlagen. */
var FAHRER_TABELLEN = ['faelle', 'verlauf', 'anlagen', 'auftraggeber', 'adressen', 'fahrzeuge', 'fahrzeugeintraege', 'mitarbeiter', 'abwesenheiten', 'einsatzarten', 'touren', 'zeiten', 'aufgabenIntern', 'tachotage'];
function fahrerSicht_(d, ich) {
  var ab = Utilities.formatDate(new Date(Date.now() - 45 * 864e5), 'Europe/Berlin', 'yyyy-MM-dd');
  var lebt = function (x) { return x && !x.geloescht; };
  var team = function (t) { return [t.fahrerId].concat(String(t.beifahrerIds || '').split(',')).filter(function (x) { return x; }); };
  var touren = {}, firmen = {}, leute = {}, faelle = {};
  Object.keys(d.touren).forEach(function (k) { var t = d.touren[k]; if (lebt(t) && t.datum >= ab && team(t).indexOf(ich) >= 0) { touren[k] = t; if (t.auftraggeberId) firmen[t.auftraggeberId] = 1; team(t).forEach(function (m) { leute[m] = 1; }); } });
  Object.keys(d.faelle).forEach(function (k) { var f = d.faelle[k]; if (lebt(f) && (f.fahrerId === ich || touren[f.tourId])) faelle[k] = f; });
  var aufgaben = {};
  Object.keys(d.aufgabenIntern).forEach(function (k) { var a = d.aufgabenIntern[k]; if (lebt(a) && (a.zustaendigId === ich || (a.bezugArt === 'tour' && touren[a.bezugId]))) aufgaben[k] = a; });
  var nimm = function (tab, test, felder) { return Object.keys(d[tab]).map(function (k) { return d[tab][k]; }).filter(function (x) { return lebt(x) && test(x); }).map(function (x) {
    if (!felder) return x; var k = { id: x.id, firmaId: x.firmaId || '', rev: x.rev, geaendertAm: x.geaendertAm }; felder.forEach(function (f) { k[f] = x[f]; }); return k; }); };
  return {
    touren: nimm('touren', function (t) { return touren[t.id]; }),
    auftraggeber: nimm('auftraggeber', function (f) { return firmen[f.id]; }, ['name', 'telefon', 'status']),
    adressen: nimm('adressen', function (a) { return firmen[a.firmaId]; }),
    mitarbeiter: nimm('mitarbeiter', function (m) { return m.id === ich; }, ['name', 'rolle', 'telefon', 'email', 'aktiv', 'monteur', 'fuehrerschein', 'fahrerkarteNr', 'fahrerkarteBis', 'fuehrerscheinBis', 'modul95Bis', 'urlaubstage', 'resturlaub', 'wochenstunden'])
      .concat(nimm('mitarbeiter', function (m) { return m.id !== ich && leute[m.id]; }, ['name', 'rolle', 'telefon', 'aktiv'])),
    abwesenheiten: nimm('abwesenheiten', function (a) { return a.mitarbeiterId === ich; }),
    zeiten: nimm('zeiten', function (z) { return z.mitarbeiterId === ich; }),
    tachotage: nimm('tachotage', function (t) { return t.mitarbeiterId === ich; }),
    aufgabenIntern: nimm('aufgabenIntern', function (a) { return aufgaben[a.id]; }),
    einsatzarten: nimm('einsatzarten', function () { return true; }),
    fahrzeuge: nimm('fahrzeuge', function () { return true; }, ['kennzeichen', 'bezeichnung', 'art', 'status', 'zgg', 'kmStand', 'aliase', 'leihfahrzeug', 'fahrer', 'huBis', 'spBis', 'uvvBis']),
    fahrzeugeintraege: [],
    faelle: nimm('faelle', function (f) { return faelle[f.id]; }),
    stopps: nimm('stopps', function (x) { return touren[x.tourId]; }),
    verlauf: nimm('verlauf', function (v) { return faelle[v.fallId]; }),
    anlagen: nimm('anlagen', function (a) { return touren[a.fallId] || faelle[a.fallId]; }).map(ohneInterna_)
  };
}
var FAHRER_TOURFELDER = ['status', 'beginn', 'ende', 'kmStart', 'kmEnde', 'empfaenger', 'abgeliefertAm', 'notiz'];
/** Prüft, was ein Fahrer hochladen darf, und baut Änderungen an fremden Datensätzen auf die erlaubten Felder zurück. */
function fahrerEingang_(d, anfrage, ich) {
  var sicht = fahrerSicht_(d, ich), sichtbar = {};
  ['touren', 'faelle'].forEach(function (t) { sicht[t].forEach(function (x) { sichtbar[x.id] = t; }); });
  var neu = function (tab, x) { return x && x.id && !d[tab][String(x.id).toLowerCase()]; };
  var r = {};
  r.faelle = liste_(anfrage.faelle).filter(function (f) { return f && !f.geloescht && (neu('faelle', f) || sichtbar[String(f.id).toLowerCase()] === 'faelle'); });
  r.faelle.forEach(function (f) { sichtbar[String(f.id).toLowerCase()] = 'faelle'; });
  r.verlauf = liste_(anfrage.verlauf).filter(function (v) { return v && !v.geloescht && sichtbar[String(v.fallId).toLowerCase()] === 'faelle'; });
  r.anlagen = liste_(anfrage.anlagen).filter(function (a) { return a && !a.geloescht && sichtbar[String(a.fallId).toLowerCase()]; });
  r.touren = liste_(anfrage.touren).filter(function (t) { return t && !t.geloescht && sichtbar[String(t.id).toLowerCase()] === 'touren'; }).map(function (t) {
    var alt = d.touren[String(t.id).toLowerCase()], m = {}; Object.keys(alt).forEach(function (k) { m[k] = alt[k]; });
    FAHRER_TOURFELDER.forEach(function (f) { if (f in t) m[f] = t[f]; }); m.geaendertAm = t.geaendertAm; return m; });
  r.zeiten = liste_(anfrage.zeiten).filter(function (z) { var alt = z && d.zeiten[String(z.id).toLowerCase()];
    return z && z.mitarbeiterId === ich && (!alt || (alt.mitarbeiterId === ich && alt.quelle !== 'TACHO')) && z.quelle !== 'TACHO'; });
  r.abwesenheiten = liste_(anfrage.abwesenheiten).filter(function (a) { var alt = a && d.abwesenheiten[String(a.id).toLowerCase()]; return a && a.mitarbeiterId === ich && (!alt || alt.mitarbeiterId === ich); });
  r.aufgabenIntern = liste_(anfrage.aufgabenIntern).filter(function (a) { return a && !a.geloescht; }).map(function (a) {
    var alt = d.aufgabenIntern[String(a.id).toLowerCase()]; if (!alt) return a;
    if (alt.zustaendigId !== ich) return null; var m = {}; Object.keys(alt).forEach(function (k) { m[k] = alt[k]; }); m.erledigt = a.erledigt === true; m.erledigtAm = a.erledigtAm; m.geaendertAm = a.geaendertAm; return m; }).filter(function (a) { return a; });
  // Stopps eigener Touren: nur Status, Zeitpunkt, Empfänger und Notiz – keine neuen Stopps
  r.stopps = liste_(anfrage.stopps).map(function (x) {
    var alt = x && !x.geloescht && d.stopps[String(x.id).toLowerCase()]; if (!alt || alt.geloescht || !sichtbar[String(alt.tourId).toLowerCase()]) return null;
    var m = {}; Object.keys(alt).forEach(function (k) { m[k] = alt[k]; }); ['status', 'erledigtAm', 'empfaenger', 'notiz'].forEach(function (f) { if (f in x) m[f] = x[f]; }); m.geaendertAm = x.geaendertAm; return m; })
    .filter(function (x) { return x; });
  r.fahrzeugeintraege = liste_(anfrage.fahrzeugeintraege).filter(function (x) { return x && !x.geloescht && neu('fahrzeugeintraege', x) && ['TANKEN', 'KM', 'SCHADEN'].indexOf(x.art) >= 0; });
  return r;
}

// ============================== PIN ==============================

// ============================== Statuslink für Endkunden (ohne Anmeldung) ==============================
var STATUS_TEXT = { GEPLANT: 'Geplant', UNTERWEGS: 'Unterwegs', ANGEKOMMEN: 'Vor Ort', ERLEDIGT: 'Zugestellt', STORNIERT: 'Abgesagt', PROBLEM: 'Verzögert' };
/** Code gehört zu einer Tour oder zu einem Stopp: { t: Tour, s: Stopp oder null, ziel: Datensatz mit Bewertung }. */
function tourZumCode_(d, code) {
  code = String(code || '');
  if (!/^[A-Za-z0-9]{16,40}$/.test(code)) throw new Error('Link ungültig');
  var finde = function (tab) { var e = null; Object.keys(d[tab] || {}).some(function (k) { var x = d[tab][k]; if (!x.geloescht && x.statusCode === code) { e = x; return true; } return false; }); return e; };
  var s = finde('stopps'), t = s ? d.touren[s.tourId] : finde('touren');
  if (!t || t.geloescht) throw new Error('Link ungültig oder abgelaufen');
  return { t: t, s: s, ziel: s || t };
}
/** Was der Endkunde über seinen Statuslink sieht – keine Namen von Fahrern, keine Preise. */
function sendungsstatus(code) {
  var d = ladeDaten_(), g = tourZumCode_(d, code), t = g.t, s = g.s, firma = d.auftraggeber[t.auftraggeberId];
  var erledigt = s ? s.status === 'ERLEDIGT' : (t.status === 'ERLEDIGT' || !!t.abgeliefertAm);
  var status = erledigt ? 'ERLEDIGT' : s && s.status === 'PROBLEM' ? 'PROBLEM' : (t.status === 'ERLEDIGT' ? 'UNTERWEGS' : t.status || 'GEPLANT');
  var vorher = null;
  if (s && !erledigt && status === 'UNTERWEGS') vorher = Object.keys(d.stopps).map(function (k) { return d.stopps[k]; })
    .filter(function (x) { return !x.geloescht && x.tourId === s.tourId && x.status !== 'ERLEDIGT' && (x.reihenfolge || 0) < (s.reihenfolge || 0); }).length;
  return { datum: t.datum, zeitfenster: (s ? s.zeitfenster : t.zeitfenster) || t.uhrzeit || '', status: status, statusText: STATUS_TEXT[status] || 'Geplant', stoppsVorher: vorher,
    abgeliefertAm: (s ? s.erledigtAm : t.abgeliefertAm) || '', empfaenger: erledigt ? ((s ? s.empfaenger : t.empfaenger) || '') : '',
    im_auftrag: firma && !firma.geloescht ? firma.name : (t.auftraggeber || ''), kunde: (s ? s.kundeName : t.kundeName) || '', abholung: !!(s && s.art === 'ABHOLUNG'),
    bewertbar: erledigt && !g.ziel.bewertung, bewertung: g.ziel.bewertung || null };
}
/** Bewertung 1–5 Sterne nach der Ablieferung – einmal je Lieferung. */
function bewerten(code, sterne, text) {
  var sperre = LockService.getScriptLock(); sperre.waitLock(20000);
  try {
    var d = ladeDaten_(), g = tourZumCode_(d, code), t = g.ziel, n = Math.round(Number(sterne));
    if (!(g.s ? g.s.status === 'ERLEDIGT' : (t.status === 'ERLEDIGT' || t.abgeliefertAm))) throw new Error('Bewerten geht erst nach der Lieferung.');
    if (t.bewertung) throw new Error('Diese Lieferung wurde schon bewertet. Danke!');
    if (!(n >= 1 && n <= 5)) throw new Error('Bitte 1 bis 5 Sterne wählen.');
    t.bewertung = n; t.bewertungText = String(text || '').slice(0, 1000); t.bewertetAm = new Date().toISOString();
    t.geaendertAm = t.bewertetAm; t.rev = ++d.rev;
    speichereDaten_(d);
    return { ok: true };
  } finally { sperre.releaseLock(); }
}

function status() {
  return {
    name: 'Schadensfälle',
    api: API_VERSION,
    eingerichtet: !!PropertiesService.getScriptProperties().getProperty('PIN_HASH'),
    benutzer: Object.keys(benutzer_()).length > 0,
    pinAus: pinAus_(),
    selbstUpdate: true
  };
}

// ============================== Selbst-Update ==============================
/**
 * Das Skript aktualisiert sich selbst (ohne Kopieren in den Apps-Script-Editor): Es lädt Code.gs von der festen Adresse
 * der Web-App, prüft die SHA-256-Prüfsumme aus cloud-update.json, ersetzt seinen Code über die Apps Script API, legt eine
 * neue Version an und stellt sie auf DERSELBEN Bereitstellung bereit (Adresse bleibt gleich). Antwortet die neue Version
 * nicht, wird die vorherige wieder bereitgestellt. Einmalig nötig: Apps Script API einschalten
 * (script.google.com/home/usersettings) und appsscript.json mit den Berechtigungen script.projects/script.deployments.
 */
var UPDATE_BASIS = 'https://aysetransport.github.io/schaden/';
var SKRIPT_API = 'https://script.googleapis.com/v1/projects/';

function holeText_(url) {
  var r = UrlFetchApp.fetch(url + (url.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now(), { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('Update-Server nicht erreichbar (' + r.getResponseCode() + ')');
  return r.getContentText();
}
function hex_(bytes) { return bytes.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join(''); }
function skriptApi_(methode, pfad, inhalt) {
  var r = UrlFetchApp.fetch(SKRIPT_API + ScriptApp.getScriptId() + pfad, {
    method: methode, contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, payload: inhalt == null ? undefined : JSON.stringify(inhalt)
  });
  var code = r.getResponseCode(), text = r.getContentText();
  if (code >= 300) {
    if (code === 403 && /has not been used|disabled|SERVICE_DISABLED/i.test(text)) throw new Error('Bitte einmalig die Google Apps Script API einschalten: script.google.com/home/usersettings');
    if (code === 403 || code === 401) throw new Error('Dem Skript fehlt die Berechtigung zum Selbst-Update – bitte appsscript.json einmalig mit den neuen Berechtigungen einsetzen und neu bereitstellen.');
    throw new Error('Apps Script API: ' + code + ' ' + text.slice(0, 200));
  }
  return text ? JSON.parse(text) : {};
}
function bereitstellungsId_() {
  var gemerkt = PropertiesService.getScriptProperties().getProperty('BEREITSTELLUNG');
  if (gemerkt) return gemerkt;
  var m = String(ScriptApp.getService().getUrl() || '').match(/\/s\/([^/]+)\/(exec|dev)/);
  if (!m) throw new Error('Bereitstellung nicht gefunden');
  return m[1];
}
function cloudUpdateInfo() {
  nurHauptadmin_();
  var props = PropertiesService.getScriptProperties(), m = null, fehler = '';
  try { m = JSON.parse(holeText_(UPDATE_BASIS + 'cloud-update.json')); } catch (e) { fehler = String(e.message || e); }
  return { api: API_VERSION, stand: Number(props.getProperty('CODE_STAND') || 0), verfuegbar: m, fehler: fehler,
    automatisch: props.getProperty('AUTO_UPDATE') === '1', letzterFehler: props.getProperty('UPDATE_FEHLER') || '' };
}
function cloudAktualisieren(erzwingen) { nurHauptadmin_(); return selbstUpdate_(!!erzwingen); }
function selbstUpdate_(erzwingen) {
  var props = PropertiesService.getScriptProperties();
  var m = JSON.parse(holeText_(UPDATE_BASIS + 'cloud-update.json'));
  if (!erzwingen && Number(m.stand) <= Number(props.getProperty('CODE_STAND') || 0)) return { neu: false, api: API_VERSION };
  var code = holeText_(UPDATE_BASIS + 'cloud/Code.gs');
  if (hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, code, Utilities.Charset.UTF_8)) !== m.sha256) throw new Error('Prüfsumme des Cloud-Skripts stimmt nicht – Update abgebrochen');
  var manifest = null;
  if (m.manifestSha256) {
    manifest = holeText_(UPDATE_BASIS + 'cloud/appsscript.json');
    if (hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, manifest, Utilities.Charset.UTF_8)) !== m.manifestSha256) throw new Error('Prüfsumme von appsscript.json stimmt nicht');
  }
  var inhalt = skriptApi_('get', '/content'), dateien = inhalt.files || [];
  var js = dateien.filter(function (f) { return f.type === 'SERVER_JS'; });
  var ziel = js.filter(function (f) { return f.name === 'Code'; })[0] || (js.length === 1 ? js[0] : null);
  if (!ziel) throw new Error('Datei „Code“ im Skriptprojekt nicht gefunden');
  ziel.source = code;
  if (manifest) dateien.forEach(function (f) { if (f.type === 'JSON' && f.name === 'appsscript') f.source = manifest; });
  skriptApi_('put', '/content', { files: dateien });
  var version = skriptApi_('post', '/versions', { description: 'Ayse CRM ' + (m.version || '') + ' (API ' + m.api + ')' }).versionNumber;
  var id = bereitstellungsId_(), alt = skriptApi_('get', '/deployments/' + id);
  var vorher = alt.deploymentConfig && alt.deploymentConfig.versionNumber;
  var konfig = function (v, text) { return { deploymentConfig: { scriptId: ScriptApp.getScriptId(), versionNumber: v, manifestFileName: 'appsscript', description: text } }; };
  skriptApi_('put', '/deployments/' + id, konfig(version, 'Ayse CRM ' + (m.version || '')));
  // Antwortet die neue Version? Sonst zurück auf die vorherige.
  var ok = false;
  try {
    var r = UrlFetchApp.fetch(ScriptApp.getService().getUrl(), { method: 'post', contentType: 'text/plain', payload: JSON.stringify({ fn: 'status', args: [] }), muteHttpExceptions: true });
    var j = JSON.parse(r.getContentText()); ok = !!(j.ok && Number(j.ok.api) >= Number(m.api));
  } catch (e) { ok = false; }
  if (!ok) {
    if (vorher) skriptApi_('put', '/deployments/' + id, konfig(vorher, 'zurückgesetzt nach fehlgeschlagenem Update'));
    throw new Error('Die neue Version antwortet nicht – die vorherige Version ist wieder aktiv.');
  }
  props.setProperty('BEREITSTELLUNG', id);
  props.setProperty('CODE_STAND', String(m.stand));
  props.deleteProperty('UPDATE_FEHLER');
  return { neu: true, vorher: API_VERSION, api: Number(m.api), version: version };
}
/** Zeitgesteuert (nachts): Update einspielen, Fehler merken statt abbrechen. */
function nachtsUpdate() {
  try { selbstUpdate_(false); } catch (e) { PropertiesService.getScriptProperties().setProperty('UPDATE_FEHLER', new Date().toISOString().slice(0, 16) + ' ' + String(e.message || e)); }
}
function cloudAutoUpdate(an) {
  nurHauptadmin_();
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'nachtsUpdate') ScriptApp.deleteTrigger(t); });
  if (an) ScriptApp.newTrigger('nachtsUpdate').timeBased().everyDays(1).atHour(3).create();
  PropertiesService.getScriptProperties().setProperty('AUTO_UPDATE', an ? '1' : '0');
  return !!an;
}

/** Legt die PIN fest – nur möglich, solange noch keine vergeben ist. */
function pinFestlegen(pin) {
  pin = String(pin == null ? '' : pin);
  if (pin.length < MIN_PIN_LAENGE) throw new Error('Die PIN braucht mindestens ' + MIN_PIN_LAENGE + ' Zeichen.');
  var sperre = LockService.getScriptLock();
  sperre.waitLock(20000);
  try {
    var props = PropertiesService.getScriptProperties();
    if (props.getProperty('PIN_HASH')) throw new Error('Es ist bereits eine PIN festgelegt.');
    var salz = Utilities.getUuid();
    props.setProperty('PIN_SALZ', salz);
    props.setProperty('PIN_HASH', hash_(pin, salz));
    return { eingerichtet: true };
  } finally {
    sperre.releaseLock();
  }
}

/**
 * Im Skript-Editor ausführen, wenn die PIN vergessen wurde. Danach kann in der App eine neue
 * festgelegt werden. Die Daten bleiben erhalten.
 */
function pinZuruecksetzen() {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty('PIN_HASH');
  props.deleteProperty('PIN_SALZ');
  props.deleteProperty('FEHLVERSUCHE');
}

function pruefePin_(pin) {
  var props = PropertiesService.getScriptProperties();
  var jetzt = Date.now();
  var zaehler = JSON.parse(props.getProperty('FEHLVERSUCHE') || '{"n":0,"bis":0}');
  if (zaehler.bis > jetzt) {
    throw new Error('GESPERRT: Zu viele falsche PIN-Eingaben. Bitte in ' +
      Math.ceil((zaehler.bis - jetzt) / 60000) + ' Minuten erneut versuchen.');
  }
  var gespeichert = props.getProperty('PIN_HASH');
  if (!gespeichert) throw new Error('PIN noch nicht festgelegt');
  if (hash_(String(pin == null ? '' : pin), props.getProperty('PIN_SALZ')) === gespeichert) {
    if (zaehler.n) props.deleteProperty('FEHLVERSUCHE');
    return;
  }
  zaehler.n = (zaehler.bis && zaehler.bis <= jetzt ? 0 : zaehler.n) + 1;
  zaehler.bis = zaehler.n >= MAX_FEHLVERSUCHE ? jetzt + SPERRE_MINUTEN * 60000 : 0;
  props.setProperty('FEHLVERSUCHE', JSON.stringify(zaehler));
  throw new Error('PIN falsch');
}

function hash_(pin, salz) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salz + '|' + pin, Utilities.Charset.UTF_8);
  return Utilities.base64Encode(bytes);
}

// ============================== Abgleich ==============================

function anmelden() {
  var d = ladeDaten_();
  return { name: 'Schadensfälle', api: API_VERSION, kennung: d.kennung, rev: d.rev, rolle: ZUGANG_.rolle, mitarbeiterId: ZUGANG_.mitarbeiterId || '', benutzer: ZUGANG_.name || '', hauptadmin: !!ZUGANG_.hauptadmin, pinAus: pinAus_() };
}

/** Schnelle Abfrage, ob es Neues gibt. */
function stand() {
  // Ohne daten.json zu lesen (die ist mit vielen Firmen und Mails groß): Kennung und Stand liegen
  // zusätzlich in den Skript-Eigenschaften, zusammen mit der ID der Datei, zu der sie gehören.
  var gemerkt = String(PropertiesService.getScriptProperties().getProperty('STAND') || '').split('|');
  var datei = datenDatei_();
  if (datei && gemerkt.length === 3 && gemerkt[0] === datei.getId()) return { kennung: gemerkt[1], rev: Number(gemerkt[2]) };
  var d = ladeDaten_();
  merkeStand_(d);
  return { kennung: d.kennung, rev: d.rev };
}

function merkeStand_(d) {
  var datei = datenDatei_();
  if (datei) PropertiesService.getScriptProperties().setProperty('STAND', datei.getId() + '|' + d.kennung + '|' + d.rev);
}

/**
 * Nimmt die lokalen Änderungen eines Geräts entgegen und liefert alles zurück, was sich seit
 * dem letzten Abgleich dieses Geräts geändert hat.
 *
 * anfrage: { seit, kennung, faelle: […], verlauf: […], anlagen: […], auftraggeber: […], adressen: […], … }
 * antwort: dieselben Listen mit allem, was sich seit „seit“ geändert hat, dazu kennung und rev
 *
 * Regeln: Bei einem Fall gewinnt der Stand mit dem späteren Änderungszeitpunkt. Gelöscht
 * bleibt gelöscht. Verlaufseinträge und Anlagen werden nur hinzugefügt oder gelöscht.
 */
function sync(anfrage) {
  anfrage = anfrage || {};
  var sperre = LockService.getScriptLock();
  sperre.waitLock(25000);
  try {
    var d = ladeDaten_();
    var rolle = ZUGANG_.rolle, ich = ZUGANG_.mitarbeiterId || '';
    if (rolle === 'FAHRER') {
      var erlaubt = fahrerEingang_(d, anfrage, ich);
      anfrage = { seit: anfrage.seit, kennung: anfrage.kennung };
      Object.keys(erlaubt).forEach(function (t) { anfrage[t] = erlaubt[t]; });
    } else if (rolle === 'DISPO') {
      // keine Lohndaten: Personalakte ohne Lohnabrechnungen (keine Beträge), Stundenlohn bleibt wie gespeichert
      anfrage.personaleintraege = liste_(anfrage.personaleintraege).filter(function (x) {
        var alt = x && d.personaleintraege[String(x.id).toLowerCase()];
        return x && x.art !== 'LOHN' && !(alt && alt.art === 'LOHN');
      }).map(function (x) { var k = {}; Object.keys(x).forEach(function (f) { if (['bruttoCent', 'nettoCent', 'kostenCent', 'stunden'].indexOf(f) < 0) k[f] = x[f]; }); return k; });
      anfrage.mitarbeiter = liste_(anfrage.mitarbeiter).map(function (m) { var alt = m && d.mitarbeiter[String(m.id).toLowerCase()]; if (m) { m.stundenlohnCent = alt ? alt.stundenlohnCent : null; m.einsatzKostenCent = alt ? alt.einsatzKostenCent : null; } return m; });
    }
    // Kennt das Gerät einen anderen Datenbestand (z. B. nach neu angelegtem Ordner), bekommt es alles.
    var seit = anfrage.kennung === d.kennung ? Math.max(0, Number(anfrage.seit) || 0) : 0;
    var vorher = d.rev;
    var zurueck = { faelle: {}, verlauf: {}, anlagen: {}, auftraggeber: {} };

    liste_(anfrage.faelle).forEach(function (roh) { uebernehmeFall_(d, roh, zurueck.faelle); });
    liste_(anfrage.verlauf).forEach(function (roh) { uebernehmeVerlauf_(d, roh); });
    liste_(anfrage.anlagen).forEach(function (roh) { uebernehmeAnlage_(d, roh); });
    // Gelöschte Firmen zuletzt: Führt ein Gerät zwei gleichnamige Firmen zusammen, schickt es die
    // umgehängten Einträge zusammen mit der Löschung der zweiten Firma – sie dürfen nicht mitgelöscht werden.
    var firmen = liste_(anfrage.auftraggeber);
    firmen.filter(function (roh) { return !(roh && roh.geloescht === true); })
      .forEach(function (roh) { uebernehmeAuftraggeber_(d, roh, zurueck.auftraggeber); });
    CRM_NAMEN.forEach(function (t) {
      zurueck[t] = {};
      liste_(anfrage[t]).forEach(function (roh) { uebernehmeCrm_(d, t, roh, zurueck[t]); });
    });
    firmen.filter(function (roh) { return roh && roh.geloescht === true; })
      .forEach(function (roh) { uebernehmeAuftraggeber_(d, roh, zurueck.auftraggeber); });

    if (d.rev !== vorher) speichereDaten_(d);
    var antwort = {
      kennung: d.kennung,
      rev: d.rev,
      faelle: auswahl_(d.faelle, seit, zurueck.faelle),
      verlauf: auswahl_(d.verlauf, seit, zurueck.verlauf),
      anlagen: auswahl_(d.anlagen, seit, zurueck.anlagen).map(ohneInterna_),
      auftraggeber: auswahl_(d.auftraggeber, seit, zurueck.auftraggeber)
    };
    CRM_NAMEN.forEach(function (t) { antwort[t] = auswahl_(d[t], seit, zurueck[t]); });
    if (rolle === 'FAHRER') {
      // Fahrer bekommen jedes Mal ihren vollständigen, gefilterten Bestand (klein) – nichts darüber hinaus.
      var sicht = fahrerSicht_(d, ich);
      ['faelle', 'verlauf', 'anlagen', 'auftraggeber'].concat(CRM_NAMEN).forEach(function (t) { antwort[t] = sicht[t] || []; });
      antwort.ansicht = 'FAHRER';
    } else if (rolle === 'DISPO') {
      // vollständige Personalakte ohne Lohnabrechnungen (die App gleicht sie für die Disposition komplett ab)
      antwort.personaleintraege = Object.keys(d.personaleintraege).map(function (k) { return d.personaleintraege[k]; }).filter(function (x) { return !x.geloescht && x.art !== 'LOHN'; });
      antwort.anlagen = antwort.anlagen.filter(function (a) { return !lohnAnlage_(d, a); });
      antwort.mitarbeiter = antwort.mitarbeiter.map(function (m) { var k = {}; Object.keys(m).forEach(function (f) { if (f !== 'stundenlohnCent' && f !== 'einsatzKostenCent') k[f] = m[f]; }); return k; });
      antwort.ansicht = 'DISPO';
    }
    antwort.rolle = rolle;
    return antwort;
  } finally {
    sperre.releaseLock();
  }
}

function uebernehmeFall_(d, roh, zurueck) {
  var neu = bereinigeFall_(roh);
  var alt = d.faelle[neu.id];
  if (alt && alt.geloescht) {
    if (!neu.geloescht) zurueck[neu.id] = true; // dem Gerät mitteilen, dass der Fall gelöscht ist
    return;
  }
  if (neu.geloescht) {
    loescheFall_(d, neu.id, neu.geaendertAm);
    return;
  }
  if (alt && zeit_(neu.geaendertAm) <= zeit_(alt.geaendertAm)) {
    if (!gleicherInhalt_(alt, neu)) zurueck[neu.id] = true; // Server ist neuer: dessen Stand zurückgeben
    return;
  }
  if (alt) neu.erstelltAm = alt.erstelltAm;
  neu.fallnummer = eindeutigeFallnummer_(d, neu);
  neu.rev = ++d.rev;
  d.faelle[neu.id] = neu;
}

/**
 * Firmen (Auftraggeber): wie bei Fällen gewinnt die spätere Änderung, Gelöschtes bleibt gelöscht.
 * Mit einer Firma wird alles gelöscht, was an ihr hängt (Ansprechpartner, Adressen …).
 */
function uebernehmeAuftraggeber_(d, roh, zurueck) {
  roh = roh || {};
  var neu = { id: kennung_(roh.id), geaendertAm: zeitpunkt_(roh.geaendertAm) };
  var alt = d.auftraggeber[neu.id];
  if (alt && alt.geloescht) { if (roh.geloescht !== true) zurueck[neu.id] = true; return; }
  if (roh.geloescht === true) {
    d.auftraggeber[neu.id] = { id: neu.id, geloescht: true, geaendertAm: neu.geaendertAm, rev: ++d.rev };
    CRM_NAMEN.forEach(function (t) {
      Object.keys(d[t]).forEach(function (k) {
        var e = d[t][k];
        if (e.firmaId === neu.id && !e.geloescht) d[t][k] = { id: k, firmaId: neu.id, geloescht: true, geaendertAm: neu.geaendertAm, rev: ++d.rev };
      });
    });
    return;
  }
  neu.name = text_(roh.name).slice(0, 200);
  neu.rechtsform = text_(roh.rechtsform).slice(0, 100);
  neu.status = wort_(roh.status, 'AKTIV');
  neu.telefon = text_(roh.telefon).slice(0, 100);
  neu.email = text_(roh.email).slice(0, 200);
  neu.website = text_(roh.website).slice(0, 300);
  neu.notizen = text_(roh.notizen);
  neu.schlagworte = text_(roh.schlagworte).slice(0, 500);
  neu.kundennummer = text_(roh.kundennummer).slice(0, 50);
  neu.ustId = text_(roh.ustId).slice(0, 50);
  neu.zahlungszielTage = text_(roh.zahlungszielTage).slice(0, 5);
  neu.rechnungBank = text_(roh.rechnungBank).slice(0, 100);
  neu.rechnungIban = text_(roh.rechnungIban).slice(0, 40);
  neu.rechnungBic = text_(roh.rechnungBic).slice(0, 15);
  neu.leitwegId = text_(roh.leitwegId).slice(0, 60);
  neu.eRechnungEmail = text_(roh.eRechnungEmail).slice(0, 200);
  // Ältere Apps schicken diese Felder nicht mit – dann den bisherigen Wert behalten statt ihn zu leeren.
  FIRMEN_ZUSATZ.forEach(function (k) { if (roh[k] === undefined && alt && alt[k] !== undefined) neu[k] = alt[k]; });
  if (alt && zeit_(neu.geaendertAm) <= zeit_(alt.geaendertAm)) {
    if (!gleicherInhalt_(alt, neu)) zurueck[neu.id] = true;
    return;
  }
  neu.rev = ++d.rev;
  d.auftraggeber[neu.id] = neu;
}

/** CRM-Einträge: die spätere Änderung gewinnt; was zu einer gelöschten Firma kommt, gilt als gelöscht. */
function uebernehmeCrm_(d, tabelle, roh, zurueck) {
  roh = roh || {};
  // Der Fuhrpark gehört zu keiner Firma.
  var neu = { id: kennung_(roh.id), firmaId: roh.firmaId ? kennung_(roh.firmaId) : '', geaendertAm: zeitpunkt_(roh.geaendertAm) };
  var alt = d[tabelle][neu.id];
  var firma = d.auftraggeber[neu.firmaId];
  if (alt && alt.geloescht) { if (roh.geloescht !== true) zurueck[neu.id] = true; return; }
  if (roh.geloescht === true || (firma && firma.geloescht)) {
    if (roh.geloescht !== true) zurueck[neu.id] = true;
    d[tabelle][neu.id] = { id: neu.id, firmaId: neu.firmaId, geloescht: true, geaendertAm: neu.geaendertAm, rev: ++d.rev };
    return;
  }
  var felder = CRM_TABELLEN[tabelle];
  Object.keys(felder).forEach(function (k) {
    var art = felder[k];
    if (art === 'text') neu[k] = text_(roh[k]);
    else if (art.indexOf('wort:') === 0) neu[k] = wort_(roh[k], art.slice(5));
    else if (art === 'datum') neu[k] = datum_(roh[k]);
    else if (art === 'cent') neu[k] = cent_(roh[k]);
    else if (art === 'bool') neu[k] = roh[k] === true;
  });
  if (tabelle === 'aktivitaeten' && !neu.datum) neu.datum = neu.geaendertAm.slice(0, 10); // ein Kontakt hat immer ein Datum
  if (alt && zeit_(neu.geaendertAm) <= zeit_(alt.geaendertAm)) {
    if (!gleicherInhalt_(alt, neu)) zurueck[neu.id] = true;
    return;
  }
  // Bewertungen kommen nur vom Kunden (Statuslink) – ein Gerät mit älterem Stand löscht sie nicht.
  if ((tabelle === 'touren' || tabelle === 'stopps') && alt && alt.bewertung && !neu.bewertung) { neu.bewertung = alt.bewertung; neu.bewertungText = alt.bewertungText; neu.bewertetAm = alt.bewertetAm; }
  neu.rev = ++d.rev;
  d[tabelle][neu.id] = neu;
}

/** Löscht einen Fall samt Verlauf und Anlagen. Zurück bleibt nur ein Vermerk ohne Inhalt. */
function loescheFall_(d, id, zeitpunkt) {
  d.faelle[id] = { id: id, geloescht: true, geaendertAm: zeitpunkt, rev: ++d.rev };
  Object.keys(d.verlauf).forEach(function (k) {
    var v = d.verlauf[k];
    if (v.fallId === id && !v.geloescht) d.verlauf[k] = { id: k, fallId: id, geloescht: true, rev: ++d.rev };
  });
  Object.keys(d.anlagen).forEach(function (k) {
    if (d.anlagen[k].fallId === id && !d.anlagen[k].geloescht) loescheAnlage_(d, k);
  });
}

function uebernehmeVerlauf_(d, roh) {
  var neu = bereinigeVerlauf_(roh);
  var alt = d.verlauf[neu.id];
  if (alt) {
    if (neu.geloescht && !alt.geloescht) d.verlauf[neu.id] = { id: neu.id, fallId: alt.fallId, geloescht: true, rev: ++d.rev };
    return;
  }
  var fall = d.faelle[neu.fallId];
  if (neu.geloescht || (fall && fall.geloescht)) neu = { id: neu.id, fallId: neu.fallId, geloescht: true };
  neu.rev = ++d.rev;
  d.verlauf[neu.id] = neu;
}

function uebernehmeAnlage_(d, roh) {
  var neu = bereinigeAnlage_(roh);
  var alt = d.anlagen[neu.id];
  if (alt) {
    if (neu.geloescht && !alt.geloescht) loescheAnlage_(d, neu.id);
    return;
  }
  var fall = d.faelle[neu.fallId];
  if (neu.geloescht || (fall && fall.geloescht)) neu = { id: neu.id, fallId: neu.fallId, geloescht: true };
  else neu.vorhanden = false; // die Datei selbst kommt mit anlageHochladen
  neu.rev = ++d.rev;
  d.anlagen[neu.id] = neu;
}

function loescheAnlage_(d, id) {
  var alt = d.anlagen[id];
  if (alt.dateiId) {
    try { DriveApp.getFileById(alt.dateiId).setTrashed(true); } catch (fehler) { /* Datei schon weg */ }
  }
  d.anlagen[id] = { id: id, fallId: alt.fallId, geloescht: true, rev: ++d.rev };
}

/**
 * Zwei Geräte können ohne Netz dieselbe Fallnummer vergeben. Wer zuerst abgleicht, behält sie;
 * der spätere Fall bekommt die nächste freie Nummer seines Jahres.
 */
function eindeutigeFallnummer_(d, fall) {
  var belegt = {};
  Object.keys(d.faelle).forEach(function (k) {
    var f = d.faelle[k];
    if (k !== fall.id && !f.geloescht && f.fallnummer) belegt[f.fallnummer] = true;
  });
  if (fall.fallnummer && !belegt[fall.fallnummer]) return fall.fallnummer;
  var treffer = /^(\d{4})-\d+$/.exec(fall.fallnummer || '');
  var jahr = treffer ? treffer[1] : String(new Date(zeit_(fall.erstelltAm) || Date.now()).getFullYear());
  var hoechste = 0;
  Object.keys(belegt).forEach(function (nummer) {
    var m = /^(\d{4})-(\d+)$/.exec(nummer);
    if (m && m[1] === jahr) hoechste = Math.max(hoechste, Number(m[2]));
  });
  var laufend = String(hoechste + 1);
  while (laufend.length < 3) laufend = '0' + laufend;
  return jahr + '-' + laufend;
}

// ============================== Anlagen ==============================

/** Speichert den Inhalt einer Anlage, deren Eintrag bereits per sync bekannt ist. */
function anlageHochladen(id, base64) {
  id = kennung_(id);
  var bytes = Utilities.base64Decode(String(base64 || ''));
  if (!bytes.length) throw new Error('Die Anlage ist leer.');
  if (bytes.length > MAX_ANLAGE_BYTES) throw new Error('Die Anlage ist größer als 25 MB.');

  var dd = ladeDaten_(), eintrag = dd.anlagen[id];
  if (!eintrag || eintrag.geloescht) throw new Error('Anlage unbekannt');
  pruefeAnlageSichtbar_(dd, eintrag);
  if (eintrag.vorhanden) return { vorhanden: true };
  // Die Datei wird vor der Sperre angelegt, damit andere Geräte währenddessen abgleichen können.
  var datei = unterordner_(ANLAGEN_ORDNER).createFile(
    Utilities.newBlob(bytes, eintrag.mimeType || 'application/octet-stream', id));

  var sperre = LockService.getScriptLock();
  sperre.waitLock(25000);
  try {
    var d = ladeDaten_();
    var a = d.anlagen[id];
    if (!a || a.geloescht || a.vorhanden) {
      datei.setTrashed(true); // inzwischen gelöscht oder von einem anderen Gerät hochgeladen
      return { vorhanden: !!(a && a.vorhanden) };
    }
    a.dateiId = datei.getId();
    a.vorhanden = true;
    a.groesseBytes = bytes.length;
    a.rev = ++d.rev;
    speichereDaten_(d);
    return { vorhanden: true, rev: d.rev };
  } finally {
    sperre.releaseLock();
  }
}

/** Lohnabrechnungen in der Personalakte gehören zu den Lohndaten – nur für Admins. */
function lohnAnlage_(d, a) {
  return !!(a && d.mitarbeiter && d.mitarbeiter[String(a.fallId || '').toLowerCase()] && /^lohnabrechnung/i.test(String(a.anzeigename || '')));
}
function pruefeAnlageSichtbar_(d, a) {
  if (ZUGANG_.rolle === 'DISPO' && lohnAnlage_(d, a)) throw new Error('Kein Zugriff auf diese Anlage');
  if (ZUGANG_.rolle !== 'FAHRER') return;
  var sicht = fahrerSicht_(d, ZUGANG_.mitarbeiterId || '');
  if (!sicht.anlagen.some(function (x) { return x.id === a.id; })) throw new Error('Kein Zugriff auf diese Anlage');
}
function anlageLaden(id) {
  var d = ladeDaten_(), a = d.anlagen[kennung_(id)];
  if (!a || a.geloescht) throw new Error('Anlage unbekannt');
  pruefeAnlageSichtbar_(d, a);
  if (!a.vorhanden || !a.dateiId) throw new Error('Die Anlage wurde noch nicht hochgeladen.');
  var blob = DriveApp.getFileById(a.dateiId).getBlob();
  return { base64: Utilities.base64Encode(blob.getBytes()), mimeType: a.mimeType, anzeigename: a.anzeigename };
}

function ohneInterna_(anlage) {
  var kopie = {};
  Object.keys(anlage).forEach(function (k) { if (k !== 'dateiId') kopie[k] = anlage[k]; });
  return kopie;
}

// ============================== Eingaben prüfen ==============================
// Es wird nur übernommen, was die Apps kennen – unbekannte Felder und übergroße Texte fallen weg.

var FALL_TEXTE = ['fallnummer', 'kundeName', 'kundeFirma', 'kundeTelefon', 'kundeEmail', 'kundeAnschrift',
  'kundenAktenzeichen', 'auftraggeber', 'auftraggeberUuid', 'auftraggeberKontakt', 'auftraggeberTelefon', 'auftraggeberEmail', 'auftraggeberZeichen', 'auftragsReferenz', 'tour', 'fahrzeug', 'fahrer', 'beifahrer1', 'beifahrer2', 'schadensort',
  'beschreibung', 'wiedervorlageNotiz', 'versicherungsNummer', 'tourId', 'fahrzeugId', 'fahrerId'];
var FALL_DATEN = ['schadensdatum', 'meldedatum', 'wiedervorlageAm', 'zahlungsfrist'];

function bereinigeFall_(roh) {
  roh = roh || {};
  var fall = { id: kennung_(roh.id), geloescht: roh.geloescht === true, geaendertAm: zeitpunkt_(roh.geaendertAm) };
  if (fall.geloescht) return fall;
  FALL_TEXTE.forEach(function (k) { fall[k] = text_(roh[k]); });
  FALL_DATEN.forEach(function (k) { fall[k] = datum_(roh[k]); });
  fall.schadensart = wort_(roh.schadensart, 'WARE');
  fall.status = wort_(roh.status, 'NEU');
  fall.wartetAuf = roh.wartetAuf == null ? null : wort_(roh.wartetAuf, null);
  fall.forderungCent = cent_(roh.forderungCent);
  fall.vergleichCent = cent_(roh.vergleichCent);
  fall.erstelltAm = zeitpunkt_(roh.erstelltAm);
  return fall;
}

function bereinigeVerlauf_(roh) {
  roh = roh || {};
  return {
    id: kennung_(roh.id),
    fallId: kennung_(roh.fallId),
    geloescht: roh.geloescht === true,
    zeitpunkt: zeitpunkt_(roh.zeitpunkt),
    typ: wort_(roh.typ, 'NOTIZ'),
    text: text_(roh.text)
  };
}

function bereinigeAnlage_(roh) {
  roh = roh || {};
  return {
    id: kennung_(roh.id),
    fallId: kennung_(roh.fallId),
    geloescht: roh.geloescht === true,
    anzeigename: text_(roh.anzeigename).slice(0, 200),
    mimeType: /^[\w.+-]+\/[\w.+-]+$/.test(String(roh.mimeType)) ? String(roh.mimeType) : 'application/octet-stream',
    groesseBytes: Math.max(0, Math.floor(Number(roh.groesseBytes) || 0)),
    hinzugefuegtAm: zeitpunkt_(roh.hinzugefuegtAm)
  };
}

function kennung_(wert) {
  wert = String(wert == null ? '' : wert).toLowerCase();
  if (!/^[0-9a-f-]{8,64}$/.test(wert)) throw new Error('Ungültige Kennung');
  return wert;
}
function text_(wert) { return String(wert == null ? '' : wert).slice(0, MAX_TEXT); }
function datum_(wert) { return /^\d{4}-\d{2}-\d{2}$/.test(String(wert)) ? String(wert) : null; }
function wort_(wert, standard) { return /^[A-Z_]{1,40}$/.test(String(wert)) ? String(wert) : standard; }
function cent_(wert) {
  if (wert == null || wert === '') return null;
  var zahl = Math.floor(Number(wert));
  return isFinite(zahl) && zahl >= 0 ? zahl : null;
}
/** Zeitpunkte einheitlich als ISO-Text in UTC; Unlesbares wird zu „jetzt“. */
function zeitpunkt_(wert) {
  var ms = Date.parse(String(wert));
  return new Date(isNaN(ms) ? Date.now() : ms).toISOString();
}
function zeit_(iso) { var ms = Date.parse(String(iso)); return isNaN(ms) ? 0 : ms; }
function liste_(wert) { return Array.isArray(wert) ? wert : []; }

function gleicherInhalt_(a, b) {
  return Object.keys(b).every(function (k) { return k === 'erstelltAm' || a[k] === b[k]; });
}

function auswahl_(tabelle, seit, zusaetzlich) {
  return Object.keys(tabelle)
    .filter(function (k) { return tabelle[k].rev > seit || zusaetzlich[k]; })
    .map(function (k) { return tabelle[k]; });
}

// ============================== Ablage in Google Drive ==============================

function ordner_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('ORDNER_ID');
  if (id) {
    try {
      var vorhanden = DriveApp.getFolderById(id);
      if (!vorhanden.isTrashed()) return vorhanden;
    } catch (fehler) { /* Ordner gelöscht – neu anlegen */ }
  }
  var treffer = DriveApp.getFoldersByName(ORDNER_NAME);
  var ordner = treffer.hasNext() ? treffer.next() : DriveApp.createFolder(ORDNER_NAME);
  props.setProperty('ORDNER_ID', ordner.getId());
  return ordner;
}

function unterordner_(name) {
  var treffer = ordner_().getFoldersByName(name);
  return treffer.hasNext() ? treffer.next() : ordner_().createFolder(name);
}

/**
 * daten.json – über die gemerkte Datei-ID (schnell); nur wenn sie fehlt, per Suche im Ordner
 * (die Suche in Google Drive dauert spürbar länger).
 */
function datenDatei_() {
  var props = PropertiesService.getScriptProperties();
  var ordner = ordner_();
  // gemerkt als „Ordner-ID|Datei-ID“: Wurde der Ordner gelöscht und neu angelegt, gilt die Datei nicht mehr.
  var gemerkt = String(props.getProperty('DATEN_ID') || '').split('|');
  if (gemerkt[0] === ordner.getId() && gemerkt[1]) {
    try {
      var datei = DriveApp.getFileById(gemerkt[1]);
      if (!datei.isTrashed()) return datei;
    } catch (fehler) { /* Datei gelöscht – neu suchen */ }
  }
  props.deleteProperty('DATEN_ID');
  var treffer = ordner.getFilesByName(DATEN_DATEI);
  if (!treffer.hasNext()) return null;
  var gefunden = treffer.next();
  props.setProperty('DATEN_ID', ordner.getId() + '|' + gefunden.getId());
  return gefunden;
}

/** Legt daten.json an und merkt sich die ID. */
function neueDatenDatei_(text) {
  var ordner = ordner_();
  var datei = ordner.createFile(DATEN_DATEI, text, 'application/json');
  PropertiesService.getScriptProperties().setProperty('DATEN_ID', ordner.getId() + '|' + datei.getId());
  return datei;
}

function ladeDaten_() {
  var datei = datenDatei_();
  if (datei) {
    var d = JSON.parse(datei.getBlob().getDataAsString('UTF-8'));
    d.faelle = d.faelle || {};
    d.verlauf = d.verlauf || {};
    d.anlagen = d.anlagen || {};
    d.auftraggeber = d.auftraggeber || {};
    CRM_NAMEN.forEach(function (t) { d[t] = d[t] || {}; });
    return d;
  }
  // Neuer Bestand: sofort anlegen, damit die Kennung bei jedem weiteren Aufruf gleich bleibt.
  // Ändert sie sich, erkennen die Geräte daran, dass sie alles neu hochladen müssen.
  var sperre = LockService.getScriptLock();
  sperre.waitLock(25000);
  try {
    if (datenDatei_()) return ladeDaten_(); // inzwischen von einem anderen Aufruf angelegt
    var neu = { kennung: Utilities.getUuid(), rev: 0, faelle: {}, verlauf: {}, anlagen: {}, auftraggeber: {} };
    CRM_NAMEN.forEach(function (t) { neu[t] = {}; });
    neueDatenDatei_(JSON.stringify(neu));
    return neu;
  } finally {
    sperre.releaseLock();
  }
}

function speichereDaten_(d) {
  var text = JSON.stringify(d);
  var datei = datenDatei_();
  if (!datei) {
    neueDatenDatei_(text);
    merkeStand_(d);
    return;
  }
  sichereTaeglich_(datei);
  datei.setContent(text);
  merkeStand_(d);
}

/** Hebt vor der ersten Änderung des Tages den bisherigen Stand auf. */
function sichereTaeglich_(datei) {
  var props = PropertiesService.getScriptProperties();
  var heute = new Date().toISOString().slice(0, 10);
  if (props.getProperty('LETZTE_SICHERUNG') === heute) return;
  var bisher = datei.getBlob().getDataAsString('UTF-8');
  if (JSON.parse(bisher).rev === 0) return; // ein leerer Bestand braucht keine Sicherung
  var ziel = unterordner_(SICHERUNG_ORDNER);
  ziel.createFile('daten-' + heute + '.json', bisher, 'application/json');
  props.setProperty('LETZTE_SICHERUNG', heute);

  var namen = [];
  var dateien = ziel.getFiles();
  var nachName = {};
  while (dateien.hasNext()) {
    var f = dateien.next();
    namen.push(f.getName());
    nachName[f.getName()] = f;
  }
  namen.sort().slice(0, Math.max(0, namen.length - SICHERUNGEN_BEHALTEN)).forEach(function (name) {
    nachName[name].setTrashed(true);
  });
}
