/**
 * app.js — Available Office Calendar (Grist Custom Widget)
 * ─────────────────────────────────────────────────────────────────
 * Uses FullCalendar 6 for the week view.
 * Data comes from the Grist plugin API — no fetch(), no CORS issues.
 *
 * Sections:
 *   1. Configuration
 *   2. State
 *   3. Date & time helpers
 *   4. Period helpers
 *   5. Text helpers
 *   6. FullCalendar setup & render
 *   7. Autocomplete ("Who are you?")
 *   8. Modal (openModal, closeModal, confirmEvent)
 *   9. Grist API (normalise, fetchPeople, fetchAvailablePeople, loadData)
 *  10. UI helpers
 *  11. Bootstrap
 */


/* ═══════════════════════════════════════════════════════════════
   1. CONFIGURATION
════════════════════════════════════════════════════════════════ */
const CONFIG = {
  tables: {
    calendar:        'Calendar',
    people:          'People',
    availablePeople: 'Setting_available_place',
    bookings:        'Getting_available_place',
  },
  calendarCols: {
    date:  'date',
    text:  'calendar_text',
    start: 'start',
    end:   'end',
  },
  bookingCols: {
    date:            'date',
    personAvailable: 'people_available_place',
    personTaking:    'people_taking_the_place',
    period:          'Period',
  },
  peopleNameCol:          'people',
  availablePeopleNameCol: 'people_str',
  dayStart: 6,
  dayEnd:   20,
};


/* ═══════════════════════════════════════════════════════════════
   2. STATE
════════════════════════════════════════════════════════════════ */
let calendar        = null; // FullCalendar instance
let events          = [];   // normalised event objects
let people          = [];   // { id, name } from People table
let availablePeople = [];   // { id, name } from Setting_available_place
let bookings        = [];   // { date, personAvailable, personTaking, period } from Getting_available_place
let selectedEvent   = null; // event shown in the modal


/* ═══════════════════════════════════════════════════════════════
   3. DATE & TIME HELPERS
════════════════════════════════════════════════════════════════ */

/**
 * Parse a Grist date value into a JS Date.
 * Handles Unix timestamps (s), dd/mm/yyyy strings, and ISO strings.
 */
function parseEventDate(raw) {
  if (!raw) return null;
  if (typeof raw === 'number') return new Date(raw * 1000);
  if (typeof raw === 'string') {
    const ddmmyyyy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (ddmmyyyy) return new Date(+ddmmyyyy[3], +ddmmyyyy[2] - 1, +ddmmyyyy[1]);
    const yyyymmdd = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (yyyymmdd) return new Date(+yyyymmdd[1], +yyyymmdd[2] - 1, +yyyymmdd[3]);
    return new Date(raw);
  }
  return null;
}

/**
 * Parse a Grist DateTime (Unix timestamp in seconds) into { h, m, str }.
 */
function parseTime(raw) {
  if (!raw) return null;
  if (typeof raw === 'number') {
    const d = new Date(raw * 1000);
    const h = d.getHours(), m = d.getMinutes();
    return { h, m, str: `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}` };
  }
  if (typeof raw === 'string') {
    const hm = raw.match(/(\d{1,2}):(\d{2})/);
    if (hm) {
      const h = +hm[1], m = +hm[2];
      return { h, m, str: `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}` };
    }
  }
  return null;
}

/** Human-readable date for the modal summary */
function fmtDate(d) {
  return d.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
}


/* ═══════════════════════════════════════════════════════════════
   4. PERIOD HELPERS
════════════════════════════════════════════════════════════════ */
function getPeriod(ev) {
  const st = parseTime(ev._start);
  const en = parseTime(ev._end);
  if (!st) return 'All day';
  if (st.h <= 8 && en && en.h >= 17) return 'All day';
  if (en && en.h <= 13) return 'Morning';
  if (st.h >= 12) return 'Afternoon';
  return 'All day';
}

function isAllDayEvent(ev) {
  return getPeriod(ev) === 'All day';
}


/* ═══════════════════════════════════════════════════════════════
   4b. BOOKING LOOKUP HELPERS
════════════════════════════════════════════════════════════════ */

/**
 * Return all bookings that match a given event's date + period.
 * For an "All day" event we also include Morning and Afternoon bookings
 * so the full picture is visible.
 * @param {object} ev  normalised event object
 * @returns {{ personAvailable, personTaking, period }[]}
 */
function getBookingsForEvent(ev) {
  const ed = parseEventDate(ev._date);
  if (!ed) return [];
  const period = getPeriod(ev);

  return bookings.filter(b => {
    if (!b.date) return false;
    const bd = new Date(b.date * 1000);
    const sameDay = (
      bd.getFullYear() === ed.getFullYear() &&
      bd.getMonth()    === ed.getMonth()    &&
      bd.getDate()     === ed.getDate()
    );
    if (!sameDay) return false;
    if (period === 'All day') return true;          // show all sub-periods
    return b.period === period;                      // Morning/Afternoon: exact match only
  });
}

/* ═══════════════════════════════════════════════════════════════
   5. TEXT HELPERS
   Parses the calendar_text formula output:
     "3 places:\nAlice,\nBob,\nCarol"
   → ["Alice", "Bob", "Carol"]
════════════════════════════════════════════════════════════════ */
function parseAvailablePlaces(text) {
  if (!text) return [];
  text = String(text);
  const names = [];
  for (const chunk of text.split(/[\n,]+/)) {
    const name = chunk.trim().replace(/^-\s*/, '');
    if (name && !/places?:/i.test(name) && !/^\d+/.test(name)) {
      names.push(name);
    }
  }
  return names;
}


/* ═══════════════════════════════════════════════════════════════
   6. FULLCALENDAR SETUP & RENDER
   ─────────────────────────────────────────────────────────────
   We create the FullCalendar instance once, then call
   updateCalendarEvents() whenever the events array changes.
   FullCalendar handles the week grid, navigation, and time slots.
════════════════════════════════════════════════════════════════ */

/** Initialise the FullCalendar instance (called once on startup) */
function initCalendar() {
  const el = document.getElementById('calendar');
  calendar = new FullCalendar.Calendar(el, {
    initialView:     'timeGridWeek',  // week view with time slots
    firstDay:        1,               // Monday first
    slotMinTime:     `${String(CONFIG.dayStart).padStart(2,'0')}:00:00`,
    slotMaxTime:     `${String(CONFIG.dayEnd).padStart(2,'0')}:00:00`,
    slotDuration:    '00:30:00',
    headerToolbar: {
      left:   'prev,next today',
      center: 'title',
      right:  '',                     // no view switcher needed
    },
    buttonText: { today: 'Today' },
    allDaySlot:      false,
    nowIndicator:    true,
    height:          'auto',
    expandRows:      false,
    slotDuration:    '01:00:00',  // 1h slots so all 14h fit without scroll
    slotLabelInterval: '01:00:00',
    eventClick(info) {
      // info.event.extendedProps.gristEvent holds our normalised object
      openModal(info.event.extendedProps.gristEvent);
    },
    eventClassNames(info) {
      return [`color-${info.event.extendedProps.colorIdx % 3}`];
    },
    eventContent(info) {
      return buildEventContent(info);
    },
  });
  calendar.render();
}

/**
 * Convert our normalised events[] into FullCalendar event objects
 * and replace the current event source.
 * Called every time loadData() refreshes the data.
 */
function updateCalendarEvents() {
  if (!calendar) return;

  const fcEvents = events.map((ev, idx) => {
    const st = parseTime(ev._start);
    const en = parseTime(ev._end);
    const ed = parseEventDate(ev._date);
    if (!ed || !st) return null;

    // Hide events that have nothing to show (no available places, no bookings)
    const available = parseAvailablePlaces(ev._text);
    const taken     = getBookingsForEvent(ev);
    if (available.length === 0 && taken.length === 0) return null;

    const pad     = n => String(n).padStart(2, '0');
    const dateStr = `${ed.getFullYear()}-${pad(ed.getMonth()+1)}-${pad(ed.getDate())}`;
    const start   = `${dateStr}T${st.str}:00`;
    const end     = en ? `${dateStr}T${en.str}:00` : null;

    return {
      title: ev._text || '(no title)',
      start,
      end,
      extendedProps: { gristEvent: ev, colorIdx: idx },
    };
  }).filter(Boolean);

  calendar.removeAllEvents();
  calendar.addEventSource(fcEvents);
}

/**
 * Build the HTML content shown inside each calendar event block.
 *
 * Layout:
 *   ┌────────────────────────────┐
 *   │ 🟢 Alice, Bob              │  ← available places (from calendar_text)
 *   │ ─────────────────────────  │
 *   │ 🔴 Alice → Carol (Morning) │  ← taken: personAvailable → personTaking
 *   │    Bob → Dave (All day)    │
 *   └────────────────────────────┘
 *
 * Called by FullCalendar's eventContent hook.
 * Must return a { html: string } object.
 */
function buildEventContent(info) {
  const ev        = info.event.extendedProps.gristEvent;
  const available = parseAvailablePlaces(ev._text);
  const taken     = getBookingsForEvent(ev);
  const period    = getPeriod(ev);

  // Names still free = available minus those already booked
  const takenNames = taken.map(b => b.personAvailable.toLowerCase());
  const free = available.filter(n => !takenNames.includes(n.toLowerCase()));

  let html = '<div class="fc-event-content-inner">';

  // ── Summary count line ────────────────────────────────────────
  const totalSpots = available.length || taken.length; // fallback when _text empty
  html += `<div class="ev-summary">${free.length} free · ${taken.length} taken</div>`;

  // ── Free places — one per line ────────────────────────────────
  if (free.length) {
    free.forEach(name => {
      html += `<div class="ev-free">🟢 ${name}</div>`;
    });
  } else {
    html += `<div class="ev-free ev-full">🔴 Full</div>`;
  }

  // ── Taken places — one per line ───────────────────────────────
  if (taken.length) {
    html += '<div class="ev-divider"></div>';
    taken.forEach(b => {
      const label = b.period && b.period !== period
        ? ` <span class="ev-period">(${b.period})</span>` : '';
      html += `<div class="ev-taken">🔴 ${b.personAvailable} → ${b.personTaking}${label}</div>`;
    });
  }

  html += '</div>';
  return { html };
}


/* ═══════════════════════════════════════════════════════════════
   7. AUTOCOMPLETE — "Who are you?" field
   ─────────────────────────────────────────────────────────────
   Text input that filters the people[] array as you type.
   Stores the Grist row ID in a hidden field for the Reference column.
════════════════════════════════════════════════════════════════ */
function initWhoAutocomplete() {
  const input     = document.getElementById('who-input');
  const list      = document.getElementById('who-list');
  const hiddenVal = document.getElementById('modal-who-i-am');

  input.value = '';
  input.classList.remove('confirmed');
  hiddenVal.value = '';
  list.innerHTML  = '';
  list.classList.remove('open');

  let activeIdx = -1;

  function showSuggestions(query) {
    list.innerHTML = '';
    activeIdx = -1;
    const q = query.trim().toLowerCase();
    const matches = q === ''
      ? people
      : people.filter(p => p.name.toLowerCase().includes(q));

    if (!matches.length) { list.classList.remove('open'); return; }

    matches.forEach(person => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      if (q) {
        const i = person.name.toLowerCase().indexOf(q);
        li.innerHTML = person.name.slice(0, i)
          + `<mark>${person.name.slice(i, i + q.length)}</mark>`
          + person.name.slice(i + q.length);
      } else {
        li.textContent = person.name;
      }
      li.addEventListener('mousedown', e => { e.preventDefault(); confirmSelection(person); });
      list.appendChild(li);
    });
    list.classList.add('open');
  }

  function confirmSelection(person) {
    input.value     = person.name;
    hiddenVal.value = person.id;
    input.classList.add('confirmed');
    list.classList.remove('open');
    list.innerHTML = '';
    activeIdx = -1;
  }

  input.addEventListener('input',  () => { input.classList.remove('confirmed'); hiddenVal.value = ''; showSuggestions(input.value); });
  input.addEventListener('focus',  () => showSuggestions(input.value));
  input.addEventListener('blur',   () => {
    setTimeout(() => {
      list.classList.remove('open');
      const exact = people.find(p => p.name.toLowerCase() === input.value.trim().toLowerCase());
      if (exact) confirmSelection(exact);
    }, 150);
  });
  input.addEventListener('keydown', e => {
    const items = list.querySelectorAll('li');
    if (!list.classList.contains('open') || !items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, items.length - 1); }
    else if (e.key === 'ArrowUp')  { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIdx >= 0) {
        const name = items[activeIdx].textContent;
        confirmSelection(people.find(p => p.name === name) || { id: name, name });
      }
      return;
    } else if (e.key === 'Escape') { list.classList.remove('open'); activeIdx = -1; return; }
    items.forEach((li, i) => li.classList.toggle('active', i === activeIdx));
    if (activeIdx >= 0) items[activeIdx].scrollIntoView({ block: 'nearest' });
  });
}


/* ═══════════════════════════════════════════════════════════════
   8. MODAL
════════════════════════════════════════════════════════════════ */

/** Open the booking modal for a given event */
function openModal(ev) {
  selectedEvent = ev;
  const ed     = parseEventDate(ev._date);
  const st     = parseTime(ev._start);
  const en     = parseTime(ev._end);
  const period = getPeriod(ev);
  const allDay = isAllDayEvent(ev);

  document.getElementById('modal-title').textContent  = period;
  document.getElementById('modal-date').textContent   = ed ? fmtDate(ed) : '—';
  document.getElementById('modal-hours').textContent  = st ? st.str + (en ? ' → ' + en.str : '') : '—';
  document.getElementById('modal-period').textContent = period;

  // ── Availability summary ──────────────────────────────────────
  const available  = parseAvailablePlaces(ev._text);
  const taken      = getBookingsForEvent(ev);
  const takenNames = taken.map(b => b.personAvailable.toLowerCase());
  const free       = available.filter(n => !takenNames.includes(n.toLowerCase()));

  const summaryEl = document.getElementById('modal-availability');
  let summaryHtml = `<div class="modal-avail-count">${free.length} free · ${taken.length} taken</div>`;

  if (free.length) {
    free.forEach(name => {
      summaryHtml += `<div class="modal-avail-free">🟢 ${name}</div>`;
    });
  }
  if (taken.length) {
    if (free.length) summaryHtml += '<div class="modal-avail-divider"></div>';
    taken.forEach(b => {
      const label = b.period && b.period !== period
        ? ` <span class="modal-avail-period">(${b.period})</span>` : '';
      summaryHtml += `<div class="modal-avail-taken">🔴 ${b.personAvailable} → ${b.personTaking}${label}</div>`;
    });
  }
  summaryEl.innerHTML = summaryHtml;

  // ── "Which spot?" dropdown — only free places ─────────────────
  const placeSelect = document.getElementById('modal-whose-place');
  placeSelect.innerHTML = '<option value="">— Select —</option>';
  free.forEach(name => {
    const match = availablePeople.find(p => p.name.toLowerCase() === name.toLowerCase());
    const opt = document.createElement('option');
    opt.value       = match ? match.id : name;
    opt.textContent = name;
    placeSelect.appendChild(opt);
  });

  // Period selector — only for all-day events
  const periodRow = document.getElementById('modal-period-row');
  periodRow.style.display = allDay ? 'block' : 'none';
  document.getElementById('modal-period-select').value = 'All day';

  initWhoAutocomplete();
  document.getElementById('modal-bg').classList.add('open');
}

/** Close the modal (only if clicking the backdrop itself) */
function closeModal(e) {
  if (!e || e.target === document.getElementById('modal-bg')) {
    document.getElementById('modal-bg').classList.remove('open');
    selectedEvent = null;
  }
}

/** Write a booking to Grist then refresh */
async function confirmEvent() {
  if (!selectedEvent) return;
  const whoIAm     = document.getElementById('modal-who-i-am').value.trim();
  const whosePlace = document.getElementById('modal-whose-place').value;

  if (!whoIAm)     { showToast('Please select who you are', 'error'); return; }
  if (!whosePlace) { showToast('Please select a spot', 'error'); return; }

  const btn = document.getElementById('modal-confirm-btn');
  btn.classList.add('loading');
  btn.textContent = 'Saving…';

  const ed           = parseEventDate(selectedEvent._date);
  const period       = document.getElementById('modal-period-select').value || getPeriod(selectedEvent);
  const dateValue    = ed ? Math.floor(ed.getTime() / 1000) : null;
  const whoIAmInt    = parseInt(whoIAm, 10);
  const whosePlaceInt = parseInt(whosePlace, 10);

  try {
    await grist.docApi.applyUserActions([['AddRecord', CONFIG.tables.bookings, null, {
      [CONFIG.bookingCols.date]:            dateValue,
      [CONFIG.bookingCols.personAvailable]: isNaN(whosePlaceInt) ? whosePlace : whosePlaceInt,
      [CONFIG.bookingCols.personTaking]:    isNaN(whoIAmInt)     ? whoIAm     : whoIAmInt,
      [CONFIG.bookingCols.period]:          period,
    }]]);
    showToast('Spot booked!', 'success');
    document.getElementById('modal-bg').classList.remove('open');
    selectedEvent = null;
    await loadData(true);
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }

  btn.classList.remove('loading');
  btn.textContent = 'Confirm';
}


/* ═══════════════════════════════════════════════════════════════
   9. GRIST API
════════════════════════════════════════════════════════════════ */

/** Columnar Grist table → normalised event array */
function normaliseRecords(data) {
  const ids = data.id || [];
  return ids.map((id, i) => ({
    _id:    id,
    _date:  (data[CONFIG.calendarCols.date]  || [])[i] ?? null,
    _text:  String((data[CONFIG.calendarCols.text]  || [])[i] ?? ''),
    _start: (data[CONFIG.calendarCols.start] || [])[i] ?? null,
    _end:   (data[CONFIG.calendarCols.end]   || [])[i] ?? null,
  })).filter(e => e._date !== null);
}

/** Build {id, name}[] from a Grist table (for Reference column writes) */
function buildRefList(data, nameCol) {
  return (data.id || []).map((id, i) => ({
    id,
    name: String((data[nameCol] || [])[i] || '').trim(),
  })).filter(r => r.name);
}

async function fetchPeople() {
  try {
    const data = await grist.docApi.fetchTable(CONFIG.tables.people);
    people = buildRefList(data, CONFIG.peopleNameCol);
  } catch (e) { console.error('fetchPeople:', e); }
}

/**
 * Fetch all booking records from Getting_available_place.
 * Each booking has: date (Unix ts), personAvailable name,
 * personTaking name, and period string.
 */
async function fetchBookings() {
  try {
    const data = await grist.docApi.fetchTable(CONFIG.tables.bookings);
    const ids  = data.id || [];
    bookings = ids.map((id, i) => ({
      id,
      // date stored as Unix timestamp (seconds)
      date:            (data[CONFIG.bookingCols.date]            || [])[i] ?? null,
      // Reference columns return row IDs — resolve to names
      personAvailable: resolveRef(data[CONFIG.bookingCols.personAvailable]?.[i], availablePeople),
      personTaking:    resolveRef(data[CONFIG.bookingCols.personTaking]?.[i],    people),
      period:          String((data[CONFIG.bookingCols.period] || [])[i] ?? ''),
    })).filter(b => b.date && b.period);
  } catch (e) { console.error('fetchBookings:', e); }
}

/**
 * Resolve a Grist Reference value (row ID integer) to a display name.
 * Falls back to the raw value if no match found.
 * @param {number|string} refId
 * @param {{ id: number, name: string }[]} list
 */
function resolveRef(refId, list) {
  if (!refId) return '';
  const match = list.find(r => r.id === refId);
  return match ? match.name : String(refId);
}

async function fetchAvailablePeople() {
  try {
    const data = await grist.docApi.fetchTable(CONFIG.tables.availablePeople);
    availablePeople = buildRefList(data, CONFIG.availablePeopleNameCol);
  } catch (e) { console.error('fetchAvailablePeople:', e); }
}

async function loadData(silent = false) {
  try {
    // fetchBookings depends on people + availablePeople for ref resolution,
    // so fetch those first, then bookings in a second pass.
    const [calData] = await Promise.all([
      grist.docApi.fetchTable(CONFIG.tables.calendar),
      fetchPeople(),
      fetchAvailablePeople(),
    ]);
    await fetchBookings();
    events = normaliseRecords(calData);
    updateCalendarEvents();
  } catch (err) {
    if (!silent) console.error('loadData:', err);
  }
}


/* ═══════════════════════════════════════════════════════════════
   10. UI HELPERS
════════════════════════════════════════════════════════════════ */
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (type ? ' ' + type : '');
  setTimeout(() => { t.className = 'toast'; }, 2800);
}


/* ═══════════════════════════════════════════════════════════════
   11. BOOTSTRAP
════════════════════════════════════════════════════════════════ */
initCalendar();
grist.ready({ requiredAccess: 'full' });
loadData();
setInterval(() => loadData(true), 5000);
